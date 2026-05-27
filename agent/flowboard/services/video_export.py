"""Timeline video export helpers."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import logging
from pathlib import Path
import re
import shutil
import subprocess
import textwrap
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


@dataclass(frozen=True)
class TimelineAudioOptions:
    mode: str = "none"
    voiceover_media_id: str | None = None
    music_media_id: str | None = None
    voiceover_volume: float = 1.0
    music_volume: float = 0.25


@dataclass(frozen=True)
class TimelineAudioPaths:
    voiceover: Path | None = None
    music: Path | None = None


@dataclass(frozen=True)
class TimelineClipEdit:
    shot_id: str
    trim_start_sec: float = 0.0
    trim_end_sec: float = 0.0


@dataclass(frozen=True)
class TimelineTransition:
    from_shot_id: str
    to_shot_id: str
    type: str = "cut"
    duration_sec: float = 0.0


_BLACK_DURATION_RE = re.compile(r"black_duration:(?P<duration>[0-9.]+)")
_FREEZE_DURATION_RE = re.compile(r"freeze_duration:\s*(?P<duration>[0-9.]+)")


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


def _video_dimensions(path: Path) -> tuple[int, int] | None:
    out = _ffprobe_text(
        [
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            str(path),
        ]
    )
    first = out.splitlines()[0] if out else ""
    parts = first.split("x")
    if len(parts) != 2:
        return None
    try:
        width = int(parts[0])
        height = int(parts[1])
    except ValueError:
        return None
    if width <= 0 or height <= 0:
        return None
    return width, height


def _ffmpeg_diagnostic_stderr(args: list[str]) -> str:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-v", "info", *args],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result.stderr or result.stdout or ""


def _black_duration(path: Path) -> float:
    try:
        stderr = _ffmpeg_diagnostic_stderr(
            ["-i", str(path), "-vf", "blackdetect=d=0.2:pix_th=0.98", "-an", "-f", "null", "-"]
        )
    except (subprocess.TimeoutExpired, OSError):
        return 0.0
    return sum(float(match.group("duration")) for match in _BLACK_DURATION_RE.finditer(stderr))


def _freeze_duration(path: Path) -> float:
    try:
        stderr = _ffmpeg_diagnostic_stderr(
            ["-i", str(path), "-vf", "freezedetect=n=-60dB:d=0.5", "-an", "-f", "null", "-"]
        )
    except (subprocess.TimeoutExpired, OSError):
        return 0.0
    return sum(float(match.group("duration")) for match in _FREEZE_DURATION_RE.finditer(stderr))


def _concat_line(path: Path) -> str:
    escaped = str(path).replace("'", "'\\''")
    return f"file '{escaped}'\n"


def _filter_arg(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


async def _resolve_media_path(media_id: str) -> Path:
    cached = media_service.cached_path(media_id)
    if cached is not None and cached.is_file():
        return cached
    fetched = await media_service.fetch_and_cache(media_id)
    if fetched is None:
        raise VideoExportError(f"media_not_available:{media_id}")
    _bytes, _mime, path = fetched
    return path


def _timeline_order(data: dict) -> list[str]:
    raw = data.get("timelineShotIds")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, str) and item]


def _sort_timeline_clips(timeline: Node, clips: list[Node]) -> list[Node]:
    order = _timeline_order(timeline.data or {})
    order_index = {shot_id: index for index, shot_id in enumerate(order)}

    def key(node: Node) -> tuple[int, int, int]:
        data = node.data or {}
        shot_id = data.get("shotId")
        if isinstance(shot_id, str) and shot_id in order_index:
            return (0, order_index[shot_id], node.id or 0)
        shot_index = data.get("shotIndex")
        if isinstance(shot_index, int):
            return (1, shot_index, node.id or 0)
        return (2, node.id or 0, node.id or 0)

    return sorted(clips, key=key)


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
        return timeline, _sort_timeline_clips(timeline, clips)


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


def _clip_shot_id(node: Node) -> str:
    data = node.data or {}
    shot_id = data.get("shotId")
    if isinstance(shot_id, str) and shot_id:
        return shot_id
    shot_index = data.get("shotIndex")
    if isinstance(shot_index, int):
        return f"shot_{shot_index:02d}"
    return str(node.id)


def _clip_duration(node: Node) -> int | None:
    data = node.data or {}
    for key in ("shotDurationSec", "videoDurationSec"):
        value = data.get(key)
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, float) and value > 0:
            return int(round(value))
    return None


def _node_id(node: Node) -> int | None:
    return node.id if isinstance(node.id, int) else None


def _qa_issue(severity: str, code: str, message: str) -> dict[str, str]:
    return {"severity": severity, "code": code, "message": message}


def _qa_status(issues: list[dict[str, str]]) -> str:
    if any(issue.get("severity") == "blocked" for issue in issues):
        return "blocked"
    if any(issue.get("severity") == "warning" for issue in issues):
        return "warning"
    return "ok"


def _timeline_qa_summary(items: list[dict]) -> dict[str, int]:
    return {
        "ok": sum(1 for item in items if item.get("status") == "ok"),
        "warning": sum(1 for item in items if item.get("status") == "warning"),
        "blocked": sum(1 for item in items if item.get("status") == "blocked"),
    }


def _expected_ratio(
    timeline_data: dict,
    clip_data: dict,
    *,
    expected_width: int | None,
    expected_height: int | None,
) -> float | None:
    if expected_width and expected_height and expected_width > 0 and expected_height > 0:
        return expected_width / expected_height
    export_width = timeline_data.get("exportWidth")
    export_height = timeline_data.get("exportHeight")
    if isinstance(export_width, (int, float)) and isinstance(export_height, (int, float)) and export_height > 0:
        return float(export_width) / float(export_height)
    aspect = clip_data.get("aspectRatio")
    if isinstance(aspect, str):
        if "SQUARE" in aspect:
            return 1.0
        if "LANDSCAPE" in aspect:
            return 16 / 9
        if "PORTRAIT" in aspect:
            return 9 / 16
    return None


def _clip_audio_expected(clip_data: dict) -> bool:
    return clip_data.get("videoAudioMode") in {"music", "sfx", "ambient", "speech"}


def _qa_clip_item(
    timeline: Node,
    clip: Node,
    *,
    expected_width: int | None,
    expected_height: int | None,
) -> dict:
    data = clip.data or {}
    timeline_data = timeline.data or {}
    shot_id = _clip_shot_id(clip)
    planned_duration = _clip_duration(clip)
    issues: list[dict[str, str]] = []
    metrics: dict[str, float | int | bool | None] = {
        "plannedDurationSec": planned_duration,
    }

    if data.get("reviewVerdict") == "redo":
        issues.append(_qa_issue("blocked", "needs_redo", "Clip marked redo blocks export."))

    try:
        media_id = _first_clip_media_id(clip)
    except VideoExportError:
        media_id = None
        issues.append(_qa_issue("blocked", "no_media", "Shot has no rendered media."))

    path: Path | None = None
    if media_id:
        cached = media_service.cached_path(media_id)
        if cached is not None and cached.is_file():
            path = cached
        else:
            issues.append(_qa_issue("blocked", "media_not_available", "Media file is not cached locally."))

    if path is not None:
        duration = _duration_sec(path)
        dimensions = _video_dimensions(path)
        has_audio = _has_audio(path)
        metrics.update(
            {
                "durationSec": round(duration, 3),
                "hasAudio": has_audio,
            }
        )
        if dimensions is None:
            issues.append(_qa_issue("blocked", "invalid_video", "No readable video stream found."))
        else:
            width, height = dimensions
            metrics.update({"width": width, "height": height})
            expected = _expected_ratio(
                timeline_data,
                data,
                expected_width=expected_width,
                expected_height=expected_height,
            )
            if expected is not None:
                actual = width / height
                metrics["aspectRatio"] = round(actual, 4)
                metrics["expectedAspectRatio"] = round(expected, 4)
                if abs(actual - expected) > 0.08:
                    issues.append(
                        _qa_issue(
                            "warning",
                            "aspect_mismatch",
                            f"Clip aspect {actual:.2f} differs from target {expected:.2f}.",
                        )
                    )
        if duration < 0.4:
            issues.append(_qa_issue("blocked", "too_short", "Clip is shorter than 0.4s."))
        elif planned_duration is not None:
            tolerance = max(0.75, planned_duration * 0.25)
            if abs(duration - planned_duration) > tolerance:
                issues.append(
                    _qa_issue(
                        "warning",
                        "duration_mismatch",
                        f"Clip duration {duration:.2f}s differs from planned {planned_duration}s.",
                    )
                )
        if _clip_audio_expected(data) and not has_audio:
            issues.append(_qa_issue("warning", "missing_expected_audio", "Clip requested audio but has no audio stream."))
        black = _black_duration(path)
        metrics["blackDurationSec"] = round(black, 3)
        if black >= max(0.4, duration * 0.8):
            issues.append(_qa_issue("warning", "black_frames", "Most frames are black."))
        frozen = _freeze_duration(path)
        metrics["frozenDurationSec"] = round(frozen, 3)
        if duration >= 1.5 and frozen >= duration * 0.8:
            issues.append(_qa_issue("warning", "frozen_frames", "Most frames appear frozen."))

    status = _qa_status(issues)
    return {
        "shotId": shot_id,
        "nodeId": _node_id(clip),
        "mediaId": media_id,
        "status": status,
        "issues": issues,
        "metrics": metrics,
    }


def _stamp_timeline_qa(
    timeline_node_id: int,
    *,
    checked_at: str,
    status: str,
    summary: dict[str, int],
    items: list[dict],
) -> None:
    with get_session() as s:
        node = s.get(Node, timeline_node_id)
        if node is None:
            return
        data = dict(node.data or {})
        data.update(
            {
                "timelineQaCheckedAt": checked_at,
                "timelineQaStatus": status,
                "timelineQaSummary": summary,
                "timelineQaItems": items,
            }
        )
        node.data = data
        s.add(node)
        s.commit()


def _clean_trim_seconds(value: object, field: str, shot_id: str) -> float:
    if value is None:
        return 0.0
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise VideoExportError(f"invalid_{field}:{shot_id}") from exc
    if seconds < 0 or seconds > 600:
        raise VideoExportError(f"invalid_{field}:{shot_id}")
    return round(seconds, 3)


def _clip_edit_entry(raw: object) -> TimelineClipEdit | None:
    if not isinstance(raw, dict):
        return None
    shot_id = raw.get("shot_id") or raw.get("shotId")
    if not isinstance(shot_id, str) or not shot_id.strip():
        return None
    shot_id = shot_id.strip()
    trim_start = _clean_trim_seconds(
        raw.get("trim_start_sec", raw.get("trimStartSec")),
        "trim_start_sec",
        shot_id,
    )
    trim_end = _clean_trim_seconds(
        raw.get("trim_end_sec", raw.get("trimEndSec")),
        "trim_end_sec",
        shot_id,
    )
    if trim_start <= 0 and trim_end <= 0:
        return None
    return TimelineClipEdit(
        shot_id=shot_id,
        trim_start_sec=trim_start,
        trim_end_sec=trim_end,
    )


def _timeline_stored_clip_edits(data: dict) -> list[dict]:
    raw = data.get("timelineClipEdits")
    if not isinstance(raw, dict):
        return []
    out: list[dict] = []
    for shot_id, edit in raw.items():
        if not isinstance(shot_id, str) or not isinstance(edit, dict):
            continue
        out.append({"shot_id": shot_id, **edit})
    return out


def _resolve_clip_edits(
    timeline: Node,
    raw_clip_edits: list[dict] | None,
) -> dict[str, TimelineClipEdit]:
    raw_entries = raw_clip_edits if raw_clip_edits else _timeline_stored_clip_edits(timeline.data or {})
    out: dict[str, TimelineClipEdit] = {}
    for raw in raw_entries:
        entry = _clip_edit_entry(raw)
        if entry is not None:
            out[entry.shot_id] = entry
    return out


def _clip_edit_dict(edit: TimelineClipEdit) -> dict[str, float | str]:
    return {
        "shotId": edit.shot_id,
        "trimStartSec": edit.trim_start_sec,
        "trimEndSec": edit.trim_end_sec,
    }


def _clip_edit_export_list(
    edits: dict[str, TimelineClipEdit],
    shot_ids: list[str],
) -> list[dict[str, float | str]]:
    return [_clip_edit_dict(edits[shot_id]) for shot_id in shot_ids if shot_id in edits]


def _timeline_stored_transitions(data: dict, shot_ids: list[str]) -> list[dict]:
    raw = data.get("timelineTransitions")
    if not isinstance(raw, dict):
        return []
    out: list[dict] = []
    adjacent = {shot_ids[index]: shot_ids[index + 1] for index in range(len(shot_ids) - 1)}
    for from_shot_id, to_shot_id in adjacent.items():
        transition = raw.get(from_shot_id)
        if not isinstance(transition, dict):
            continue
        out.append({"from_shot_id": from_shot_id, "to_shot_id": to_shot_id, **transition})
    return out


def _clean_transition_duration(
    value: object,
    transition_type: str,
    from_shot_id: str,
    to_shot_id: str,
) -> float:
    if transition_type == "cut":
        return 0.0
    if value is None:
        return 0.5
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise VideoExportError(f"invalid_transition_duration:{from_shot_id}:{to_shot_id}") from exc
    if seconds < 0.05 or seconds > 5:
        raise VideoExportError(f"invalid_transition_duration:{from_shot_id}:{to_shot_id}")
    return round(seconds, 3)


def _transition_entry(
    raw: object,
    adjacent: dict[str, str],
    effective_durations: dict[str, float],
    *,
    strict: bool,
) -> TimelineTransition | None:
    if not isinstance(raw, dict):
        return None
    from_shot_id = raw.get("from_shot_id") or raw.get("fromShotId")
    to_shot_id = raw.get("to_shot_id") or raw.get("toShotId")
    if not isinstance(from_shot_id, str) or not from_shot_id.strip():
        if strict:
            raise VideoExportError("invalid_transition_boundary")
        return None
    from_shot_id = from_shot_id.strip()
    if not isinstance(to_shot_id, str) or not to_shot_id.strip():
        to_shot_id = adjacent.get(from_shot_id)
    elif isinstance(to_shot_id, str):
        to_shot_id = to_shot_id.strip()
    if not isinstance(to_shot_id, str) or not to_shot_id:
        if strict:
            raise VideoExportError(f"invalid_transition_boundary:{from_shot_id}")
        return None
    if adjacent.get(from_shot_id) != to_shot_id:
        if strict:
            raise VideoExportError(f"invalid_transition_boundary:{from_shot_id}:{to_shot_id}")
        return None
    transition_type = raw.get("type") or raw.get("transitionType") or "cut"
    if transition_type not in {"cut", "fade"}:
        raise VideoExportError(f"invalid_transition_type:{from_shot_id}:{to_shot_id}")
    duration = _clean_transition_duration(
        raw.get("duration_sec", raw.get("durationSec")),
        transition_type,
        from_shot_id,
        to_shot_id,
    )
    if transition_type == "fade":
        max_duration = min(
            effective_durations.get(from_shot_id, 0.0),
            effective_durations.get(to_shot_id, 0.0),
        )
        if duration >= max_duration:
            raise VideoExportError(f"invalid_transition_duration:{from_shot_id}:{to_shot_id}")
    return TimelineTransition(
        from_shot_id=from_shot_id,
        to_shot_id=to_shot_id,
        type=transition_type,
        duration_sec=duration,
    )


def _resolve_transitions(
    timeline: Node,
    raw_transitions: list[dict] | None,
    shot_ids: list[str],
    effective_durations_sec: list[float],
) -> dict[str, TimelineTransition]:
    if len(shot_ids) < 2:
        return {}
    adjacent = {shot_ids[index]: shot_ids[index + 1] for index in range(len(shot_ids) - 1)}
    durations_by_shot = dict(zip(shot_ids, effective_durations_sec, strict=False))
    strict = bool(raw_transitions)
    raw_entries = raw_transitions if raw_transitions else _timeline_stored_transitions(timeline.data or {}, shot_ids)
    out: dict[str, TimelineTransition] = {}
    for raw in raw_entries:
        entry = _transition_entry(raw, adjacent, durations_by_shot, strict=strict)
        if entry is not None:
            out[entry.from_shot_id] = entry
    return out


def _transition_dict(transition: TimelineTransition) -> dict[str, float | str]:
    return {
        "fromShotId": transition.from_shot_id,
        "toShotId": transition.to_shot_id,
        "type": transition.type,
        "durationSec": transition.duration_sec,
    }


def _transition_export_list(
    transitions: dict[str, TimelineTransition],
    shot_ids: list[str],
) -> list[dict[str, float | str]]:
    return [_transition_dict(transitions[shot_id]) for shot_id in shot_ids[:-1] if shot_id in transitions]


def _effective_clip_duration(
    path: Path,
    edit: TimelineClipEdit | None,
) -> float:
    duration = _duration_sec(path)
    if edit is None:
        return duration
    effective = duration - edit.trim_start_sec - edit.trim_end_sec
    if effective < 0.1:
        raise VideoExportError(f"invalid_clip_trim:{edit.shot_id}")
    return effective


def _clip_caption(timeline: Node, node: Node) -> str | None:
    timeline_data = timeline.data or {}
    shot_id = _clip_shot_id(node)
    captions = timeline_data.get("timelineCaptions")
    if isinstance(captions, dict):
        value = captions.get(shot_id)
        if isinstance(value, str) and value.strip():
            return value.strip()
    data = node.data or {}
    for key in ("captionText", "onScreenText"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _node_media_id(node: Node) -> str | None:
    data = node.data or {}
    media_id = data.get("mediaId")
    if isinstance(media_id, str) and media_id:
        return media_id
    media_ids = data.get("mediaIds")
    if isinstance(media_ids, list):
        for item in media_ids:
            if isinstance(item, str) and item:
                return item
    return None


def _timeline_audio_ref_media_ids(timeline_node_id: int, clips: list[Node]) -> dict[str, str]:
    target_ids = [timeline_node_id]
    target_ids.extend(node.id for node in clips if isinstance(node.id, int))
    with get_session() as s:
        edges = s.exec(
            select(Edge)
            .where(Edge.target_id.in_(target_ids))  # type: ignore[attr-defined]
            .order_by(Edge.id)
        ).all()
        out: dict[str, str] = {}
        for edge in edges:
            if edge.ref_role not in {"audio_ref", "script_ref"}:
                continue
            source = s.get(Node, edge.source_id)
            if source is None:
                continue
            media_id = _node_media_id(source)
            if not media_id:
                continue
            source_kind = (source.data or {}).get("type") or source.type
            if edge.ref_role == "script_ref" or source_kind == "script":
                out.setdefault("voiceover", media_id)
            elif edge.ref_role == "audio_ref" or source_kind == "audio":
                out.setdefault("music", media_id)
        return out


def _clean_optional_media_id(value: str | None, field: str) -> str | None:
    if value is None:
        return None
    media_id = media_service.normalize_media_id(value.strip())
    if not media_id:
        return None
    if not media_service.is_valid_media_id(media_id):
        raise VideoExportError(f"invalid_{field}_media_id")
    return media_id


def _clean_volume(value: float, field: str) -> float:
    try:
        volume = float(value)
    except (TypeError, ValueError) as exc:
        raise VideoExportError(f"invalid_{field}_volume") from exc
    if volume < 0 or volume > 2:
        raise VideoExportError(f"invalid_{field}_volume")
    return volume


def _resolve_audio_options(
    timeline_node_id: int,
    clips: list[Node],
    *,
    audio_mode: str,
    voiceover_media_id: str | None,
    music_media_id: str | None,
    voiceover_volume: float,
    music_volume: float,
) -> TimelineAudioOptions:
    if audio_mode not in {"none", "mix"}:
        raise VideoExportError("invalid_audio_mode")
    voiceover = _clean_optional_media_id(voiceover_media_id, "voiceover")
    music = _clean_optional_media_id(music_media_id, "music")
    voiceover_vol = _clean_volume(voiceover_volume, "voiceover")
    music_vol = _clean_volume(music_volume, "music")
    if audio_mode == "mix":
        refs = _timeline_audio_ref_media_ids(timeline_node_id, clips)
        voiceover = voiceover or _clean_optional_media_id(refs.get("voiceover"), "voiceover")
        music = music or _clean_optional_media_id(refs.get("music"), "music")
    return TimelineAudioOptions(
        mode=audio_mode,
        voiceover_media_id=voiceover if audio_mode == "mix" else None,
        music_media_id=music if audio_mode == "mix" else None,
        voiceover_volume=voiceover_vol,
        music_volume=music_vol,
    )


def _audio_media_ids(audio: TimelineAudioOptions) -> dict[str, str]:
    if audio.mode != "mix":
        return {}
    out: dict[str, str] = {}
    if audio.voiceover_media_id:
        out["voiceover"] = audio.voiceover_media_id
    if audio.music_media_id:
        out["music"] = audio.music_media_id
    return out


def _audio_mix(audio: TimelineAudioOptions) -> dict[str, float]:
    if audio.mode != "mix":
        return {"clipVolume": 1.0}
    mix = {
        "clipVolume": 1.0,
        "voiceoverVolume": audio.voiceover_volume if audio.voiceover_media_id else 0.0,
        "musicVolume": audio.music_volume if audio.music_media_id else 0.0,
    }
    return mix


async def _resolve_audio_paths(audio: TimelineAudioOptions) -> TimelineAudioPaths:
    if audio.mode != "mix":
        return TimelineAudioPaths()

    async def resolve(media_id: str | None) -> Path | None:
        if not media_id:
            return None
        path = await _resolve_media_path(media_id)
        if not _has_audio(path):
            raise VideoExportError(f"audio_media_has_no_audio:{media_id}")
        return path

    return TimelineAudioPaths(
        voiceover=await resolve(audio.voiceover_media_id),
        music=await resolve(audio.music_media_id),
    )


def _volume_arg(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def _mix_timeline_audio(
    source: Path,
    target: Path,
    *,
    audio: TimelineAudioOptions,
    audio_paths: TimelineAudioPaths,
) -> None:
    duration = _duration_sec(source)
    cmd = ["ffmpeg", "-y", "-i", str(source)]
    filters = ["[0:a:0]volume=1,asetpts=PTS-STARTPTS[a0]"]
    labels = ["[a0]"]
    input_index = 1

    if audio_paths.voiceover is not None:
        cmd.extend(["-i", str(audio_paths.voiceover)])
        label = f"a{input_index}"
        filters.append(
            f"[{input_index}:a:0]"
            f"volume={_volume_arg(audio.voiceover_volume)},"
            f"atrim=0:{duration:.3f},asetpts=PTS-STARTPTS[{label}]"
        )
        labels.append(f"[{label}]")
        input_index += 1

    if audio_paths.music is not None:
        cmd.extend(["-stream_loop", "-1", "-i", str(audio_paths.music)])
        label = f"a{input_index}"
        filters.append(
            f"[{input_index}:a:0]"
            f"volume={_volume_arg(audio.music_volume)},"
            f"atrim=0:{duration:.3f},asetpts=PTS-STARTPTS[{label}]"
        )
        labels.append(f"[{label}]")

    filters.append(
        "".join(labels)
        + f"amix=inputs={len(labels)}:duration=first:dropout_transition=0:normalize=0,"
        + "alimiter=limit=0.98[aout]"
    )
    cmd.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "0:v:0",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-t",
            f"{duration:.3f}",
            "-movflags",
            "+faststart",
            str(target),
        ]
    )
    _run_ffmpeg(cmd, timeout=240)


def _concat_clips(paths: list[Path], target: Path, concat_file: Path) -> None:
    concat_file.write_text("".join(_concat_line(path) for path in paths))
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
            str(target),
        ],
        timeout=240,
    )


def _render_transition_sequence(
    paths: list[Path],
    target: Path,
    *,
    shot_ids: list[str],
    effective_durations_sec: list[float],
    transitions: dict[str, TimelineTransition],
) -> None:
    if len(paths) == 1:
        _concat_clips(paths, target, target.with_suffix(".concat.txt"))
        return
    cmd = ["ffmpeg", "-y"]
    for path in paths:
        cmd.extend(["-i", str(path)])

    filters: list[str] = []
    for index in range(len(paths)):
        filters.append(f"[{index}:v:0]setpts=PTS-STARTPTS[v{index}in]")
        filters.append(f"[{index}:a:0]asetpts=PTS-STARTPTS[a{index}in]")

    video_label = "v0in"
    audio_label = "a0in"
    output_duration = effective_durations_sec[0]
    for index in range(1, len(paths)):
        from_shot_id = shot_ids[index - 1]
        transition = transitions.get(from_shot_id)
        next_video = f"v{index}in"
        next_audio = f"a{index}in"
        out_video = f"v{index}out"
        out_audio = f"a{index}out"
        if transition is not None and transition.type == "fade":
            duration = transition.duration_sec
            offset = max(0.0, output_duration - duration)
            filters.append(
                f"[{video_label}][{next_video}]"
                f"xfade=transition=fade:duration={duration:.3f}:offset={offset:.3f}"
                f"[{out_video}]"
            )
            filters.append(
                f"[{audio_label}][{next_audio}]"
                f"acrossfade=d={duration:.3f}:c1=tri:c2=tri"
                f"[{out_audio}]"
            )
            output_duration += effective_durations_sec[index] - duration
        else:
            filters.append(f"[{video_label}][{next_video}]concat=n=2:v=1:a=0[{out_video}]")
            filters.append(f"[{audio_label}][{next_audio}]concat=n=2:v=0:a=1[{out_audio}]")
            output_duration += effective_durations_sec[index]
        video_label = out_video
        audio_label = out_audio

    cmd.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            f"[{video_label}]",
            "-map",
            f"[{audio_label}]",
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
    _run_ffmpeg(cmd, timeout=240)


def _render_timeline_sequence(
    paths: list[Path],
    target: Path,
    *,
    shot_ids: list[str],
    effective_durations_sec: list[float],
    transitions: dict[str, TimelineTransition],
    concat_file: Path,
) -> None:
    if any(transition.type == "fade" for transition in transitions.values()):
        _render_transition_sequence(
            paths,
            target,
            shot_ids=shot_ids,
            effective_durations_sec=effective_durations_sec,
            transitions=transitions,
        )
        return
    _concat_clips(paths, target, concat_file)


def _caption_file_text(caption: str) -> str:
    text = " ".join(caption.split())
    if not text:
        return ""
    lines = textwrap.wrap(text, width=36, max_lines=3, placeholder="...")
    return "\n".join(lines)


def _video_filter(
    *,
    width: int,
    height: int,
    caption_file: Path | None = None,
) -> str:
    filters = [
        f"scale={width}:{height}:force_original_aspect_ratio=decrease",
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
        "setsar=1",
        "fps=30",
    ]
    if caption_file is not None:
        fontsize = max(18, round(height * 0.045))
        filters.append(
            "drawtext="
            f"textfile={_filter_arg(caption_file)}:"
            f"fontsize={fontsize}:"
            "fontcolor=white:"
            "line_spacing=8:"
            "box=1:"
            "boxcolor=black@0.58:"
            "boxborderw=18:"
            "x=(w-text_w)/2:"
            "y=h-text_h-(h*0.08)"
        )
    filters.append("format=yuv420p")
    return ",".join(filters)


def _normalise_clip(
    source: Path,
    target: Path,
    *,
    width: int,
    height: int,
    caption: str | None = None,
    edit: TimelineClipEdit | None = None,
) -> None:
    caption_file: Path | None = None
    caption_text = _caption_file_text(caption or "")
    if caption_text:
        caption_file = target.with_suffix(".caption.txt")
        caption_file.write_text(caption_text, encoding="utf-8")
    vf = _video_filter(width=width, height=height, caption_file=caption_file)
    effective_duration = _effective_clip_duration(source, edit)
    base = [
        "ffmpeg",
        "-y",
    ]
    if edit is not None and edit.trim_start_sec > 0:
        base.extend(["-ss", f"{edit.trim_start_sec:.3f}"])
    if edit is not None:
        base.extend(["-t", f"{effective_duration:.3f}"])
    base.extend(["-i", str(source)])
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
            f"{effective_duration:.3f}",
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
    try:
        _run_ffmpeg(cmd)
    finally:
        if caption_file is not None:
            caption_file.unlink(missing_ok=True)


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


def _export_snapshot(data: dict) -> dict | None:
    media_id = data.get("exportMediaId")
    if not isinstance(media_id, str) or not media_id:
        return None
    snapshot = {
        "mediaId": media_id,
        "status": data.get("exportStatus") or "fresh",
        "version": data.get("exportVersion"),
        "exportedAt": data.get("exportedAt"),
        "clipCount": data.get("exportClipCount"),
        "size": data.get("exportSize"),
        "sourceMediaIds": data.get("exportSourceMediaIds"),
        "sourceShotIds": data.get("exportShotIds"),
        "durationsSec": data.get("exportDurationsSec"),
        "effectiveDurationsSec": data.get("exportEffectiveDurationsSec"),
        "clipEdits": data.get("exportClipEdits"),
        "transitions": data.get("exportTransitions"),
        "captions": data.get("exportCaptions"),
        "captionMode": data.get("exportCaptionMode"),
        "audioMode": data.get("exportAudioMode"),
        "audioMediaIds": data.get("exportAudioMediaIds"),
        "audioMix": data.get("exportAudioMix"),
        "staleAt": data.get("exportStaleAt"),
        "staleReason": data.get("exportStaleReason"),
    }
    return {k: v for k, v in snapshot.items() if v is not None}


def _export_history_with_prior(data: dict) -> list:
    raw_history = data.get("exportHistory")
    history = list(raw_history) if isinstance(raw_history, list) else []
    prior = _export_snapshot(data)
    if prior is not None:
        last = history[-1] if history else None
        same_as_last = (
            isinstance(last, dict)
            and last.get("mediaId") == prior.get("mediaId")
            and last.get("version") == prior.get("version")
        )
        if not same_as_last:
            history.append(prior)
    return history[-10:]


def _next_export_version(data: dict) -> int:
    value = data.get("exportVersion")
    if isinstance(value, int):
        return value + 1
    if isinstance(value, str):
        try:
            return int(value) + 1
        except ValueError:
            pass
    return 1


def _stamp_timeline(
    timeline_node_id: int,
    *,
    media_id: str,
    clip_count: int,
    width: int,
    height: int,
    source_media_ids: list[str],
    source_shot_ids: list[str],
    clip_durations_sec: list[int | None],
    effective_durations_sec: list[float],
    clip_edits: list[dict[str, float | str]],
    transitions: list[dict[str, float | str]],
    clip_captions: list[str | None],
    caption_mode: str,
    audio_mode: str,
    audio_media_ids: dict[str, str],
    audio_mix: dict[str, float],
) -> dict:
    with get_session() as s:
        node = s.get(Node, timeline_node_id)
        if node is None:
            return {}
        data = dict(node.data or {})
        exported_at = datetime.now(timezone.utc).isoformat()
        export_version = _next_export_version(data)
        export_history = _export_history_with_prior(data)
        data.update(
            {
                "exportMediaId": media_id,
                "exportedAt": exported_at,
                "exportClipCount": clip_count,
                "exportSize": f"{width}x{height}",
                "exportStatus": "fresh",
                "exportVersion": export_version,
                "exportSourceMediaIds": source_media_ids,
                "exportShotIds": source_shot_ids,
                "exportDurationsSec": clip_durations_sec,
                "exportEffectiveDurationsSec": effective_durations_sec,
                "exportClipEdits": clip_edits,
                "exportTransitions": transitions,
                "exportCaptions": clip_captions,
                "exportCaptionMode": caption_mode,
                "exportAudioMode": audio_mode,
                "exportAudioMediaIds": audio_media_ids,
                "exportAudioMix": audio_mix,
                "exportHistory": export_history,
            }
        )
        data.pop("exportStaleAt", None)
        data.pop("exportStaleReason", None)
        node.data = data
        node.status = "done"
        s.add(node)
        s.commit()
        return {
            "exported_at": exported_at,
            "export_status": "fresh",
            "export_version": export_version,
            "export_history": export_history,
        }


async def analyze_timeline_qa(
    timeline_node_id: int,
    *,
    expected_width: int | None = None,
    expected_height: int | None = None,
) -> dict:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise VideoExportError("ffmpeg_not_found")
    if expected_width is not None and (expected_width < 64 or expected_width > 4096):
        raise VideoExportError("invalid_qa_width")
    if expected_height is not None and (expected_height < 64 or expected_height > 4096):
        raise VideoExportError("invalid_qa_height")
    timeline, clips = _timeline_clips(timeline_node_id)
    if not clips:
        raise VideoExportError("timeline_has_no_clips")
    items = [
        _qa_clip_item(
            timeline,
            clip,
            expected_width=expected_width,
            expected_height=expected_height,
        )
        for clip in clips
    ]
    summary = _timeline_qa_summary(items)
    status = "blocked" if summary["blocked"] else "warning" if summary["warning"] else "ok"
    checked_at = datetime.now(timezone.utc).isoformat()
    _stamp_timeline_qa(
        timeline.id,  # type: ignore[arg-type]
        checked_at=checked_at,
        status=status,
        summary=summary,
        items=items,
    )
    return {
        "timeline_node_id": timeline_node_id,
        "status": status,
        "checked_at": checked_at,
        "summary": summary,
        "items": items,
    }


async def export_timeline(
    timeline_node_id: int,
    *,
    width: int = 1080,
    height: int = 1920,
    caption_mode: str = "none",
    audio_mode: str = "none",
    voiceover_media_id: str | None = None,
    music_media_id: str | None = None,
    voiceover_volume: float = 1.0,
    music_volume: float = 0.25,
    clip_edits: list[dict] | None = None,
    transitions: list[dict] | None = None,
) -> dict:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise VideoExportError("ffmpeg_not_found")
    if width < 64 or height < 64 or width > 4096 or height > 4096:
        raise VideoExportError("invalid_export_size")
    if caption_mode not in {"none", "burn_in"}:
        raise VideoExportError("invalid_caption_mode")
    timeline, clips = _timeline_clips(timeline_node_id)
    if not clips:
        raise VideoExportError("timeline_has_no_clips")
    export_clips = _exportable_clips(clips)
    trim_edits = _resolve_clip_edits(timeline, clip_edits)
    audio = _resolve_audio_options(
        timeline_node_id,
        export_clips,
        audio_mode=audio_mode,
        voiceover_media_id=voiceover_media_id,
        music_media_id=music_media_id,
        voiceover_volume=voiceover_volume,
        music_volume=music_volume,
    )
    audio_paths = await _resolve_audio_paths(audio)
    audio_media_ids = _audio_media_ids(audio)
    audio_mix = _audio_mix(audio)

    work_dir = EXPORT_DIR / f"timeline-{timeline_node_id}-{uuid.uuid4().hex[:8]}"
    work_dir.mkdir(parents=True, exist_ok=True)
    normalised: list[Path] = []
    scratch_files: list[Path] = []
    media_ids: list[str] = []
    shot_ids: list[str] = []
    durations: list[int | None] = []
    effective_durations: list[float] = []
    captions: list[str | None] = []
    try:
        for index, clip in enumerate(export_clips, start=1):
            media_id = _first_clip_media_id(clip)
            shot_id = _clip_shot_id(clip)
            media_ids.append(media_id)
            shot_ids.append(shot_id)
            durations.append(_clip_duration(clip))
            captions.append(_clip_caption(timeline, clip))
            source = await _resolve_media_path(media_id)
            effective_durations.append(round(_effective_clip_duration(source, trim_edits.get(shot_id)), 3))
            target = work_dir / f"{index:03d}.mp4"
            _normalise_clip(
                source,
                target,
                width=width,
                height=height,
                caption=captions[-1] if caption_mode == "burn_in" else None,
                edit=trim_edits.get(shot_id),
            )
            normalised.append(target)

        concat_file = work_dir / "concat.txt"
        transition_edits = _resolve_transitions(timeline, transitions, shot_ids, effective_durations)
        export_transitions = _transition_export_list(transition_edits, shot_ids)
        export_media_id = str(uuid.uuid4())
        output_path = media_service.MEDIA_CACHE_DIR / f"{export_media_id}.mp4"
        has_extra_audio = audio_paths.voiceover is not None or audio_paths.music is not None
        sequence_output_path = work_dir / "stitched.mp4" if has_extra_audio else output_path
        if has_extra_audio:
            scratch_files.append(sequence_output_path)
        _render_timeline_sequence(
            normalised,
            sequence_output_path,
            shot_ids=shot_ids,
            effective_durations_sec=effective_durations,
            transitions=transition_edits,
            concat_file=concat_file,
        )
        if has_extra_audio:
            _mix_timeline_audio(
                sequence_output_path,
                output_path,
                audio=audio,
                audio_paths=audio_paths,
            )
        _register_export(export_media_id, output_path)
        stamp = _stamp_timeline(
            timeline.id,  # type: ignore[arg-type]
            media_id=export_media_id,
            clip_count=len(export_clips),
            width=width,
            height=height,
            source_media_ids=media_ids,
            source_shot_ids=shot_ids,
            clip_durations_sec=durations,
            effective_durations_sec=effective_durations,
            clip_edits=_clip_edit_export_list(trim_edits, shot_ids),
            transitions=export_transitions,
            clip_captions=captions,
            caption_mode=caption_mode,
            audio_mode=audio.mode,
            audio_media_ids=audio_media_ids,
            audio_mix=audio_mix,
        )
        return {
            "timeline_node_id": timeline_node_id,
            "media_id": export_media_id,
            "url": f"/media/{export_media_id}",
            "clip_count": len(export_clips),
            "source_media_ids": media_ids,
            "source_shot_ids": shot_ids,
            "clip_durations_sec": durations,
            "clip_effective_durations_sec": effective_durations,
            "export_clip_edits": _clip_edit_export_list(trim_edits, shot_ids),
            "export_transitions": export_transitions,
            "clip_captions": captions,
            "export_caption_mode": caption_mode,
            "export_audio_mode": audio.mode,
            "export_audio_media_ids": audio_media_ids,
            "export_audio_mix": audio_mix,
            "width": width,
            "height": height,
            **stamp,
        }
    except subprocess.TimeoutExpired as exc:
        raise VideoExportError("ffmpeg_timeout") from exc
    finally:
        for path in normalised:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        for path in scratch_files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            (work_dir / "concat.txt").unlink(missing_ok=True)
            work_dir.rmdir()
        except OSError:
            logger.debug("export work dir retained: %s", work_dir)
