import { z } from "zod";

const nonEmptyStringSchema = z.string().min(1);
const positiveIntSchema = z.number().int().positive();
const nonNegativeIntSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().finite().nonnegative();
const volumeSchema = z.number().finite().min(0).max(2);
const finiteNumberSchema = z.number().finite();

export const nodeTypeSchema = z.enum([
  "character",
  "image",
  "video",
  "prompt",
  "note",
  "visual_asset",
  "product",
  "location",
  "brand",
  "campaign",
  "script",
  "audio",
  "Storyboard",
  "chatgpt",
]);

export const nodeStatusSchema = z.enum(["idle", "queued", "running", "done", "error"]);

export const refRoleSchema = z.enum([
  "first_frame",
  "last_frame",
  "character_ref",
  "product_ref",
  "package_ref",
  "background_ref",
  "style_ref",
  "storyboard_ref",
  "storyboard_panel",
  "campaign_ref",
  "script_ref",
  "audio_ref",
  "ingredient",
]);

export const videoRecipeIdSchema = z.enum([
  "fashion_fit_check",
  "mirror_selfie",
  "unbox",
  "product_demo",
  "lifestyle_ad",
  "ugc_review",
  "ugc_testimonial",
  "skincare_tvc",
  "cinematic_reveal",
  "before_after",
  "location_establishing",
  "brand_bumper",
  "audio_led",
  "transition_shot",
  "packshot_loop",
  "dance",
  "storyboard_sequence",
]);

export const referenceKindSchema = z.enum([
  "image",
  "video",
  "character",
  "visual_asset",
  "storyboard_shot",
  "product",
  "package",
  "location",
  "style",
  "brand",
  "campaign",
  "script",
  "audio",
  "first_frame",
]);

const unknownRecordSchema = z.record(z.string(), z.unknown());

const referenceProfileBaseSchema = z.object({
  kind: referenceKindSchema.optional(),
  mediaId: nonEmptyStringSchema.optional(),
  sourceNodeShortId: nonEmptyStringSchema.optional(),
  name: z.string().optional(),
  brief: z.string().optional(),
  aiBrief: z.string().optional(),
  prompt: z.string().optional(),
  aspectRatio: z.string().optional(),
}).passthrough();

export const productReferenceProfileSchema = referenceProfileBaseSchema.extend({
  kind: z.enum(["product", "package"]).optional(),
  productName: z.string().optional(),
  brandName: z.string().optional(),
  claimRules: z.string().optional(),
  claimsAllowed: z.string().optional(),
  claimsAvoid: z.string().optional(),
  legalNotes: z.string().optional(),
});

export const locationReferenceProfileSchema = referenceProfileBaseSchema.extend({
  kind: z.literal("location").optional(),
  locationName: z.string().optional(),
  palette: z.string().optional(),
  legalNotes: z.string().optional(),
});

export const brandReferenceProfileSchema = referenceProfileBaseSchema.extend({
  kind: z.literal("brand").optional(),
  brandName: z.string().optional(),
  brandTone: z.string().optional(),
  palette: z.string().optional(),
  cta: z.string().optional(),
  legalNotes: z.string().optional(),
});

export const campaignReferenceProfileSchema = referenceProfileBaseSchema.extend({
  kind: z.literal("campaign").optional(),
  objective: z.string().optional(),
  audience: z.string().optional(),
  offer: z.string().optional(),
  cta: z.string().optional(),
  claimRules: z.string().optional(),
  tone: z.string().optional(),
  platform: z.string().optional(),
  mustInclude: z.string().optional(),
  mustAvoid: z.string().optional(),
});

export const scriptReferenceProfileSchema = referenceProfileBaseSchema.extend({
  kind: z.literal("script").optional(),
  scriptHook: z.string().optional(),
  voiceoverText: z.string().optional(),
  onScreenText: z.string().optional(),
  captionText: z.string().optional(),
  scriptBeats: z.string().optional(),
  language: z.string().optional(),
  pacing: z.string().optional(),
  pronunciation: z.string().optional(),
  mustSay: z.string().optional(),
  mustNotSay: z.string().optional(),
});

