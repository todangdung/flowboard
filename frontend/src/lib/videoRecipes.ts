import type { RefRole, VideoRecipeId } from "../api/client";
import {
  VIDEO_RECIPE_LIBRARY,
  type VideoSourceMode,
} from "./videoRecipeLibrary";

export type VideoRecipeKey = "auto" | VideoRecipeId;

export interface VideoRecipeOption {
  key: VideoRecipeKey;
  label: string;
  defaultCamera?: "static" | "dynamic";
  defaultAspectRatio?: "VIDEO_ASPECT_RATIO_LANDSCAPE" | "VIDEO_ASPECT_RATIO_PORTRAIT";
  defaultSourceMode?: VideoSourceMode;
  scaffold?: boolean;
}

export const VIDEO_RECIPES: readonly VideoRecipeOption[] = [
  { key: "auto", label: "Auto" },
  ...VIDEO_RECIPE_LIBRARY.map((recipe) => ({
    key: recipe.id,
    label: recipe.label,
    defaultCamera: recipe.defaultCamera,
    defaultAspectRatio: recipe.defaultAspectRatio,
    defaultSourceMode: recipe.defaultSourceMode,
    scaffold: true,
  })),
  { key: "fashion_fit_check", label: "Fashion fit check", defaultCamera: "static", defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT", scaffold: true },
  { key: "mirror_selfie", label: "Mirror selfie", defaultCamera: "static", defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT", scaffold: true },
  { key: "unbox", label: "Unbox", defaultCamera: "static", defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT" },
  { key: "ugc_review", label: "UGC review", defaultCamera: "static", defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT" },
  { key: "skincare_tvc", label: "Skincare TVC", defaultCamera: "static", defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT" },
  { key: "dance", label: "Dance", defaultCamera: "dynamic", defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT" },
  { key: "storyboard_sequence", label: "Seq / Chuỗi cảnh", defaultCamera: "dynamic", defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT", scaffold: true },
];

export const FLOW_SCAFFOLD_RECIPES = VIDEO_RECIPES.filter(
  (recipe): recipe is VideoRecipeOption & { key: VideoRecipeId } =>
    recipe.scaffold === true && recipe.key !== "auto",
);

export const REF_ROLE_OPTIONS: readonly { key: "" | RefRole; label: string }[] = [
  { key: "", label: "Auto role" },
  { key: "first_frame", label: "First frame" },
  { key: "last_frame", label: "Last frame" },
  { key: "character_ref", label: "Character" },
  { key: "product_ref", label: "Product" },
  { key: "package_ref", label: "Package" },
  { key: "background_ref", label: "Background" },
  { key: "style_ref", label: "Style" },
  { key: "storyboard_ref", label: "Storyboard" },
  { key: "storyboard_panel", label: "Panel" },
  { key: "audio_ref", label: "Audio" },
  { key: "ingredient", label: "Ingredient" },
];

export const REF_ROLE_LABELS: Record<RefRole, string> = {
  first_frame: "First frame",
  last_frame: "Last frame",
  character_ref: "Character",
  product_ref: "Product",
  package_ref: "Package",
  background_ref: "Background",
  style_ref: "Style",
  storyboard_ref: "Storyboard",
  storyboard_panel: "Panel",
  audio_ref: "Audio",
  ingredient: "Ingredient",
};

export function labelForRefRole(role: RefRole): string {
  return REF_ROLE_LABELS[role] ?? role;
}

export function isVideoRecipeId(value: unknown): value is VideoRecipeId {
  return (
    typeof value === "string"
    && VIDEO_RECIPES.some((recipe) => recipe.key === value && recipe.key !== "auto")
  );
}

export function findVideoRecipe(key: VideoRecipeKey): VideoRecipeOption | undefined {
  return VIDEO_RECIPES.find((recipe) => recipe.key === key);
}
