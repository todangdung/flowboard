from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from flowboard.services.video_export import VideoExportError, export_timeline

router = APIRouter(prefix="/api/exports", tags=["exports"])


class TimelineExportBody(BaseModel):
    width: int = Field(default=1080, ge=64, le=4096)
    height: int = Field(default=1920, ge=64, le=4096)
    caption_mode: Literal["none", "burn_in"] = "none"


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
        )
    except VideoExportError as exc:
        msg = str(exc)
        status = 404 if msg in {"timeline_not_found"} else 400
        if msg == "ffmpeg_not_found":
            status = 503
        raise HTTPException(status_code=status, detail=msg)
