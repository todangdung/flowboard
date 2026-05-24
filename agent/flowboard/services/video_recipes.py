"""Short-video recipe catalog.

The catalog is the structured layer above prompt text: each recipe declares
which reference roles it expects, sensible generation defaults, and the motion
contract appended to the video auto-prompt system prompt.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Edge, Node


@dataclass(frozen=True)
class VideoRecipe:
    id: str
    label: str
    required_roles: tuple[str, ...]
    optional_roles: tuple[str, ...]
    recommended_generation_path: str
    default_camera: str
    default_aspect_ratio: str
    action_hint: str
    audio_hint: str
    preserve_hint: str
    avoid_hint: str
    prompt_contract: str

    def to_dict(self) -> dict:
        data = asdict(self)
        data["required_roles"] = list(self.required_roles)
        data["optional_roles"] = list(self.optional_roles)
        return data


VIDEO_RECIPES: tuple[VideoRecipe, ...] = (
    VideoRecipe(
        id="fashion_fit_check",
        label="Fashion fit check",
        required_roles=("character_ref", "first_frame"),
        optional_roles=("product_ref", "background_ref", "style_ref"),
        recommended_generation_path="image_to_video",
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        action_hint=(
            "One natural fit-check motion: subtle weight shift, half turn, "
            "small outfit adjustment, then hold the full outfit readable."
        ),
        audio_hint="Instrumental low-volume fashion/lifestyle bed, no speech or lip-sync.",
        preserve_hint="Preserve character identity, outfit silhouette, fabric drape, and first-frame framing.",
        avoid_hint=(
            "Avoid exaggerated runway posing, fast crops, warped hands, hidden "
            "outfit details, and text overlays."
        ),
        prompt_contract=(
            "FASHION FIT CHECK RECIPE — Flowkit-style contract: the scene "
            "prompt locks the source frame and outfit references; the "
            "video_prompt describes only the motion after frame 0. Keep the "
            "full outfit readable for the full clip: silhouette, fit, fabric "
            "drape, shoes/accessories when visible. Use one natural try-on "
            "motion such as a small weight shift, half turn, hem/collar check, "
            "or mirror-angle adjustment. No exaggerated runway walk, no hard "
            "pose sequence, no fast camera crop that hides the outfit."
        ),
    ),
    VideoRecipe(
        id="mirror_selfie",
        label="Mirror selfie",
        required_roles=("character_ref", "first_frame"),
        optional_roles=("background_ref", "style_ref", "product_ref"),
        recommended_generation_path="image_to_video",
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        action_hint=(
            "Small mirror-selfie motion: phone tilt, weight shift, eye-line "
            "moving between screen and mirror, then a stable outfit hold."
        ),
        audio_hint="Quiet room tone plus soft instrumental bed, no speech or lip-sync.",
        preserve_hint="Preserve character identity, phone/mirror geometry, outfit, and room mood.",
        avoid_hint=(
            "Avoid duplicate phones, warped reflections, extra hands, sudden "
            "cuts, captions, and text overlays."
        ),
        prompt_contract=(
            "MIRROR SELFIE RECIPE — Treat the phone/mirror setup as part of "
            "the source frame. Keep reflection geometry stable: no duplicate "
            "phones, no warped hands, no impossible mirror angle. The "
            "video_prompt should feel handheld and casual: tiny phone tilt, "
            "subtle weight shift, eye-line moving between screen and mirror."
        ),
    ),
    VideoRecipe(
        id="unbox",
        label="Unbox",
        required_roles=("package_ref", "first_frame"),
        optional_roles=("product_ref", "background_ref", "style_ref"),
        recommended_generation_path="first_last_frame",
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        action_hint="One clear reveal action: open package, part tissue, lift product, or rotate package.",
        audio_hint="Subtle package handling SFX plus soft instrumental bed, no speech unless requested.",
        preserve_hint="Preserve package shape, product shape, logo/label area, materials, and scale.",
        avoid_hint="Avoid invented labels, extra items, jump cuts, warped fingers, and unreadable branding.",
        prompt_contract=(
            "UNBOX RECIPE — Preserve packaging, product shape, and brand-safe "
            "details. The video_prompt should show one clear reveal action: "
            "lid opening, tissue paper parting, product lifted slightly, or "
            "hands rotating the package. No invented labels, no extra items, "
            "no jump cuts unless the user explicitly asks for cuts."
        ),
    ),
    VideoRecipe(
        id="product_demo",
        label="Product demo",
        required_roles=("product_ref", "first_frame"),
        optional_roles=("package_ref", "background_ref", "style_ref"),
        recommended_generation_path="image_to_video",
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        action_hint=(
            "Demonstrate one visible product operation while keeping the "
            "product centered, readable, and physically plausible."
        ),
        audio_hint="Light product-handling SFX plus soft instrumental bed, no speech by default.",
        preserve_hint=(
            "Preserve exact product shape, material, color, logo/label area, "
            "buttons/caps/nozzles, and scale."
        ),
        avoid_hint="Avoid invented labels, fake UI/text overlays, extra product variants, distorted hands, and motion blur.",
        prompt_contract=(
            "PRODUCT DEMO RECIPE — Flowkit-style contract: bind product_ref / "
            "package_ref / first_frame roles before writing the video_prompt. "
            "Product fidelity is the priority: preserve shape, material, color, "
            "logo/label area, cap/nozzle/buttons, and scale. Demonstrate one "
            "clear product action while keeping it readable in frame. No "
            "invented labels, no fake UI/text overlays, no extra variants of "
            "the product."
        ),
    ),
    VideoRecipe(
        id="ugc_review",
        label="UGC review",
        required_roles=("character_ref", "product_ref"),
        optional_roles=("first_frame", "background_ref", "style_ref"),
        recommended_generation_path="ingredients_to_video",
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        action_hint="Natural silent review gesture: show product, point to one detail, react subtly, hold product near camera.",
        audio_hint="Casual room tone plus soft instrumental bed, no speech or lip-sync by default.",
        preserve_hint="Preserve creator identity, product design, room mood, and handheld UGC framing.",
        avoid_hint="Avoid lip-sync, testimonial captions, fake labels, over-polished lighting, and product drift.",
        prompt_contract=(
            "UGC REVIEW RECIPE — Casual creator-style review without spoken "
            "dialogue by default. Keep the person and product naturally framed; "
            "use one believable gesture such as holding the product near camera, "
            "nodding subtly, pointing to texture, or reacting silently. No lip "
            "sync, no captions, no testimonial text unless explicitly requested."
        ),
    ),
    VideoRecipe(
        id="skincare_tvc",
        label="Skincare TVC",
        required_roles=("product_ref", "first_frame"),
        optional_roles=("character_ref", "background_ref", "style_ref"),
        recommended_generation_path="per_shot_sequence",
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        action_hint="Premium beauty motion: slow macro, bottle turn, soft application, texture reveal, or glow hold.",
        audio_hint="Soft premium instrumental bed with subtle beauty-product SFX, no speech unless scripted.",
        preserve_hint="Preserve product packaging, skin texture, liquid/cream consistency, clean lighting, and brand-safe tone.",
        avoid_hint="Avoid medical claims, invented before/after claims, text overlays, over-smoothing, and label drift.",
        prompt_contract=(
            "SKINCARE TVC RECIPE — Premium beauty-commercial pacing. Preserve "
            "skin texture, product packaging, liquid/cream consistency, and clean "
            "lighting. The video_prompt can use slow macro movement, soft hand "
            "application, bottle turn, glow reveal, or water/gel texture motion. "
            "No medical claims, no invented before/after claims, no text overlays."
        ),
    ),
    VideoRecipe(
        id="before_after",
        label="Before / after",
        required_roles=("first_frame", "last_frame"),
        optional_roles=("character_ref", "product_ref", "style_ref"),
        recommended_generation_path="first_last_frame",
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        action_hint="Smooth transition or reveal from first frame to last frame, preserving identity and scene logic.",
        audio_hint="Soft transition whoosh plus ambient instrumental bed, no speech by default.",
        preserve_hint="Preserve subject/product identity, pose continuity, lighting continuity, and target endpoint.",
        avoid_hint="Avoid impossible morphs, misleading claims, jump cuts, fake UI labels, and identity drift.",
        prompt_contract=(
            "BEFORE/AFTER RECIPE — Keep the transformation readable without "
            "inventing impossible changes. Preserve identity, pose continuity, "
            "and product/garment fidelity. If two references are present, use "
            "their roles as before_ref and after_ref in spirit even when labels "
            "are generic; describe a clean comparison or reveal motion. No "
            "misleading medical/beauty claims, no fake UI labels."
        ),
    ),
    VideoRecipe(
        id="dance",
        label="Dance",
        required_roles=("character_ref", "first_frame"),
        optional_roles=("background_ref", "style_ref"),
        recommended_generation_path="image_to_video",
        default_camera="dynamic",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        action_hint="Simple 1-2 move phrase: step-touch, shoulder sway, hand wave, hip sway, or gentle groove.",
        audio_hint="Instrumental rhythm only, no vocals, no singing, no lip-sync.",
        preserve_hint="Preserve face, outfit, limb count, body proportions, and source-frame framing.",
        avoid_hint="Avoid complex choreography, acrobatics, foot sliding, extra limbs, and sudden scene cuts.",
        prompt_contract=(
            "DANCE RECIPE — Choreography must be light, natural, and physically "
            "plausible from the source pose. Use a short 1-2 move phrase: small "
            "step-touch, shoulder sway, hand wave, hip sway, or gentle groove. "
            "Preserve face, outfit, limb count, and camera framing. No extreme "
            "acrobatic moves unless the source clearly supports them."
        ),
    ),
    VideoRecipe(
        id="storyboard_sequence",
        label="Storyboard sequence",
        required_roles=("storyboard_ref",),
        optional_roles=("character_ref", "product_ref", "background_ref"),
        recommended_generation_path="per_shot_sequence",
        default_camera="dynamic",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        action_hint="Move through storyboard panels in order without inventing a new plot.",
        audio_hint="Music/SFX follow panel beats; speech only when storyboard/script explicitly asks.",
        preserve_hint="Preserve subject, product, location, lighting, and continuity between panels.",
        avoid_hint="Avoid panel order confusion, random cuts, caption drift, and changed character/product identity.",
        prompt_contract=(
            "STORYBOARD SEQUENCE RECIPE — Treat storyboard panels as ordered "
            "beats. The video_prompt should move through the panels in sequence "
            "without inventing a new plot: panel 1 establishes, middle panels "
            "carry action, final panel resolves. Keep continuity of subject, "
            "location, product, and lighting between beats."
        ),
    ),
)

_BY_ID = {recipe.id: recipe for recipe in VIDEO_RECIPES}

_REF_SOURCE_TYPES = {"character", "image", "visual_asset", "Storyboard"}

_ROLE_LABELS = {
    "first_frame": "First frame",
    "last_frame": "Last frame",
    "character_ref": "Character",
    "product_ref": "Product",
    "package_ref": "Package",
    "background_ref": "Background",
    "style_ref": "Style",
    "storyboard_ref": "Storyboard",
    "storyboard_panel": "Storyboard panel",
    "ingredient": "Ingredient",
}

_ROLE_PRESERVE_HINTS = {
    "first_frame": "Use first_frame as the literal opening frame and motion anchor.",
    "last_frame": "Use last_frame as the target endpoint for the transition.",
    "character_ref": "Keep character identity, face, hairstyle, proportions, and wardrobe consistent.",
    "product_ref": "Keep product shape, logo/label area, color, material, and scale exact.",
    "package_ref": "Keep packaging shape, material, label area, and opening logic exact.",
    "background_ref": "Keep setting, lighting direction, perspective, and scene mood consistent.",
    "style_ref": "Apply style as visual language only; do not let it override identity/product locks.",
    "storyboard_ref": "Preserve panel order, narrative beats, and continuity locks.",
    "storyboard_panel": "Treat panel as one shot reference, not the whole sequence.",
    "ingredient": "Use as a conditioning ingredient only when no stricter role is assigned.",
}


def list_video_recipes() -> list[dict]:
    return [recipe.to_dict() for recipe in VIDEO_RECIPES]


def get_video_recipe(recipe_id: str) -> Optional[VideoRecipe]:
    return _BY_ID.get(recipe_id)


def normalize_video_recipe_id(recipe_id: Optional[str]) -> Optional[str]:
    if not recipe_id or recipe_id == "auto":
        return None
    return recipe_id if recipe_id in _BY_ID else None


def video_recipe_clause(recipe_id: str) -> str:
    recipe = _BY_ID[recipe_id]
    return "\n\n" + recipe.prompt_contract


def infer_video_recipe_id(records: list[dict], target_data: dict) -> Optional[str]:
    texts: list[str] = []
    title = target_data.get("title")
    if isinstance(title, str):
        texts.append(title)
    for r in records:
        for key in ("ref_role", "brief", "prompt", "title", "type"):
            value = r.get(key)
            if isinstance(value, str):
                texts.append(value)
    blob = " ".join(texts).lower()
    roles = {r.get("ref_role") for r in records if isinstance(r.get("ref_role"), str)}

    if "storyboard" in blob or "storyboard_ref" in roles or "storyboard_panel" in roles:
        return "storyboard_sequence"
    if "unbox" in blob or "package_ref" in roles or "packaging" in blob:
        return "unbox"
    if "before" in blob and "after" in blob:
        return "before_after"
    if "dance" in blob or "dancing" in blob or "choreography" in blob:
        return "dance"
    if "ugc" in blob or "review" in blob or "testimonial" in blob:
        return "ugc_review"
    if "skincare" in blob or "serum" in blob or "beauty" in blob or "tvc" in blob:
        return "skincare_tvc"
    if "mirror" in blob or "selfie" in blob:
        return "mirror_selfie"
    if "fit check" in blob or "outfit" in blob or "try-on" in blob or "try on" in blob:
        return "fashion_fit_check"
    if "product_ref" in roles or "visual_asset" in blob or "product" in blob:
        return "product_demo"
    return None


def _collect_plan_context(node_id: int) -> tuple[list[dict], Optional[dict]]:
    with get_session() as s:
        target = s.get(Node, node_id)
        if target is None:
            return [], None
        edges = s.exec(
            select(Edge).where(Edge.target_id == node_id).order_by(Edge.id)
        ).all()
        records: list[dict] = []
        next_ref_index = 1
        for edge in edges:
            node = s.get(Node, edge.source_id)
            if node is None:
                continue
            data = node.data or {}
            prompt = data.get("prompt") if isinstance(data.get("prompt"), str) else None
            ai_brief = data.get("aiBrief") if isinstance(data.get("aiBrief"), str) else None
            mids = data.get("mediaIds")
            has_media = bool(
                (isinstance(data.get("mediaId"), str) and data.get("mediaId"))
                or (isinstance(mids, list) and any(isinstance(m, str) and m for m in mids))
            )
            ref_index: Optional[int] = None
            if node.type in _REF_SOURCE_TYPES and has_media:
                ref_index = next_ref_index
                next_ref_index += 1
            records.append(
                {
                    "type": node.type,
                    "shortId": node.short_id,
                    "ref_role": edge.ref_role if isinstance(edge.ref_role, str) else None,
                    "ref_index": ref_index,
                    "brief": prompt or ai_brief,
                    "prompt": prompt,
                    "title": data.get("title") if isinstance(data.get("title"), str) else None,
                    "has_media": has_media,
                }
            )
        return records, target.data or {}


def _ordered_roles(records: list[dict]) -> list[str]:
    seen: set[str] = set()
    roles: list[str] = []
    for record in records:
        role = record.get("ref_role")
        if isinstance(role, str) and role and role not in seen:
            seen.add(role)
            roles.append(role)
    return roles


def _describe_record(record: dict) -> str:
    role = record.get("ref_role") or "unassigned"
    role_label = _ROLE_LABELS.get(str(role), str(role))
    ref_index = record.get("ref_index")
    prefix = f"ref_image_{ref_index}" if ref_index else "text_ref"
    title = record.get("title") if isinstance(record.get("title"), str) else record.get("type")
    brief = record.get("brief") if isinstance(record.get("brief"), str) else ""
    if brief and title and brief != title:
        return f"{role_label}: {prefix} - {title}: {brief}"
    return f"{role_label}: {prefix} - {title or '(no description)'}"


def _refs_section(records: list[dict]) -> str:
    if not records:
        return "No upstream references connected."
    return "\n".join(_describe_record(record) for record in records)


def _preserve_section(recipe: VideoRecipe, present_roles: list[str]) -> str:
    hints = [recipe.preserve_hint]
    for role in present_roles:
        hint = _ROLE_PRESERVE_HINTS.get(role)
        if hint and hint not in hints:
            hints.append(hint)
    return " ".join(hints)


def build_video_recipe_plan_from_records(
    records: list[dict],
    target_data: dict,
    recipe_id: Optional[str],
    *,
    camera: Optional[str] = None,
) -> dict:
    normalized_recipe_id = normalize_video_recipe_id(recipe_id)
    if recipe_id == "auto" or normalized_recipe_id is None:
        normalized_recipe_id = normalized_recipe_id or infer_video_recipe_id(records, target_data)

    recipe = get_video_recipe(normalized_recipe_id) if normalized_recipe_id else None
    present_roles = _ordered_roles(records)
    if recipe is None:
        return {
            "recipe_id": None,
            "label": "Auto",
            "ready": False,
            "required_roles": [],
            "optional_roles": [],
            "present_roles": present_roles,
            "missing_roles": [],
            "recommended_generation_path": "image_to_video",
            "prompt_sections": {
                "brief": "Auto recipe not determined yet.",
                "refs": _refs_section(records),
                "action": "Select a recipe or label reference roles for a stricter motion contract.",
                "camera": camera or "auto",
                "audio": "Instrumental background bed by default, no speech unless requested.",
                "preserve": "Preserve any explicitly labeled identity, product, and source-frame references.",
                "avoid": "Avoid text overlays, identity drift, product drift, and sudden scene cuts.",
            },
        }

    missing_roles = [role for role in recipe.required_roles if role not in present_roles]
    target_title = target_data.get("title") if isinstance(target_data.get("title"), str) else None
    camera_mode = camera or recipe.default_camera
    return {
        "recipe_id": recipe.id,
        "label": recipe.label,
        "ready": len(missing_roles) == 0,
        "required_roles": list(recipe.required_roles),
        "optional_roles": list(recipe.optional_roles),
        "present_roles": present_roles,
        "missing_roles": missing_roles,
        "recommended_generation_path": recipe.recommended_generation_path,
        "prompt_sections": {
            "brief": f"{recipe.label}: {target_title or 'untitled video'}",
            "refs": _refs_section(records),
            "action": recipe.action_hint,
            "camera": f"{camera_mode} camera; default aspect {recipe.default_aspect_ratio}.",
            "audio": recipe.audio_hint,
            "preserve": _preserve_section(recipe, present_roles),
            "avoid": recipe.avoid_hint,
        },
    }


def build_video_recipe_plan(
    node_id: int,
    recipe_id: Optional[str],
    *,
    camera: Optional[str] = None,
) -> dict:
    records, target_data = _collect_plan_context(node_id)
    if target_data is None:
        raise ValueError(f"node {node_id} not found")
    return build_video_recipe_plan_from_records(
        records,
        target_data,
        recipe_id,
        camera=camera,
    )


def format_video_recipe_plan_for_prompt(plan: dict) -> str:
    sections = plan.get("prompt_sections")
    if not isinstance(sections, dict):
        sections = {}
    missing = plan.get("missing_roles") or []
    readiness = (
        "ready"
        if plan.get("ready")
        else f"missing roles: {', '.join(missing) or 'recipe not selected'}"
    )
    return "\n\n".join(
        [
            "VIDEO RECIPE PLAN",
            f"Recipe: {plan.get('label') or plan.get('recipe_id') or 'Auto'}",
            f"Readiness: {readiness}",
            f"Recommended generation path: {plan.get('recommended_generation_path')}",
            f"Role-bound references:\n{sections.get('refs', '')}",
            f"Action:\n{sections.get('action', '')}",
            f"Camera:\n{sections.get('camera', '')}",
            f"Audio:\n{sections.get('audio', '')}",
            f"Preserve:\n{sections.get('preserve', '')}",
            f"Avoid:\n{sections.get('avoid', '')}",
        ]
    )
