import { create } from "zustand";
import type { Edge, Node } from "@xyflow/react";
import {
  listBoards,
  createBoard,
  getBoard,
  patchBoard as apiPatchBoard,
  deleteBoard as apiDeleteBoard,
  createNode,
  patchNode,
  deleteNode,
  createEdge,
  deleteEdge,
  ensureBoardProject,
  buildRecipeWorkflow,
  type Board,
  type NodeDTO,
  type NodeType,
  type RefRole,
  type ShotPlanItem,
  type TimelineCaptionStyle,
  type TimelineQaItem,
  type TimelineQaStatus,
  type VideoRecipeId,
} from "../api/client";
import { isVideoRecipeId } from "../lib/videoRecipes";

export type { NodeType, RefRole, VideoRecipeId };

export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";
export type ExportStatus = "fresh" | "stale";

export interface ExportHistoryItem {
  mediaId: string;
  status?: ExportStatus;
  version?: number;
  exportedAt?: string;
  clipCount?: number;
  size?: string;
  sourceMediaIds?: string[];
  sourceShotIds?: string[];
  durationsSec?: (number | null)[];
  effectiveDurationsSec?: number[];
  clipEdits?: Array<{ shotId: string; trimStartSec: number; trimEndSec: number }>;
  transitions?: Array<{ fromShotId: string; toShotId: string; type: "cut" | "fade"; durationSec: number }>;
  captions?: (string | null)[];
  captionMode?: "none" | "burn_in";
  captionFormat?: "ass";
  captionStyle?: TimelineCaptionStyle;
  audioMode?: "none" | "mix";
  audioMediaIds?: { voiceover?: string; music?: string };
  audioMix?: {
    clipVolume?: number;
    voiceoverVolume?: number;
    musicVolume?: number;
  };
  staleAt?: string;
  staleReason?: string;
}

// Storyboard grid options.
//   2x2 → 4 panels (square)
//   2x3 → 6 panels (rectangular: 2×3 on landscape, 3×2 on portrait)
//   2x4 → 8 panels (rectangular: 2×4 on landscape, 4×2 on portrait)
// The rows/cols mapping happens at prompt-build time based on the
// node's aspectRatio — see resolveStoryboardLayout in
// frontend/src/lib/storyboardPrompt.ts.
export type StoryboardGrid = "2x2" | "2x3" | "2x4";

export interface FlowboardNodeData extends Record<string, unknown> {
  type: NodeType;
  shortId: string;
  title: string;
  status?: NodeStatus;
  prompt?: string;
  thumbnailUrl?: string;
  mediaId?: string;
  // Per-variant media ids in dispatch order. `null` entries are
  // positional placeholders for variants that failed (e.g. Veo content
  // filter blocked one of the 4 i2v clips while the other 3 succeeded);
  // keeping the slot preserves alignment with the upstream image's
  // variants for poster/edge-pin lookups.
  mediaIds?: (string | null)[];
  // Per-slot error code, aligned to `mediaIds` indexing. `null` for
  // succeeded slots, an error string (e.g. "PUBLIC_ERROR_UNSAFE_GENERATION")
  // for blocked ones. ResultViewer reads this to render the exact
  // filter reason on the blocked tile instead of falling through to
  // the previous variant.
  slotErrors?: (string | null)[];
  variantCount?: number;
  // Active / reviewed variant. `mediaId` remains the canonical active
  // pointer; these fields make the quality-review choice visible in UI.
  bestVariantIdx?: number;
  bestMediaId?: string;
  reviewVerdict?: "good" | "redo" | "skip";
  reviewNote?: string;
  reviewedAt?: string;
  // The aspect-ratio enum the asset was generated / uploaded at — used to
  // default-match downstream gen dialogs (e.g. a 9:16 visual_asset feeds
  // into a downstream image / video that defaults to 9:16). Values are
  // Flow's IMAGE_ASPECT_RATIO_* enum strings since that's what the upload
  // route + gen worker produce. Video targets map them onto the matching
  // VIDEO_ASPECT_RATIO_* enum at dialog-open time.
  aspectRatio?: string;
  // AI-generated factual description of mediaId (set by /api/vision/describe).
  // Spliced into auto-prompts on downstream nodes for richer context.
  aiBrief?: string;
  aiBriefStatus?: "pending" | "done" | "failed";
  // Transient status while the GenerationDialog runs `autoPrompt` /
  // `autoPromptBatch` against this node — set to "pending" while the
  // backend is composing the prompt, cleared on success/failure. Not
  // persisted to the DB; it's a few-second UX flag so the node can
  // render a visible "busy" treatment that blocks duplicate dispatches.
  autoPromptStatus?: "pending" | "done" | "failed";
  // ISO timestamp persisted when a generation completes successfully.
  // Powers the "5 phút trước" relative-time display in ResultViewer.
  // Uploads also stamp this so the timestamp reflects "when the asset
  // landed on the node" regardless of source.
  renderedAt?: string;
  // Model used to produce the rendered media. Populated on completion
  // of gen_image / edit_image (`imageModel`, e.g. "NANO_BANANA_PRO") or
  // gen_video (`videoQuality`, e.g. "fast" / "lite" / "quality"). Absent
  // on uploads (no model involved) and on nodes generated before this
  // feature shipped — ResultViewer falls back to current settings as
  // plain text in that case so the user knows it's an estimate.
  imageModel?: string;
  videoQuality?: string;
  videoAudioMode?: string;
  videoRecipeId?: "auto" | VideoRecipeId;
  videoSourceMode?: "auto" | "text" | "first_frame" | "first_last" | "ingredients" | "edit";
  videoDurationSec?: number;
  videoEditSourceMediaId?: string;
  // Character-builder selections — persisted on dispatch so the detail
  // panel can show "Country / Vibe / Gender" pills under METADATA. Keys
  // (`vn`, `clean`, `female`) match the constants in
  // `src/constants/character.ts`; viewer maps key → display label.
  charCountry?: string;
  charVibe?: string;
  charGender?: string;
  productName?: string;
  brandName?: string;
  locationName?: string;
  characterName?: string;
  voiceName?: string;
  claimRules?: string;
  brandTone?: string;
  objective?: string;
  audience?: string;
  offer?: string;
  scriptHook?: string;
  voiceoverText?: string;
  onScreenText?: string;
  captionText?: string;
  scriptBeats?: string;
  language?: string;
  pacing?: string;
  speaker?: string;
  pronunciation?: string;
  mustSay?: string;
  mustNotSay?: string;
  claimsAllowed?: string;
  claimsAvoid?: string;
  tone?: string;
  platform?: string;
  mustInclude?: string;
  mustAvoid?: string;
  palette?: string;
  cta?: string;
  legalNotes?: string;
  error?: string;
  // Storyboard layout. The Storyboard node is now a thin image-node
  // wrapper that generates a single composite using a locked prompt
  // template `Create visual storyboard for "<topic>" as SINGLE IMAGE
  // arranged in a NxN layout (N rows, N columns)`. Default `3x3` when
  // missing (true for fresh nodes + legacy pre-1.2.15 nodes whose
  // multi-shot data is now ignored).
  storyboardGrid?: StoryboardGrid;
  workflowKind?: string;
  shotId?: string;
  shotIndex?: number;
  shotDurationSec?: number;
  sourceFrameId?: string;
  sourceFrameChangedAt?: string;
  timelineRecipeId?: string;
  timelineShotIds?: string[];
  timelineDurationsSec?: number[];
  timelineCaptions?: Record<string, string>;
  timelineClipEdits?: Record<string, { trimStartSec?: number; trimEndSec?: number }>;
  timelineTransitions?: Record<string, { type?: "cut" | "fade"; durationSec?: number }>;
  timelineQaStatus?: TimelineQaStatus;
  timelineQaCheckedAt?: string;
  timelineQaSummary?: { ok: number; warning: number; blocked: number };
  timelineQaItems?: TimelineQaItem[];
  exportMediaId?: string;
  exportedAt?: string;
  exportClipCount?: number;
  exportSize?: string;
  exportStatus?: ExportStatus;
  exportVersion?: number;
  exportSourceMediaIds?: string[];
  exportShotIds?: string[];
  exportDurationsSec?: (number | null)[];
  exportEffectiveDurationsSec?: number[];
  exportClipEdits?: Array<{ shotId: string; trimStartSec: number; trimEndSec: number }>;
  exportTransitions?: Array<{ fromShotId: string; toShotId: string; type: "cut" | "fade"; durationSec: number }>;
  exportCaptions?: (string | null)[];
  exportCaptionMode?: "none" | "burn_in";
  exportCaptionFormat?: "ass";
  exportCaptionStyle?: TimelineCaptionStyle;
  exportAudioMode?: "none" | "mix";
  exportAudioMediaIds?: { voiceover?: string; music?: string };
  exportAudioMix?: {
    clipVolume?: number;
    voiceoverVolume?: number;
    musicVolume?: number;
  };
  exportStaleAt?: string;
  exportStaleReason?: string;
  exportHistory?: ExportHistoryItem[];
  exportPreset?: string;
  exportWidth?: number;
  exportHeight?: number;
}

