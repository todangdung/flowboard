import shutil
import subprocess

import pytest

from flowboard.db import get_session
from flowboard.db.models import Board, Edge, Node
from flowboard.services import media as media_service


def _write_clip(media_id: str, color: str) -> None:
    path = media_service.MEDIA_CACHE_DIR / f"{media_id}.mp4"
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s=160x284:r=15",
            "-t",
            "0.25",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr[-500:]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_export_timeline_stitches_shot_clips(client):
    media_a = "aaaaaaaa-0000-4000-8000-000000000001"
    media_b = "bbbbbbbb-0000-4000-8000-000000000002"
    _write_clip(media_a, "red")
    _write_clip(media_b, "blue")

    with get_session() as s:
        board = Board(name="export")
        s.add(board)
        s.commit()
        s.refresh(board)
        clip_a = Node(
            board_id=board.id,
            short_id="clpa",
            type="video",
            data={
                "title": "Shot 1",
                "workflowKind": "shot_clip",
                "shotIndex": 1,
                "mediaId": media_a,
                "mediaIds": [media_a],
            },
            status="done",
        )
        clip_b = Node(
            board_id=board.id,
            short_id="clpb",
            type="video",
            data={
                "title": "Shot 2",
                "workflowKind": "shot_clip",
                "shotIndex": 2,
                "mediaId": media_b,
                "mediaIds": [media_b],
            },
            status="done",
        )
        timeline = Node(
            board_id=board.id,
            short_id="time",
            type="note",
            data={"title": "Timeline", "workflowKind": "timeline"},
            status="idle",
        )
        s.add_all([clip_a, clip_b, timeline])
        s.commit()
        for node in (clip_a, clip_b, timeline):
            s.refresh(node)
        s.add(
            Edge(
                board_id=board.id,
                source_id=clip_b.id,
                target_id=timeline.id,
                ref_role="storyboard_panel",
            )
        )
        s.add(
            Edge(
                board_id=board.id,
                source_id=clip_a.id,
                target_id=timeline.id,
                ref_role="storyboard_panel",
            )
        )
        s.commit()
        timeline_id = timeline.id

    response = client.post(
        f"/api/exports/timelines/{timeline_id}",
        json={"width": 180, "height": 320},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["clip_count"] == 2
    assert body["source_media_ids"] == [media_a, media_b]
    assert body["url"] == f"/media/{body['media_id']}"
    assert media_service.cached_path(body["media_id"]) is not None

    status = client.get(f"/api/media/{body['media_id']}/status")
    assert status.status_code == 200
    assert status.json()["available"] is True

    with get_session() as s:
        timeline = s.get(Node, timeline_id)
        assert timeline is not None
        assert timeline.status == "done"
        assert timeline.data["exportMediaId"] == body["media_id"]
        assert timeline.data["exportClipCount"] == 2
        assert timeline.data["exportStatus"] == "fresh"
        assert timeline.data["exportVersion"] == 1
        assert timeline.data["exportSourceMediaIds"] == [media_a, media_b]
        assert timeline.data["exportHistory"] == []
        assert isinstance(timeline.data["exportedAt"], str)
    assert body["export_status"] == "fresh"
    assert body["export_version"] == 1
    assert isinstance(body["exported_at"], str)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_export_timeline_uses_timeline_shot_order_and_metadata(client):
    media_a = "aaaaaaaa-0000-4000-8000-000000000101"
    media_b = "bbbbbbbb-0000-4000-8000-000000000102"
    _write_clip(media_a, "red")
    _write_clip(media_b, "blue")

    with get_session() as s:
        board = Board(name="export-order")
        s.add(board)
        s.commit()
        s.refresh(board)
        clip_a = Node(
            board_id=board.id,
            short_id="ord1",
            type="video",
            data={
                "title": "Shot 1",
                "workflowKind": "shot_clip",
                "shotId": "shot-1",
                "shotIndex": 1,
                "shotDurationSec": 4,
                "mediaId": media_a,
                "mediaIds": [media_a],
            },
            status="done",
        )
        clip_b = Node(
            board_id=board.id,
            short_id="ord2",
            type="video",
            data={
                "title": "Shot 2",
                "workflowKind": "shot_clip",
                "shotId": "shot-2",
                "shotIndex": 2,
                "shotDurationSec": 7,
                "mediaId": media_b,
                "mediaIds": [media_b],
            },
            status="done",
        )
        timeline = Node(
            board_id=board.id,
            short_id="time",
            type="note",
            data={
                "title": "Timeline",
                "workflowKind": "timeline",
                "timelineShotIds": ["shot-2", "shot-1"],
                "timelineCaptions": {
                    "shot-1": "First caption",
                    "shot-2": "Second caption",
                },
            },
            status="idle",
        )
        s.add_all([clip_a, clip_b, timeline])
        s.commit()
        for node in (clip_a, clip_b, timeline):
            s.refresh(node)
        for clip in (clip_a, clip_b):
            s.add(
                Edge(
                    board_id=board.id,
                    source_id=clip.id,
                    target_id=timeline.id,
                    ref_role="storyboard_panel",
                )
            )
        s.commit()
        timeline_id = timeline.id

    response = client.post(
        f"/api/exports/timelines/{timeline_id}",
        json={"width": 180, "height": 320},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source_media_ids"] == [media_b, media_a]
    assert body["source_shot_ids"] == ["shot-2", "shot-1"]
    assert body["clip_durations_sec"] == [7, 4]
    assert body["clip_captions"] == ["Second caption", "First caption"]

    with get_session() as s:
        timeline = s.get(Node, timeline_id)
        assert timeline is not None
        assert timeline.data["exportSourceMediaIds"] == [media_b, media_a]
        assert timeline.data["exportShotIds"] == ["shot-2", "shot-1"]
        assert timeline.data["exportDurationsSec"] == [7, 4]
        assert timeline.data["exportCaptions"] == ["Second caption", "First caption"]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_export_timeline_prefers_active_best_variant(client):
    media_a = "aaaaaaaa-0000-4000-8000-000000000101"
    media_b = "bbbbbbbb-0000-4000-8000-000000000102"
    _write_clip(media_a, "red")
    _write_clip(media_b, "blue")

    with get_session() as s:
        board = Board(name="export-best")
        s.add(board)
        s.commit()
        s.refresh(board)
        clip = Node(
            board_id=board.id,
            short_id="clip",
            type="video",
            data={
                "title": "Shot 1",
                "workflowKind": "shot_clip",
                "shotIndex": 1,
                "mediaId": media_b,
                "mediaIds": [media_a, media_b],
                "bestMediaId": media_b,
                "bestVariantIdx": 1,
                "reviewVerdict": "good",
            },
            status="done",
        )
        timeline = Node(
            board_id=board.id,
            short_id="time",
            type="note",
            data={"title": "Timeline", "workflowKind": "timeline"},
            status="idle",
        )
        s.add_all([clip, timeline])
        s.commit()
        s.refresh(clip)
        s.refresh(timeline)
        s.add(
            Edge(
                board_id=board.id,
                source_id=clip.id,
                target_id=timeline.id,
                ref_role="storyboard_panel",
            )
        )
        s.commit()
        timeline_id = timeline.id

    response = client.post(
        f"/api/exports/timelines/{timeline_id}",
        json={"width": 180, "height": 320},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["clip_count"] == 1
    assert body["source_media_ids"] == [media_b]
    assert media_service.cached_path(body["media_id"]) is not None


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_export_timeline_blocks_redo_clip(client):
    media_a = "aaaaaaaa-0000-4000-8000-000000000201"
    _write_clip(media_a, "red")

    with get_session() as s:
        board = Board(name="export-redo")
        s.add(board)
        s.commit()
        s.refresh(board)
        clip = Node(
            board_id=board.id,
            short_id="clip",
            type="video",
            data={
                "title": "Shot 1",
                "workflowKind": "shot_clip",
                "shotIndex": 1,
                "mediaId": media_a,
                "mediaIds": [media_a],
                "reviewVerdict": "redo",
                "reviewNote": "subject drifted",
            },
            status="done",
        )
        timeline = Node(
            board_id=board.id,
            short_id="time",
            type="note",
            data={"title": "Timeline", "workflowKind": "timeline"},
            status="idle",
        )
        s.add_all([clip, timeline])
        s.commit()
        s.refresh(clip)
        s.refresh(timeline)
        s.add(
            Edge(
                board_id=board.id,
                source_id=clip.id,
                target_id=timeline.id,
                ref_role="storyboard_panel",
            )
        )
        s.commit()
        timeline_id = timeline.id

    response = client.post(
        f"/api/exports/timelines/{timeline_id}",
        json={"width": 180, "height": 320},
    )
    assert response.status_code == 400
    assert "shot_1_needs_redo" in response.text


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_export_timeline_skips_review_skipped_clip(client):
    media_a = "aaaaaaaa-0000-4000-8000-000000000301"
    media_b = "bbbbbbbb-0000-4000-8000-000000000302"
    _write_clip(media_a, "red")
    _write_clip(media_b, "blue")

    with get_session() as s:
        board = Board(name="export-skip")
        s.add(board)
        s.commit()
        s.refresh(board)
        skipped = Node(
            board_id=board.id,
            short_id="skp1",
            type="video",
            data={
                "title": "Shot 1",
                "workflowKind": "shot_clip",
                "shotIndex": 1,
                "mediaId": media_a,
                "mediaIds": [media_a],
                "reviewVerdict": "skip",
            },
            status="done",
        )
        kept = Node(
            board_id=board.id,
            short_id="kep2",
            type="video",
            data={
                "title": "Shot 2",
                "workflowKind": "shot_clip",
                "shotIndex": 2,
                "mediaId": media_b,
                "mediaIds": [media_b],
                "reviewVerdict": "good",
            },
            status="done",
        )
        timeline = Node(
            board_id=board.id,
            short_id="time",
            type="note",
            data={"title": "Timeline", "workflowKind": "timeline"},
            status="idle",
        )
        s.add_all([skipped, kept, timeline])
        s.commit()
        for node in (skipped, kept, timeline):
            s.refresh(node)
        for clip in (skipped, kept):
            s.add(
                Edge(
                    board_id=board.id,
                    source_id=clip.id,
                    target_id=timeline.id,
                    ref_role="storyboard_panel",
                )
            )
        s.commit()
        timeline_id = timeline.id

    response = client.post(
        f"/api/exports/timelines/{timeline_id}",
        json={"width": 180, "height": 320},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["clip_count"] == 1
    assert body["source_media_ids"] == [media_b]

    with get_session() as s:
        timeline = s.get(Node, timeline_id)
        assert timeline is not None
        assert timeline.data["exportClipCount"] == 1


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_export_timeline_skips_no_media_review_skipped_clip(client):
    media_b = "bbbbbbbb-0000-4000-8000-000000000312"
    _write_clip(media_b, "blue")

    with get_session() as s:
        board = Board(name="export-skip-no-media")
        s.add(board)
        s.commit()
        s.refresh(board)
        skipped = Node(
            board_id=board.id,
            short_id="skp0",
            type="video",
            data={
                "title": "Shot 1",
                "workflowKind": "shot_clip",
                "shotIndex": 1,
                "reviewVerdict": "skip",
                "slotErrors": ["PUBLIC_ERROR_UNSAFE_GENERATION"],
            },
            status="error",
        )
        kept = Node(
            board_id=board.id,
            short_id="kep2",
            type="video",
            data={
                "title": "Shot 2",
                "workflowKind": "shot_clip",
                "shotIndex": 2,
                "mediaId": media_b,
                "mediaIds": [media_b],
            },
            status="done",
        )
        timeline = Node(
            board_id=board.id,
            short_id="time",
            type="note",
            data={"title": "Timeline", "workflowKind": "timeline"},
            status="idle",
        )
        s.add_all([skipped, kept, timeline])
        s.commit()
        for node in (skipped, kept, timeline):
            s.refresh(node)
        for clip in (skipped, kept):
            s.add(
                Edge(
                    board_id=board.id,
                    source_id=clip.id,
                    target_id=timeline.id,
                    ref_role="storyboard_panel",
                )
            )
        s.commit()
        timeline_id = timeline.id

    response = client.post(
        f"/api/exports/timelines/{timeline_id}",
        json={"width": 180, "height": 320},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["clip_count"] == 1
    assert body["source_media_ids"] == [media_b]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_reexport_supersedes_stale_export_and_keeps_history(client):
    old_export = "dddddddd-0000-4000-8000-000000000401"
    media_a = "aaaaaaaa-0000-4000-8000-000000000402"
    _write_clip(media_a, "red")

    with get_session() as s:
        board = Board(name="export-reexport")
        s.add(board)
        s.commit()
        s.refresh(board)
        clip = Node(
            board_id=board.id,
            short_id="clip",
            type="video",
            data={
                "title": "Shot 1",
                "workflowKind": "shot_clip",
                "shotIndex": 1,
                "mediaId": media_a,
                "mediaIds": [media_a],
                "reviewVerdict": "good",
            },
            status="done",
        )
        timeline = Node(
            board_id=board.id,
            short_id="time",
            type="note",
            data={
                "title": "Timeline",
                "workflowKind": "timeline",
                "exportMediaId": old_export,
                "exportedAt": "2026-05-25T00:00:00+00:00",
                "exportClipCount": 1,
                "exportSize": "1080x1920",
                "exportStatus": "stale",
                "exportVersion": 3,
                "exportSourceMediaIds": ["old-source"],
                "exportStaleAt": "2026-05-25T00:05:00+00:00",
                "exportStaleReason": "review_changed",
            },
            status="idle",
        )
        s.add_all([clip, timeline])
        s.commit()
        s.refresh(clip)
        s.refresh(timeline)
        s.add(
            Edge(
                board_id=board.id,
                source_id=clip.id,
                target_id=timeline.id,
                ref_role="storyboard_panel",
            )
        )
        s.commit()
        timeline_id = timeline.id

    response = client.post(
        f"/api/exports/timelines/{timeline_id}",
        json={"width": 180, "height": 320},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["media_id"] != old_export
    assert body["export_status"] == "fresh"
    assert body["export_version"] == 4
    assert body["source_media_ids"] == [media_a]

    with get_session() as s:
        timeline = s.get(Node, timeline_id)
        assert timeline is not None
        assert timeline.status == "done"
        assert timeline.data["exportMediaId"] == body["media_id"]
        assert timeline.data["exportStatus"] == "fresh"
        assert timeline.data["exportVersion"] == 4
        assert timeline.data["exportSourceMediaIds"] == [media_a]
        assert "exportStaleAt" not in timeline.data
        assert "exportStaleReason" not in timeline.data
        assert timeline.data["exportHistory"][-1] == {
            "mediaId": old_export,
            "status": "stale",
            "version": 3,
            "exportedAt": "2026-05-25T00:00:00+00:00",
            "clipCount": 1,
            "size": "1080x1920",
            "sourceMediaIds": ["old-source"],
            "staleAt": "2026-05-25T00:05:00+00:00",
            "staleReason": "review_changed",
        }


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg required")
def test_export_timeline_uses_rewired_redo_clone(client):
    media_a = "aaaaaaaa-0000-4000-8000-000000000321"
    media_b = "bbbbbbbb-0000-4000-8000-000000000322"
    _write_clip(media_a, "red")
    _write_clip(media_b, "blue")

    with get_session() as s:
        board = Board(name="export-redo-rewired")
        s.add(board)
        s.commit()
        s.refresh(board)
        original = Node(
            board_id=board.id,
            short_id="old1",
            type="video",
            data={
                "title": "Shot 1",
                "workflowKind": "shot_clip",
                "shotId": "shot-1",
                "shotIndex": 1,
                "shotDurationSec": 5,
                "mediaId": media_a,
                "mediaIds": [media_a],
                "reviewVerdict": "redo",
                "reviewNote": "logo drifted",
            },
            status="done",
        )
        redo = Node(
            board_id=board.id,
            short_id="new1",
            type="video",
            data={
                "title": "Shot 1 (redo)",
                "workflowKind": "shot_clip",
                "shotId": "shot-1",
                "shotIndex": 1,
                "shotDurationSec": 5,
                "mediaId": media_b,
                "mediaIds": [media_b],
            },
            status="done",
        )
        timeline = Node(
            board_id=board.id,
            short_id="time",
            type="note",
            data={"title": "Timeline", "workflowKind": "timeline"},
            status="idle",
        )
        s.add_all([original, redo, timeline])
        s.commit()
        for node in (original, redo, timeline):
            s.refresh(node)
        s.add(
            Edge(
                board_id=board.id,
                source_id=redo.id,
                target_id=timeline.id,
                ref_role="storyboard_panel",
            )
        )
        s.commit()
        timeline_id = timeline.id

    response = client.post(
        f"/api/exports/timelines/{timeline_id}",
        json={"width": 180, "height": 320},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["clip_count"] == 1
    assert body["source_media_ids"] == [media_b]


def test_export_timeline_requires_clip_media(client):
    with get_session() as s:
        board = Board(name="export-missing")
        s.add(board)
        s.commit()
        s.refresh(board)
        clip = Node(
            board_id=board.id,
            short_id="clip",
            type="video",
            data={"workflowKind": "shot_clip", "shotIndex": 1},
            status="idle",
        )
        timeline = Node(
            board_id=board.id,
            short_id="time",
            type="note",
            data={"workflowKind": "timeline"},
            status="idle",
        )
        s.add_all([clip, timeline])
        s.commit()
        s.refresh(clip)
        s.refresh(timeline)
        s.add(
            Edge(
                board_id=board.id,
                source_id=clip.id,
                target_id=timeline.id,
                ref_role="storyboard_panel",
            )
        )
        s.commit()
        timeline_id = timeline.id

    response = client.post(f"/api/exports/timelines/{timeline_id}", json={})
    assert response.status_code == 400
    assert "has_no_media" in response.text
