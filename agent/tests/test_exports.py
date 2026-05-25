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
