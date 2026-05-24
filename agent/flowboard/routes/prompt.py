"""Auto-prompt route.

`POST /api/prompt/auto { node_id }` returns a Claude-composed prompt built
from the immediate-upstream context (character / visual_asset / image
nodes' aiBriefs). Frontend calls this when the user clicks Generate
without typing a prompt.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.services import prompt_synth
from flowboard.services.video_recipes import (
    build_video_recipe_plan,
    list_video_recipes,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prompt", tags=["prompt"])


class AutoPromptBody(BaseModel):
    node_id: int
    # Optional video-only constraint: e.g. "static" → synth uses the camera-
    # locked system prompt and avoids dolly/zoom suggestions.
    camera: Optional[str] = None
    # Optional video recipe selector. "auto" / null lets prompt_synth infer
    # from upstream roles and titles; explicit ids apply a known short-video
    # contract such as product_demo or fashion_fit_check.
    recipe_id: Optional[str] = None


class AutoPromptResponse(BaseModel):
    node_id: int
    prompt: str


class VideoRecipeCatalogResponse(BaseModel):
    recipes: list[dict]


class VideoRecipePlanResponse(BaseModel):
    node_id: int
    plan: dict


@router.get("/video-recipes", response_model=VideoRecipeCatalogResponse)
def video_recipes() -> VideoRecipeCatalogResponse:
    return VideoRecipeCatalogResponse(recipes=list_video_recipes())


@router.get("/video-recipe-plan", response_model=VideoRecipePlanResponse)
def video_recipe_plan(
    node_id: int,
    recipe_id: Optional[str] = None,
    camera: Optional[str] = None,
) -> VideoRecipePlanResponse:
    try:
        plan = build_video_recipe_plan(node_id, recipe_id, camera=camera)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return VideoRecipePlanResponse(node_id=node_id, plan=plan)


@router.post("/auto", response_model=AutoPromptResponse)
async def auto_prompt(body: AutoPromptBody) -> AutoPromptResponse:
    try:
        text = await prompt_synth.auto_prompt(
            body.node_id, camera=body.camera, recipe_id=body.recipe_id
        )
    except prompt_synth.PromptSynthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return AutoPromptResponse(node_id=body.node_id, prompt=text)


class AutoPromptBatchBody(BaseModel):
    node_id: int
    count: int
    camera: Optional[str] = None


class AutoPromptBatchResponse(BaseModel):
    node_id: int
    prompts: list[str]


@router.post("/auto-batch", response_model=AutoPromptBatchResponse)
async def auto_prompt_batch(body: AutoPromptBatchBody) -> AutoPromptBatchResponse:
    """Return N pose-distinct prompts so that an N-variant image gen
    actually produces N different shots instead of N seeds of the same
    stance."""
    if body.count < 1 or body.count > 8:
        raise HTTPException(status_code=400, detail="count must be 1..8")
    try:
        prompts = await prompt_synth.auto_prompt_batch(
            body.node_id, body.count, camera=body.camera
        )
    except prompt_synth.PromptSynthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return AutoPromptBatchResponse(node_id=body.node_id, prompts=prompts)