export const audioReferenceProfileSchema = referenceProfileBaseSchema.extend({
  kind: z.literal("audio").optional(),
  voiceName: z.string().optional(),
  speaker: z.string().optional(),
  language: z.string().optional(),
  pacing: z.string().optional(),
  pronunciation: z.string().optional(),
});

const allKnownReferenceProfileFieldsSchema = referenceProfileBaseSchema.extend({
  productName: z.string().optional(),
  brandName: z.string().optional(),
  locationName: z.string().optional(),
  characterName: z.string().optional(),
  voiceName: z.string().optional(),
  claimRules: z.string().optional(),
  brandTone: z.string().optional(),
  objective: z.string().optional(),
  audience: z.string().optional(),
  offer: z.string().optional(),
  scriptHook: z.string().optional(),
  voiceoverText: z.string().optional(),
  onScreenText: z.string().optional(),
  captionText: z.string().optional(),
  scriptBeats: z.string().optional(),
  language: z.string().optional(),
  pacing: z.string().optional(),
  speaker: z.string().optional(),
  pronunciation: z.string().optional(),
  mustSay: z.string().optional(),
  mustNotSay: z.string().optional(),
  claimsAllowed: z.string().optional(),
  claimsAvoid: z.string().optional(),
  tone: z.string().optional(),
  platform: z.string().optional(),
  mustInclude: z.string().optional(),
  mustAvoid: z.string().optional(),
  palette: z.string().optional(),
  cta: z.string().optional(),
  legalNotes: z.string().optional(),
});

export const referenceProfileSchema = allKnownReferenceProfileFieldsSchema;

type ReferenceProfileIssue = {
  path: Array<string | number | symbol>;
  message: string;
};

const referenceProfileSchemasByKind: Partial<Record<
  ReferenceKind,
  z.ZodType<unknown>
>> = {
  product: productReferenceProfileSchema,
  package: productReferenceProfileSchema,
  location: locationReferenceProfileSchema,
  brand: brandReferenceProfileSchema,
  campaign: campaignReferenceProfileSchema,
  script: scriptReferenceProfileSchema,
  audio: audioReferenceProfileSchema,
};

function referenceProfileIssuesForKind(
  kind: ReferenceKind,
  profile: ReferenceProfile,
): ReferenceProfileIssue[] {
  const issues: ReferenceProfileIssue[] = [];
  if (profile.kind !== undefined && profile.kind !== kind) {
    issues.push({
      path: ["kind"],
      message: `must match reference kind ${kind}`,
    });
  }
  const profileSchema = referenceProfileSchemasByKind[kind];
  if (profileSchema) {
    const parsed = profileSchema.safeParse(profile);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ path: issue.path, message: issue.message });
      }
    }
  }
  return issues;
}

export const nodeDtoSchema = z.object({
  id: positiveIntSchema,
  board_id: positiveIntSchema,
  short_id: nonEmptyStringSchema,
  type: nodeTypeSchema,
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  w: finiteNumberSchema,
  h: finiteNumberSchema,
  data: unknownRecordSchema,
  status: nodeStatusSchema,
  created_at: nonEmptyStringSchema,
});

const referenceRowWireBaseSchema = z.object({
  id: positiveIntSchema,
  media_id: nonEmptyStringSchema,
  url: z.string().nullable(),
  label: z.string(),
  kind: referenceKindSchema,
  ai_brief: z.string().nullable(),
  aspect_ratio: z.string().nullable(),
  tags: z.array(z.string()),
  profile: referenceProfileSchema,
  pinned: z.boolean(),
  position: nonNegativeIntSchema,
  source_board_id: positiveIntSchema.nullable(),
  source_node_short_id: z.string().nullable(),
  created_at: nonEmptyStringSchema,
});

