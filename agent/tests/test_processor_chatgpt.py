"""Tests for the worker's `gen_chatgpt` handler.

Unlike Flow handlers, this one doesn't talk to Google Flow or care about
paygate tier. It mocks the extension bridge (`flow_client.chatgpt_request`)
and asserts the handler unpacks the response envelope correctly.

M1 scope: text-only. `asset_pointers` is preserved but not resolved into
media IDs yet — that lands in M2 via base64 download + ingest_inline_bytes.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flowboard.worker import processor as proc


@pytest.mark.asyncio
async def test_gen_chatgpt_returns_text_from_extension():
    """Happy path — extension returns `{text, asset_pointers, conversation_id}`
    inside the WS envelope's `data` field. Handler unpacks those into the
    request result so the frontend can stamp `responseText` on the node."""
    with patch.object(
        proc.flow_client,
        "chatgpt_request",
        new=AsyncMock(return_value={
            "status": 200,
            "data": {
                "text": "Một con mèo dễ thương đang ngồi…",
                "asset_pointers": [],
                "conversation_id": "abc-123",
            },
        }),
    ):
        result, err = await proc._handle_gen_chatgpt({
            "prompt": "mô tả con mèo",
        })

    assert err is None
    assert result["text"] == "Một con mèo dễ thương đang ngồi…"
    assert result["conversation_id"] == "abc-123"
    assert result["asset_pointers"] == []
    # M1 keeps media_ids empty so downstream nodes don't pick up bogus refs.
    assert result["media_ids"] == []


@pytest.mark.asyncio
async def test_gen_chatgpt_surfaces_asset_pointers_for_m2():
    """When the extension surfaces image asset pointers (M2), they pass
    through to the result. M1's handler doesn't resolve them but doesn't
    drop them either — UI shows them in the activity log."""
    with patch.object(
        proc.flow_client,
        "chatgpt_request",
        new=AsyncMock(return_value={
            "status": 200,
            "data": {
                "text": "Đây là ảnh:",
                "asset_pointers": [
                    "file-service://file-AAAA",
                    "file-service://file-BBBB",
                ],
                "conversation_id": "conv-1",
            },
        }),
    ):
        result, err = await proc._handle_gen_chatgpt({
            "prompt": "vẽ con mèo",
        })

    assert err is None
    assert len(result["asset_pointers"]) == 2
    assert result["asset_pointers"][0].startswith("file-service://")


@pytest.mark.asyncio
async def test_gen_chatgpt_missing_prompt_fails_loud():
    """No silent default — empty / missing prompt returns
    `missing_prompt` so the worker stamps the request as failed
    instead of dispatching an empty chat."""
    result, err = await proc._handle_gen_chatgpt({})
    assert err == "missing_prompt"

    result, err = await proc._handle_gen_chatgpt({"prompt": "   "})
    assert err == "missing_prompt"


@pytest.mark.asyncio
async def test_gen_chatgpt_propagates_extension_error():
    """When the extension surfaces an error (rate limit, auth fail, tab
    dead), the handler returns the raw envelope + truncated error string
    so the request row's error column has actionable text."""
    with patch.object(
        proc.flow_client,
        "chatgpt_request",
        new=AsyncMock(return_value={"error": "RATE_LIMITED"}),
    ):
        result, err = await proc._handle_gen_chatgpt({"prompt": "hi"})

    assert err == "RATE_LIMITED"
    assert result["error"] == "RATE_LIMITED"


@pytest.mark.asyncio
async def test_gen_chatgpt_passes_model_override():
    """When the caller stamps a model name, the SDK call receives it
    verbatim. Used by future Settings panel for explicit model pinning."""
    captured: dict = {}

    async def fake(prompt: str, model: str | None = None):
        captured["prompt"] = prompt
        captured["model"] = model
        return {"status": 200, "data": {"text": "ok", "asset_pointers": [], "conversation_id": None}}

    with patch.object(proc.flow_client, "chatgpt_request", new=fake):
        await proc._handle_gen_chatgpt({"prompt": "hi", "model": "gpt-image-2"})

    assert captured["model"] == "gpt-image-2"
    assert captured["prompt"] == "hi"


