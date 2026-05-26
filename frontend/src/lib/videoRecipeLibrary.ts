import type { NodeType, RefRole, VideoRecipeId } from "../api/client";

export type VideoSourceMode = "text" | "first_frame" | "first_last" | "ingredients" | "edit";
export type VideoRecipeNodeKind =
  | "product"
  | "location"
  | "brand"
  | "campaign"
  | "audio"
  | "character"
  | "media";
export type VideoExportPresetKey = "portrait_1080" | "landscape_1080" | "square_1080";
export type VideoRecipeQaStatus =
  | "untested"
  | "mocked"
  | "real_pass"
  | "blocked_quota"
  | "blocked_access"
  | "blocked_v2v";
export type VideoRecipeUiPlacement = "generation_dialog" | "project_sidebar";

export interface VideoRecipeShot {
  title: string;
  action: string;
  durationSec: number;
}

export interface VideoRecipeDefinition {
  id: VideoRecipeId;
  label: string;
  summary: string;
  requiredNodeKinds: readonly VideoRecipeNodeKind[];
  optionalNodeKinds: readonly VideoRecipeNodeKind[];
  requiredRoles: readonly RefRole[];
  optionalRoles: readonly RefRole[];
  allowedSourceModes: readonly VideoSourceMode[];
  defaultSourceMode: VideoSourceMode;
  durationRangeSec: { min: number; max: number; recommended: number };
  defaultCamera: "static" | "dynamic";
  defaultAspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE" | "VIDEO_ASPECT_RATIO_PORTRAIT";
  exportPreset: VideoExportPresetKey;
  scaffold: boolean;
  uiPlacement: VideoRecipeUiPlacement;
  qaStatus: VideoRecipeQaStatus;
  promptContract: string;
  preserve: string;
  avoid: string;
  timelineShots: readonly VideoRecipeShot[];
}

export interface VideoRecipePromptInput {
  basePrompt: string;
  sourceMode: VideoSourceMode;
  durationSec: number;
  cameraInstruction?: string;
  audioInstruction?: string;
  campaignBrief?: string;
}

export interface VideoRecipePreflightContext {
  sourceMode: VideoSourceMode;
  durationSec: number;
  presentNodeKinds: readonly VideoRecipeNodeKind[];
  hasFirstFrame: boolean;
  hasLastFrame: boolean;
  hasIngredientRefs: boolean;
  hasEditSource: boolean;
  hasCampaignBrief?: boolean;
  hasCampaignCta?: boolean;
  hasCampaignClaimLimits?: boolean;
}

export interface VideoRecipePreflightItem {
  key: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
}

const PROJECT_SIDEBAR_SCAFFOLD = {
  scaffold: true,
  uiPlacement: "project_sidebar",
} as const;

const CAMPAIGN_RECOMMENDED_RECIPE_IDS = new Set<VideoRecipeId>([
  "product_demo",
  "lifestyle_ad",
  "ugc_testimonial",
  "before_after",
  "brand_bumper",
  "audio_led",
  "packshot_loop",
  "storyboard_sequence",
]);