export type FlowNode = Node<FlowboardNodeData>;

// Per-edge data we attach to ReactFlow's `Edge.data` so dispatch and
// edge-rendering paths can read it without a round-trip through the
// backend. `sourceVariantIdx` mirrors `EdgeDTO.source_variant_idx`.
export interface FlowboardEdgeData extends Record<string, unknown> {
  sourceVariantIdx?: number | null;
  refRole?: RefRole | null;
}

/** Map an EdgeDTO from the backend into ReactFlow's Edge shape, carrying
 * the variant pin through `data` so dispatch + edge UI can read it. */
function edgeFromDto(dto: {
  id: number;
  source_id: number;
  target_id: number;
  source_variant_idx?: number | null;
  ref_role?: RefRole | null;
}): Edge<FlowboardEdgeData> {
  return {
    id: String(dto.id),
    source: String(dto.source_id),
    target: String(dto.target_id),
    data: {
      sourceVariantIdx: dto.source_variant_idx ?? null,
      refRole: dto.ref_role ?? null,
    },
  };
}

// ── Tiny per-node debounce (no external deps) ─────────────────────────────
const positionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debouncePosition(rfId: string, fn: () => void, delay = 150) {
  const existing = positionTimers.get(rfId);
  if (existing !== undefined) clearTimeout(existing);
  positionTimers.set(rfId, setTimeout(() => {
    positionTimers.delete(rfId);
    fn();
  }, delay));
}

// ── Type-to-title lookup ───────────────────────────────────────────────────
const TYPE_TITLE: Record<NodeType, string> = {
  character: "Character",
  image: "Image",
  video: "Video",
  prompt: "Prompt",
  note: "Note",
  visual_asset: "Visual asset",
  product: "Product",
  location: "Location",
  brand: "Brand kit",
  campaign: "Campaign brief",
  script: "Script / voiceover",
  audio: "Audio",
  Storyboard: "Storyboard",
};

const AUTO_LAYOUT_NODE_WIDTH = 240;
const AUTO_LAYOUT_TIMELINE_WIDTH = 360;
const AUTO_LAYOUT_DEFAULT_HEIGHT = 220;
const AUTO_LAYOUT_COMPACT_HEIGHT = 150;
const AUTO_LAYOUT_TIMELINE_HEIGHT = 340;
const AUTO_LAYOUT_COLUMN_GAP = 160;
const AUTO_LAYOUT_ROW_GAP = 64;
const AUTO_LAYOUT_COMPONENT_GAP_X = 360;
const AUTO_LAYOUT_COMPONENT_GAP_Y = 260;
const AUTO_LAYOUT_COMPONENT_ROW_MAX_WIDTH = 2200;
const AUTO_LAYOUT_GRID = 20;

interface AutoLayoutSize {
  width: number;
  height: number;
}

interface AutoLayoutComponent {
  ids: string[];
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  originalX: number;
  originalY: number;
}

function snapLayoutValue(value: number): number {
  return Math.round(value / AUTO_LAYOUT_GRID) * AUTO_LAYOUT_GRID;
}

function ceilLayoutValue(value: number): number {
  return Math.ceil(value / AUTO_LAYOUT_GRID) * AUTO_LAYOUT_GRID;
}

function positiveLayoutValue(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function defaultLayoutHeight(node: FlowNode): number {
  if (node.data.workflowKind === "timeline") return AUTO_LAYOUT_TIMELINE_HEIGHT;
  if (node.data.type === "note" || node.data.type === "prompt") {
    return AUTO_LAYOUT_COMPACT_HEIGHT;
  }
  return AUTO_LAYOUT_DEFAULT_HEIGHT;
}

function getLayoutSize(node: FlowNode): AutoLayoutSize {
  const fallbackWidth =
    node.data.workflowKind === "timeline"
      ? AUTO_LAYOUT_TIMELINE_WIDTH
      : AUTO_LAYOUT_NODE_WIDTH;
  return {
    width: positiveLayoutValue(
      node.measured?.width ?? node.width ?? node.initialWidth,
      fallbackWidth,
    ),
    height: positiveLayoutValue(
      node.measured?.height ?? node.height ?? node.initialHeight,
      defaultLayoutHeight(node),
    ),
  };
}

function compareNodeId(a: string, b: string): number {
  const aNum = Number(a);
  const bNum = Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) {
    return aNum - bNum;
  }
  return a.localeCompare(b);
}

function nodePriority(node: FlowNode): number {
  switch (node.data.workflowKind) {
    case "storyboard_plan":
      return 55;
    case "shot_frame":
      return 70;
    case "shot_clip":
      return 80;
    case "timeline":
      return 100;
    default:
      break;
  }
  switch (node.data.type) {
    case "campaign":
      return 10;
    case "brand":
      return 20;
    case "product":
      return 30;
    case "character":
      return 40;
    case "location":
      return 50;
    case "visual_asset":
    case "image":
    case "Storyboard":
      return 60;
    case "prompt":
      return 65;
    case "script":
      return 75;
    case "audio":
      return 85;
    case "video":
      return 90;
    case "note":
      return 110;
    default:
      return 999;
  }
}

