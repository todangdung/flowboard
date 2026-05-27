import { z } from "zod";

const nonEmptyStringSchema = z.string().min(1);
const positiveIntSchema = z.number().int().positive();
const nonNegativeIntSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().finite().nonnegative();
const volumeSchema = z.number().finite().min(0).max(2);

export const timelineCaptionModeSchema = z.enum(["none", "burn_in"]);
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

export type TimelineExportRequest = z.infer<typeof timelineExportRequestSchema>;
export type TimelineExportResponse = z.infer<typeof timelineExportResponseSchema>;
export type TimelineQaRequest = z.infer<typeof timelineQaRequestSchema>;
export type TimelineQaStatus = z.infer<typeof timelineQaStatusSchema>;
export type TimelineQaIssue = z.infer<typeof timelineQaIssueSchema>;
export type TimelineQaItem = z.infer<typeof timelineQaItemSchema>;
export type TimelineQaResponse = z.infer<typeof timelineQaResponseSchema>;
