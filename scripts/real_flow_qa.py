#!/usr/bin/env python3
"""Real Flow recipe QA runner.

Drives the local Flowboard agent over HTTP, so it works against the same
Chrome-extension-authenticated Flow session as the UI.

Common runs:

  python scripts/real_flow_qa.py --mode fixtures
  python scripts/real_flow_qa.py --mode videos --video-profile free-lite
  python scripts/real_flow_qa.py --mode all --video-profile full

The runner writes a manifest under storage/real-flow-qa/ by default. That
manifest stores board/project ids, generated fixture media ids, saved reference
ids, and video QA request outcomes, so changing accounts or waiting for quota
reset is a one-command rerun instead of a manual API session.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time
from typing import Any

import httpx


DEFAULT_MANIFEST = Path("storage/real-flow-qa/manifest.json")
TERMINAL_REQUEST_STATUSES = {"done", "failed", "timeout", "canceled"}


class QAError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(event: str, **fields: Any) -> None:
    payload = {"ts": utc_now(), "event": event, **fields}
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise QAError(f"cannot read manifest {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise QAError(f"manifest {path} must contain a JSON object")
    return raw


def save_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest["updated_at"] = utc_now()
    path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


async def request_json(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    timeout: float | None = None,
    **kwargs: Any,
) -> dict[str, Any] | list[Any]:
    resp = await client.request(method, path, timeout=timeout, **kwargs)
    text = resp.text
    if resp.status_code >= 400:
        raise QAError(f"{method} {path} -> {resp.status_code}: {text[:1000]}")
    try:
        return resp.json()
    except ValueError as exc:
        raise QAError(f"{method} {path} returned non-json: {text[:500]}") from exc


async def poll_request(
    client: httpx.AsyncClient,
    request_id: int,
    *,
    timeout_s: float,
    interval_s: float,
) -> dict[str, Any]:
    start = time.monotonic()
    last_status = None
    while True:
        row = await request_json(client, "GET", f"/api/requests/{request_id}")
        assert isinstance(row, dict)
        status = row.get("status")
        if status != last_status:
            log("request_status", request_id=request_id, status=status, error=row.get("error"))
            last_status = status
        if status in TERMINAL_REQUEST_STATUSES:
            return row
        if time.monotonic() - start > timeout_s:
            raise QAError(f"request {request_id} did not settle within {timeout_s}s")
        await asyncio.sleep(interval_s)


def media_ids_from_result(row: dict[str, Any]) -> list[str]:
    result = row.get("result") if isinstance(row.get("result"), dict) else {}
    ids: list[str] = []
    for item in result.get("media_ids") or []:
        if isinstance(item, str) and item and item not in ids:
            ids.append(item)
    for entry in result.get("media_entries") or []:
        if isinstance(entry, dict):
            media_id = entry.get("media_id")
            if isinstance(media_id, str) and media_id and media_id not in ids:
                ids.append(media_id)
    dispatch = result.get("raw_dispatch")
    if isinstance(dispatch, dict):
        for workflow in dispatch.get("workflows") or []:
            if isinstance(workflow, dict):
                media_id = workflow.get("primary_media_id")
                if isinstance(media_id, str) and media_id and media_id not in ids:
                    ids.append(media_id)
        raw = dispatch.get("raw")
        data = raw.get("data") if isinstance(raw, dict) else None
        if isinstance(data, dict):
            for workflow in data.get("workflows") or []:
                metadata = workflow.get("metadata") if isinstance(workflow, dict) else None
                media_id = metadata.get("primaryMediaId") if isinstance(metadata, dict) else None
                if isinstance(media_id, str) and media_id and media_id not in ids:
                    ids.append(media_id)
    return ids


def operation_names_from_result(row: dict[str, Any]) -> list[str]:
    result = row.get("result") if isinstance(row.get("result"), dict) else {}
    names = result.get("operation_names")
    if isinstance(names, list):
        return [name for name in names if isinstance(name, str)]
    dispatch = result.get("raw_dispatch")
    if isinstance(dispatch, dict) and isinstance(dispatch.get("operation_names"), list):
        return [name for name in dispatch["operation_names"] if isinstance(name, str)]
    return []


async def assert_media_available(client: httpx.AsyncClient, media_id: str) -> dict[str, Any]:
    status = await request_json(client, "GET", f"/api/media/{media_id}/status")
    assert isinstance(status, dict)
    log("media_status", media_id=media_id, status=status)
    if status.get("available"):
        return status
    if not status.get("has_url"):
        raise QAError(f"media {media_id} is not available and has no cached url: {status}")
    resp = await client.get(f"/media/{media_id}", timeout=90.0)
    if resp.status_code != 200:
        raise QAError(f"/media/{media_id} -> {resp.status_code}: {resp.text[:500]}")
    post_fetch = await request_json(client, "GET", f"/api/media/{media_id}/status")
    assert isinstance(post_fetch, dict)
    log("media_status_after_fetch", media_id=media_id, status=post_fetch)
    if not post_fetch.get("available"):
        raise QAError(f"media {media_id} did not cache after fetch: {post_fetch}")
    return post_fetch


FIXTURE_DEFS: list[dict[str, Any]] = [
    {
        "key": "product",
        "node_type": "product",
        "ref_kind": "product",
        "role": "product_ref",
        "title": "QA product: matte teal mug",
        "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT",
        "profile": {
            "kind": "product",
            "productName": "Matte teal ceramic mug",
            "brief": "Matte teal ceramic mug, clean silhouette, visible rim and handle.",
            "claimRules": "No unsupported performance claims. No invented labels.",
        },
        "prompt": (
            "Photorealistic 9:16 product packshot of a matte teal ceramic mug "
            "on a warm gray desk, soft window daylight, clean background, no "
            "readable text, no logo, no people, natural shadows."
        ),
        "x": 0,
        "y": 0,
    },
    {
        "key": "location",
        "node_type": "location",
        "ref_kind": "location",
        "role": "background_ref",
        "title": "QA location: warm cafe table",
        "aspect_ratio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
        "profile": {
            "kind": "location",
            "locationName": "Warm cafe tabletop",
            "brief": "Soft daylight cafe table, warm gray and oak surfaces, uncluttered.",
        },
        "prompt": (
            "Photorealistic warm cafe tabletop location, soft morning window "
            "light, neutral oak and warm gray surfaces, shallow depth of field, "
            "clean commercial background, no people, no readable text."
        ),
        "x": 260,
        "y": 0,
    },
    {
        "key": "brand",
        "node_type": "brand",
        "ref_kind": "brand",
        "role": "style_ref",
        "title": "QA brand: calm premium homeware",
        "aspect_ratio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
        "profile": {
            "kind": "brand",
            "brandName": "QA Homeware",
            "brandTone": "Calm, premium, warm, tactile, minimal.",
            "palette": "teal, warm gray, soft white, oak.",
            "legalNotes": "Avoid fake logos, readable claims, and medical language.",
        },
        "prompt": (
            "Premium homeware brand mood board with teal, warm gray, oak, and "
            "soft white palette, tactile ceramics, minimal composition, no "
            "readable text, no logos, no UI, photoreal editorial lighting."
        ),
        "x": 520,
        "y": 0,
    },
    {
        "key": "character",
        "node_type": "character",
        "ref_kind": "character",
        "role": "character_ref",
        "title": "QA character: lifestyle creator",
        "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT",
        "profile": {
            "kind": "character",
            "characterName": "QA lifestyle creator",
            "brief": "Friendly adult lifestyle creator, natural expression, creator-style framing.",
        },
        "prompt": (
            "Photorealistic portrait of an adult lifestyle creator at a warm "
            "cafe table, natural expression, casual neutral clothing, creator "
            "style framing, soft daylight, no readable text, no logo."
        ),
        "x": 780,
        "y": 0,
    },
    {
        "key": "first_frame",
        "node_type": "image",
        "ref_kind": "first_frame",
        "role": "first_frame",
        "title": "QA first frame: product in scene",
        "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT",
        "profile": {
            "kind": "first_frame",
            "brief": "First frame for product/lifestyle i2v QA.",
        },
        "prompt": (
            "Photorealistic vertical first frame for a lifestyle product video: "
            "matte teal ceramic mug centered on warm cafe table, soft daylight, "
            "subtle steam, clean premium composition, no readable text."
        ),
        "x": 0,
        "y": 240,
    },
    {
        "key": "last_frame",
        "node_type": "image",
        "ref_kind": "image",
        "role": "last_frame",
        "title": "QA last frame: final hero hold",
        "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT",
        "profile": {
            "kind": "image",
            "brief": "Last frame for before/after and transition QA.",
        },
        "prompt": (
            "Photorealistic vertical final hero frame: same matte teal ceramic "
            "mug on warm cafe table, slightly warmer light, clean final hold, "
            "product centered and readable, no text, no extra products."
        ),
        "x": 260,
        "y": 240,
    },
]


AUDIO_FIXTURE: dict[str, Any] = {
    "key": "audio",
    "node_type": "audio",
    "title": "QA audio: warm no-speech bed",
    "profile": {
        "kind": "audio",
        "voiceName": "No speech",
        "brief": "Warm low-volume instrumental bed, soft ceramic/tabletop foley, no speech.",
    },
    "data": {
        "title": "QA audio: warm no-speech bed",
        "audioMode": "music",
        "prompt": "Warm low-volume instrumental bed with subtle tabletop foley, no speech.",
        "voiceName": "No speech",
    },
    "x": 520,
    "y": 240,
}


def fixture_media_id(manifest: dict[str, Any], key: str) -> str:
    fixtures = manifest.get("fixtures")
    if not isinstance(fixtures, dict):
        raise QAError("manifest has no fixtures; run --mode fixtures first")
    item = fixtures.get(key)
    if not isinstance(item, dict):
        raise QAError(f"manifest missing fixture {key!r}; run --mode fixtures first")
    media_id = item.get("media_id")
    if not isinstance(media_id, str) or not media_id:
        raise QAError(f"fixture {key!r} has no media_id")
    return media_id


async def create_node(
    client: httpx.AsyncClient,
    *,
    board_id: int,
    node_type: str,
    x: float,
    y: float,
    data: dict[str, Any],
    status: str = "idle",
) -> dict[str, Any]:
    row = await request_json(
        client,
        "POST",
        "/api/nodes",
        json={
            "board_id": board_id,
            "type": node_type,
            "x": x,
            "y": y,
            "data": data,
            "status": status,
        },
    )
    assert isinstance(row, dict)
    return row


async def patch_node_media(
    client: httpx.AsyncClient,
    *,
    node_id: int,
    media_id: str,
    media_ids: list[str],
    extra_data: dict[str, Any] | None = None,
) -> None:
    data = {
        "mediaId": media_id,
        "mediaIds": media_ids,
        "renderedAt": utc_now(),
    }
    if extra_data:
        data.update(extra_data)
    await request_json(
        client,
        "PATCH",
        f"/api/nodes/{node_id}",
        json={"status": "done", "data": data},
    )


async def save_reference(
    client: httpx.AsyncClient,
    *,
    media_id: str,
    kind: str,
    label: str,
    ai_brief: str,
    aspect_ratio: str,
    board_id: int,
    node: dict[str, Any],
    tags: list[str],
    profile: dict[str, Any],
) -> dict[str, Any]:
    row = await request_json(
        client,
        "POST",
        "/api/references",
        json={
            "media_id": media_id,
            "kind": kind,
            "label": label,
            "ai_brief": ai_brief,
            "aspect_ratio": aspect_ratio,
            "source_board_id": board_id,
            "source_node_short_id": node.get("short_id"),
            "tags": tags,
            "profile": profile,
        },
    )
    assert isinstance(row, dict)
    return row


async def ensure_project(
    client: httpx.AsyncClient,
    *,
    board_id: int,
    project_id_arg: str | None,
) -> str:
    if project_id_arg:
        log("project_ready", board_id=board_id, project_id=project_id_arg, source="arg")
        return project_id_arg
    project = await request_json(
        client,
        "POST",
        f"/api/boards/{board_id}/project",
        timeout=90.0,
    )
    assert isinstance(project, dict)
    project_id = str(project["flow_project_id"])
    log("project_ready", board_id=board_id, project_id=project_id, created=project.get("created"))
    return project_id


async def bootstrap_agent(client: httpx.AsyncClient) -> dict[str, Any]:
    health = await request_json(client, "GET", "/api/health")
    log("health", health=health)
    if not isinstance(health, dict) or not health.get("extension_connected"):
        raise QAError("extension is not connected")
    scan = await request_json(client, "POST", "/api/auth/scan")
    me = await request_json(client, "GET", "/api/auth/me")
    log("auth", scan=scan, me=me)
    if not isinstance(me, dict) or not me.get("paygate_tier"):
        raise QAError("paygate tier unavailable")
    return me


async def create_qa_board(client: httpx.AsyncClient, *, name_prefix: str) -> dict[str, Any]:
    board_name = f"{name_prefix} {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
    board = await request_json(client, "POST", "/api/boards", json={"name": board_name})
    assert isinstance(board, dict)
    log("board_created", board_id=board.get("id"), name=board_name)
    return board


async def run_image_fixture(
    client: httpx.AsyncClient,
    *,
    fixture: dict[str, Any],
    board_id: int,
    project_id: str,
    paygate_tier: str,
    args: argparse.Namespace,
) -> dict[str, Any]:
    profile = dict(fixture.get("profile") or {})
    profile.setdefault("brief", fixture["title"])
    node_data = {
        "title": fixture["title"],
        "prompt": fixture["prompt"],
        "aspectRatio": fixture["aspect_ratio"],
        **profile,
    }
    node = await create_node(
        client,
        board_id=board_id,
        node_type=fixture["node_type"],
        x=float(fixture["x"]),
        y=float(fixture["y"]),
        data=node_data,
        status="queued",
    )
    node_id = int(node["id"])
    image_request = await request_json(
        client,
        "POST",
        "/api/requests",
        json={
            "node_id": node_id,
            "type": "gen_image",
            "params": {
                "prompt": fixture["prompt"],
                "project_id": project_id,
                "aspect_ratio": fixture["aspect_ratio"],
                "paygate_tier": paygate_tier,
                "variant_count": 1,
                "image_model": args.image_model,
                "low_priority": args.low_priority_image,
            },
        },
    )
    assert isinstance(image_request, dict)
    request_id = int(image_request["id"])
    log("request_created", fixture=fixture["key"], kind="gen_image", request_id=request_id)
    row = await poll_request(
        client,
        request_id,
        timeout_s=args.image_timeout,
        interval_s=args.poll_interval,
    )
    media_ids = media_ids_from_result(row)
    if row.get("status") != "done" or not media_ids:
        raise QAError(f"fixture {fixture['key']} gen_image ended {row.get('status')}: {row.get('error')}")
    media_id = media_ids[0]
    await assert_media_available(client, media_id)
    await patch_node_media(
        client,
        node_id=node_id,
        media_id=media_id,
        media_ids=media_ids,
        extra_data={
            "qaFixtureKey": fixture["key"],
            "refRole": fixture["role"],
        },
    )
    reference = await save_reference(
        client,
        media_id=media_id,
        kind=fixture["ref_kind"],
        label=fixture["title"],
        ai_brief=profile["brief"],
        aspect_ratio=fixture["aspect_ratio"],
        board_id=board_id,
        node=node,
        tags=["real-flow-qa", fixture["key"]],
        profile={**profile, "mediaId": media_id, "qaFixtureKey": fixture["key"]},
    )
    result = {
        "key": fixture["key"],
        "node_id": node_id,
        "node_short_id": node.get("short_id"),
        "media_id": media_id,
        "media_ids": media_ids,
        "request_id": request_id,
        "reference_id": reference.get("id"),
        "role": fixture["role"],
        "kind": fixture["ref_kind"],
        "label": fixture["title"],
    }
    log("fixture_ready", fixture=result)
    return result


async def create_audio_fixture(
    client: httpx.AsyncClient,
    *,
    board_id: int,
) -> dict[str, Any]:
    node = await create_node(
        client,
        board_id=board_id,
        node_type=AUDIO_FIXTURE["node_type"],
        x=float(AUDIO_FIXTURE["x"]),
        y=float(AUDIO_FIXTURE["y"]),
        data={**AUDIO_FIXTURE["data"], **AUDIO_FIXTURE["profile"]},
        status="done",
    )
    result = {
        "key": AUDIO_FIXTURE["key"],
        "node_id": int(node["id"]),
        "node_short_id": node.get("short_id"),
        "profile": AUDIO_FIXTURE["profile"],
        "label": AUDIO_FIXTURE["title"],
        "role": "audio_ref",
    }
    log("fixture_ready", fixture=result)
    return result


async def run_fixtures(
    client: httpx.AsyncClient,
    *,
    args: argparse.Namespace,
    manifest: dict[str, Any],
    me: dict[str, Any],
) -> dict[str, Any]:
    board = await create_qa_board(client, name_prefix="Real Flow QA fixtures")
    board_id = int(board["id"])
    project_id = await ensure_project(client, board_id=board_id, project_id_arg=args.project_id)
    manifest.update(
        {
            "schema_version": 1,
            "created_at": utc_now(),
            "last_fixture_run_at": utc_now(),
            "base_url": args.base_url,
            "account": {
                "email": me.get("email"),
                "sku": me.get("sku"),
                "paygate_tier": me.get("paygate_tier"),
                "credits": me.get("credits"),
            },
            "board_id": board_id,
            "board_name": board.get("name"),
            "project_id": project_id,
            "fixtures": {},
        }
    )
    save_manifest(args.manifest, manifest)

    fixtures: dict[str, Any] = {}
    for fixture in FIXTURE_DEFS:
        try:
            item = await run_image_fixture(
                client,
                fixture=fixture,
                board_id=board_id,
                project_id=project_id,
                paygate_tier=str(me["paygate_tier"]),
                args=args,
            )
            fixtures[fixture["key"]] = item
        except Exception as exc:  # noqa: BLE001
            error_item = {
                "key": fixture["key"],
                "status": "failed",
                "error": str(exc),
                "label": fixture["title"],
            }
            fixtures[fixture["key"]] = error_item
            log("fixture_failed", fixture=fixture["key"], error=str(exc))
            if not args.continue_on_error:
                raise
        manifest["fixtures"] = fixtures
        save_manifest(args.manifest, manifest)

    fixtures["audio"] = await create_audio_fixture(client, board_id=board_id)
    manifest["fixtures"] = fixtures
    save_manifest(args.manifest, manifest)
    log("fixtures_done", board_id=board_id, project_id=project_id, manifest=str(args.manifest))
    return manifest


def free_lite_cases(manifest: dict[str, Any], *, duration_s: int) -> list[dict[str, Any]]:
    return [
        {
            "name": "free_lite_product_demo",
            "type": "gen_video",
            "recipe_id": "product_demo",
            "source_mode": "first_frame",
            "start_key": "first_frame",
            "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
            "video_quality": "lite",
            "duration_s": duration_s,
            "prompt": (
                "Real Flow QA product demo. Use first frame as exact product lock. "
                "Matte teal mug stays centered, subtle steam rises, camera locked, "
                "no captions, no extra objects, preserve shape and color."
            ),
        },
        {
            "name": "free_lite_packshot_loop",
            "type": "gen_video",
            "recipe_id": "packshot_loop",
            "source_mode": "first_frame",
            "start_key": "product",
            "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
            "video_quality": "lite",
            "duration_s": duration_s,
            "prompt": (
                "Real Flow QA packshot loop. Premium product loop from first frame. "
                "Teal mug slowly rotates a few degrees with soft steam and stable "
                "tabletop lighting, no text, no logo invention, seamless final hold."
            ),
        },
        {
            "name": "free_lite_cinematic_reveal",
            "type": "gen_video",
            "recipe_id": "cinematic_reveal",
            "source_mode": "first_frame",
            "start_key": "product",
            "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
            "video_quality": "lite",
            "duration_s": duration_s,
            "prompt": (
                "Real Flow QA cinematic reveal. Start from first frame, add a subtle "
                "light sweep and slow push-in. Preserve subject identity and framing, "
                "cinematic but readable, no abrupt cuts, no captions."
            ),
        },
        {
            "name": "free_lite_ugc_testimonial",
            "type": "gen_video",
            "recipe_id": "ugc_testimonial",
            "source_mode": "first_frame",
            "start_key": "character",
            "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
            "video_quality": "lite",
            "duration_s": duration_s,
            "prompt": (
                "Real Flow QA UGC testimonial visual. Start from creator/product "
                "frame. Natural handheld micro movement, creator presents product to "
                "camera, no lip sync, no captions, no claims, preserve face and "
                "product shape."
            ),
        },
        {
            "name": "free_lite_lifestyle_ad",
            "type": "gen_video",
            "recipe_id": "lifestyle_ad",
            "source_mode": "first_frame",
            "start_key": "first_frame",
            "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
            "video_quality": "lite",
            "duration_s": duration_s,
            "prompt": (
                "Real Flow QA lifestyle ad. Start from product lifestyle frame. "
                "Soft natural motion, believable ad beat, product remains readable, "
                "no random location changes, no captions, no unsupported claims."
            ),
        },
    ]


def full_cases(manifest: dict[str, Any], *, duration_s: int) -> list[dict[str, Any]]:
    cases = free_lite_cases(manifest, duration_s=duration_s)
    cases.extend(
        [
            {
                "name": "full_edit_video_refine",
                "type": "edit_video_omni",
                "recipe_id": "product_demo",
                "source_mode": "edit",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                "prompt": (
                    "Real Flow QA edit-video refine. Keep source clip composition, "
                    "add slightly warmer lighting and smoother final hold, preserve "
                    "product/source identity, no captions."
                ),
            },
            {
                "name": "full_brand_bumper_text",
                "type": "gen_video_text",
                "recipe_id": "brand_bumper",
                "source_mode": "text",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                "video_quality": "fast",
                "duration_s": duration_s,
                "prompt": (
                    "Real Flow QA brand bumper. Premium homeware brand bumper for a "
                    "matte teal ceramic mug on warm gray desk, slow push-in, calm "
                    "minimal lighting, no captions, no readable text."
                ),
            },
            {
                "name": "full_location_establishing_text",
                "type": "gen_video_text",
                "recipe_id": "location_establishing",
                "source_mode": "text",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                "video_quality": "fast",
                "duration_s": duration_s,
                "prompt": (
                    "Real Flow QA location establishing shot. Warm cafe tabletop and "
                    "soft morning daylight, slow cinematic drift across clean product "
                    "setup, no captions, no people."
                ),
            },
            {
                "name": "full_before_after_first_last",
                "type": "gen_video",
                "recipe_id": "before_after",
                "source_mode": "first_last",
                "start_key": "first_frame",
                "end_key": "last_frame",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                "video_quality": "fast",
                "duration_s": duration_s,
                "prompt": (
                    "Real Flow QA before/after. Smooth transition from first frame to "
                    "final hero frame while preserving mug identity, lighting continuity, "
                    "and product scale. No captions."
                ),
            },
            {
                "name": "full_transition_first_last",
                "type": "gen_video",
                "recipe_id": "transition_shot",
                "source_mode": "first_last",
                "start_key": "product",
                "end_key": "last_frame",
                "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                "video_quality": "fast",
                "duration_s": duration_s,
                "prompt": (
                    "Real Flow QA transition shot. Smooth product transition from packshot "
                    "to final hero hold, no hard cuts, no captions, preserve shape and color."
                ),
            },
            {
                "name": "full_lifestyle_ingredients_omni",
                "type": "gen_video_omni",
                "recipe_id": "lifestyle_ad",
                "source_mode": "ingredients",
                "ref_keys": ["product", "location", "brand"],
                "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                "duration_s": max(4, duration_s),
                "prompt": (
                    "Real Flow QA lifestyle ad via ingredients. Combine product, location, "
                    "and brand refs into a believable premium homeware ad beat. Product "
                    "remains readable, no captions, no claims."
                ),
            },
            {
                "name": "full_audio_led_ingredients_omni",
                "type": "gen_video_omni",
                "recipe_id": "audio_led",
                "source_mode": "ingredients",
                "ref_keys": ["product", "brand"],
                "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                "duration_s": max(4, duration_s),
                "prompt": (
                    "Real Flow QA audio-led video. Warm no-speech music bed and subtle "
                    "tabletop foley drive gentle product motion. Preserve product identity, "
                    "no captions, no voiceover."
                ),
            },
        ]
    )
    return cases


def build_case_params(
    case: dict[str, Any],
    *,
    manifest: dict[str, Any],
    project_id: str,
    paygate_tier: str,
    source_video_media_id: str | None,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "prompt": case["prompt"],
        "project_id": project_id,
        "paygate_tier": paygate_tier,
        "recipe_id": case["recipe_id"],
        "source_mode": case["source_mode"],
        "aspect_ratio": case["aspect_ratio"],
        "duration_s": case.get("duration_s"),
    }
    if case["type"] in {"gen_video", "gen_video_text"}:
        params["video_quality"] = case.get("video_quality")
    if case["type"] == "gen_video_text":
        params["count"] = 1
    if case["type"] == "gen_video":
        params["start_media_id"] = fixture_media_id(manifest, case["start_key"])
        if case.get("end_key"):
            params["end_media_id"] = fixture_media_id(manifest, case["end_key"])
    if case["type"] == "gen_video_omni":
        params["ref_media_ids"] = [fixture_media_id(manifest, key) for key in case["ref_keys"]]
    if case["type"] == "edit_video_omni":
        if not source_video_media_id:
            raise QAError("edit_video_omni case requires --source-video-media-id or prior video success")
        params["source_video_media_id"] = source_video_media_id
        params["start_frame_index"] = 0
        params["end_frame_index"] = 240
    return {key: value for key, value in params.items() if value is not None}


async def run_video_case(
    client: httpx.AsyncClient,
    *,
    case: dict[str, Any],
    params: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    request = await request_json(
        client,
        "POST",
        "/api/requests",
        json={"type": case["type"], "params": params},
    )
    assert isinstance(request, dict)
    request_id = int(request["id"])
    log(
        "request_created",
        case=case["name"],
        kind=case["type"],
        request_id=request_id,
        recipe_id=case["recipe_id"],
        source_mode=case["source_mode"],
    )
    row = await poll_request(
        client,
        request_id,
        timeout_s=args.video_timeout,
        interval_s=args.poll_interval,
    )
    media_ids = media_ids_from_result(row)
    status = str(row.get("status"))
    error = row.get("error")
    if media_ids:
        for media_id in media_ids:
            await assert_media_available(client, media_id)
    result = {
        "name": case["name"],
        "request_id": request_id,
        "type": case["type"],
        "recipe_id": case["recipe_id"],
        "source_mode": case["source_mode"],
        "status": status,
        "error": error,
        "media_ids": media_ids,
        "operation_names": operation_names_from_result(row),
        "duration_s": params.get("duration_s"),
        "video_quality": params.get("video_quality"),
        "finished_at": row.get("finished_at"),
    }
    log("video_case_done", result=result)
    if status != "done" and not args.continue_on_error:
        raise QAError(f"{case['name']} ended {status}: {error}")
    return result


async def run_videos(
    client: httpx.AsyncClient,
    *,
    args: argparse.Namespace,
    manifest: dict[str, Any],
    me: dict[str, Any],
) -> dict[str, Any]:
    project_id = args.project_id or manifest.get("project_id")
    if not isinstance(project_id, str) or not project_id:
        raise QAError("no project id; run fixtures first or pass --project-id")
    paygate_tier = str(me["paygate_tier"])
    cases = (
        free_lite_cases(manifest, duration_s=args.video_duration)
        if args.video_profile == "free-lite"
        else full_cases(manifest, duration_s=args.video_duration)
    )
    if args.max_cases is not None:
        cases = cases[: args.max_cases]
    if args.dry_run:
        for case in cases:
            log("video_case_dry_run", case=case)
        return manifest

    run_record = {
        "started_at": utc_now(),
        "profile": args.video_profile,
        "project_id": project_id,
        "account": {
            "email": me.get("email"),
            "sku": me.get("sku"),
            "paygate_tier": me.get("paygate_tier"),
            "credits": me.get("credits"),
        },
        "cases": [],
    }
    manifest.setdefault("video_runs", []).append(run_record)
    prior_video_media_id = args.source_video_media_id
    for case in cases:
        try:
            params = build_case_params(
                case,
                manifest=manifest,
                project_id=project_id,
                paygate_tier=paygate_tier,
                source_video_media_id=prior_video_media_id,
            )
            result = await run_video_case(client, case=case, params=params, args=args)
            if result["media_ids"] and case["type"] != "edit_video_omni":
                prior_video_media_id = result["media_ids"][0]
            run_record["cases"].append(result)
        except Exception as exc:  # noqa: BLE001
            result = {
                "name": case["name"],
                "type": case["type"],
                "recipe_id": case["recipe_id"],
                "source_mode": case["source_mode"],
                "status": "runner_failed",
                "error": str(exc),
                "media_ids": [],
                "finished_at": utc_now(),
            }
            run_record["cases"].append(result)
            log("video_case_failed", result=result)
            if not args.continue_on_error:
                raise
        manifest["video_runs"] = manifest["video_runs"][-20:]
        save_manifest(args.manifest, manifest)
    run_record["finished_at"] = utc_now()
    manifest["video_runs"] = manifest["video_runs"][-20:]
    save_manifest(args.manifest, manifest)
    log("videos_done", profile=args.video_profile, cases=len(run_record["cases"]))
    return manifest


async def run(args: argparse.Namespace) -> dict[str, Any]:
    manifest = load_manifest(args.manifest)
    async with httpx.AsyncClient(base_url=args.base_url, timeout=30.0) as client:
        me = await bootstrap_agent(client)
        if args.mode in {"fixtures", "all"}:
            manifest = await run_fixtures(client, args=args, manifest=manifest, me=me)
        if args.mode in {"videos", "all"}:
            manifest = await run_videos(client, args=args, manifest=manifest, me=me)
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8101")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--mode", choices=["fixtures", "videos", "all"], default="all")
    parser.add_argument("--project-id", help="reuse an existing Flow project id")
    parser.add_argument("--image-model", default="NANO_BANANA_2")
    parser.add_argument("--low-priority-image", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--image-timeout", type=float, default=240.0)
    parser.add_argument("--video-timeout", type=float, default=420.0)
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument("--video-profile", choices=["free-lite", "full"], default="free-lite")
    parser.add_argument("--video-duration", type=int, default=4)
    parser.add_argument("--max-cases", type=int)
    parser.add_argument("--source-video-media-id", help="existing video media id for edit-video case")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--continue-on-error", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest = asyncio.run(run(args))
    except Exception as exc:  # noqa: BLE001
        log("qa_failed", error=str(exc))
        return 1
    log(
        "qa_done",
        mode=args.mode,
        profile=args.video_profile,
        manifest=str(args.manifest),
        board_id=manifest.get("board_id"),
        project_id=manifest.get("project_id"),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