export const referenceRowWireSchema = referenceRowWireBaseSchema.superRefine(
  (row, ctx) => {
    for (const issue of referenceProfileIssuesForKind(row.kind, row.profile)) {
      ctx.addIssue({
        code: "custom",
        path: ["profile", ...issue.path],
        message: issue.message,
      });
    }
  },
);

export const referenceListResponseSchema = z.array(referenceRowWireSchema);

export const referenceListParamsSchema = z.object({
  q: z.string().optional(),
  pinned_first: z.boolean().optional(),
  limit: positiveIntSchema.optional(),
});

const referenceCreateInputBaseSchema = z.object({
  media_id: nonEmptyStringSchema,
  kind: referenceKindSchema,
  label: z.string().optional(),
  ai_brief: z.string().nullable().optional(),
  aspect_ratio: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  source_board_id: positiveIntSchema.nullable().optional(),
  source_node_short_id: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  profile: referenceProfileSchema.optional(),
});

export const referenceCreateInputSchema = referenceCreateInputBaseSchema.superRefine(
  (input, ctx) => {
    if (!input.profile) return;
    for (const issue of referenceProfileIssuesForKind(input.kind, input.profile)) {
      ctx.addIssue({
        code: "custom",
        path: ["profile", ...issue.path],
        message: issue.message,
      });
    }
  },
);

