#!/usr/bin/env python3
"""Real media smoke for Flowboard.

Drives the live agent over HTTP:
board -> Flow project -> gen_image -> gen_video -> timeline export.

This intentionally uses the same public API as the frontend instead of
importing app internals, so it can run against a user-started agent with the
Chrome extension already connected.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
import sys
import time
from typing import Any

import httpx


IMAGE_PROMPT = (
    "Photorealistic 9:16 tabletop shot of a matte teal ceramic mug on a warm "
    "gray desk, soft window daylight, clean background, no text, no logo, no "
    "people, natural shadows."
)
VIDEO_PROMPT = (
    "Slow gentle camera push-in toward the teal mug on the desk. Keep the mug "
    "shape, color, desk, lighting, and background consistent from the first "
    "frame. Natural realistic motion only. Audio: no speech, no voice-over, "
    "no singing, no text overlays, no logo."
)


class SmokeError(RuntimeError):
    pass


def log(event: str, **fields: Any) -> None:
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
    }
    print(json.dumps(payload, ensure_ascii=False), flush=True)


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
        raise SmokeError(f"{method} {path} -> {resp.status_code}: {text[:1000]}")
    try:
        return resp.json()
    except ValueError as exc:
        raise SmokeError(f"{method} {path} returned non-json: {text[:500]}") from exc


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
        if status in {"done", "failed", "timeout", "canceled"}:
            return row
        if time.monotonic() - start > timeout_s:
            raise SmokeError(f"request {request_id} did not settle within {timeout_s}s")
        await asyncio.sleep(interval_s)


def first_media_id(row: dict[str, Any]) -> str:
    result = row.get("result") if isinstance(row.get("result"), dict) else {}
    media_ids = result.get("media_ids")
    if isinstance(media_ids, list):
        for item in media_ids:
            if isinstance(item, str) and item:
                return item
    raise SmokeError(f"no media id in request result: {json.dumps(result)[:1000]}")


async def assert_media_available(client: httpx.AsyncClient, media_id: str) -> None:
    status = await request_json(client, "GET", f"/api/media/{media_id}/status")
    assert isinstance(status, dict)
    log("media_status", media_id=media_id, status=status)
    if not status.get("available") and not status.get("has_url"):
        raise SmokeError(f"media {media_id} is not available: {status}")
    resp = await client.get(f"/media/{media_id}", timeout=60.0)
    if resp.status_code != 200:
        raise SmokeError(f"/media/{media_id} -> {resp.status_code}: {resp.text[:500]}")
    if len(resp.content) < 16:
        raise SmokeError(f"/media/{media_id} returned too few bytes")
    post_fetch = await request_json(client, "GET", f"/api/media/{media_id}/status")
    assert isinstance(post_fetch, dict)
    log("media_status_after_fetch", media_id=media_id, status=post_fetch)
    if not post_fetch.get("available"):
        raise SmokeError(f"media {media_id} did not cache after fetch: {post_fetch}")
    log(
        "media_bytes_ok",
        media_id=media_id,
        bytes=len(resp.content),
        content_type=resp.headers.get("content-type"),
    )


async def run(args: argparse.Namespace) -> dict[str, Any]:
    async with httpx.AsyncClient(base_url=args.base_url, timeout=30.0) as client:
        health = await request_json(client, "GET", "/api/health")
        log("health_before", health=health)
        if not isinstance(health, dict) or not health.get("extension_connected"):
            raise SmokeError("extension is not connected")

        scan = await request_json(client, "POST", "/api/auth/scan")
        me = await request_json(client, "GET", "/api/auth/me")
        log("auth_scan", scan=scan, me=me)
        if not isinstance(me, dict) or not me.get("paygate_tier"):
            raise SmokeError("paygate tier unavailable")

        board_name = f"Real media smoke {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        board = await request_json(client, "POST", "/api/boards", json={"name": board_name})
        assert isinstance(board, dict)
        board_id = int(board["id"])
        log("board_created", board_id=board_id, name=board_name)

        try:
            if args.project_id:
                project_id = args.project_id
                log("project_ready", board_id=board_id, project_id=project_id, created=False, source="arg")
            else:
                project = await request_json(
                    client,
                    "POST",
                    f"/api/boards/{board_id}/project",
                    timeout=90.0,
                )
                assert isinstance(project, dict)
                project_id = str(project["flow_project_id"])
                log("project_ready", board_id=board_id, project_id=project_id, created=project.get("created"))

            image_node = await request_json(
                client,
                "POST",
                "/api/nodes",
                json={
                    "board_id": board_id,
                    "type": "image",
                    "x": 0,
                    "y": 0,
                    "data": {
                        "title": "Smoke first frame",
                        "prompt": IMAGE_PROMPT,
                        "aspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                    },
                    "status": "queued",
                },
            )
            assert isinstance(image_node, dict)
            image_node_id = int(image_node["id"])

            if args.start_media_id:
                image_request_id: int | None = None
                image_media_id = args.start_media_id
                log("image_reused", media_id=image_media_id, node_id=image_node_id)
            else:
                image_request = await request_json(
                    client,
                    "POST",
                    "/api/requests",
                    json={
                        "node_id": image_node_id,
                        "type": "gen_image",
                        "params": {
                            "prompt": IMAGE_PROMPT,
                            "project_id": project_id,
                            "aspect_ratio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                            "paygate_tier": me.get("paygate_tier"),
                            "variant_count": 1,
                            "image_model": args.image_model,
                            "low_priority": args.low_priority_image,
                        },
                    },
                )
                assert isinstance(image_request, dict)
                image_request_id = int(image_request["id"])
                log("request_created", kind="gen_image", request_id=image_request_id, node_id=image_node_id)
                image_row = await poll_request(
                    client,
                    image_request_id,
                    timeout_s=args.image_timeout,
                    interval_s=args.poll_interval,
                )
                if image_row.get("status") != "done":
                    raise SmokeError(f"gen_image ended {image_row.get('status')}: {image_row.get('error')}")
                image_media_id = first_media_id(image_row)
            await assert_media_available(client, image_media_id)
            await request_json(
                client,
                "PATCH",
                f"/api/nodes/{image_node_id}",
                json={
                    "status": "done",
                    "data": {
                        "mediaId": image_media_id,
                        "mediaIds": [image_media_id],
                        "renderedAt": datetime.now(timezone.utc).isoformat(),
                    },
                },
            )

            video_node = await request_json(
                client,
                "POST",
                "/api/nodes",
                json={
                    "board_id": board_id,
                    "type": "video",
                    "x": 320,
                    "y": 0,
                    "data": {
                        "title": "Smoke clip",
                        "prompt": VIDEO_PROMPT,
                        "workflowKind": "shot_clip",
                        "shotIndex": 1,
                        "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                    },
                    "status": "queued",
                },
            )
            assert isinstance(video_node, dict)
            video_node_id = int(video_node["id"])
            await request_json(
                client,
                "POST",
                "/api/edges",
                json={
                    "board_id": board_id,
                    "source_id": image_node_id,
                    "target_id": video_node_id,
                    "kind": "ref",
                    "ref_role": "first_frame",
                },
            )

            video_request = await request_json(
                client,
                "POST",
                "/api/requests",
                json={
                    "node_id": video_node_id,
                    "type": "gen_video",
                    "params": {
                        "prompt": VIDEO_PROMPT,
                        "project_id": project_id,
                        "start_media_id": image_media_id,
                        "aspect_ratio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                        "paygate_tier": me.get("paygate_tier"),
                        "audio_mode": "no_speech",
                        "video_quality": args.video_quality,
                        "low_priority": args.low_priority_video,
                    },
                },
            )
            assert isinstance(video_request, dict)
            video_request_id = int(video_request["id"])
            log("request_created", kind="gen_video", request_id=video_request_id, node_id=video_node_id)
            video_row = await poll_request(
                client,
                video_request_id,
                timeout_s=args.video_timeout,
                interval_s=args.poll_interval,
            )
            if video_row.get("status") != "done":
                raise SmokeError(f"gen_video ended {video_row.get('status')}: {video_row.get('error')}")
            video_media_id = first_media_id(video_row)
            await assert_media_available(client, video_media_id)
            await request_json(
                client,
                "PATCH",
                f"/api/nodes/{video_node_id}",
                json={
                    "status": "done",
                    "data": {
                        "mediaId": video_media_id,
                        "mediaIds": [video_media_id],
                        "slotErrors": [None],
                        "renderedAt": datetime.now(timezone.utc).isoformat(),
                        "videoAudioMode": "no_speech",
                    },
                },
            )

            timeline_node = await request_json(
                client,
                "POST",
                "/api/nodes",
                json={
                    "board_id": board_id,
                    "type": "note",
                    "x": 640,
                    "y": 0,
                    "data": {"title": "Smoke timeline", "workflowKind": "timeline"},
                    "status": "idle",
                },
            )
            assert isinstance(timeline_node, dict)
            timeline_node_id = int(timeline_node["id"])
            await request_json(
                client,
                "POST",
                "/api/edges",
                json={
                    "board_id": board_id,
                    "source_id": video_node_id,
                    "target_id": timeline_node_id,
                    "kind": "ref",
                    "ref_role": "storyboard_panel",
                },
            )
            export = await request_json(
                client,
                "POST",
                f"/api/exports/timelines/{timeline_node_id}",
                json={"width": args.export_width, "height": args.export_height},
                timeout=300.0,
            )
            assert isinstance(export, dict)
            export_media_id = str(export["media_id"])
            log("export_done", export=export)
            await assert_media_available(client, export_media_id)

            health_after = await request_json(client, "GET", "/api/health")
            log("health_after", health=health_after)
            result = {
                "board_id": board_id,
                "project_id": project_id,
                "image_node_id": image_node_id,
                "image_request_id": image_request_id,
                "image_media_id": image_media_id,
                "video_node_id": video_node_id,
                "video_request_id": video_request_id,
                "video_media_id": video_media_id,
                "timeline_node_id": timeline_node_id,
                "export_media_id": export_media_id,
                "export_url": export.get("url"),
                "kept_board": not args.cleanup,
            }
            if args.cleanup:
                await request_json(client, "DELETE", f"/api/boards/{board_id}")
                log("board_deleted", board_id=board_id)
            return result
        except Exception:
            if args.cleanup:
                await request_json(client, "DELETE", f"/api/boards/{board_id}")
                log("board_deleted_after_failure", board_id=board_id)
            raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8101")
    parser.add_argument("--project-id", help="reuse an existing Flow project id instead of creating one")
    parser.add_argument("--start-media-id", help="reuse an existing first-frame media id and skip gen_image")
    parser.add_argument("--image-timeout", type=float, default=240.0)
    parser.add_argument("--video-timeout", type=float, default=420.0)
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument("--image-model", default="NANO_BANANA_2")
    parser.add_argument("--low-priority-image", action="store_true")
    parser.add_argument("--low-priority-video", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--video-quality", default=None, choices=["lite", "fast", "quality", "lite_relaxed", "fast_relaxed"])
    parser.add_argument("--export-width", type=int, default=360)
    parser.add_argument("--export-height", type=int, default=640)
    parser.add_argument("--cleanup", action="store_true", help="delete smoke board after run")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = asyncio.run(run(args))
    except Exception as exc:  # noqa: BLE001
        log("smoke_failed", error=str(exc))
        return 1
    log("smoke_passed", result=result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
