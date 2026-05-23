"""Short-video recipe catalog.

The catalog is the structured layer above prompt text: each recipe declares
which reference roles it expects, sensible generation defaults, and the motion
contract appended to the video auto-prompt system prompt.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional


@dataclass(frozen=True)
class VideoRecipe:
    id: str
    label: str
    required_roles: tuple[str, ...]
    optional_roles: tuple[str, ...]
    default_camera: str
    default_aspect_ratio: str
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
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
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
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
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
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
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
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
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
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
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
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
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
        default_camera="static",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
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
        default_camera="dynamic",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
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
        default_camera="dynamic",
        default_aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
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
