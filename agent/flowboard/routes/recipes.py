"""Recipe workflow builder endpoints.

Turns a selected video recipe into a runnable graph scaffold. This is the
deterministic bridge between recipe readiness and actual production flow:
refs -> first-frame image -> video node.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Board, Edge, Node
from flowboard.routes.edges import RefRole
from flowboard.services.llm import run_llm
from flowboard.services.llm.base import LLMError
from flowboard.services.video_recipes import normalize_video_recipe_id
from flowboard.short_id import generate_unique_short_id

router = APIRouter(prefix="/api/recipes", tags=["recipes"])

_COORD_MIN = -1_000_000.0
_COORD_MAX = 1_000_000.0


@dataclass(frozen=True)
class WorkflowNodeSpec:
    key: str
    type: str
    title: str
    dx: int
    dy: int
    data: dict = field(default_factory=dict)
    role: Optional[str] = None


@dataclass(frozen=True)
class WorkflowEdgeSpec:
    source: str
    target: str
    role: str


@dataclass(frozen=True)
class RecipeWorkflowSpec:
    nodes: tuple[WorkflowNodeSpec, ...]
    edges: tuple[WorkflowEdgeSpec, ...]
    video_key: str
    frame_key: Optional[str] = None


@dataclass(frozen=True)
class ShotWorkflowSpec:
    recipe_id: str
    label: str
    shot_count: int
    shared_inputs: tuple[WorkflowNodeSpec, ...]


_WORKFLOWS: dict[str, RecipeWorkflowSpec] = {
    "fashion_fit_check": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "character",
                "character",
                "Fit check character",
                0,
                0,
                role="character_ref",
            ),
            WorkflowNodeSpec(
                "outfit",
                "visual_asset",
                "Outfit / garment ref",
                0,
                220,
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "style",
                "prompt",
                "Fit check direction",
                0,
                440,
                data={
                    "prompt": (
                        "full outfit visible, mirror or try-on framing, natural "
                        "small movement, fabric and fit remain readable"
                    ),
                    "status": "done",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "Fit check first frame",
                360,
                110,
                data={
                    "prompt": (
                        "Photoreal editorial fashion photo, full-body try-on "
                        "framing, direct eye contact, closed-mouth neutral "
                        "expression, complete outfit and fabric detail clearly "
                        "readable, soft even key light, clean indoor background."
                    )
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Fashion fit check video",
                720,
                110,
                data={"videoRecipeId": "fashion_fit_check"},
            ),
        ),
        edges=(
            WorkflowEdgeSpec("character", "frame", "character_ref"),
            WorkflowEdgeSpec("outfit", "frame", "product_ref"),
            WorkflowEdgeSpec("style", "frame", "style_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("character", "video", "character_ref"),
            WorkflowEdgeSpec("outfit", "video", "product_ref"),
            WorkflowEdgeSpec("style", "video", "style_ref"),
        ),
    ),
    "mirror_selfie": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "character",
                "character",
                "Selfie character",
                0,
                0,
                role="character_ref",
            ),
            WorkflowNodeSpec(
                "style",
                "prompt",
                "Mirror selfie direction",
                0,
                220,
                data={
                    "prompt": (
                        "mirror selfie, phone visible but stable, casual handheld "
                        "feel, reflection geometry remains natural"
                    ),
                    "status": "done",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "Mirror selfie first frame",
                360,
                80,
                data={
                    "prompt": (
                        "Photoreal mirror selfie first frame, phone held naturally, "
                        "outfit visible, reflection geometry stable, direct composed "
                        "gaze, closed-mouth neutral expression, clean room light."
                    )
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Mirror selfie video",
                720,
                80,
                data={"videoRecipeId": "mirror_selfie"},
            ),
        ),
        edges=(
            WorkflowEdgeSpec("character", "frame", "character_ref"),
            WorkflowEdgeSpec("style", "frame", "style_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("character", "video", "character_ref"),
            WorkflowEdgeSpec("style", "video", "style_ref"),
        ),
    ),
    "product_demo": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "product",
                "product",
                "Product profile",
                0,
                0,
                data={
                    "productName": "Product",
                    "claimRules": "visible product facts only; no unsupported claims",
                },
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "campaign",
                "campaign",
                "Product demo campaign",
                0,
                220,
                data={
                    "objective": "show one useful product action",
                    "audience": "qualified product shoppers",
                    "cta": "learn more",
                    "claimsAllowed": "visible product features only",
                    "claimsAvoid": "no unsupported performance claims",
                    "tone": "clear, useful, credible",
                    "platform": "vertical short video",
                },
                role="campaign_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "Product demo first frame",
                360,
                0,
                data={
                    "prompt": (
                        "Photoreal product demo first frame, product centered and "
                        "fully readable, clean tabletop or hand-held setup, exact "
                        "shape and label area preserved, soft commercial lighting."
                    )
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Product demo video",
                720,
                0,
                data={
                    "videoRecipeId": "product_demo",
                    "videoSourceMode": "first_frame",
                    "videoDurationSec": 6,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("product", "frame", "product_ref"),
            WorkflowEdgeSpec("campaign", "frame", "campaign_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("product", "video", "product_ref"),
            WorkflowEdgeSpec("campaign", "video", "campaign_ref"),
        ),
    ),
    "lifestyle_ad": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "product",
                "product",
                "Lifestyle product",
                0,
                0,
                data={"productName": "Hero product"},
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "location",
                "location",
                "Lifestyle location",
                0,
                220,
                data={"locationName": "Use context", "palette": "natural lifestyle palette"},
                role="background_ref",
            ),
            WorkflowNodeSpec(
                "brand",
                "brand",
                "Brand mood",
                0,
                440,
                data={"brandTone": "warm, useful, aspirational", "palette": "brand-safe"},
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "campaign",
                "campaign",
                "Lifestyle campaign",
                0,
                660,
                data={
                    "objective": "connect product to one real-use occasion",
                    "audience": "lifestyle shoppers",
                    "offer": "hero product benefit",
                    "cta": "shop the look",
                    "claimsAllowed": "visible use case and sensory mood",
                    "claimsAvoid": "no unsupported results or comparisons",
                    "tone": "warm, useful, aspirational",
                    "platform": "vertical social ad",
                    "mustInclude": "product visible in lifestyle context",
                },
                role="campaign_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "Lifestyle first frame",
                360,
                130,
                data={
                    "prompt": (
                        "Photoreal lifestyle ad first frame, hero product visible "
                        "inside a believable real-use location, brand palette and "
                        "lighting locked, no text overlays."
                    ),
                    "aspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Lifestyle ad video",
                720,
                130,
                data={
                    "videoRecipeId": "lifestyle_ad",
                    "videoSourceMode": "first_frame",
                    "videoDurationSec": 8,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("product", "frame", "product_ref"),
            WorkflowEdgeSpec("location", "frame", "background_ref"),
            WorkflowEdgeSpec("brand", "frame", "style_ref"),
            WorkflowEdgeSpec("campaign", "frame", "campaign_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("product", "video", "product_ref"),
            WorkflowEdgeSpec("location", "video", "background_ref"),
            WorkflowEdgeSpec("brand", "video", "style_ref"),
            WorkflowEdgeSpec("campaign", "video", "campaign_ref"),
        ),
    ),
    "ugc_testimonial": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "character",
                "character",
                "UGC creator",
                0,
                0,
                role="character_ref",
            ),
            WorkflowNodeSpec(
                "product",
                "product",
                "UGC product",
                0,
                220,
                data={"productName": "Reviewed product"},
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "audio",
                "audio",
                "UGC audio direction",
                0,
                440,
                data={"voiceName": "Casual creator voice", "legalNotes": "exact script only"},
                role="audio_ref",
            ),
            WorkflowNodeSpec(
                "campaign",
                "campaign",
                "UGC campaign",
                0,
                660,
                data={
                    "objective": "make product feel credible in creator context",
                    "audience": "social shoppers comparing options",
                    "cta": "try it",
                    "claimsAllowed": "visible product detail and personal preference",
                    "claimsAvoid": "no invented testimonial or guaranteed result",
                    "tone": "casual, honest, claim-safe",
                    "platform": "vertical UGC ad",
                    "mustAvoid": "unscripted testimonial claims",
                },
                role="campaign_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "UGC first frame",
                360,
                130,
                data={
                    "prompt": (
                        "Photoreal creator-shot first frame, creator naturally "
                        "holding the product near camera, casual room light, "
                        "no captions, no lip-sync setup."
                    ),
                    "aspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "UGC testimonial video",
                720,
                130,
                data={
                    "videoRecipeId": "ugc_testimonial",
                    "videoSourceMode": "first_frame",
                    "videoDurationSec": 8,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("character", "frame", "character_ref"),
            WorkflowEdgeSpec("product", "frame", "product_ref"),
            WorkflowEdgeSpec("campaign", "frame", "campaign_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("character", "video", "character_ref"),
            WorkflowEdgeSpec("product", "video", "product_ref"),
            WorkflowEdgeSpec("audio", "video", "audio_ref"),
            WorkflowEdgeSpec("campaign", "video", "campaign_ref"),
        ),
    ),
    "cinematic_reveal": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "subject",
                "visual_asset",
                "Reveal subject",
                0,
                0,
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "style",
                "prompt",
                "Reveal direction",
                0,
                220,
                data={
                    "prompt": (
                        "cinematic reveal, slow push or light sweep, controlled "
                        "atmosphere, preserve subject silhouette"
                    ),
                    "status": "done",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "Cinematic reveal first frame",
                360,
                70,
                data={
                    "prompt": (
                        "Cinematic first frame with the subject partially "
                        "concealed by light, shadow, foreground, or framing; "
                        "premium lighting, no text overlays."
                    ),
                    "aspectRatio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Cinematic reveal video",
                720,
                70,
                data={
                    "videoRecipeId": "cinematic_reveal",
                    "videoSourceMode": "first_frame",
                    "videoDurationSec": 6,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("subject", "frame", "product_ref"),
            WorkflowEdgeSpec("style", "frame", "style_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("subject", "video", "product_ref"),
            WorkflowEdgeSpec("style", "video", "style_ref"),
        ),
    ),
    "before_after": RecipeWorkflowSpec(
        frame_key="first",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "product",
                "product",
                "Before/after product",
                0,
                0,
                data={"claimRules": "no medical or guaranteed result claims"},
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "campaign",
                "campaign",
                "Before/after campaign",
                0,
                220,
                data={
                    "objective": "show a readable visual transition",
                    "audience": "comparison-driven shoppers",
                    "cta": "see details",
                    "claimsAllowed": "visible cosmetic or visual endpoint only",
                    "claimsAvoid": "no medical, guaranteed, or time-bound result claims",
                    "tone": "neutral, transparent, compliant",
                    "mustAvoid": "misleading before/after promise",
                },
                role="campaign_ref",
            ),
            WorkflowNodeSpec(
                "first",
                "image",
                "Before frame",
                360,
                0,
                data={
                    "prompt": (
                        "Photoreal before frame, clear starting state, stable "
                        "composition, neutral claim-safe framing."
                    ),
                    "aspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                },
            ),
            WorkflowNodeSpec(
                "last",
                "image",
                "After frame",
                360,
                220,
                data={
                    "prompt": (
                        "Photoreal after frame, same subject/product and "
                        "composition, visible cosmetic or visual endpoint only."
                    ),
                    "aspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Before/after video",
                720,
                110,
                data={
                    "videoRecipeId": "before_after",
                    "videoSourceMode": "first_last",
                    "videoDurationSec": 6,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("product", "first", "product_ref"),
            WorkflowEdgeSpec("product", "last", "product_ref"),
            WorkflowEdgeSpec("campaign", "first", "campaign_ref"),
            WorkflowEdgeSpec("campaign", "last", "campaign_ref"),
            WorkflowEdgeSpec("first", "video", "first_frame"),
            WorkflowEdgeSpec("last", "video", "last_frame"),
            WorkflowEdgeSpec("product", "video", "product_ref"),
            WorkflowEdgeSpec("campaign", "video", "campaign_ref"),
        ),
    ),
    "location_establishing": RecipeWorkflowSpec(
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "location",
                "location",
                "Establishing location",
                0,
                0,
                data={"locationName": "Hero location", "palette": "realistic location light"},
                role="background_ref",
            ),
            WorkflowNodeSpec(
                "style",
                "prompt",
                "Establishing direction",
                0,
                220,
                data={
                    "prompt": (
                        "wide geography first, motivated camera move inward, "
                        "preserve architecture and time of day"
                    ),
                    "status": "done",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Location establishing video",
                360,
                80,
                data={
                    "prompt": (
                        "Establish the location with a readable wide view, then "
                        "move inward toward the action area. No random signage."
                    ),
                    "videoRecipeId": "location_establishing",
                    "videoSourceMode": "text",
                    "videoDurationSec": 6,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("location", "video", "background_ref"),
            WorkflowEdgeSpec("style", "video", "style_ref"),
        ),
    ),
    "brand_bumper": RecipeWorkflowSpec(
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "brand",
                "brand",
                "Brand kit",
                0,
                0,
                data={
                    "brandTone": "concise, polished, brand-safe",
                    "cta": "End on clean brand hold",
                    "legalNotes": "no invented claims or random taglines",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "audio",
                "audio",
                "Bumper audio",
                0,
                220,
                data={"voiceName": "short sting", "brandTone": "clean audio logo"},
                role="audio_ref",
            ),
            WorkflowNodeSpec(
                "campaign",
                "campaign",
                "Brand bumper campaign",
                0,
                440,
                data={
                    "objective": "create a concise branded opener or closer",
                    "audience": "brand-aware viewers",
                    "cta": "remember the brand",
                    "claimsAllowed": "brand mark, tone, and product category only",
                    "claimsAvoid": "no invented claims or random taglines",
                    "tone": "polished, simple, brand-safe",
                    "platform": "vertical social ad",
                },
                role="campaign_ref",
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Brand bumper video",
                360,
                80,
                data={
                    "prompt": (
                        "Create a short brand bumper with one simple motion idea "
                        "and a clean final hold. Keep typography area readable."
                    ),
                    "videoRecipeId": "brand_bumper",
                    "videoSourceMode": "text",
                    "videoDurationSec": 4,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("brand", "video", "style_ref"),
            WorkflowEdgeSpec("audio", "video", "audio_ref"),
            WorkflowEdgeSpec("campaign", "video", "campaign_ref"),
        ),
    ),
    "audio_led": RecipeWorkflowSpec(
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "audio",
                "audio",
                "Audio direction",
                0,
                0,
                data={
                    "voiceName": "Voice / music direction",
                    "legalNotes": "exact script only; no unscripted speech",
                },
                role="audio_ref",
            ),
            WorkflowNodeSpec(
                "brand",
                "brand",
                "Audio-led brand tone",
                0,
                220,
                data={"brandTone": "match visual beats to audio cadence"},
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "campaign",
                "campaign",
                "Audio-led campaign",
                0,
                440,
                data={
                    "objective": "align visuals to one audio-led message",
                    "audience": "short-form social viewers",
                    "cta": "follow the audio cue",
                    "claimsAllowed": "supplied script only",
                    "claimsAvoid": "no unscripted claims",
                    "tone": "paced to voice or sound design",
                    "platform": "vertical audio-led ad",
                    "mustInclude": "exact supplied script if speech is used",
                },
                role="campaign_ref",
            ),
            WorkflowNodeSpec(
                "script",
                "script",
                "Voiceover script",
                0,
                660,
                data={
                    "scriptHook": "opening hook",
                    "voiceoverText": "exact voiceover wording",
                    "captionText": "matching short caption",
                    "language": "Vietnamese or English",
                    "pacing": "paced to 8 seconds",
                    "mustNotSay": "no unsupported claims",
                },
                role="script_ref",
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Voiceover / audio-led video",
                360,
                80,
                data={
                    "prompt": (
                        "Build visual beats around the supplied audio direction. "
                        "Use only supplied script wording if speech is present."
                    ),
                    "videoRecipeId": "audio_led",
                    "videoSourceMode": "text",
                    "videoDurationSec": 8,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("audio", "video", "audio_ref"),
            WorkflowEdgeSpec("brand", "video", "style_ref"),
            WorkflowEdgeSpec("campaign", "video", "campaign_ref"),
            WorkflowEdgeSpec("script", "video", "script_ref"),
        ),
    ),
    "transition_shot": RecipeWorkflowSpec(
        frame_key="first",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "first",
                "image",
                "Transition start frame",
                0,
                0,
                data={
                    "prompt": "Start frame for a transition shot; clear source state.",
                    "aspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                },
            ),
            WorkflowNodeSpec(
                "last",
                "image",
                "Transition end frame",
                0,
                220,
                data={
                    "prompt": "End frame for a transition shot; clear target state.",
                    "aspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                },
            ),
            WorkflowNodeSpec(
                "style",
                "prompt",
                "Transition direction",
                0,
                440,
                data={
                    "prompt": "object pass, match cut, wipe, whip pan, or light move",
                    "status": "done",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Transition shot video",
                360,
                120,
                data={
                    "videoRecipeId": "transition_shot",
                    "videoSourceMode": "first_last",
                    "videoDurationSec": 4,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("first", "video", "first_frame"),
            WorkflowEdgeSpec("last", "video", "last_frame"),
            WorkflowEdgeSpec("style", "video", "style_ref"),
        ),
    ),
    "packshot_loop": RecipeWorkflowSpec(
        frame_key="frame",
        video_key="video",
        nodes=(
            WorkflowNodeSpec(
                "product",
                "product",
                "Packshot product",
                0,
                0,
                data={"productName": "Hero product", "brandName": "Brand"},
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "brand",
                "brand",
                "Packshot brand rules",
                0,
                220,
                data={
                    "brandTone": "clean hero product loop",
                    "legalNotes": "preserve label area; no invented typography",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "campaign",
                "campaign",
                "Packshot campaign",
                0,
                440,
                data={
                    "objective": "end on a memorable product hero hold",
                    "audience": "ready-to-buy product viewers",
                    "cta": "shop now",
                    "claimsAllowed": "visible packaging and product facts",
                    "claimsAvoid": "no invented label text or unsupported claims",
                    "tone": "clean, premium, product-first",
                    "platform": "vertical ad loop",
                    "mustInclude": "product and label area readable",
                },
                role="campaign_ref",
            ),
            WorkflowNodeSpec(
                "frame",
                "image",
                "Packshot first frame",
                360,
                80,
                data={
                    "prompt": (
                        "Clean centered packshot first frame, product fully "
                        "readable, label area preserved, loop-safe composition."
                    ),
                    "aspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                },
            ),
            WorkflowNodeSpec(
                "video",
                "video",
                "Packshot / hero loop video",
                720,
                80,
                data={
                    "videoRecipeId": "packshot_loop",
                    "videoSourceMode": "first_frame",
                    "videoDurationSec": 4,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                },
            ),
        ),
        edges=(
            WorkflowEdgeSpec("product", "frame", "product_ref"),
            WorkflowEdgeSpec("brand", "frame", "style_ref"),
            WorkflowEdgeSpec("campaign", "frame", "campaign_ref"),
            WorkflowEdgeSpec("frame", "video", "first_frame"),
            WorkflowEdgeSpec("product", "video", "product_ref"),
            WorkflowEdgeSpec("brand", "video", "style_ref"),
            WorkflowEdgeSpec("campaign", "video", "campaign_ref"),
        ),
    ),
}

_SHOT_WORKFLOWS: dict[str, ShotWorkflowSpec] = {
    "storyboard_sequence": ShotWorkflowSpec(
        recipe_id="storyboard_sequence",
        label="Storyboard sequence / Chuỗi cảnh",
        shot_count=3,
        shared_inputs=(
            WorkflowNodeSpec(
                "character",
                "character",
                "Sequence character / Nhân vật",
                0,
                0,
                role="character_ref",
            ),
            WorkflowNodeSpec(
                "product",
                "visual_asset",
                "Product or hero asset / Sản phẩm",
                0,
                220,
                role="product_ref",
            ),
            WorkflowNodeSpec(
                "style",
                "prompt",
                "Sequence direction / Hướng cảnh",
                0,
                440,
                data={
                    "prompt": (
                        "consistent subject/product, clear 3-shot short video arc, "
                        "no text overlays unless requested"
                    ),
                    "status": "done",
                },
                role="style_ref",
            ),
            WorkflowNodeSpec(
                "campaign",
                "campaign",
                "Campaign brief / Brief chiến dịch",
                0,
                660,
                data={
                    "objective": "define campaign objective",
                    "audience": "target viewer",
                    "cta": "clear next action",
                    "claimsAvoid": "no unsupported claims",
                    "tone": "campaign-safe, concise",
                },
                role="campaign_ref",
            ),
        ),
    ),
}

_ROLE_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("first_frame", ("first frame", "source frame", "opening frame", "start frame", "still")),
    ("last_frame", ("last frame", "final frame", "end frame")),
    ("script_ref", ("script", "voiceover", "voice over", "caption", "copy", "hook", "cta line", "must say")),
    ("audio_ref", ("audio", "voice", "voiceover", "voice over", "music", "sound", "sfx")),
    ("campaign_ref", ("campaign", "objective", "audience", "offer", "cta", "claim", "platform")),
    ("package_ref", ("package", "packaging", "box", "carton", "unbox")),
    ("product_ref", ("product", "garment", "outfit", "shirt", "dress", "bottle", "serum", "cream", "shoe")),
    ("background_ref", ("background", "location", "room", "cafe", "street", "park", "interior", "exterior", "scene")),
    ("style_ref", ("style", "mood", "tone", "palette", "lighting", "aesthetic", "direction")),
    ("storyboard_ref", ("storyboard", "panel", "shot list")),
    ("character_ref", ("character", "person", "woman", "man", "model", "face", "portrait")),
)


class RoleClassifyRequest(BaseModel):
    node_id: int
    recipe_id: Optional[str] = None
    use_llm: bool = False


def _edge_context_row(edge: Edge, node: Node) -> dict:
    data = node.data or {}
    text_parts = [
        data.get("title"),
        data.get("aiBrief"),
        data.get("prompt"),
        node.type,
    ]
    text = " ".join(p for p in text_parts if isinstance(p, str)).lower()
    return {
        "edge_id": edge.id,
        "source_node_id": node.id,
        "source_short_id": node.short_id,
        "source_type": node.type,
        "title": data.get("title") if isinstance(data.get("title"), str) else None,
        "brief": data.get("aiBrief") if isinstance(data.get("aiBrief"), str) else None,
        "prompt": data.get("prompt") if isinstance(data.get("prompt"), str) else None,
        "current_role": edge.ref_role,
        "_text": text,
    }


def _heuristic_role(row: dict, target: Node, recipe_id: Optional[str]) -> tuple[str, float, str]:
    source_type = row["source_type"]
    text = row["_text"]

    if source_type == "character":
        return "character_ref", 0.95, "character node"
    if source_type == "product":
        return "product_ref", 0.95, "product node"
    if source_type == "location":
        return "background_ref", 0.95, "location node"
    if source_type == "brand":
        return "style_ref", 0.88, "brand node drives style and rules"
    if source_type == "campaign":
        return "campaign_ref", 0.95, "campaign node"
    if source_type == "script":
        return "script_ref", 0.95, "script node"
    if source_type == "audio":
        return "audio_ref", 0.95, "audio node"
    if source_type == "visual_asset":
        if any(word in text for word in ("package", "packaging", "box", "unbox")):
            return "package_ref", 0.85, "visual asset looks like packaging"
        return "product_ref", 0.9, "visual asset node"
    if source_type == "prompt":
        if "storyboard" in text:
            return "storyboard_ref", 0.8, "prompt mentions storyboard"
        return "style_ref", 0.75, "prompt node is text direction"
    if source_type == "Storyboard":
        return "storyboard_ref", 0.95, "Storyboard node"

    if target.type == "video" and source_type == "image":
        current = row.get("current_role")
        if current == "first_frame":
            return "first_frame", 0.99, "already labelled first frame"
        if recipe_id in {
            "fashion_fit_check",
            "mirror_selfie",
            "product_demo",
            "lifestyle_ad",
            "cinematic_reveal",
            "location_establishing",
            "brand_bumper",
            "transition_shot",
            "packshot_loop",
        }:
            return "first_frame", 0.82, "image feeding single-shot video recipe"

    for role, keywords in _ROLE_KEYWORDS:
        for keyword in keywords:
            if keyword in text:
                return role, 0.7, f"matched keyword {keyword!r}"

    return "ingredient", 0.45, "fallback generic ingredient"


def _suggest_roles_heuristic(rows: list[dict], target: Node, recipe_id: Optional[str]) -> list[dict]:
    suggestions = []
    for row in rows:
        role, confidence, reason = _heuristic_role(row, target, recipe_id)
        suggestions.append(
            {
                "edge_id": row["edge_id"],
                "source_node_id": row["source_node_id"],
                "source_short_id": row["source_short_id"],
                "source_type": row["source_type"],
                "title": row["title"],
                "current_role": row["current_role"],
                "suggested_role": role,
                "confidence": confidence,
                "reason": reason,
            }
        )
    return suggestions


def _strip_json_fence(text: str) -> str:
    out = (text or "").strip()
    if out.startswith("```"):
        out = out.lstrip("`")
        if out.lower().startswith("json"):
            out = out[4:]
        out = out.rsplit("```", 1)[0]
    return out.strip()


async def _suggest_roles_llm(rows: list[dict], target: Node, recipe_id: Optional[str]) -> list[dict]:
    role_values = list(RefRole.__args__)  # type: ignore[attr-defined]
    payload = [
        {
            k: row[k]
            for k in (
                "edge_id",
                "source_node_id",
                "source_short_id",
                "source_type",
                "title",
                "brief",
                "prompt",
                "current_role",
            )
        }
        for row in rows
    ]
    system_prompt = (
        "You classify Flowboard upstream assets into production reference roles. "
        "Return ONLY a JSON array. Each item: edge_id, role, confidence 0-1, reason. "
        f"Allowed roles: {', '.join(role_values)}. Use visible/brief facts; do not invent."
    )
    user_prompt = (
        f"Target node: type={target.type}, title={(target.data or {}).get('title')!r}\n"
        f"Recipe: {recipe_id or 'auto'}\n"
        f"Assets:\n{json.dumps(payload, ensure_ascii=False)}"
    )
    text = await run_llm(
        "auto_prompt",
        user_prompt,
        system_prompt=system_prompt,
        timeout=45.0,
    )
    arr = json.loads(_strip_json_fence(text))
    if not isinstance(arr, list):
        return []
    valid_edge_ids = {row["edge_id"] for row in rows}
    valid_roles = set(role_values)
    out: list[dict] = []
    for item in arr:
        if not isinstance(item, dict):
            continue
        edge_id = item.get("edge_id")
        role = item.get("role") or item.get("suggested_role")
        if edge_id not in valid_edge_ids or role not in valid_roles:
            continue
        conf = item.get("confidence", 0.65)
        try:
            confidence = max(0.0, min(float(conf), 1.0))
        except (TypeError, ValueError):
            confidence = 0.65
        reason = item.get("reason")
        out.append(
            {
                "edge_id": edge_id,
                "suggested_role": role,
                "confidence": confidence,
                "reason": reason if isinstance(reason, str) else "LLM role classifier",
            }
        )
    return out


class SourceBinding(BaseModel):
    node_id: int
    role: RefRole


class ShotPlanItemInput(BaseModel):
    shot_index: int = Field(default=1, ge=1, le=6)
    title_en: str = Field(default="", max_length=120)
    title_vi: str = Field(default="", max_length=120)
    frame_prompt: str = Field(default="", max_length=4000)
    video_prompt: str = Field(default="", max_length=4000)
    duration_sec: Optional[int] = Field(default=None, ge=1, le=10)
    action: str = Field(default="", max_length=2000)
    camera: str = Field(default="", max_length=1200)
    audio: str = Field(default="", max_length=1200)
    continuity: str = Field(default="", max_length=2000)
    avoid: str = Field(default="", max_length=2000)


class ShotPlanBuildRequest(BaseModel):
    board_id: int
    recipe_id: str = "storyboard_sequence"
    brief: str = Field(default="", max_length=2000)
    shot_count: int = Field(default=3, ge=1, le=6)
    shot_duration_sec: int = Field(default=4, ge=1, le=10)
    sources: list[SourceBinding] = Field(default_factory=list)
    use_llm: bool = True


class WorkflowBuildRequest(BaseModel):
    board_id: int
    recipe_id: str
    x: float = Field(default=0.0, ge=_COORD_MIN, le=_COORD_MAX)
    y: float = Field(default=0.0, ge=_COORD_MIN, le=_COORD_MAX)
    sources: list[SourceBinding] = Field(default_factory=list)
    open_generation: bool = True
    shot_count: int = Field(default=3, ge=1, le=6)
    shot_duration_sec: int = Field(default=4, ge=1, le=10)
    brief: str = Field(default="", max_length=2000)
    use_llm: bool = False
    shot_plan: Optional[list[ShotPlanItemInput]] = None


def _node_dict(node: Node) -> dict:
    return {
        "id": node.id,
        "board_id": node.board_id,
        "short_id": node.short_id,
        "type": node.type,
        "x": node.x,
        "y": node.y,
        "w": node.w,
        "h": node.h,
        "data": node.data or {},
        "status": node.status,
        "created_at": node.created_at.isoformat() if node.created_at else None,
    }


def _edge_dict(edge: Edge) -> dict:
    return {
        "id": edge.id,
        "board_id": edge.board_id,
        "source_id": edge.source_id,
        "target_id": edge.target_id,
        "kind": edge.kind,
        "source_variant_idx": edge.source_variant_idx,
        "ref_role": edge.ref_role,
    }


@router.post("/build-workflow")
async def build_recipe_workflow(body: WorkflowBuildRequest) -> dict:
    recipe_id = normalize_video_recipe_id(body.recipe_id)
    if recipe_id in _SHOT_WORKFLOWS:
        return await _build_shot_workflow(body, recipe_id)
    if recipe_id is None or recipe_id not in _WORKFLOWS:
        raise HTTPException(400, f"unsupported recipe_id {body.recipe_id!r}")
    spec = _WORKFLOWS[recipe_id]

    with get_session() as s:
        board = s.get(Board, body.board_id)
        if board is None:
            raise HTTPException(404, "board not found")

        bound_by_role: dict[str, Node] = {}
        for binding in body.sources:
            node = s.get(Node, binding.node_id)
            if node is None:
                raise HTTPException(404, f"source node {binding.node_id} not found")
            if node.board_id != body.board_id:
                raise HTTPException(400, "source node belongs to another board")
            bound_by_role[binding.role] = node

        node_by_key: dict[str, Node] = {}
        created_nodes: list[Node] = []
        created_edges: list[Edge] = []

        for node_spec in spec.nodes:
            bound = bound_by_role.get(node_spec.role or "")
            if bound is not None:
                node_by_key[node_spec.key] = bound
                continue

            data = {"title": node_spec.title, **dict(node_spec.data)}
            status = "done" if data.get("status") == "done" else "idle"
            node = Node(
                board_id=body.board_id,
                short_id=generate_unique_short_id(s, body.board_id),
                type=node_spec.type,
                x=round(body.x + node_spec.dx),
                y=round(body.y + node_spec.dy),
                w=240,
                h=180 if node_spec.type != "prompt" else 120,
                data=data,
                status=status,
            )
            s.add(node)
            s.flush()
            node_by_key[node_spec.key] = node
            created_nodes.append(node)

        for edge_spec in spec.edges:
            source = node_by_key.get(edge_spec.source)
            target = node_by_key.get(edge_spec.target)
            if source is None or target is None or source.id == target.id:
                continue
            edge = Edge(
                board_id=body.board_id,
                source_id=source.id,
                target_id=target.id,
                kind="ref",
                ref_role=edge_spec.role,
            )
            s.add(edge)
            s.flush()
            created_edges.append(edge)

        s.commit()
        for node in created_nodes:
            s.refresh(node)
        for edge in created_edges:
            s.refresh(edge)

        video_node = node_by_key.get(spec.video_key)
        frame_node = node_by_key.get(spec.frame_key) if spec.frame_key else None
        return {
            "recipe_id": recipe_id,
            "nodes": [_node_dict(n) for n in created_nodes],
            "edges": [_edge_dict(e) for e in created_edges],
            "video_node_id": video_node.id if video_node else None,
            "frame_node_id": frame_node.id if frame_node else None,
            "timeline_node_id": None,
            "shot_node_ids": [],
            "shot_count": 0,
            "open_node_id": video_node.id if video_node else None,
            "open_generation": body.open_generation,
        }


def _shot_id(index: int) -> str:
    return f"shot_{index:02d}"


def _clean_text(value: Any, fallback: str, *, limit: int = 1200) -> str:
    if isinstance(value, str):
        text = " ".join(value.split())
        if text:
            return text[:limit]
    return fallback


def _clean_duration(value: Any, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    try:
        duration = int(value)
    except (TypeError, ValueError):
        return fallback
    return min(10, max(1, duration))


def _dump_model(value: BaseModel) -> dict:
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return dump()
    return value.dict()


def _shot_fallback_item(
    index: int,
    total: int,
    *,
    brief: str,
    recipe_label: str,
    duration_sec: int,
) -> dict:
    title_pairs = (
        ("Hook", "Mở đầu"),
        ("Context", "Bối cảnh"),
        ("Action", "Hành động"),
        ("Proof", "Chứng minh"),
        ("Hero hold", "Giữ hero"),
        ("Payoff", "Kết"),
    )
    title_en, title_vi = title_pairs[min(index - 1, len(title_pairs) - 1)]
    if index == total and total > 1:
        title_en, title_vi = "Payoff", "Kết"
    if index == 1:
        action = "establish the subject/product and hook the viewer with one clear visual beat"
    elif index == total:
        action = "resolve the story with a clean final hero hold"
    else:
        action = "advance the story with one concrete product or character action"
    camera = "stable vertical framing with motivated micro movement"
    audio = "music bed and subtle SFX, no speech unless explicitly scripted"
    continuity = "same subject/product, lighting, location, palette, and visual style"
    avoid = "random cuts, changed identity, product drift, captions, text overlays, warped hands"
    subject = brief or recipe_label
    frame_prompt = (
        f"Create shot {index}/{total} first frame for: {subject}. "
        f"Beat: {action}. Keep composition readable, production-ready, "
        f"and consistent with adjacent shots. Continuity: {continuity}. Avoid: {avoid}."
    )
    video_prompt = (
        f"The uploaded image is the first frame. Generate a {duration_sec}s "
        f"shot {index}/{total} for: {subject}. Action: {action}. Camera: {camera}. "
        f"Audio: {audio}. Continuity: {continuity}. Avoid: {avoid}."
    )
    return {
        "shot_index": index,
        "title_en": title_en,
        "title_vi": title_vi,
        "frame_prompt": frame_prompt,
        "video_prompt": video_prompt,
        "duration_sec": duration_sec,
        "action": action,
        "camera": camera,
        "audio": audio,
        "continuity": continuity,
        "avoid": avoid,
    }


def _normalise_shot_items(
    raw_items: Any,
    *,
    brief: str,
    recipe_label: str,
    shot_count: int,
    duration_sec: int,
) -> list[dict]:
    items = raw_items if isinstance(raw_items, list) else []
    out: list[dict] = []
    for idx in range(1, shot_count + 1):
        raw = items[idx - 1] if idx - 1 < len(items) and isinstance(items[idx - 1], dict) else {}
        fallback = _shot_fallback_item(
            idx,
            shot_count,
            brief=brief,
            recipe_label=recipe_label,
            duration_sec=duration_sec,
        )
        title_en = _clean_text(raw.get("title_en"), fallback["title_en"], limit=80)
        title_vi = _clean_text(raw.get("title_vi"), fallback["title_vi"], limit=80)
        action = _clean_text(raw.get("action"), fallback["action"])
        camera = _clean_text(raw.get("camera"), fallback["camera"])
        audio = _clean_text(raw.get("audio"), fallback["audio"])
        continuity = _clean_text(raw.get("continuity"), fallback["continuity"])
        avoid = _clean_text(raw.get("avoid"), fallback["avoid"])
        frame_prompt = _clean_text(raw.get("frame_prompt"), fallback["frame_prompt"], limit=1800)
        video_prompt = _clean_text(raw.get("video_prompt"), fallback["video_prompt"], limit=1800)
        item_duration = _clean_duration(raw.get("duration_sec"), duration_sec)
        out.append(
            {
                "shot_index": idx,
                "title_en": title_en,
                "title_vi": title_vi,
                "frame_prompt": frame_prompt,
                "video_prompt": video_prompt,
                "duration_sec": item_duration,
                "action": action,
                "camera": camera,
                "audio": audio,
                "continuity": continuity,
                "avoid": avoid,
            }
        )
    return out


def _source_context_for_board(board_id: int, sources: list[SourceBinding]) -> list[dict]:
    profile_keys = (
        "productName",
        "brandName",
        "locationName",
        "characterName",
        "voiceName",
        "claimRules",
        "brandTone",
        "palette",
        "cta",
        "legalNotes",
        "objective",
        "audience",
        "offer",
        "scriptHook",
        "voiceoverText",
        "onScreenText",
        "captionText",
        "scriptBeats",
        "language",
        "pacing",
        "speaker",
        "pronunciation",
        "mustSay",
        "mustNotSay",
        "claimsAllowed",
        "claimsAvoid",
        "tone",
        "platform",
        "mustInclude",
        "mustAvoid",
    )
    with get_session() as s:
        board = s.get(Board, board_id)
        if board is None:
            raise HTTPException(404, "board not found")
        rows: list[dict] = []
        for binding in sources:
            node = s.get(Node, binding.node_id)
            if node is None:
                raise HTTPException(404, f"source node {binding.node_id} not found")
            if node.board_id != board_id:
                raise HTTPException(400, "source node belongs to another board")
            data = node.data or {}
            profile = {
                key: value
                for key in profile_keys
                if isinstance((value := data.get(key)), str) and value.strip()
            }
            rows.append(
                {
                    "node_id": node.id,
                    "short_id": node.short_id,
                    "type": node.type,
                    "role": binding.role,
                    "title": data.get("title") if isinstance(data.get("title"), str) else None,
                    "brief": data.get("aiBrief") if isinstance(data.get("aiBrief"), str) else None,
                    "prompt": data.get("prompt") if isinstance(data.get("prompt"), str) else None,
                    "profile": profile,
                    "has_media": bool(data.get("mediaId") or data.get("mediaIds")),
                }
            )
        return rows


async def _llm_shot_plan(
    body: ShotPlanBuildRequest,
    *,
    recipe_label: str,
    source_context: list[dict],
) -> Optional[list[dict]]:
    brief = body.brief.strip()
    if not body.use_llm or not brief:
        return None
    system_prompt = (
        "You are a Flowboard short-video director. Return ONLY a JSON array "
        "with exactly the requested number of shots. Each item must include: "
        "title_en, title_vi, frame_prompt, video_prompt, action, camera, audio, "
        "continuity, avoid. Keep prompts model-ready and production-safe. "
        "Preserve referenced product/character identity; do not invent medical "
        "or beauty claims."
    )
    user_prompt = (
        f"Recipe: {body.recipe_id} / {recipe_label}\n"
        f"Shot count: {body.shot_count}\n"
        f"Duration per shot: {body.shot_duration_sec}s\n"
        f"Brief: {brief}\n"
        f"Source assets:\n{json.dumps(source_context, ensure_ascii=False)}\n\n"
        "For each shot, write a first-frame image prompt and a video prompt. "
        "Use Vietnamese title in title_vi. Do not return markdown."
    )
    try:
        text = await run_llm(
            "auto_prompt",
            user_prompt,
            system_prompt=system_prompt,
            timeout=60.0,
        )
        parsed = json.loads(_strip_json_fence(text))
    except (LLMError, json.JSONDecodeError, ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, list) else None


async def _build_shot_plan_payload(
    body: ShotPlanBuildRequest,
    *,
    source_context: Optional[list[dict]] = None,
) -> dict:
    recipe_id = normalize_video_recipe_id(body.recipe_id)
    if recipe_id is None or recipe_id not in _SHOT_WORKFLOWS:
        raise HTTPException(400, f"unsupported shot recipe_id {body.recipe_id!r}")
    spec = _SHOT_WORKFLOWS[recipe_id]
    context = source_context if source_context is not None else _source_context_for_board(
        body.board_id, body.sources
    )
    brief = body.brief.strip()
    llm_items = await _llm_shot_plan(body, recipe_label=spec.label, source_context=context)
    source = "llm" if llm_items else "fallback"
    shots = _normalise_shot_items(
        llm_items or [],
        brief=brief,
        recipe_label=spec.label,
        shot_count=body.shot_count,
        duration_sec=body.shot_duration_sec,
    )
    return {
        "recipe_id": recipe_id,
        "label": spec.label,
        "brief": brief,
        "shot_count": body.shot_count,
        "shot_duration_sec": body.shot_duration_sec,
        "source": source,
        "source_context": context,
        "shots": shots,
    }


def _build_custom_shot_plan_payload(
    body: WorkflowBuildRequest,
    recipe_id: str,
    *,
    source_context: list[dict],
) -> dict:
    if not body.shot_plan:
        raise HTTPException(400, "shot_plan is empty")
    shot_count = len(body.shot_plan)
    if shot_count < 1 or shot_count > 6:
        raise HTTPException(400, "shot_plan length must be between 1 and 6")
    spec = _SHOT_WORKFLOWS[recipe_id]
    brief = body.brief.strip()
    shots = _normalise_shot_items(
        [_dump_model(item) for item in body.shot_plan],
        brief=brief,
        recipe_label=spec.label,
        shot_count=shot_count,
        duration_sec=body.shot_duration_sec,
    )
    return {
        "recipe_id": recipe_id,
        "label": spec.label,
        "brief": brief,
        "shot_count": shot_count,
        "shot_duration_sec": body.shot_duration_sec,
        "source": "custom",
        "source_context": source_context,
        "shots": shots,
    }


@router.post("/build-shot-plan")
async def build_shot_plan(body: ShotPlanBuildRequest) -> dict:
    return await _build_shot_plan_payload(body)


def _shot_plan_prompt(index: int, total: int, label: str) -> str:
    if index == 1:
        beat = "Hook: establish subject/product and visual problem in one readable frame."
    elif index == total:
        beat = "Payoff: resolve action with final hero hold and clear continuity."
    else:
        beat = "Development: show one concrete action beat that moves the short forward."
    return (
        f"{label} shot {index}/{total}. {beat} Keep subject, product, lighting, "
        "and location consistent with adjacent shots. Output should be one "
        "production-ready first frame for this shot."
    )


def _shot_video_prompt(index: int, total: int, label: str, duration_sec: int) -> str:
    if index == 1:
        action = "start with a calm establishing motion, then reveal the main subject/product"
    elif index == total:
        action = "complete the action and hold the final hero composition"
    else:
        action = "perform one clear transition/action beat with stable continuity"
    return (
        f"The uploaded image is the first frame. Generate a {duration_sec}s "
        f"shot {index}/{total} "
        f"for {label}. Action: {action}. Camera movement stays motivated by "
        "this single shot. Preserve continuity locks from the storyboard plan. "
        "Avoid random cuts, changed identity, product drift, captions, and text overlays."
    )


def _add_edge(
    s,
    created_edges: list[Edge],
    board_id: int,
    source: Node,
    target: Node,
    role: str,
) -> None:
    if source.id == target.id:
        return
    edge = Edge(
        board_id=board_id,
        source_id=source.id,
        target_id=target.id,
        kind="ref",
        ref_role=role,
    )
    s.add(edge)
    s.flush()
    created_edges.append(edge)


async def _build_shot_workflow(body: WorkflowBuildRequest, recipe_id: str) -> dict:
    spec = _SHOT_WORKFLOWS[recipe_id]
    shot_duration_sec = body.shot_duration_sec
    source_context = _source_context_for_board(body.board_id, body.sources)
    if body.shot_plan:
        shot_plan = _build_custom_shot_plan_payload(
            body,
            recipe_id,
            source_context=source_context,
        )
    else:
        shot_plan = await _build_shot_plan_payload(
            ShotPlanBuildRequest(
                board_id=body.board_id,
                recipe_id=recipe_id,
                brief=body.brief,
                shot_count=body.shot_count or spec.shot_count,
                shot_duration_sec=shot_duration_sec,
                sources=body.sources,
                use_llm=body.use_llm,
            ),
            source_context=source_context,
        )
    shot_count = shot_plan["shot_count"]
    planned_shots = shot_plan["shots"]

    with get_session() as s:
        board = s.get(Board, body.board_id)
        if board is None:
            raise HTTPException(404, "board not found")

        bound_by_role: dict[str, Node] = {}
        for binding in body.sources:
            node = s.get(Node, binding.node_id)
            if node is None:
                raise HTTPException(404, f"source node {binding.node_id} not found")
            if node.board_id != body.board_id:
                raise HTTPException(400, "source node belongs to another board")
            bound_by_role[binding.role] = node

        created_nodes: list[Node] = []
        created_edges: list[Edge] = []
        shared_by_role: dict[str, Node] = {}

        for node_spec in spec.shared_inputs:
            bound = bound_by_role.get(node_spec.role or "")
            if bound is not None:
                shared_by_role[node_spec.role or ""] = bound
                continue
            data = {"title": node_spec.title, **dict(node_spec.data)}
            status = "done" if data.get("status") == "done" else "idle"
            node = Node(
                board_id=body.board_id,
                short_id=generate_unique_short_id(s, body.board_id),
                type=node_spec.type,
                x=round(body.x + node_spec.dx),
                y=round(body.y + node_spec.dy),
                w=240,
                h=180 if node_spec.type != "prompt" else 120,
                data=data,
                status=status,
            )
            s.add(node)
            s.flush()
            shared_by_role[node_spec.role or ""] = node
            created_nodes.append(node)

        plan_node = Node(
            board_id=body.board_id,
            short_id=generate_unique_short_id(s, body.board_id),
            type="prompt",
            x=round(body.x + 330),
            y=round(body.y - 80),
            w=280,
            h=150,
            data={
                "title": "Storyboard plan / Kế hoạch cảnh",
                "prompt": (
                    f"Create a {shot_count}-shot short-video storyboard. "
                    f"Brief: {shot_plan['brief'] or spec.label}. "
                    "Each shot needs one first frame and one generated clip. "
                    "Continuity locks: same subject/product/location, one clear action beat per shot."
                ),
                "workflowKind": "storyboard_plan",
                "videoRecipeId": recipe_id,
                "shotPlanSource": shot_plan["source"],
                "brief": shot_plan["brief"],
                "status": "done",
            },
            status="done",
        )
        s.add(plan_node)
        s.flush()
        created_nodes.append(plan_node)

        frame_nodes: list[Node] = []
        clip_nodes: list[Node] = []
        for idx in range(1, shot_count + 1):
            shot = _shot_id(idx)
            planned = planned_shots[idx - 1]
            planned_duration_sec = planned["duration_sec"]
            frame = Node(
                board_id=body.board_id,
                short_id=generate_unique_short_id(s, body.board_id),
                type="image",
                x=round(body.x + 670),
                y=round(body.y + (idx - 1) * 260),
                w=240,
                h=180,
                data={
                    "title": f"Shot {idx}: {planned['title_en']} / {planned['title_vi']}",
                    "prompt": planned["frame_prompt"],
                    "workflowKind": "shot_frame",
                    "shotId": shot,
                    "shotIndex": idx,
                    "shotDurationSec": planned_duration_sec,
                    "shotTitleEn": planned["title_en"],
                    "shotTitleVi": planned["title_vi"],
                    "shotAction": planned["action"],
                    "shotCamera": planned["camera"],
                    "shotAudio": planned["audio"],
                    "shotContinuity": planned["continuity"],
                    "shotAvoid": planned["avoid"],
                    "shotPlanSource": shot_plan["source"],
                    "videoRecipeId": recipe_id,
                    "aspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                },
                status="idle",
            )
            clip = Node(
                board_id=body.board_id,
                short_id=generate_unique_short_id(s, body.board_id),
                type="video",
                x=round(body.x + 1010),
                y=round(body.y + (idx - 1) * 260),
                w=240,
                h=180,
                data={
                    "title": f"Shot {idx} clip: {planned['title_en']} / {planned['title_vi']}",
                    "prompt": planned["video_prompt"],
                    "workflowKind": "shot_clip",
                    "shotId": shot,
                    "shotIndex": idx,
                    "shotDurationSec": planned_duration_sec,
                    "shotTitleEn": planned["title_en"],
                    "shotTitleVi": planned["title_vi"],
                    "shotAction": planned["action"],
                    "shotCamera": planned["camera"],
                    "shotAudio": planned["audio"],
                    "shotContinuity": planned["continuity"],
                    "shotAvoid": planned["avoid"],
                    "shotPlanSource": shot_plan["source"],
                    "videoRecipeId": recipe_id,
                    "aspectRatio": "VIDEO_ASPECT_RATIO_PORTRAIT",
                },
                status="idle",
            )
            s.add(frame)
            s.flush()
            s.add(clip)
            s.flush()
            frame_nodes.append(frame)
            clip_nodes.append(clip)
            created_nodes.extend([frame, clip])

        timeline_node = Node(
            board_id=body.board_id,
            short_id=generate_unique_short_id(s, body.board_id),
            type="note",
            x=round(body.x + 1350),
            y=round(body.y + 80),
            w=300,
            h=max(180, 80 + shot_count * 42),
            data={
                "title": "Timeline / Dòng dựng",
                "prompt": f"{shot_count} shots / {shot_count} cảnh",
                "workflowKind": "timeline",
                "timelineRecipeId": recipe_id,
                "timelineShotIds": [_shot_id(i) for i in range(1, shot_count + 1)],
                "timelineDurationsSec": [shot["duration_sec"] for shot in planned_shots],
                "shotPlanSource": shot_plan["source"],
                "brief": shot_plan["brief"],
            },
            status="idle",
        )
        s.add(timeline_node)
        s.flush()
        created_nodes.append(timeline_node)

        for frame, clip in zip(frame_nodes, clip_nodes):
            _add_edge(s, created_edges, body.board_id, plan_node, frame, "storyboard_ref")
            _add_edge(s, created_edges, body.board_id, frame, clip, "first_frame")
            for role, source in shared_by_role.items():
                _add_edge(s, created_edges, body.board_id, source, frame, role)
                _add_edge(s, created_edges, body.board_id, source, clip, role)
            _add_edge(s, created_edges, body.board_id, clip, timeline_node, "storyboard_panel")

        s.commit()
        for node in created_nodes:
            s.refresh(node)
        for edge in created_edges:
            s.refresh(edge)

        first_frame = frame_nodes[0] if frame_nodes else None
        first_clip = clip_nodes[0] if clip_nodes else None
        return {
            "recipe_id": recipe_id,
            "nodes": [_node_dict(n) for n in created_nodes],
            "edges": [_edge_dict(e) for e in created_edges],
            "video_node_id": first_clip.id if first_clip else None,
            "frame_node_id": first_frame.id if first_frame else None,
            "timeline_node_id": timeline_node.id,
            "shot_node_ids": [node.id for pair in zip(frame_nodes, clip_nodes) for node in pair],
            "shot_count": shot_count,
            "open_node_id": first_frame.id if first_frame else None,
            "open_generation": body.open_generation,
        }


@router.post("/classify-roles")
async def classify_reference_roles(body: RoleClassifyRequest) -> dict:
    recipe_id = normalize_video_recipe_id(body.recipe_id)
    with get_session() as s:
        target = s.get(Node, body.node_id)
        if target is None:
            raise HTTPException(404, "node not found")
        edges = s.exec(
            select(Edge).where(Edge.target_id == body.node_id).order_by(Edge.id)
        ).all()
        rows: list[dict] = []
        for edge in edges:
            source = s.get(Node, edge.source_id)
            if source is None:
                continue
            rows.append(_edge_context_row(edge, source))

    suggestions = _suggest_roles_heuristic(rows, target, recipe_id)
    source = "heuristic"

    if body.use_llm and rows:
        try:
            llm_items = await _suggest_roles_llm(rows, target, recipe_id)
        except (LLMError, json.JSONDecodeError, ValueError, TypeError):
            llm_items = []
        if llm_items:
            by_edge = {item["edge_id"]: item for item in suggestions}
            for item in llm_items:
                base = by_edge.get(item["edge_id"])
                if base is None:
                    continue
                base["suggested_role"] = item["suggested_role"]
                base["confidence"] = item["confidence"]
                base["reason"] = item["reason"]
                base["source"] = "llm"
            source = "llm"

    for item in suggestions:
        item.setdefault("source", source if source == "heuristic" else "heuristic")
        item["needs_change"] = item["current_role"] != item["suggested_role"]

    return {
        "node_id": body.node_id,
        "recipe_id": recipe_id,
        "source": source,
        "suggestions": suggestions,
    }