function shotSortValue(node: FlowNode): number {
  return typeof node.data.shotIndex === "number"
    ? node.data.shotIndex
    : Number.POSITIVE_INFINITY;
}

function sortLayoutIds(ids: string[], nodeById: Map<string, FlowNode>): string[] {
  return [...ids].sort((a, b) => {
    const aNode = nodeById.get(a);
    const bNode = nodeById.get(b);
    if (!aNode || !bNode) return compareNodeId(a, b);
    const aShot = shotSortValue(aNode);
    const bShot = shotSortValue(bNode);
    if (aShot !== bShot) return aShot - bShot;
    const priorityDelta = nodePriority(aNode) - nodePriority(bNode);
    if (priorityDelta !== 0) return priorityDelta;
    const yDelta = aNode.position.y - bNode.position.y;
    if (yDelta !== 0) return yDelta;
    const xDelta = aNode.position.x - bNode.position.x;
    if (xDelta !== 0) return xDelta;
    return compareNodeId(a, b);
  });
}

function averageKnownOrder(ids: string[], orderById: Map<string, number>): number {
  const known = ids
    .map((id) => orderById.get(id))
    .filter((value): value is number => typeof value === "number");
  if (known.length === 0) return Number.POSITIVE_INFINITY;
  return known.reduce((sum, value) => sum + value, 0) / known.length;
}

function findLayoutComponents(
  nodes: FlowNode[],
  edges: Edge[],
  nodeById: Map<string, FlowNode>,
): string[][] {
  const links = new Map<string, Set<string>>();
  for (const node of nodes) {
    links.set(node.id, new Set());
  }
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    links.get(edge.source)?.add(edge.target);
    links.get(edge.target)?.add(edge.source);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const startId of sortLayoutIds(nodes.map((node) => node.id), nodeById)) {
    if (visited.has(startId)) continue;
    const queue = [startId];
    const ids: string[] = [];
    visited.add(startId);
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) continue;
      ids.push(id);
      for (const next of links.get(id) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    components.push(ids);
  }
  return components;
}

function layoutComponent(
  ids: string[],
  edges: Edge[],
  nodeById: Map<string, FlowNode>,
): AutoLayoutComponent {
  const idSet = new Set(ids);
  const incoming = new Map<string, string[]>();
  for (const id of ids) {
    incoming.set(id, []);
  }
  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    incoming.get(edge.target)?.push(edge.source);
  }

  const depthMemo = new Map<string, number>();
  function depthFor(id: string, visiting: Set<string>): number {
    const memo = depthMemo.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const depth = (incoming.get(id) ?? []).reduce(
      (maxDepth, sourceId) => Math.max(maxDepth, depthFor(sourceId, visiting) + 1),
      0,
    );
    visiting.delete(id);
    depthMemo.set(id, depth);
    return depth;
  }

  const rawLayers = new Map<number, string[]>();
  for (const id of ids) {
    const depth = depthFor(id, new Set());
    rawLayers.set(depth, [...(rawLayers.get(depth) ?? []), id]);
  }
  const columns = [...rawLayers.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, layerIds]) => sortLayoutIds(layerIds, nodeById));

  const orderById = new Map<string, number>();
  for (const column of columns) {
    column.sort((a, b) => {
      const aNode = nodeById.get(a);
      const bNode = nodeById.get(b);
      if (!aNode || !bNode) return compareNodeId(a, b);
      const aShot = shotSortValue(aNode);
      const bShot = shotSortValue(bNode);
      if (aShot !== bShot) return aShot - bShot;
      const upstreamDelta =
        averageKnownOrder(incoming.get(a) ?? [], orderById)
        - averageKnownOrder(incoming.get(b) ?? [], orderById);
      if (Number.isFinite(upstreamDelta) && upstreamDelta !== 0) {
        return upstreamDelta;
      }
      return sortLayoutIds([a, b], nodeById)[0] === a ? -1 : 1;
    });
    column.forEach((id, index) => orderById.set(id, index));
  }

  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const column of columns) {
    const columnSizes = column.map((id) => getLayoutSize(nodeById.get(id)!));
    const columnWidth = columnSizes.reduce(
      (maxWidth, size) => Math.max(maxWidth, size.width),
      AUTO_LAYOUT_NODE_WIDTH,
    );
    const columnHeight = columnSizes.reduce(
      (sum, size, index) => sum + size.height + (index === 0 ? 0 : AUTO_LAYOUT_ROW_GAP),
      0,
    );
    let y = -columnHeight / 2;
    column.forEach((id, index) => {
      const size = columnSizes[index];
      positions.set(id, { x, y });
      y += size.height + AUTO_LAYOUT_ROW_GAP;
    });
    x += columnWidth + AUTO_LAYOUT_COLUMN_GAP;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let originalX = Number.POSITIVE_INFINITY;
  let originalY = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const node = nodeById.get(id);
    const position = positions.get(id);
    if (!node || !position) continue;
    const size = getLayoutSize(node);
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + size.width);
    maxY = Math.max(maxY, position.y + size.height);
    originalX = Math.min(originalX, node.position.x);
    originalY = Math.min(originalY, node.position.y);
  }

  const normalised = new Map<string, { x: number; y: number }>();
  for (const [id, position] of positions) {
    normalised.set(id, {
      x: snapLayoutValue(position.x - minX),
      y: snapLayoutValue(position.y - minY),
    });
  }

  return {
    ids,
    positions: normalised,
    width: ceilLayoutValue(maxX - minX),
    height: ceilLayoutValue(maxY - minY),
    originalX,
    originalY,
  };
}

