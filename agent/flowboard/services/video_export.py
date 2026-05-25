"""Timeline video export helpers."""
from __future__ import annotations

from datetime import datetime, timezone
import logging
from pathlib import Path
import shutil
import subprocess
import uuid

from sqlmodel import select

from flowboard.config import STORAGE_DIR
from flowboard.db import get_session
from flowboard.db.models import Asset, Edge, Node
from flowboard.services import media as media_service

logger = logging.getLogger(__name__)

EXPORT_DIR = STORAGE_DIR / "exports"
EXPORT_DIR.mkdir(parents=True, exist_ok=True)


class VideoExportError(RuntimeError):
    pass


def _run_ffmpeg(cmd: list[str], *, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "")[-800:]
        raise VideoExportError(tail or f"command failed: {cmd[0]}")
    return result


def _ffprobe_text(args: list[str]) -> str:
    result = subprocess.run(
        ["ffprobe", "-v", "error", *args],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def _duration_sec(path: Path) -> float:
    out = _ffprobe_text(
        [
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    try:
        return max(0.1, float(out))
    except (TypeError, ValueError):
        return 1.0


def _has_audio(path: Path) -> bool:
    out = _ffprobe_text(
        [
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            str(path),
        ]
    )
    return bool(out)


def _concat_line(path: Path) -> str:
    escaped = str(path).replace("'", "'\\''")
    return f"file '{escaped}'\n"


async def _resolve_media_path(media_id: str) -> Path:
    cached = media_service.cached_path(media_id)
    if cached is not None and cached.is_file():
        return cached
    fetched = await media_service.fetch_and_cache(media_id)
    if fetched is None:
        raise VideoExportError(f"media_not_available:{media_id}")
    _bytes, _mime, path = fetched
    return path


def _timeline_clips(timeline_node_id: int) -> tuple[Node, list[Node]]:
    with get_session() as s:
        timeline = s.get(Node, timeline_node_id)
        if timeline is None:
            raise VideoExportError("timeline_not_found")
        if (timeline.data or {}).get("workflowKind") != "timeline":
            raise VideoExportError("node_is_not_timeline")
        edges = s.exec(
            select(Edge)
            .where(Edge.target_id == timeline_node_id)
            .where(Edge.ref_role == "storyboard_panel")
            .order_by(Edge.id)
        ).all()
        clips: list[Node] = []
        for edge in edges:
            node = s.get(Node, edge.source_id)
            if node is not None and (node.data or {}).get("workflowKind") == "shot_clip":
                clips.append(node)
        clips.sort(key=lambda node: int((node.data or {}).get("shotIndex") or 0))
        return timeline, clips


def _first_clip_media_id(node: Node) -> str:
    data = node.data or {}
    media_id = data.get("mediaId")
    if isinstance(media_id, str) and media_id:
        return media_id
    media_ids = data.get("mediaIds")
    if isinstance(media_ids, list):
        for item in media_ids:
            if isinstance(item, str) and item:
                return item
    raise VideoExportError(f"shot_{data.get('shotIndex') or node.id}_has_no_media")


def _exportable_clips(clips: list[Node]) -> list[Node]:
    out: list[Node] = []
    for clip in clips:
        data = clip.data or {}
        verdict = data.get("reviewVerdict")
        shot = data.get("shotIndex") or clip.id
        if verdict == "redo":
            raise VideoExportError(f"shot_{shot}_needs_redo")
        if verdict == "skip":
            continue
        out.append(clip)
    if not out:
        raise VideoExportError("timeline_has_no_exportable_clips")
    return out


def _normalise_clip(
    source: Path,
    target: Path,
    *,
    width: int,
    height: int,
) -> None:
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
        "setsar=1,fps=30,format=yuv420p"
    )
    base = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
    ]
    if _has_audio(source):
        cmd = [
            *base,
            "-vf",
            vf,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
        ]
    else:
        cmd = [
            *base,
            "-f",
            "lavfi",
            "-t",
            f"{_duration_sec(source):.3f}",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-filter_complex",
            f"[0:v:0]{vf}[v]",
            "-map",
            "[v]",
            "-map",
            "1:a:0",
            "-shortest",
        ]
    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            str(target),
        ]
    )
    _run_ffmpeg(cmd)


def _register_export(media_id: str, path: Path) -> None:
    with get_session() as s:
        row = s.exec(select(Asset).where(Asset.uuid_media_id == media_id)).first()
        if row is None:
            row = Asset(uuid_media_id=media_id, kind="video")
        row.local_path = str(path)
        row.mime = "video/mp4"
        row.kind = "video"
        s.add(row)
        s.commit()


def _stamp_timeline(
    timeline_node_id: int,
    *,
    media_id: str,
    clip_count: int,
    width: int,
    height: int,
) -> None:
    with get_session() as s:
        node = s.get(Node, timeline_node_id)
        if node is None:
            return
        data = dict(node.data or {})
        data.update(
            {
                "exportMediaId": media_id,
                "exportedAt": datetime.now(timezone.utc).isoformat(),
                "exportClipCount": clip_count,
                "exportSize": f"{width}x{height}",
            }
        )
        node.data = data
        node.status = "done"
        s.add(node)
        s.commit()


async def export_timeline(
    timeline_node_id: int,
    *,
    width: int = 1080,
    height: int = 1920,
) -> dict:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise VideoExportError("ffmpeg_not_found")
    if width < 64 or height < 64 or width > 4096 or height > 4096:
        raise VideoExportError("invalid_export_size")
    timeline, clips = _timeline_clips(timeline_node_id)
    if not clips:
        raise VideoExportError("timeline_has_no_clips")
    export_clips = _exportable_clips(clips)

    work_dir = EXPORT_DIR / f"timeline-{timeline_node_id}-{uuid.uuid4().hex[:8]}"
    work_dir.mkdir(parents=True, exist_ok=True)
    normalised: list[Path] = []
    media_ids: list[str] = []
    try:
        for index, clip in enumerate(export_clips, start=1):
            media_id = _first_clip_media_id(clip)
            media_ids.append(media_id)
            source = await _resolve_media_path(media_id)
            target = work_dir / f"{index:03d}.mp4"
            _normalise_clip(source, target, width=width, height=height)
            normalised.append(target)

        concat_file = work_dir / "concat.txt"
        concat_file.write_text("".join(_concat_line(path) for path in normalised))
        export_media_id = str(uuid.uuid4())
        output_path = media_service.MEDIA_CACHE_DIR / f"{export_media_id}.mp4"
        _run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_file),
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(output_path),
            ],
            timeout=240,
        )
        _register_export(export_media_id, output_path)
        _stamp_timeline(
            timeline.id,  # type: ignore[arg-type]
            media_id=export_media_id,
            clip_count=len(export_clips),
            width=width,
            height=height,
        )
        return {
            "timeline_node_id": timeline_node_id,
            "media_id": export_media_id,
            "url": f"/media/{export_media_id}",
            "clip_count": len(export_clips),
            "source_media_ids": media_ids,
            "width": width,
            "height": height,
        }
    except subprocess.TimeoutExpired as exc:
        raise VideoExportError("ffmpeg_timeout") from exc
    finally:
        for path in normalised:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            (work_dir / "concat.txt").unlink(missing_ok=True)
            work_dir.rmdir()
        except OSError:
            logger.debug("export work dir retained: %s", work_dir)
