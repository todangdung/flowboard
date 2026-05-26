from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from flowboard.services.video_export import VideoExportError, export_timeline

router = APIRouter(prefix="/api/exports", tags=["exports"])


class TimelineExportBody(BaseModel):
    width: int = Field(default=1080, ge=64, le=4096)
    height: int = Field(default=1920, ge=64, le=4096)
    caption_mode: Literal["none", "burn_in"] = "none"
    audio_mode: Literal["none", "mix"] = "none"
    voiceover_media_id: str | None = None
    music_media_id: str | None = None
    voiceover_volume: float = Field(default=1.0, ge=0, le=2)
    music_volume: float = Field(default=0.25, ge=0, le=2)


@router.post("/timelines/{timeline_node_id}")
async def export_timeline_route(
    timeline_node_id: int,
    body: TimelineExportBody | None = None,
) -> dict:
    body = body or TimelineExportBody()
    try:
        return await export_timeline(
            timeline_node_id,
            width=body.width,
            height=body.height,
            caption_mode=body.caption_mode,
            audio_mode=body.audio_mode,
            voiceover_media_id=body.voiceover_media_id,
            music_media_id=body.music_media_id,
            voiceover_volume=body.voiceover_volume,
            music_volume=body.music_volume,
        )
    except VideoExportError as exc:
        msg = str(exc)
        status = 404 if msg in {"timeline_not_found"} else 400
        if msg == "ffmpeg_not_found":
            status = 503
        raise HTTPException(status_code=status, detail=msg)