@pytest.mark.asyncio
async def test_gen_chatgpt_ingests_inline_image_bytes(tmp_path, monkeypatch):
    """When the extension returns `images: [{media_id, bytes_b64, mime}]`
    (M2 happy path), the handler base64-decodes, calls
    `media_service.ingest_inline_bytes`, and returns the populated
    `media_ids` so downstream Image/Video nodes can wire the asset."""
    import base64
    from flowboard.services import media as media_service

    captured: list[dict] = []

    def fake_ingest(media_id, data, *, kind, mime):
        captured.append({"media_id": media_id, "len": len(data), "kind": kind, "mime": mime})
        return True

    monkeypatch.setattr(media_service, "ingest_inline_bytes", fake_ingest)
    # processor.py imports the symbol at module load (`from flowboard.services
    # import media as media_service`), so we also need to patch the
    # processor's bound reference for the test to take effect.
    monkeypatch.setattr(proc.media_service, "ingest_inline_bytes", fake_ingest)

    img_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    img_b64 = base64.b64encode(img_bytes).decode("ascii")

    with patch.object(
        proc.flow_client,
        "chatgpt_request",
        new=AsyncMock(return_value={
            "status": 200,
            "data": {
                "text": "Here are the images:",
                "asset_pointers": ["file-service://file-AAAA", "file-service://file-BBBB"],
                "conversation_id": "conv-1",
                "images": [
                    {
                        "media_id": "11111111-1111-1111-1111-111111111111",
                        "bytes_b64": img_b64,
                        "mime": "image/webp",
                        "asset_pointer": "file-service://file-AAAA",
                    },
                    {
                        "media_id": "22222222-2222-2222-2222-222222222222",
                        "bytes_b64": img_b64,
                        "mime": "image/webp",
                        "asset_pointer": "file-service://file-BBBB",
                    },
                ],
            },
        }),
    ):
        result, err = await proc._handle_gen_chatgpt({"prompt": "draw a fox"})

    assert err is None
    assert result["media_ids"] == [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
    ]
    assert len(captured) == 2
    assert captured[0]["kind"] == "image"
    assert captured[0]["mime"] == "image/webp"
    assert captured[0]["len"] == len(img_bytes)


@pytest.mark.asyncio
async def test_gen_chatgpt_skips_failed_image_but_keeps_others(monkeypatch):
    """Per-image failure (expired CDN URL → extension stamps `error` on
    that record) must NOT drop the rest of the batch. The handler
    accumulates `image_errors` and still returns succeeded `media_ids`."""
    import base64

    monkeypatch.setattr(proc.media_service, "ingest_inline_bytes", lambda *a, **kw: True)

    img_b64 = base64.b64encode(b"valid bytes").decode("ascii")

    with patch.object(
        proc.flow_client,
        "chatgpt_request",
        new=AsyncMock(return_value={
            "status": 200,
            "data": {
                "text": "Partial result",
                "asset_pointers": ["file-service://file-OK", "file-service://file-BAD"],
                "conversation_id": "conv-1",
                "images": [
                    {
                        "media_id": "33333333-3333-3333-3333-333333333333",
                        "bytes_b64": img_b64,
                        "mime": "image/webp",
                        "asset_pointer": "file-service://file-OK",
                    },
                    {
                        "error": "CDN_403",
                        "asset_pointer": "file-service://file-BAD",
                    },
                ],
            },
        }),
    ):
        result, err = await proc._handle_gen_chatgpt({"prompt": "x"})

    assert err is None
    assert result["media_ids"] == ["33333333-3333-3333-3333-333333333333"]
    assert result["image_errors"] == ["CDN_403"]


@pytest.mark.asyncio
async def test_gen_chatgpt_drops_blank_model():
    """A blank / whitespace-only model string degrades to `None` so the
    extension uses ChatGPT's default routing (`auto`)."""
    captured: dict = {}

    async def fake(prompt: str, model: str | None = None):
        captured["model"] = model
        return {"status": 200, "data": {"text": "ok", "asset_pointers": [], "conversation_id": None}}

    with patch.object(proc.flow_client, "chatgpt_request", new=fake):
        await proc._handle_gen_chatgpt({"prompt": "hi", "model": "   "})

    assert captured["model"] is None
