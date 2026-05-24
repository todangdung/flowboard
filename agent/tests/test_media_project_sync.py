from __future__ import annotations

import pytest

from flowboard.services import media_project_sync


@pytest.mark.asyncio
async def test_sync_sniffs_cached_bytes_instead_of_extension(monkeypatch, tmp_path):
    """Flow-generated cache files can have a stale .png suffix while the
    bytes are JPEG. Uploading JPEG bytes as image/png makes Flow accept the
    request but return no media id, so sync must trust magic bytes first."""
    media_id = "11111111-2222-3333-4444-555555555555"
    cached = tmp_path / f"{media_id}.png"
    cached.write_bytes(b"\xff\xd8\xff\xe0" + b"jpeg payload bytes")
    captured: dict = {}

    class _FakeFlowSDK:
        async def upload_image(self, *, image_base64, mime_type, project_id, file_name):
            captured["mime_type"] = mime_type
            captured["project_id"] = project_id
            captured["file_name"] = file_name
            return {
                "raw": {"data": {"media": {"name": "synced-media-id"}}},
                "media_id": "synced-media-id",
            }

    monkeypatch.setattr(
        media_project_sync.media_service,
        "cached_path",
        lambda mid: cached if mid == media_id else None,
    )
    monkeypatch.setattr(
        media_project_sync,
        "get_flow_sdk",
        lambda: _FakeFlowSDK(),
    )

    out = await media_project_sync.ensure_media_in_project(media_id, "project-123")

    assert out == "synced-media-id"
    assert captured["mime_type"] == "image/jpeg"
    assert captured["file_name"].endswith(".jpg")
