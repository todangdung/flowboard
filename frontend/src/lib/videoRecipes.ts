import type { RefRole, VideoRecipeId } from "../api/client";
import {
  VIDEO_RECIPE_LIBRARY,
  type VideoRecipeQaStatus,
  type VideoRecipeUiPlacement,
  type VideoSourceMode,
} from "./videoRecipeLibrary";

export type VideoRecipeKey = "auto" | VideoRecipeId;

export interface VideoRecipeOption {
  key: VideoRecipeKey;
  label: string;
  defaultCamera?: "static" | "dynamic";
  defaultAspectRatio?: "VIDEO_ASPECT_RATIO_LANDSCAPE" | "VIDEO_ASPECT_RATIO_PORTRAIT";
  defaultSourceMode?: VideoSourceMode;
  allowedSourceModes?: readonly VideoSourceMode[];
  scaffold?: boolean;
  uiPlacement?: VideoRecipeUiPlacement;
  qaStatus?: VideoRecipeQaStatus;
}

export const VIDEO_RECIPES: readonly VideoRecipeOption[] = [
  { key: "auto", label: "Auto" },
  ...VIDEO_RECIPE_LIBRARY.map((recipe) => ({
    key: recipe.id,
    label: recipe.label,
    defaultCamera: recipe.defaultCamera,
    defaultAspectRatio: recipe.defaultAspectRatio,
    defaultSourceMode: recipe.defaultSourceMode,
    allowedSourceModes: recipe.allowedSourceModes,
    scaffold: recipe.scaffold,
    uiPlacement: recipe.uiPlacement,
    qaStatus: recipe.qaStatus,
  })),
  {
    key: "unbox",
    label: "Unbox",
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    defaultSourceMode: "first_last",
    allowedSourceModes: ["first_last"],
    scaffold: false,
    uiPlacement: "generation_dialog",
    qaStatus: "untested",
  },
  {
    key: "ugc_review",
    label: "UGC review",
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    defaultSourceMode: "ingredients",
    allowedSourceModes: ["ingredients", "first_frame"],
    scaffold: false,
    uiPlacement: "generation_dialog",
    qaStatus: "untested",
  },
  {
    key: "skincare_tvc",
    label: "Skincare TVC",
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    defaultSourceMode: "first_frame",
    allowedSourceModes: ["first_frame"],
    scaffold: false,
    uiPlacement: "generation_dialog",
    qaStatus: "untested",
  },
  {
    key: "dance",
    label: "Dance",
    defaultCamera: "dynamic",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    defaultSourceMode: "first_frame",
    allowedSourceModes: ["first_frame"],
    scaffold: false,
    uiPlacement: "generation_dialog",
    qaStatus: "untested",
  },
];

export const FLOW_SCAFFOLD_RECIPES = VIDEO_RECIPES.filter(
  (recipe): recipe is VideoRecipeOption & { key: VideoRecipeId } =>
    recipe.scaffold === true && recipe.uiPlacement === "project_sidebar" && recipe.key !== "auto",
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
  { key: "campaign_ref", label: "Campaign" },
  { key: "script_ref", label: "Script" },
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
  campaign_ref: "Campaign",
  script_ref: "Script",
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