export const VIDEO_RECIPE_LIBRARY = [
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "product_demo",
    label: "Product demo",
    summary: "One visible product operation with product fidelity locked.",
    qaStatus: "real_pass",
    requiredNodeKinds: ["product", "media"],
    optionalNodeKinds: ["brand", "campaign", "location", "audio", "character"],
    requiredRoles: ["product_ref", "first_frame"],
    optionalRoles: ["package_ref", "background_ref", "style_ref", "campaign_ref", "audio_ref", "character_ref"],
    allowedSourceModes: ["first_frame", "ingredients", "edit"],
    defaultSourceMode: "first_frame",
    durationRangeSec: { min: 4, max: 8, recommended: 6 },
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Demonstrate one concrete product use, feature, or handling step. Keep the product centered and readable for the whole clip.",
    preserve: "Preserve product shape, material, color, logo or label area, buttons, caps, nozzles, and real-world scale.",
    avoid: "No invented labels, fake UI, extra product variants, warped hands, or motion blur over key details.",
    timelineShots: [
      { title: "Hero setup", action: "Show product clearly in its use context.", durationSec: 2 },
      { title: "Operation", action: "Perform one readable product action.", durationSec: 3 },
      { title: "Result hold", action: "Hold final product state for inspection.", durationSec: 1 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "lifestyle_ad",
    label: "Lifestyle ad",
    summary: "Product in a believable location with brand mood and human context.",
    qaStatus: "blocked_quota",
    requiredNodeKinds: ["product", "location"],
    optionalNodeKinds: ["brand", "campaign", "character", "audio", "media"],
    requiredRoles: ["product_ref", "background_ref"],
    optionalRoles: ["character_ref", "style_ref", "campaign_ref", "audio_ref", "first_frame"],
    allowedSourceModes: ["text", "first_frame", "ingredients"],
    defaultSourceMode: "first_frame",
    durationRangeSec: { min: 6, max: 10, recommended: 8 },
    defaultCamera: "dynamic",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Create a polished lifestyle ad beat where product, location, and mood all support one clear use case.",
    preserve: "Preserve product identity, location logic, brand tone, palette, and character continuity when present.",
    avoid: "No random location changes, floating product, fake captions, or unsupported claims.",
    timelineShots: [
      { title: "Context", action: "Establish location and product presence.", durationSec: 2 },
      { title: "Lifestyle action", action: "Show product naturally used or approached.", durationSec: 4 },
      { title: "Brand hold", action: "End on product and brand mood.", durationSec: 2 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "ugc_testimonial",
    label: "UGC testimonial",
    summary: "Creator-style product proof without forced captions or unsafe claims.",
    qaStatus: "blocked_quota",
    requiredNodeKinds: ["product", "character"],
    optionalNodeKinds: ["brand", "campaign", "location", "audio", "media"],
    requiredRoles: ["product_ref", "character_ref"],
    optionalRoles: ["first_frame", "background_ref", "style_ref", "campaign_ref", "audio_ref"],
    allowedSourceModes: ["text", "first_frame", "ingredients", "edit"],
    defaultSourceMode: "first_frame",
    durationRangeSec: { min: 6, max: 10, recommended: 8 },
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Create casual creator footage: product shown to camera, one honest-looking gesture, subtle reaction, no unscripted claim text.",
    preserve: "Preserve creator identity, product design, room tone, handheld framing, and believable human motion.",
    avoid: "No lip-sync unless exact script is supplied, no testimonial captions, no fake labels, no exaggerated results.",
    timelineShots: [
      { title: "Creator hook", action: "Creator brings product into frame.", durationSec: 2 },
      { title: "Detail proof", action: "Point to or show one visible product detail.", durationSec: 4 },
      { title: "Reaction", action: "Subtle satisfied reaction and product hold.", durationSec: 2 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "cinematic_reveal",
    label: "Cinematic reveal",
    summary: "Mood-first reveal with controlled camera and identity locks.",
    qaStatus: "blocked_quota",
    requiredNodeKinds: ["media"],
    optionalNodeKinds: ["product", "brand", "location", "audio", "character"],
    requiredRoles: ["first_frame"],
    optionalRoles: ["last_frame", "product_ref", "background_ref", "style_ref", "audio_ref", "character_ref"],
    allowedSourceModes: ["first_frame", "first_last", "ingredients"],
    defaultSourceMode: "first_frame",
    durationRangeSec: { min: 4, max: 8, recommended: 6 },
    defaultCamera: "dynamic",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE",
    exportPreset: "landscape_1080",
    promptContract: "Reveal subject with one cinematic motion: light sweep, slow push, parallax, door open, cloth lift, or shadow-to-hero.",
    preserve: "Preserve subject identity, silhouette, material, lighting direction, and endpoint composition.",
    avoid: "No abrupt cuts, random new objects, excessive smoke, unreadable subject, or identity drift.",
    timelineShots: [
      { title: "Conceal", action: "Begin with partial view or atmospheric occlusion.", durationSec: 2 },
      { title: "Reveal", action: "Move camera or light to reveal the subject.", durationSec: 3 },
      { title: "Hero frame", action: "Hold final cinematic composition.", durationSec: 1 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "before_after",
    label: "Before / after",
    summary: "Readable transformation from a first frame to a final frame.",
    qaStatus: "blocked_quota",
    requiredNodeKinds: ["media"],
    optionalNodeKinds: ["product", "brand", "campaign", "character", "audio"],
    requiredRoles: ["first_frame", "last_frame"],
    optionalRoles: ["product_ref", "character_ref", "style_ref", "campaign_ref", "audio_ref"],
    allowedSourceModes: ["first_last", "edit"],
    defaultSourceMode: "first_last",
    durationRangeSec: { min: 4, max: 8, recommended: 6 },
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Create a clear transition from before frame to after frame while keeping identity, pose logic, and lighting continuity stable.",
    preserve: "Preserve subject identity, product identity, pose continuity, framing, and final endpoint.",
    avoid: "No misleading medical or beauty claims, impossible morphs, fake UI labels, jump cuts, or identity drift.",
    timelineShots: [
      { title: "Before", action: "Open on the first frame state.", durationSec: 2 },
      { title: "Transition", action: "Move smoothly toward the final frame.", durationSec: 3 },
      { title: "After", action: "Hold the last frame state clearly.", durationSec: 1 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "location_establishing",
    label: "Location establishing",
    summary: "Set the place, mood, and movement before a story beat.",
    qaStatus: "untested",
    requiredNodeKinds: ["location"],
    optionalNodeKinds: ["brand", "product", "character", "audio", "media"],
    requiredRoles: ["background_ref"],
    optionalRoles: ["style_ref", "product_ref", "character_ref", "audio_ref", "first_frame"],
    allowedSourceModes: ["text", "first_frame", "ingredients"],
    defaultSourceMode: "text",
    durationRangeSec: { min: 4, max: 8, recommended: 6 },
    defaultCamera: "dynamic",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE",
    exportPreset: "landscape_1080",
    promptContract: "Establish a real-feeling place with one motivated camera move and clear spatial geography.",
    preserve: "Preserve location architecture, lighting, weather, palette, and continuity for downstream shots.",
    avoid: "No random signage, warped architecture, unexplained time-of-day changes, or cluttered text.",
    timelineShots: [
      { title: "Wide place", action: "Open on a readable wide location.", durationSec: 3 },
      { title: "Move inward", action: "Glide toward the story area or product context.", durationSec: 3 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "brand_bumper",
    label: "Brand bumper",
    summary: "Short branded opener or closer with strict logo and tone control.",
    qaStatus: "blocked_quota",
    requiredNodeKinds: ["brand"],
    optionalNodeKinds: ["product", "campaign", "audio", "media", "location"],
    requiredRoles: ["style_ref"],
    optionalRoles: ["product_ref", "audio_ref", "campaign_ref", "first_frame", "background_ref"],
    allowedSourceModes: ["text", "first_frame", "ingredients", "edit"],
    defaultSourceMode: "text",
    durationRangeSec: { min: 2, max: 6, recommended: 4 },
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Create a concise branded bumper: one visual mark, one motion idea, one clean ending.",
    preserve: "Preserve brand palette, typography area, logo proportions when supplied, CTA tone, and legal limits.",
    avoid: "No invented claims, random taglines, extra logos, unreadable typography, or crowded composition.",
    timelineShots: [
      { title: "Brand mark", action: "Introduce the brand visual or product mark.", durationSec: 2 },
      { title: "End card motion", action: "Resolve to clean branded hold.", durationSec: 2 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "audio_led",
    label: "Voiceover / audio-led",
    summary: "Video structured around voice, rhythm, or sound design.",
    qaStatus: "untested",
    requiredNodeKinds: ["audio"],
    optionalNodeKinds: ["brand", "campaign", "product", "character", "location", "media"],
    requiredRoles: ["audio_ref"],
    optionalRoles: ["product_ref", "character_ref", "background_ref", "style_ref", "campaign_ref", "first_frame"],
    allowedSourceModes: ["text", "ingredients", "edit"],
    defaultSourceMode: "text",
    durationRangeSec: { min: 6, max: 10, recommended: 8 },
    defaultCamera: "dynamic",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Let audio timing lead the visual beats. If speech is requested, use only supplied script wording.",
    preserve: "Preserve voice direction, music energy, brand tone, and beat-to-image timing.",
    avoid: "No unscripted speech, accidental lip-sync, lyrics, garbled captions, or off-brand sound cues.",
    timelineShots: [
      { title: "Audio hook", action: "First visual lands on the opening beat.", durationSec: 2 },
      { title: "Rhythm cuts", action: "Motion follows voice or sound cadence.", durationSec: 4 },
      { title: "Final beat", action: "End on brand or product at the final audio cue.", durationSec: 2 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "transition_shot",
    label: "Transition shot",
    summary: "Bridge two scenes or assets with one motivated transition.",
    qaStatus: "untested",
    requiredNodeKinds: ["media"],
    optionalNodeKinds: ["product", "location", "brand", "audio", "character"],
    requiredRoles: ["first_frame", "last_frame"],
    optionalRoles: ["product_ref", "background_ref", "style_ref", "audio_ref", "character_ref"],
    allowedSourceModes: ["first_last", "edit", "first_frame"],
    defaultSourceMode: "first_last",
    durationRangeSec: { min: 2, max: 6, recommended: 4 },
    defaultCamera: "dynamic",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Bridge from source state to target state with one motivated wipe, match cut, object pass, whip pan, or light move.",
    preserve: "Preserve visual continuity, endpoint framing, subject identity, product identity, and motion direction.",
    avoid: "No random scene swap, hard jump cut, impossible morph, fake overlay, or endpoint mismatch.",
    timelineShots: [
      { title: "Start anchor", action: "Begin from the first frame composition.", durationSec: 1 },
      { title: "Motivated bridge", action: "Use one transition action to carry momentum.", durationSec: 2 },
      { title: "End anchor", action: "Land cleanly on the target frame.", durationSec: 1 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "packshot_loop",
    label: "Packshot / hero loop",
    summary: "Loopable hero product shot for ads, PDPs, and end cards.",
    qaStatus: "blocked_quota",
    requiredNodeKinds: ["product", "media"],
    optionalNodeKinds: ["brand", "campaign", "location", "audio"],
    requiredRoles: ["product_ref", "first_frame"],
    optionalRoles: ["package_ref", "style_ref", "background_ref", "campaign_ref", "audio_ref"],
    allowedSourceModes: ["first_frame", "ingredients", "edit"],
    defaultSourceMode: "first_frame",
    durationRangeSec: { min: 4, max: 6, recommended: 4 },
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Create a clean loopable hero shot: micro rotation, light sweep, condensation, texture shimmer, or platform turn.",
    preserve: "Preserve product silhouette, packaging, label area, material, reflection, scale, and centered hero composition.",
    avoid: "No label drift, added products, cropped packaging, fast spin, fake typography, or non-looping endpoint jump.",
    timelineShots: [
      { title: "Hero frame", action: "Open on clean centered product.", durationSec: 1 },
      { title: "Micro motion", action: "Use subtle loop-safe product or lighting motion.", durationSec: 2 },
      { title: "Loop return", action: "Return to a matching hero hold.", durationSec: 1 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "fashion_fit_check",
    label: "Fashion fit check",
    summary: "Outfit-focused one-shot with character identity and full fit readable.",
    qaStatus: "mocked",
    requiredNodeKinds: ["character", "product", "media"],
    optionalNodeKinds: ["location", "brand", "audio"],
    requiredRoles: ["character_ref", "first_frame"],
    optionalRoles: ["product_ref", "background_ref", "style_ref", "audio_ref"],
    allowedSourceModes: ["first_frame", "ingredients", "edit"],
    defaultSourceMode: "first_frame",
    durationRangeSec: { min: 4, max: 8, recommended: 6 },
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Keep the full outfit readable while the character performs one natural try-on motion.",
    preserve: "Preserve character identity, outfit silhouette, fabric drape, source framing, and visible accessories.",
    avoid: "No hard runway pose sequence, fast crop, hidden outfit details, warped hands, or identity drift.",
    timelineShots: [
      { title: "Full-body setup", action: "Show the outfit clearly before motion.", durationSec: 2 },
      { title: "Fit motion", action: "Use one subtle turn, weight shift, or garment adjustment.", durationSec: 3 },
      { title: "Outfit hold", action: "End on readable full-fit pose.", durationSec: 1 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "mirror_selfie",
    label: "Mirror selfie",
    summary: "Casual mirror/phone clip with stable reflection geometry.",
    qaStatus: "mocked",
    requiredNodeKinds: ["character", "media"],
    optionalNodeKinds: ["product", "location", "brand", "audio"],
    requiredRoles: ["character_ref", "first_frame"],
    optionalRoles: ["product_ref", "background_ref", "style_ref", "audio_ref"],
    allowedSourceModes: ["first_frame", "ingredients", "edit"],
    defaultSourceMode: "first_frame",
    durationRangeSec: { min: 4, max: 8, recommended: 6 },
    defaultCamera: "static",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Treat the phone and mirror as fixed source-frame geometry; use only small natural selfie motion.",
    preserve: "Preserve character identity, phone/mirror geometry, outfit, room mood, and handheld framing.",
    avoid: "No duplicate phones, warped reflections, extra hands, sudden cuts, captions, or text overlays.",
    timelineShots: [
      { title: "Mirror setup", action: "Hold readable mirror composition.", durationSec: 2 },
      { title: "Phone tilt", action: "Use small phone tilt or weight shift.", durationSec: 3 },
      { title: "Outfit hold", action: "End with stable outfit readability.", durationSec: 1 },
    ],
  },
  {
    ...PROJECT_SIDEBAR_SCAFFOLD,
    id: "storyboard_sequence",
    label: "Storyboard sequence",
    summary: "Build shot-frame nodes, shot-clip nodes, and a timeline from a sequence brief.",
    qaStatus: "mocked",
    requiredNodeKinds: ["media"],
    optionalNodeKinds: ["product", "location", "brand", "campaign", "audio", "character"],
    requiredRoles: ["storyboard_ref"],
    optionalRoles: ["character_ref", "product_ref", "background_ref", "campaign_ref", "audio_ref"],
    allowedSourceModes: ["first_frame"],
    defaultSourceMode: "first_frame",
    durationRangeSec: { min: 2, max: 10, recommended: 4 },
    defaultCamera: "dynamic",
    defaultAspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
    exportPreset: "portrait_1080",
    promptContract: "Convert a sequence brief or storyboard context into per-shot first frames, clips, and timeline assembly.",
    preserve: "Preserve panel order, subject/product/location continuity, lighting, palette, and shot intent.",
    avoid: "No panel order confusion, random cuts, caption drift, changed identity, or product drift.",
    timelineShots: [
      { title: "Plan", action: "Define ordered shot beats.", durationSec: 1 },
      { title: "Frames", action: "Generate first frame per shot.", durationSec: 1 },
      { title: "Clips", action: "Generate one clip per shot.", durationSec: 1 },
      { title: "Timeline", action: "Review and export final sequence.", durationSec: 1 },
    ],
  },
] satisfies readonly VideoRecipeDefinition[];

const RECIPE_BY_ID = new Map<VideoRecipeId, VideoRecipeDefinition>(
  VIDEO_RECIPE_LIBRARY.map((recipe) => [recipe.id, recipe]),
);

const NODE_KIND_LABELS: Record<VideoRecipeNodeKind, string> = {
  product: "Product",
  location: "Location",
  brand: "Brand",
  campaign: "Campaign",
  audio: "Audio",
  character: "Character",
  media: "Media",
};

const SOURCE_MODE_LABELS: Record<VideoSourceMode, string> = {
  text: "Text",
  first_frame: "First frame",
  first_last: "First+last",
  ingredients: "Ingredients",
  edit: "Edit",
};

const EXPORT_PRESET_LABELS: Record<VideoExportPresetKey, string> = {
  portrait_1080: "9:16 1080p",
  landscape_1080: "16:9 1080p",
  square_1080: "1:1 1080p",
};

const QA_STATUS_LABELS: Record<VideoRecipeQaStatus, string> = {
  untested: "Untested real Flow",
  mocked: "Mocked QA",
  real_pass: "Real Flow pass",
  blocked_quota: "Blocked by quota",
  blocked_access: "Blocked by access",
  blocked_v2v: "Blocked by V2V gate",
};

export function findVideoRecipeDefinition(id: unknown): VideoRecipeDefinition | undefined {
  return typeof id === "string" ? RECIPE_BY_ID.get(id as VideoRecipeId) : undefined;
}

export function labelForRecipeNodeKind(kind: VideoRecipeNodeKind): string {
  return NODE_KIND_LABELS[kind] ?? kind;
}

export function labelForVideoSourceMode(mode: VideoSourceMode): string {
  return SOURCE_MODE_LABELS[mode] ?? mode;
}

export function labelForExportPreset(preset: VideoExportPresetKey): string {
  return EXPORT_PRESET_LABELS[preset] ?? preset;
}

export function labelForRecipeQaStatus(status: VideoRecipeQaStatus): string {
  return QA_STATUS_LABELS[status] ?? status;
}

export function sourceModeFromRecommendedPath(path: string | undefined): VideoSourceMode | null {
  if (!path) return null;
  if (path === "first_last_frame") return "first_last";
  if (path === "ingredients_to_video") return "ingredients";
  if (path === "text_to_video") return "text";
  if (path === "video_edit") return "edit";
  if (path === "image_to_video" || path === "per_shot_sequence") return "first_frame";
  return null;
}

export function recipeNodeKindsForSource(input: {
  type: NodeType | string;
  refRole?: RefRole | null;
  hasMedia?: boolean;
}): VideoRecipeNodeKind[] {
  const kinds = new Set<VideoRecipeNodeKind>();
  const { type, refRole, hasMedia } = input;
  if (type === "product" || refRole === "product_ref" || refRole === "package_ref") kinds.add("product");
  if (type === "location" || refRole === "background_ref") kinds.add("location");
  if (type === "brand") kinds.add("brand");
  if (type === "campaign" || refRole === "campaign_ref") kinds.add("campaign");
  if (type === "audio" || refRole === "audio_ref") kinds.add("audio");
  if (type === "character" || refRole === "character_ref") kinds.add("character");
  if (hasMedia || type === "image" || type === "visual_asset" || type === "Storyboard" || type === "video") {
    kinds.add("media");
  }
  return Array.from(kinds);
}

export function buildVideoRecipePrompt(
  recipe: VideoRecipeDefinition,
  input: VideoRecipePromptInput,
): string {
  const base = input.basePrompt.trim() || `${recipe.label} video.`;
  const shotStructure = recipe.timelineShots
    .map((shot, index) => `${index + 1}. ${shot.title}: ${shot.action}`)
    .join(" ");
  return [
    base,
    `${recipe.label} recipe: ${recipe.promptContract}`,
    `Source mode: ${labelForVideoSourceMode(input.sourceMode)}. Target duration: ${input.durationSec}s.`,
    `Suggested shot structure: ${shotStructure}`,
    input.campaignBrief ? `Campaign brief: ${input.campaignBrief}` : undefined,
    input.cameraInstruction,
    input.audioInstruction,
    `Preserve: ${recipe.preserve}`,
    `Avoid: ${recipe.avoid}`,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim().replace(/\.+$/, ""))
    .join(". ");
}

export function buildVideoRecipePreflight(
  recipe: VideoRecipeDefinition,
  context: VideoRecipePreflightContext,
): VideoRecipePreflightItem[] {
  const present = new Set(context.presentNodeKinds);
  const missingKinds = recipe.requiredNodeKinds.filter((kind) => !present.has(kind));
  const sourceModeAllowed = recipe.allowedSourceModes.includes(context.sourceMode);
  const durationOk =
    context.durationSec >= recipe.durationRangeSec.min
    && context.durationSec <= recipe.durationRangeSec.max;

  const sourceReady =
    context.sourceMode === "text"
      ? true
      : context.sourceMode === "first_frame"
        ? context.hasFirstFrame
        : context.sourceMode === "first_last"
          ? context.hasFirstFrame && context.hasLastFrame
          : context.sourceMode === "ingredients"
            ? context.hasIngredientRefs
            : context.hasEditSource;
  const sourceDetail =
    context.sourceMode === "first_last"
      ? "Needs first-frame and last-frame refs."
      : context.sourceMode === "first_frame"
        ? "Needs a selected first-frame media source."
        : context.sourceMode === "ingredients"
          ? "Needs at least one ingredient media ref."
          : context.sourceMode === "edit"
            ? "Needs an upstream rendered video."
            : "Text-to-video path needs no media source.";

  const items: VideoRecipePreflightItem[] = [
    {
      key: "kinds",
      label: "Required nodes",
      ok: missingKinds.length === 0,
      blocking: true,
      detail: missingKinds.length === 0
        ? recipe.requiredNodeKinds.map(labelForRecipeNodeKind).join(", ")
        : `Missing ${missingKinds.map(labelForRecipeNodeKind).join(", ")}`,
    },
    {
      key: "source_mode",
      label: "Source mode",
      ok: sourceModeAllowed,
      blocking: true,
      detail: sourceModeAllowed
        ? labelForVideoSourceMode(context.sourceMode)
        : `Allowed: ${recipe.allowedSourceModes.map(labelForVideoSourceMode).join(", ")}`,
    },
    {
      key: "source_ready",
      label: "Source input",
      ok: sourceReady,
      blocking: true,
      detail: sourceReady ? "Ready" : sourceDetail,
    },
    {
      key: "duration",
      label: "Duration",
      ok: durationOk,
      blocking: true,
      detail: `${context.durationSec}s target; recipe range ${recipe.durationRangeSec.min}-${recipe.durationRangeSec.max}s`,
    },
    {
      key: "export",
      label: "Export default",
      ok: true,
      blocking: false,
      detail: labelForExportPreset(recipe.exportPreset),
    },
    {
      key: "timeline",
      label: "Timeline",
      ok: true,
      blocking: false,
      detail: recipe.timelineShots.map((shot) => shot.title).join(" > "),
    },
  ];
  if (CAMPAIGN_RECOMMENDED_RECIPE_IDS.has(recipe.id)) {
    const hasBrief = context.hasCampaignBrief === true;
    const hasCta = context.hasCampaignCta === true;
    const hasClaimLimits = context.hasCampaignClaimLimits === true;
    items.push(
      {
        key: "campaign_brief",
        label: "Campaign brief",
        ok: hasBrief,
        blocking: false,
        detail: hasBrief
          ? "Campaign node connected"
          : "Add a Campaign brief node with campaign_ref for objective, audience, offer, tone, and platform.",
      },
      {
        key: "campaign_cta_claims",
        label: "CTA / claims",
        ok: hasCta && hasClaimLimits,
        blocking: false,
        detail: hasCta && hasClaimLimits
          ? "CTA and claim limits present"
          : "Campaign should include CTA plus claimsAllowed/claimsAvoid or claim rules.",
      },
    );
  }
  return items;
}