function graphBounds(nodes: FlowNode[]): { x: number; y: number; width: number; height: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const size = getLayoutSize(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function computeAutoLayoutPositions(
  nodes: FlowNode[],
  edges: Edge[],
): Map<string, { x: number; y: number }> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const components = findLayoutComponents(nodes, edges, nodeById)
    .map((ids) => layoutComponent(ids, edges, nodeById))
    .sort((a, b) => {
      const yDelta = a.originalY - b.originalY;
      if (yDelta !== 0) return yDelta;
      const xDelta = a.originalX - b.originalX;
      if (xDelta !== 0) return xDelta;
      return b.ids.length - a.ids.length;
    });

  const placements: Array<{ component: AutoLayoutComponent; x: number; y: number }> = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let totalWidth = 0;
  let totalHeight = 0;
  for (const component of components) {
    if (
      cursorX > 0
      && cursorX + component.width > AUTO_LAYOUT_COMPONENT_ROW_MAX_WIDTH
    ) {
      cursorX = 0;
      cursorY += rowHeight + AUTO_LAYOUT_COMPONENT_GAP_Y;
      rowHeight = 0;
    }
    placements.push({ component, x: cursorX, y: cursorY });
    totalWidth = Math.max(totalWidth, cursorX + component.width);
    rowHeight = Math.max(rowHeight, component.height);
    totalHeight = Math.max(totalHeight, cursorY + rowHeight);
    cursorX += component.width + AUTO_LAYOUT_COMPONENT_GAP_X;
  }

  const currentBounds = graphBounds(nodes);
  const originX = snapLayoutValue(currentBounds.x + currentBounds.width / 2 - totalWidth / 2);
  const originY = snapLayoutValue(currentBounds.y + currentBounds.height / 2 - totalHeight / 2);
  const positions = new Map<string, { x: number; y: number }>();
  for (const placement of placements) {
    for (const [id, position] of placement.component.positions) {
      positions.set(id, {
        x: originX + placement.x + position.x,
        y: originY + placement.y + position.y,
      });
    }
  }
  return positions;
}

function nodeFromDto(dto: NodeDTO): FlowNode {
  return {
    id: String(dto.id),
    type: dto.type,
    position: { x: dto.x, y: dto.y },
    data: {
      type: dto.type,
      shortId: dto.short_id,
      title: (dto.data["title"] as string | undefined) ?? TYPE_TITLE[dto.type],
      status: dto.status,
      prompt: dto.data["prompt"] as string | undefined,
      thumbnailUrl: dto.data["thumbnailUrl"] as string | undefined,
      mediaId: dto.data["mediaId"] as string | undefined,
      mediaIds: dto.data["mediaIds"] as (string | null)[] | undefined,
      slotErrors: dto.data["slotErrors"] as (string | null)[] | undefined,
      variantCount: dto.data["variantCount"] as number | undefined,
      bestVariantIdx: dto.data["bestVariantIdx"] as number | undefined,
      bestMediaId: dto.data["bestMediaId"] as string | undefined,
      reviewVerdict: dto.data["reviewVerdict"] as "good" | "redo" | "skip" | undefined,
      reviewNote: dto.data["reviewNote"] as string | undefined,
      reviewedAt: dto.data["reviewedAt"] as string | undefined,
      aspectRatio: dto.data["aspectRatio"] as string | undefined,
      aiBrief: dto.data["aiBrief"] as string | undefined,
      imageModel: dto.data["imageModel"] as string | undefined,
      videoQuality: dto.data["videoQuality"] as string | undefined,
      videoAudioMode: dto.data["videoAudioMode"] as string | undefined,
      videoRecipeId: dto.data["videoRecipeId"] as "auto" | VideoRecipeId | undefined,
      videoSourceMode: dto.data["videoSourceMode"] as FlowboardNodeData["videoSourceMode"] | undefined,
      videoDurationSec: dto.data["videoDurationSec"] as number | undefined,
      videoEditSourceMediaId: dto.data["videoEditSourceMediaId"] as string | undefined,
      charCountry: dto.data["charCountry"] as string | undefined,
      charVibe: dto.data["charVibe"] as string | undefined,
      charGender: dto.data["charGender"] as string | undefined,
      productName: dto.data["productName"] as string | undefined,
      brandName: dto.data["brandName"] as string | undefined,
      locationName: dto.data["locationName"] as string | undefined,
      characterName: dto.data["characterName"] as string | undefined,
      voiceName: dto.data["voiceName"] as string | undefined,
      claimRules: dto.data["claimRules"] as string | undefined,
      brandTone: dto.data["brandTone"] as string | undefined,
      objective: dto.data["objective"] as string | undefined,
      audience: dto.data["audience"] as string | undefined,
      offer: dto.data["offer"] as string | undefined,
      scriptHook: dto.data["scriptHook"] as string | undefined,
      voiceoverText: dto.data["voiceoverText"] as string | undefined,
      onScreenText: dto.data["onScreenText"] as string | undefined,
      captionText: dto.data["captionText"] as string | undefined,
      scriptBeats: dto.data["scriptBeats"] as string | undefined,
      language: dto.data["language"] as string | undefined,
      pacing: dto.data["pacing"] as string | undefined,
      speaker: dto.data["speaker"] as string | undefined,
      pronunciation: dto.data["pronunciation"] as string | undefined,
      mustSay: dto.data["mustSay"] as string | undefined,
      mustNotSay: dto.data["mustNotSay"] as string | undefined,
      claimsAllowed: dto.data["claimsAllowed"] as string | undefined,
      claimsAvoid: dto.data["claimsAvoid"] as string | undefined,
      tone: dto.data["tone"] as string | undefined,
      platform: dto.data["platform"] as string | undefined,
      mustInclude: dto.data["mustInclude"] as string | undefined,
      mustAvoid: dto.data["mustAvoid"] as string | undefined,
      palette: dto.data["palette"] as string | undefined,
      cta: dto.data["cta"] as string | undefined,
      legalNotes: dto.data["legalNotes"] as string | undefined,
      storyboardGrid: dto.data["storyboardGrid"] as StoryboardGrid | undefined,
      workflowKind: dto.data["workflowKind"] as string | undefined,
      shotId: dto.data["shotId"] as string | undefined,
      shotIndex: dto.data["shotIndex"] as number | undefined,
      shotDurationSec: dto.data["shotDurationSec"] as number | undefined,
      sourceFrameId: dto.data["sourceFrameId"] as string | undefined,
      sourceFrameChangedAt: dto.data["sourceFrameChangedAt"] as string | undefined,
      timelineRecipeId: dto.data["timelineRecipeId"] as string | undefined,
      timelineShotIds: dto.data["timelineShotIds"] as string[] | undefined,
      timelineDurationsSec: dto.data["timelineDurationsSec"] as number[] | undefined,
      timelineCaptions: dto.data["timelineCaptions"] as Record<string, string> | undefined,
      timelineClipEdits: dto.data["timelineClipEdits"] as Record<string, { trimStartSec?: number; trimEndSec?: number }> | undefined,
      timelineTransitions: dto.data["timelineTransitions"] as Record<string, { type?: "cut" | "fade"; durationSec?: number }> | undefined,
      timelineQaStatus: dto.data["timelineQaStatus"] as TimelineQaStatus | undefined,
      timelineQaCheckedAt: dto.data["timelineQaCheckedAt"] as string | undefined,
      timelineQaSummary: dto.data["timelineQaSummary"] as { ok: number; warning: number; blocked: number } | undefined,
      timelineQaItems: dto.data["timelineQaItems"] as TimelineQaItem[] | undefined,
      exportMediaId: dto.data["exportMediaId"] as string | undefined,
      exportedAt: dto.data["exportedAt"] as string | undefined,
      exportClipCount: dto.data["exportClipCount"] as number | undefined,
      exportSize: dto.data["exportSize"] as string | undefined,
      exportStatus: dto.data["exportStatus"] as ExportStatus | undefined,
      exportVersion: dto.data["exportVersion"] as number | undefined,
      exportSourceMediaIds: dto.data["exportSourceMediaIds"] as string[] | undefined,
      exportShotIds: dto.data["exportShotIds"] as string[] | undefined,
      exportDurationsSec: dto.data["exportDurationsSec"] as (number | null)[] | undefined,
      exportEffectiveDurationsSec: dto.data["exportEffectiveDurationsSec"] as number[] | undefined,
      exportClipEdits: dto.data["exportClipEdits"] as Array<{ shotId: string; trimStartSec: number; trimEndSec: number }> | undefined,
      exportTransitions: dto.data["exportTransitions"] as Array<{ fromShotId: string; toShotId: string; type: "cut" | "fade"; durationSec: number }> | undefined,
      exportCaptions: dto.data["exportCaptions"] as (string | null)[] | undefined,
      exportCaptionMode: dto.data["exportCaptionMode"] as "none" | "burn_in" | undefined,
      exportCaptionFormat: dto.data["exportCaptionFormat"] as "ass" | undefined,
      exportCaptionStyle: dto.data["exportCaptionStyle"] as TimelineCaptionStyle | undefined,
      exportAudioMode: dto.data["exportAudioMode"] as "none" | "mix" | undefined,
      exportAudioMediaIds: dto.data["exportAudioMediaIds"] as { voiceover?: string; music?: string } | undefined,
      exportAudioMix: dto.data["exportAudioMix"] as {
        clipVolume?: number;
        voiceoverVolume?: number;
        musicVolume?: number;
      } | undefined,
      exportStaleAt: dto.data["exportStaleAt"] as string | undefined,
      exportStaleReason: dto.data["exportStaleReason"] as string | undefined,
      exportHistory: dto.data["exportHistory"] as ExportHistoryItem[] | undefined,
      exportPreset: dto.data["exportPreset"] as string | undefined,
      exportWidth: dto.data["exportWidth"] as number | undefined,
      exportHeight: dto.data["exportHeight"] as number | undefined,
      error: dto.data["error"] as string | undefined,
    },
  };
}

// ── Persisted active-board id ─────────────────────────────────────────────
// Survives page reloads so refreshing on project #4 doesn't kick the user
// back to project #1. localStorage is fine here — single-user, single-host.
const ACTIVE_BOARD_KEY = "flowboard.activeBoardId";

function loadPersistedBoardId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_BOARD_KEY);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function persistBoardId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_BOARD_KEY);
    else localStorage.setItem(ACTIVE_BOARD_KEY, String(id));
  } catch {
    // Storage disabled / quota exceeded — non-fatal, just lose persistence.
  }
}