export const referenceFromNodeCreateInputSchema = z.object({
  node_id: positiveIntSchema,
  media_id: nonEmptyStringSchema.optional(),
  kind: referenceKindSchema.optional(),
  label: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const referencePatchInputSchema = z.object({
  label: z.string().optional(),
  pinned: z.boolean().optional(),
  position: nonNegativeIntSchema.optional(),
  tags: z.array(z.string()).optional(),
  profile: referenceProfileSchema.optional(),
}).superRefine((input, ctx) => {
  const profile = input.profile;
  if (!profile) return;
  const kind = profile.kind;
  if (!kind || !(kind in referenceProfileSchemasByKind)) return;
  for (const issue of referenceProfileIssuesForKind(kind, profile)) {
    ctx.addIssue({
      code: "custom",
      path: ["profile", ...issue.path],
      message: issue.message,
    });
  }
});

export const edgeDtoSchema = z.object({
  id: positiveIntSchema,
  board_id: positiveIntSchema,
  source_id: positiveIntSchema,
  target_id: positiveIntSchema,
  kind: nonEmptyStringSchema,
  source_variant_idx: nonNegativeIntSchema.nullable(),
  ref_role: refRoleSchema.nullable(),
});

export const timelineCaptionModeSchema = z.enum(["none", "burn_in"]);
export const timelineCaptionFormatSchema = z.literal("ass");
export const timelineAudioModeSchema = z.enum(["none", "mix"]);
export const timelineTransitionTypeSchema = z.enum(["cut", "fade"]);
export const timelineExportStatusSchema = z.enum(["fresh", "stale"]);
export const timelineQaStatusSchema = z.enum(["ok", "warning", "blocked"]);

export const timelineClipEditMetadataSchema = z.object({
  shotId: nonEmptyStringSchema,
  trimStartSec: nonNegativeNumberSchema,
  trimEndSec: nonNegativeNumberSchema,
});

export const timelineTransitionMetadataSchema = z.object({
  fromShotId: nonEmptyStringSchema,
  toShotId: nonEmptyStringSchema,
  type: timelineTransitionTypeSchema,
  durationSec: nonNegativeNumberSchema,
});

export const timelineAudioMediaIdsSchema = z.object({
  voiceover: nonEmptyStringSchema.optional(),
  music: nonEmptyStringSchema.optional(),
});

export const timelineAudioMixSchema = z.object({
  clipVolume: volumeSchema.optional(),
  voiceoverVolume: volumeSchema.optional(),
  musicVolume: volumeSchema.optional(),
});

export const timelineCaptionStyleSchema = z.object({
  name: nonEmptyStringSchema,
  font: nonEmptyStringSchema,
  fontSize: positiveIntSchema,
  alignment: nonEmptyStringSchema,
  marginL: nonNegativeIntSchema,
  marginR: nonNegativeIntSchema,
  marginV: nonNegativeIntSchema,
  boxColor: nonEmptyStringSchema,
});

export const timelineExportHistoryItemSchema = z.object({
  mediaId: nonEmptyStringSchema,
  status: timelineExportStatusSchema.optional(),
  version: nonNegativeIntSchema.optional(),
  exportedAt: nonEmptyStringSchema.optional(),
  clipCount: nonNegativeIntSchema.optional(),
  size: nonEmptyStringSchema.optional(),
  sourceMediaIds: z.array(nonEmptyStringSchema).optional(),
  sourceShotIds: z.array(nonEmptyStringSchema).optional(),
  durationsSec: z.array(nonNegativeNumberSchema.nullable()).optional(),
  effectiveDurationsSec: z.array(nonNegativeNumberSchema).optional(),
  clipEdits: z.array(timelineClipEditMetadataSchema).optional(),
  transitions: z.array(timelineTransitionMetadataSchema).optional(),
  captions: z.array(z.string().nullable()).optional(),
  captionMode: timelineCaptionModeSchema.optional(),
  captionFormat: timelineCaptionFormatSchema.optional(),
  captionStyle: timelineCaptionStyleSchema.optional(),
  audioMode: timelineAudioModeSchema.optional(),
  audioMediaIds: timelineAudioMediaIdsSchema.optional(),
  audioMix: timelineAudioMixSchema.optional(),
  staleAt: nonEmptyStringSchema.optional(),
  staleReason: nonEmptyStringSchema.optional(),
});

export const timelineExportRequestSchema = z.object({
  width: positiveIntSchema.optional(),
  height: positiveIntSchema.optional(),
  caption_mode: timelineCaptionModeSchema.optional(),
  audio_mode: timelineAudioModeSchema.optional(),
  voiceover_media_id: nonEmptyStringSchema.optional(),
  music_media_id: nonEmptyStringSchema.optional(),
  voiceover_volume: volumeSchema.optional(),
  music_volume: volumeSchema.optional(),
  clip_edits: z.array(z.object({
    shot_id: nonEmptyStringSchema,
    trim_start_sec: nonNegativeNumberSchema,
    trim_end_sec: nonNegativeNumberSchema,
  })).optional(),
  transitions: z.array(z.object({
    from_shot_id: nonEmptyStringSchema,
    to_shot_id: nonEmptyStringSchema,
    type: timelineTransitionTypeSchema,
    duration_sec: nonNegativeNumberSchema,
  })).optional(),
});

export const timelineExportResponseSchema = z.object({
  timeline_node_id: positiveIntSchema,
  media_id: nonEmptyStringSchema,
  url: nonEmptyStringSchema,
  clip_count: nonNegativeIntSchema,
  source_media_ids: z.array(nonEmptyStringSchema),
  width: positiveIntSchema,
  height: positiveIntSchema,
  exported_at: nonEmptyStringSchema.optional(),
  export_status: z.literal("fresh").optional(),
  export_version: nonNegativeIntSchema.optional(),
  export_history: z.array(timelineExportHistoryItemSchema).optional(),
  source_shot_ids: z.array(nonEmptyStringSchema).optional(),
  clip_durations_sec: z.array(nonNegativeNumberSchema.nullable()).optional(),
  clip_effective_durations_sec: z.array(nonNegativeNumberSchema).optional(),
  export_clip_edits: z.array(timelineClipEditMetadataSchema).optional(),
  export_transitions: z.array(timelineTransitionMetadataSchema).optional(),
  clip_captions: z.array(z.string().nullable()).optional(),
  export_caption_mode: timelineCaptionModeSchema.optional(),
  export_caption_format: timelineCaptionFormatSchema.optional(),
  export_caption_style: timelineCaptionStyleSchema.optional(),
  export_audio_mode: timelineAudioModeSchema.optional(),
  export_audio_media_ids: timelineAudioMediaIdsSchema.optional(),
  export_audio_mix: timelineAudioMixSchema.optional(),
});

export const timelineQaIssueSchema = z.object({
  severity: timelineQaStatusSchema,
  code: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
});

export const timelineQaItemSchema = z.object({
  shotId: nonEmptyStringSchema,
  nodeId: positiveIntSchema.nullable().optional(),
  mediaId: nonEmptyStringSchema.nullable().optional(),
  status: timelineQaStatusSchema,
  issues: z.array(timelineQaIssueSchema),
  metrics: z.record(
    z.string(),
    z.union([z.number().finite(), z.boolean(), z.null()]),
  ).optional(),
});

export const timelineQaResponseSchema = z.object({
  timeline_node_id: positiveIntSchema,
  status: timelineQaStatusSchema,
  checked_at: nonEmptyStringSchema,
  summary: z.object({
    ok: nonNegativeIntSchema,
    warning: nonNegativeIntSchema,
    blocked: nonNegativeIntSchema,
  }),
  items: z.array(timelineQaItemSchema),
});

export const timelineQaRequestSchema = z.object({
  width: positiveIntSchema.optional(),
  height: positiveIntSchema.optional(),
});

export const videoRecipeDtoSchema = z.object({
  id: videoRecipeIdSchema,
  label: nonEmptyStringSchema,
  required_roles: z.array(refRoleSchema),
  optional_roles: z.array(refRoleSchema),
  recommended_generation_path: nonEmptyStringSchema,
  default_camera: z.enum(["static", "dynamic"]),
  default_aspect_ratio: nonEmptyStringSchema,
  default_source_mode: nonEmptyStringSchema.optional(),
  required_node_kinds: z.array(nonEmptyStringSchema).optional(),
  allowed_source_modes: z.array(nonEmptyStringSchema).optional(),
  duration_range_sec: z.array(nonNegativeNumberSchema).optional(),
  default_duration_sec: nonNegativeIntSchema.optional(),
  export_preset: nonEmptyStringSchema.optional(),
  timeline_shots: z.array(nonEmptyStringSchema).optional(),
  scaffold: z.boolean().optional(),
  ui_placement: nonEmptyStringSchema.optional(),
  qa_status: nonEmptyStringSchema.optional(),
  action_hint: z.string(),
  audio_hint: z.string(),
  preserve_hint: z.string(),
  avoid_hint: z.string(),
  prompt_contract: z.string(),
});

export const videoRecipeCatalogResponseSchema = z.object({
  recipes: z.array(videoRecipeDtoSchema),
});

export const videoRecipePromptSectionsSchema = z.object({
  brief: z.string(),
  refs: z.string(),
  action: z.string(),
  camera: z.string(),
  audio: z.string(),
  preserve: z.string(),
  safety: z.string(),
  avoid: z.string(),
});

export const videoRecipePlanSchema = z.object({
  recipe_id: videoRecipeIdSchema.nullable(),
  label: nonEmptyStringSchema,
  ready: z.boolean(),
  required_roles: z.array(refRoleSchema),
  optional_roles: z.array(refRoleSchema),
  present_roles: z.array(refRoleSchema),
  missing_roles: z.array(refRoleSchema),
  recommended_generation_path: nonEmptyStringSchema,
  prompt_sections: videoRecipePromptSectionsSchema,
});

export const videoRecipePlanResponseSchema = z.object({
  node_id: positiveIntSchema,
  plan: videoRecipePlanSchema,
});

export const shotPlanItemSchema = z.object({
  shot_index: positiveIntSchema,
  title_en: z.string(),
  title_vi: z.string(),
  frame_prompt: z.string(),
  video_prompt: z.string(),
  duration_sec: positiveIntSchema,
  action: z.string(),
  camera: z.string(),
  audio: z.string(),
  continuity: z.string(),
  avoid: z.string(),
});

export const shotPlanResponseSchema = z.object({
  recipe_id: videoRecipeIdSchema,
  label: nonEmptyStringSchema,
  brief: z.string(),
  shot_count: positiveIntSchema,
  shot_duration_sec: positiveIntSchema,
  source: nonEmptyStringSchema,
  source_context: z.array(unknownRecordSchema),
  shots: z.array(shotPlanItemSchema),
});

export const recipeWorkflowBuildResponseSchema = z.object({
  recipe_id: videoRecipeIdSchema,
  nodes: z.array(nodeDtoSchema),
  edges: z.array(edgeDtoSchema),
  video_node_id: positiveIntSchema.nullable(),
  frame_node_id: positiveIntSchema.nullable(),
  timeline_node_id: positiveIntSchema.nullable().optional(),
  shot_node_ids: z.array(positiveIntSchema).optional(),
  shot_count: nonNegativeIntSchema.optional(),
  open_node_id: positiveIntSchema.nullable().optional(),
  open_generation: z.boolean(),
});

export const roleSuggestionSchema = z.object({
  edge_id: positiveIntSchema,
  source_node_id: positiveIntSchema,
  source_short_id: nonEmptyStringSchema,
  source_type: nodeTypeSchema,
  title: z.string().nullable(),
  current_role: refRoleSchema.nullable(),
  suggested_role: refRoleSchema,
  confidence: z.number().finite().min(0).max(1),
  reason: z.string(),
  source: nonEmptyStringSchema,
  needs_change: z.boolean(),
});

export const roleClassifyResponseSchema = z.object({
  node_id: positiveIntSchema,
  recipe_id: videoRecipeIdSchema.nullable(),
  source: nonEmptyStringSchema,
  suggestions: z.array(roleSuggestionSchema),
});

export type TimelineExportRequest = z.infer<typeof timelineExportRequestSchema>;
export type TimelineExportResponse = z.infer<typeof timelineExportResponseSchema>;
export type TimelineQaRequest = z.infer<typeof timelineQaRequestSchema>;
export type TimelineCaptionStyle = z.infer<typeof timelineCaptionStyleSchema>;
export type TimelineQaStatus = z.infer<typeof timelineQaStatusSchema>;
export type TimelineQaIssue = z.infer<typeof timelineQaIssueSchema>;
export type TimelineQaItem = z.infer<typeof timelineQaItemSchema>;
export type TimelineQaResponse = z.infer<typeof timelineQaResponseSchema>;
export type VideoRecipeDTO = z.infer<typeof videoRecipeDtoSchema>;
export type VideoRecipeCatalogResponse = z.infer<typeof videoRecipeCatalogResponseSchema>;
export type VideoRecipePromptSections = z.infer<typeof videoRecipePromptSectionsSchema>;
export type VideoRecipePlan = z.infer<typeof videoRecipePlanSchema>;
export type VideoRecipePlanResponse = z.infer<typeof videoRecipePlanResponseSchema>;
export type ShotPlanItem = z.infer<typeof shotPlanItemSchema>;
export type ShotPlanResponse = z.infer<typeof shotPlanResponseSchema>;
export type RecipeWorkflowBuildResponse = z.infer<typeof recipeWorkflowBuildResponseSchema>;
export type RoleSuggestion = z.infer<typeof roleSuggestionSchema>;
export type RoleClassifyResponse = z.infer<typeof roleClassifyResponseSchema>;
export type ReferenceKind = z.infer<typeof referenceKindSchema>;
export type ReferenceProfile = z.infer<typeof referenceProfileSchema>;
export type ReferenceRowWire = z.infer<typeof referenceRowWireSchema>;
export type ReferenceListParams = z.infer<typeof referenceListParamsSchema>;
export type ReferenceCreateInput = z.infer<typeof referenceCreateInputSchema>;
export type ReferenceFromNodeCreateInput = z.infer<typeof referenceFromNodeCreateInputSchema>;
export type ReferencePatchInput = z.infer<typeof referencePatchInputSchema>;