// ── Store ──────────────────────────────────────────────────────────────────
interface BoardState {
  boardId: number | null;
  boardName: string;
  // Lightweight summary list rendered by the ProjectSidebar — full node /
  // edge content lives only on the active board to keep memory bounded.
  boards: Board[];
  nodes: FlowNode[];
  edges: Edge[];
  loading: boolean;
  error: string | null;

  loadInitialBoard(): Promise<void>;
  refreshBoardState(): Promise<void>;
  refreshBoardList(): Promise<void>;
  renameBoard(name: string): Promise<void>;
  // Switch the active board: load detail, replace nodes/edges, reset
  // poll-state on the generation store.
  switchBoard(id: number): Promise<void>;
  // Create a new board, switch to it, return id.
  createNewBoard(name: string): Promise<number | null>;
  // Eager variant: also creates a Flow project on labs.google immediately
  // (instead of lazily on first Generate). Returns null if board creation
  // OR Flow project creation fails — the board is still created locally,
  // but the Flow link is missing so the next Generate will retry-create
  // it via the regular lazy path.
  createNewBoardWithFlowProject(name: string): Promise<number | null>;
  // Delete a board. If it's the active one, switch to first remaining
  // board (or create a fresh "Untitled" if list ends up empty).
  deleteBoardById(id: number): Promise<void>;

  // Returns the new node's rfId on success, or null if creation failed.
  // Callers that need to wire up an edge immediately (e.g. drop-popover
  // shortcut) need the id back synchronously.
  addNodeOfType(type: NodeType, position: { x: number; y: number }): Promise<string | null>;
  addFlowFromRecipe(
    recipeId: VideoRecipeId,
    position: { x: number; y: number },
    opts?: {
      shotCount?: number;
      shotDurationSec?: number;
      brief?: string;
      useLLM?: boolean;
      shotPlan?: ShotPlanItem[];
      openGeneration?: boolean;
    },
  ): Promise<string | null>;
  // Spawn a brand-new visual_asset node from a saved Reference. Used by
  // both the panel click-to-spawn path and the canvas drop-to-spawn path.
  // The new node lands with status="done" + mediaId + aiBrief already
  // populated so its thumbnail loads immediately and it can be used as a
  // downstream ref without any extra round-trip.
  addReferenceNode(
    ref: {
      mediaId: string;
      aiBrief?: string | null;
      aspectRatio?: string | null;
      kind: string;
      label: string;
      profile?: Record<string, unknown> | null;
    },
    position: { x: number; y: number },
  ): Promise<string | null>;
  autoLayoutBoard(): Promise<boolean>;
  persistNodePosition(rfId: string, position: { x: number; y: number }): Promise<void>;
  deleteNodeByRfId(rfId: string): Promise<void>;
  addEdgeFromConnection(source: string, target: string): Promise<void>;
  deleteEdgeByRfId(rfId: string): Promise<void>;
  // Spawn an empty sibling node next to `rfId` with the same type and the
  // same upstream edges. Returns the new node's rfId so callers can focus
  // / open the generation dialog on it. Used by ResultViewer's
  // "New variant +" — gives the user a fresh canvas to gen another shot
  // sharing the original's source refs.
  cloneNodeWithUpstream(rfId: string): Promise<string | null>;
  // Timeline exports become stale when any linked shot clip review/media
  // state changes. Keep the old media link, but stamp status as stale.
  invalidateTimelineExportsForClip(rfId: string, reason?: string): Promise<void>;
  markTimelineExportsStale(timelineRfIds: string[], reason?: string): Promise<void>;
  // Redo clips replace the original shot clip on timeline storyboard_panel
  // edges so the old redo-marked source no longer blocks export.
  rewireTimelineStoryboardPanels(sourceRfId: string, replacementRfId: string): Promise<void>;
  setTimelineActiveClip(timelineRfId: string, shotId: string, clipRfId: string): Promise<void>;
  setShotSourceFrame(timelineRfId: string, shotId: string, clipRfId: string, frameRfId: string): Promise<void>;

  updateNodeData(rfId: string, partial: Partial<FlowboardNodeData>): void;
  /** Merge `partial` into edge.data — used to refresh the local cache
   * after a PATCH /api/edges/{id} so the badge updates without waiting
   * for a full board refresh. */
  updateEdgeData(edgeId: string, partial: Partial<FlowboardEdgeData>): void;
  setNodes(nodes: FlowNode[]): void;
  setEdges(edges: Edge[]): void;
  clearError(): void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  boardId: null,
  boardName: "",
  boards: [],
  nodes: [],
  edges: [],
  loading: false,
  error: null,

  async loadInitialBoard() {
    set({ loading: true, error: null });
    try {
      let boards = await listBoards();
      // Prefer the user's last-active board if it still exists; fall back
      // to the first board in the list. Without this, refresh always
      // snapped back to boards[0] regardless of what was selected before.
      const persistedId = loadPersistedBoardId();
      let board =
        (persistedId !== null && boards.find((b) => b.id === persistedId)) ||
        boards[0];
      if (!board) {
        board = await createBoard("Untitled");
        boards = [board];
      }
      const detail = await getBoard(board.id);

      const nodes: FlowNode[] = detail.nodes.map(nodeFromDto);

      const edges: Edge[] = detail.edges.map(edgeFromDto);

      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        boards,
        nodes,
        edges,
        loading: false,
      });
      persistBoardId(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async refreshBoardList() {
    try {
      const boards = await listBoards();
      set({ boards });
    } catch {
      // non-fatal
    }
  },

  async switchBoard(id) {
    if (id === get().boardId) return;
    set({ loading: true, error: null });
    try {
      const detail = await getBoard(id);
      const nodes: FlowNode[] = detail.nodes.map(nodeFromDto);
      const edges: Edge[] = detail.edges.map(edgeFromDto);
      set({
        boardId: detail.board.id,
        boardName: detail.board.name,
        nodes,
        edges,
        loading: false,
      });
      persistBoardId(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async createNewBoard(name) {
    try {
      const board = await createBoard(name || "Untitled");
      // Add to list (front of list so the newly-created project shows up
      // at the top of the sidebar) and switch to it.
      set((s) => ({ boards: [board, ...s.boards] }));
      await get().switchBoard(board.id);
      return board.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async createNewBoardWithFlowProject(name) {
    // Same as `createNewBoard` but immediately binds the new board to a
    // freshly-created Flow project on labs.google. The lazy path
    // (`ensureBoardProject` on first Generate) still works as a fallback
    // — if the Flow round-trip fails here (extension not connected,
    // tier-unknown, etc.) the board is created locally and the user can
    // retry on first Generate without losing work.
    let boardId: number | null = null;
    try {
      const board = await createBoard(name || "Untitled");
      set((s) => ({ boards: [board, ...s.boards] }));
      await get().switchBoard(board.id);
      boardId = board.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
    try {
      await ensureBoardProject(boardId);
    } catch (err) {
      // Board exists locally; just surface the Flow-side failure so the
      // user can see why the link wasn't made. Don't unwind the board
      // creation — the lazy retry path will handle it on next Generate.
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: `Board created but Flow project link failed: ${msg}` });
    }
    return boardId;
  },

  async deleteBoardById(id) {
    try {
      await apiDeleteBoard(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const remaining = get().boards.filter((b) => b.id !== id);
    set({ boards: remaining });
    // If we just deleted the active board, switch to the first remaining
    // board — or create a fresh "Untitled" if none left.
    if (get().boardId === id) {
      if (remaining.length > 0) {
        await get().switchBoard(remaining[0].id);
      } else {
        try {
          const board = await createBoard("Untitled");
          set({ boards: [board] });
          await get().switchBoard(board.id);
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  },

  async refreshBoardState() {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const detail = await getBoard(boardId);
      const nodes: FlowNode[] = detail.nodes.map(nodeFromDto);
      const edges: Edge[] = detail.edges.map(edgeFromDto);
      set({ nodes, edges });
    } catch {
      // ignore — leave state alone, next poll will retry
    }
  },

  async renameBoard(name: string) {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const updated = await apiPatchBoard(boardId, name);
      set((s) => ({
        boardName: updated.name,
        boards: s.boards.map((b) =>
          b.id === boardId ? { ...b, name: updated.name } : b,
        ),
      }));
    } catch {
      // non-fatal; keep local name
    }
  },

  async addNodeOfType(type, position) {
    const { boardId } = get();
    if (boardId === null) return null;
    const title = TYPE_TITLE[type];
    try {
      const dto = await createNode({
        board_id: boardId,
        type,
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: { title },
      });
      const node: FlowNode = {
        id: String(dto.id),
        type: dto.type,
        position: { x: dto.x, y: dto.y },
        data: {
          type: dto.type,
          shortId: dto.short_id,
          title: (dto.data["title"] as string | undefined) ?? title,
          status: dto.status,
        },
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      return node.id;
    } catch (err) {
      // Surface to console so the next "I clicked Add but nothing
      // appeared" report has a breadcrumb in DevTools instead of an
      // empty canvas — a 422 here usually means the backend's NodeType
      // literal is out of sync with the frontend's NodeType union.
      console.error("addNodeOfType failed", { type, err });
    }
    return null;
  },

  async addFlowFromRecipe(recipeId, position, opts) {
    const { boardId } = get();
    if (boardId === null) return null;
    if (!isVideoRecipeId(recipeId)) return null;
    try {
      const built = await buildRecipeWorkflow({
        board_id: boardId,
        recipe_id: recipeId,
        x: Math.round(position.x),
        y: Math.round(position.y),
        shot_count: opts?.shotCount,
        shot_duration_sec: opts?.shotDurationSec,
        brief: opts?.brief,
        use_llm: opts?.useLLM,
        shot_plan: opts?.shotPlan,
        open_generation: opts?.openGeneration,
      });
      const createdNodes = built.nodes.map(nodeFromDto);
      const createdEdges = built.edges.map(edgeFromDto);
      set((s) => ({
        nodes: [...s.nodes, ...createdNodes],
        edges: [...s.edges, ...createdEdges],
      }));

      const openNodeId =
        built.open_node_id ??
        built.video_node_id ??
        built.frame_node_id ??
        built.timeline_node_id ??
        null;
      const openNode = openNodeId !== null
        ? createdNodes.find((n) => n.id === String(openNodeId))
        : undefined;
      if (openNode && built.open_generation) {
        try {
          const { useGenerationStore } = await import("./generation");
          useGenerationStore
            .getState()
            .openGenerationDialog(openNode.id, openNode.data.prompt ?? "");
        } catch {
          // The scaffold itself is complete; opening the dialog is best-effort.
        }
        return openNode.id;
      }
      if (openNode) return openNode.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
    return null;
  },

  async addReferenceNode(ref, position) {
    const { boardId } = get();
    if (boardId === null) return null;
    const title = ref.label || "Reference";
    const type: NodeType =
      ref.kind === "character"
        ? "character"
        : ref.kind === "video"
        ? "video"
        : ref.kind === "product" || ref.kind === "package"
        ? "product"
        : ref.kind === "location"
        ? "location"
        : ref.kind === "brand"
        ? "brand"
        : ref.kind === "campaign"
        ? "campaign"
        : ref.kind === "script"
        ? "script"
        : ref.kind === "storyboard_shot"
        ? "Storyboard"
        : "visual_asset";
    const profile = ref.profile && typeof ref.profile === "object" ? ref.profile : {};
    try {
      const dto = await createNode({
        board_id: boardId,
        type,
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: {
          title,
          mediaId: ref.mediaId,
          aiBrief: ref.aiBrief ?? undefined,
          aspectRatio: ref.aspectRatio ?? undefined,
          ...profile,
          status: "done",
          renderedAt: new Date().toISOString(),
        },
      });
      // Mirror addNodeOfType's local-state insertion, but propagate the
      // rich data fields so the visual_asset body renders the thumbnail
      // straight away (instead of falling into the empty-state CTA).
      const node: FlowNode = {
        id: String(dto.id),
        type: dto.type,
        position: { x: dto.x, y: dto.y },
        data: {
          type: dto.type,
          shortId: dto.short_id,
          title: (dto.data["title"] as string | undefined) ?? title,
          status: "done",
          mediaId: ref.mediaId,
          aiBrief: ref.aiBrief ?? undefined,
          aspectRatio: ref.aspectRatio ?? undefined,
          ...(profile as Partial<FlowboardNodeData>),
          renderedAt: new Date().toISOString(),
        },
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      return node.id;
    } catch {
      // surface silently for now
    }
    return null;
  },

  async autoLayoutBoard() {
    const { nodes, edges } = get();
    if (nodes.length <= 1) return false;
    const positions = computeAutoLayoutPositions(nodes, edges);
    if (positions.size === 0) return false;

    for (const rfId of positions.keys()) {
      const pending = positionTimers.get(rfId);
      if (pending !== undefined) {
        clearTimeout(pending);
        positionTimers.delete(rfId);
      }
    }

    set((s) => ({
      nodes: s.nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      }),
    }));

    const results = await Promise.allSettled(
      [...positions.entries()].map(async ([rfId, position]) => {
        const dbId = parseInt(rfId, 10);
        if (isNaN(dbId)) return;
        await patchNode(dbId, {
          x: Math.round(position.x),
          y: Math.round(position.y),
        });
      }),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      set({ error: `Auto layout saved locally, but ${failed} node positions failed to persist.` });
    }
    return true;
  },

  async persistNodePosition(rfId, position) {
    debouncePosition(rfId, async () => {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) return;
      try {
        await patchNode(dbId, { x: Math.round(position.x), y: Math.round(position.y) });
      } catch {
        // ignore persist failures
      }
    });
  },

  async deleteNodeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    const { nodes, edges } = get();
    const staleTimelineIds = Array.from(new Set(
      edges
        .filter((e) => e.source === rfId && e.data?.refRole === "storyboard_panel")
        .map((e) => e.target)
        .filter((targetId) => {
          const target = nodes.find((n) => n.id === targetId);
          return target?.data.workflowKind === "timeline";
        }),
    ));
    // Cancel any pending debounced patch for this node (it would 404 after delete).
    const pending = positionTimers.get(rfId);
    if (pending !== undefined) {
      clearTimeout(pending);
      positionTimers.delete(rfId);
    }
    // Also cancel any in-flight generation poll — otherwise the poll loop
    // keeps pinging the server about a node that no longer exists.
    // Dynamic import to avoid a circular store dependency at module init.
    try {
      const { useGenerationStore } = await import("./generation");
      useGenerationStore.getState().cancelGeneration(rfId);
    } catch {
      // If the module isn't loaded yet (tree-shaken test path), ignore.
    }
    try {
      await deleteNode(dbId);
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== rfId),
        edges: s.edges.filter((e) => e.source !== rfId && e.target !== rfId),
      }));
      await get().markTimelineExportsStale(staleTimelineIds, "timeline_clip_set_changed");
    } catch {
      // ignore
    }
  },

  async addEdgeFromConnection(source, target) {
    const { boardId } = get();
    if (boardId === null) return;
    const sourceId = parseInt(source, 10);
    const targetId = parseInt(target, 10);
    if (isNaN(sourceId) || isNaN(targetId)) return;
    try {
      const dto = await createEdge({ board_id: boardId, source_id: sourceId, target_id: targetId });
      set((s) => ({ edges: [...s.edges, edgeFromDto(dto)] }));
    } catch {
      // ignore
    }
  },

  async cloneNodeWithUpstream(rfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return null;
    const src = nodes.find((n) => n.id === rfId);
    if (!src) return null;

    // Position the clone to the lower-right of the source so it doesn't
    // overlap. Title gets a " (variant)" suffix if not already present so
    // it's easy to tell apart at a glance.
    const offset = { x: 60, y: 60 };
    const newPos = {
      x: Math.round(src.position.x + offset.x),
      y: Math.round(src.position.y + offset.y),
    };
    const baseTitle = src.data.title ?? TYPE_TITLE[src.data.type];
    const newTitle = baseTitle.endsWith("(variant)")
      ? baseTitle
      : `${baseTitle} (variant)`;

    let nodeDto;
    try {
      nodeDto = await createNode({
        board_id: boardId,
        type: src.data.type,
        x: newPos.x,
        y: newPos.y,
        data: { title: newTitle },
      });
    } catch {
      return null;
    }

    const newNode: FlowNode = {
      id: String(nodeDto.id),
      type: nodeDto.type,
      position: { x: nodeDto.x, y: nodeDto.y },
      data: {
        type: nodeDto.type,
        shortId: nodeDto.short_id,
        title: (nodeDto.data["title"] as string | undefined) ?? newTitle,
        status: nodeDto.status,
      },
    };
    set((s) => ({ nodes: [...s.nodes, newNode] }));

    // Replicate upstream edges: every (upstream → src) becomes (upstream → clone).
    const upstreamEdges = edges.filter((e) => e.target === rfId);
    for (const upstreamEdge of upstreamEdges) {
      const sourceId = parseInt(upstreamEdge.source, 10);
      if (isNaN(sourceId)) continue;
      try {
        const eDto = await createEdge({
          board_id: boardId,
          source_id: sourceId,
          target_id: nodeDto.id,
          source_variant_idx: (upstreamEdge.data?.sourceVariantIdx ?? null) as number | null,
          ref_role: (upstreamEdge.data?.refRole ?? null) as RefRole | null,
        });
        set((s) => ({ edges: [...s.edges, edgeFromDto(eDto)] }));
      } catch {
        // best-effort — partial edge replication still useful
      }
    }
    return newNode.id;
  },

  async markTimelineExportsStale(timelineRfIds, reason = "timeline_changed") {
    const { nodes } = get();
    const staleAt = new Date().toISOString();
    const timelineIds = Array.from(new Set(timelineRfIds)).filter((timelineId) => {
      const target = nodes.find((n) => n.id === timelineId);
      return (
        target?.data.workflowKind === "timeline"
        && typeof target.data.exportMediaId === "string"
        && target.data.exportMediaId.length > 0
        && target.data.exportStatus !== "stale"
      );
    });
    if (timelineIds.length === 0) return;

    const localPatch: Partial<FlowboardNodeData> = {
      status: "idle",
      exportStatus: "stale",
      exportStaleAt: staleAt,
      exportStaleReason: reason,
    };
    for (const timelineId of timelineIds) {
      get().updateNodeData(timelineId, localPatch);
    }

    await Promise.all(
      timelineIds.map(async (timelineId) => {
        const dbId = parseInt(timelineId, 10);
        if (isNaN(dbId)) return;
        await patchNode(dbId, {
          status: "idle",
          data: {
            exportStatus: "stale",
            exportStaleAt: staleAt,
            exportStaleReason: reason,
          },
        });
      }),
    );
  },

  async invalidateTimelineExportsForClip(rfId, reason = "review_changed") {
    const { nodes, edges } = get();
    const timelineIds = Array.from(new Set(
      edges
        .filter((e) => e.source === rfId && e.data?.refRole === "storyboard_panel")
        .map((e) => e.target)
        .filter((targetId) => {
          const target = nodes.find((n) => n.id === targetId);
          return target?.data.workflowKind === "timeline";
        }),
    ));
    await get().markTimelineExportsStale(timelineIds, reason);
  },

  async rewireTimelineStoryboardPanels(sourceRfId, replacementRfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return;
    const replacementId = parseInt(replacementRfId, 10);
    if (isNaN(replacementId)) return;
    const timelineEdges = edges.filter((e) => {
      if (e.source !== sourceRfId || e.data?.refRole !== "storyboard_panel") {
        return false;
      }
      const target = nodes.find((n) => n.id === e.target);
      return target?.data.workflowKind === "timeline";
    });

    const staleTimelineIds: string[] = [];
    for (const edge of timelineEdges) {
      const targetId = parseInt(edge.target, 10);
      const oldEdgeId = parseInt(edge.id, 10);
      if (isNaN(targetId) || isNaN(oldEdgeId)) continue;
      const created = await createEdge({
        board_id: boardId,
        source_id: replacementId,
        target_id: targetId,
        source_variant_idx: (edge.data?.sourceVariantIdx ?? null) as number | null,
        ref_role: "storyboard_panel",
      });
      await deleteEdge(oldEdgeId);
      set((s) => ({
        edges: [
          ...s.edges.filter((existing) => existing.id !== edge.id),
          edgeFromDto(created),
        ],
      }));
      staleTimelineIds.push(edge.target);
    }
    await get().markTimelineExportsStale(staleTimelineIds, "timeline_clip_set_changed");
  },

  async setTimelineActiveClip(timelineRfId, shotId, clipRfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return;
    const timeline = nodes.find((n) => n.id === timelineRfId);
    const clip = nodes.find((n) => n.id === clipRfId);
    if (timeline?.data.workflowKind !== "timeline") return;
    if (clip?.data.workflowKind !== "shot_clip" || clip.data.shotId !== shotId) return;
    const clipId = parseInt(clipRfId, 10);
    const timelineId = parseInt(timelineRfId, 10);
    if (isNaN(clipId) || isNaN(timelineId)) return;

    const sameShotEdges = edges.filter((edge) => {
      if (edge.target !== timelineRfId || edge.data?.refRole !== "storyboard_panel") {
        return false;
      }
      const src = nodes.find((n) => n.id === edge.source);
      return src?.data.workflowKind === "shot_clip" && src.data.shotId === shotId;
    });
    if (sameShotEdges.length === 1 && sameShotEdges[0].source === clipRfId) return;

    try {
      const created = await createEdge({
        board_id: boardId,
        source_id: clipId,
        target_id: timelineId,
        ref_role: "storyboard_panel",
      });
      for (const edge of sameShotEdges) {
        const edgeId = parseInt(edge.id, 10);
        if (!isNaN(edgeId)) {
          await deleteEdge(edgeId);
        }
      }
      set((s) => ({
        edges: [
          ...s.edges.filter((edge) => !sameShotEdges.some((old) => old.id === edge.id)),
          edgeFromDto(created),
        ],
      }));
      get().updateNodeData(timelineRfId, {
        timelineQaStatus: undefined,
        timelineQaCheckedAt: undefined,
        timelineQaSummary: undefined,
        timelineQaItems: undefined,
      });
      await patchNode(timelineId, {
        data: {
          timelineQaStatus: null,
          timelineQaCheckedAt: null,
          timelineQaSummary: null,
          timelineQaItems: null,
        },
      });
      await get().markTimelineExportsStale([timelineRfId], "timeline_active_clip_changed");
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async setShotSourceFrame(timelineRfId, shotId, clipRfId, frameRfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return;
    const timeline = nodes.find((n) => n.id === timelineRfId);
    const clip = nodes.find((n) => n.id === clipRfId);
    const frame = nodes.find((n) => n.id === frameRfId);
    if (timeline?.data.workflowKind !== "timeline") return;
    if (clip?.data.workflowKind !== "shot_clip" || clip.data.shotId !== shotId) return;
    if (frame?.data.workflowKind !== "shot_frame" || frame.data.shotId !== shotId) return;
    const clipId = parseInt(clipRfId, 10);
    const frameId = parseInt(frameRfId, 10);
    const timelineId = parseInt(timelineRfId, 10);
    if (isNaN(clipId) || isNaN(frameId)) return;

    const firstFrameEdges = edges.filter(
      (edge) => edge.target === clipRfId && edge.data?.refRole === "first_frame",
    );
    const keepEdge = firstFrameEdges.find((edge) => edge.source === frameRfId);
    if (keepEdge && firstFrameEdges.length === 1) return;

    try {
      const created = keepEdge
        ? null
        : await createEdge({
          board_id: boardId,
          source_id: frameId,
          target_id: clipId,
          ref_role: "first_frame",
        });
      const removeEdges = firstFrameEdges.filter((edge) => edge.id !== keepEdge?.id);
      for (const edge of removeEdges) {
        const edgeId = parseInt(edge.id, 10);
        if (!isNaN(edgeId)) {
          await deleteEdge(edgeId);
        }
      }
      set((s) => ({
        edges: [
          ...s.edges.filter((edge) => !removeEdges.some((old) => old.id === edge.id)),
          ...(created ? [edgeFromDto(created)] : []),
        ],
      }));

      const changedAt = new Date().toISOString();
      get().updateNodeData(clipRfId, {
        status: "idle",
        mediaId: undefined,
        mediaIds: undefined,
        bestMediaId: undefined,
        bestVariantIdx: undefined,
        reviewVerdict: undefined,
        reviewNote: undefined,
        reviewedAt: undefined,
        renderedAt: undefined,
        error: undefined,
        slotErrors: undefined,
        sourceFrameId: frameRfId,
        sourceFrameChangedAt: changedAt,
      });
      await patchNode(clipId, {
        status: "idle",
        data: {
          mediaId: null,
          mediaIds: null,
          bestMediaId: null,
          bestVariantIdx: null,
          reviewVerdict: null,
          reviewNote: null,
          reviewedAt: null,
          renderedAt: null,
          error: null,
          slotErrors: null,
          sourceFrameId: frameRfId,
          sourceFrameChangedAt: changedAt,
        },
      });
      get().updateNodeData(timelineRfId, {
        timelineQaStatus: undefined,
        timelineQaCheckedAt: undefined,
        timelineQaSummary: undefined,
        timelineQaItems: undefined,
      });
      if (!isNaN(timelineId)) {
        await patchNode(timelineId, {
          data: {
            timelineQaStatus: null,
            timelineQaCheckedAt: null,
            timelineQaSummary: null,
            timelineQaItems: null,
          },
        });
      }
      await get().markTimelineExportsStale([timelineRfId], "timeline_source_frame_changed");
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async deleteEdgeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    const edge = get().edges.find((e) => e.id === rfId);
    const target = edge ? get().nodes.find((n) => n.id === edge.target) : undefined;
    const staleTimelineIds =
      edge?.data?.refRole === "storyboard_panel" && target?.data.workflowKind === "timeline"
        ? [edge.target]
        : [];
    try {
      await deleteEdge(dbId);
      set((s) => ({ edges: s.edges.filter((e) => e.id !== rfId) }));
      await get().markTimelineExportsStale(staleTimelineIds, "timeline_clip_set_changed");
    } catch {
      // ignore
    }
  },

  updateNodeData: (rfId, partial) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === rfId ? { ...n, data: { ...n.data, ...partial } } : n,
      ),
    })),
  updateEdgeData: (edgeId, partial) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...(e.data ?? {}), ...partial } }
          : e,
      ),
    })),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  clearError: () => set({ error: null }),
}));
