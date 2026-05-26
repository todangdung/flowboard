import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import { useBoardStore, type FlowboardNodeData } from "../store/board";
import { useSettingsStore } from "../store/settings";
import { useReferencesStore } from "../store/references";
import { getMediaStatus, mediaUrl, patchNode, type MediaStatus, type ReferenceKind } from "../api/client";
import { countryLabel, vibeLabel } from "../constants/character";
import { bestVariantIndex, preferredMediaIds } from "../lib/bestVariant";

const ICON: Record<string, string> = {
  character: "◎",
  image: "▣",
  video: "▶",
  prompt: "✦",
  note: "✎",
  visual_asset: "◇",
  product: "▤",
  location: "⌂",
  brand: "◈",
  campaign: "◉",
  script: "☷",
  audio: "♪",
};

// Friendly labels for the metadata grid's `model` row. Keys match what
// the dispatch code stamps onto node.data — keep in sync with
// `ImageModelKey` (store/settings.ts) and `VideoQuality` respectively.
const IMAGE_MODEL_LABELS: Record<string, string> = {
  NANO_BANANA_PRO: "Banana Pro",
  NANO_BANANA_2: "Banana 2",
};
const VIDEO_QUALITY_LABELS: Record<string, string> = {
  lite: "Lite",
  fast: "Fast",
  quality: "Quality",
  lite_relaxed: "Lite (Low Priority)",
  // Omni Flash dispatches stamp the per-duration model key directly
  // (resolve_omni_flash_model: abra_r2v_4s / 6s / 8s / 10s). Map all
  // four to a single "Omni Flash · Ns" label so the detail panel
  // surfaces the actual duration variant that ran.
  abra_r2v_4s: "Omni Flash · 4s",
  abra_r2v_6s: "Omni Flash · 6s",
  abra_r2v_8s: "Omni Flash · 8s",
  abra_r2v_10s: "Omni Flash · 10s",
  omni_video_edit: "Omni Flash · edit",
};
const REVIEW_LABELS: Record<string, string> = {
  good: "good / tốt",
  redo: "redo / làm lại",
  skip: "skip / bỏ qua",
};
const VIDEO_ITERATION_METADATA_KEYS: (keyof FlowboardNodeData)[] = [
  "workflowKind",
  "shotId",
  "shotIndex",
  "shotDurationSec",
  "shotTitleEn",
  "shotTitleVi",
  "shotAction",
  "shotCamera",
  "shotAudio",
  "shotContinuity",
  "shotAvoid",
  "shotPlanSource",
  "timelineRecipeId",
  "videoRecipeId",
  "videoAudioMode",
  "videoSourceMode",
  "videoDurationSec",
  "videoEditSourceMediaId",
  "aspectRatio",
];

function profileFromResult(
  mediaId: string,
  data: FlowboardNodeData,
): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    mediaId,
    kind: data.type,
    sourceNodeShortId: data.shortId,
    name: data.title,
  };
  for (const key of [
    "aiBrief",
    "prompt",
    "aspectRatio",
    "productName",
    "brandName",
    "locationName",
    "characterName",
    "voiceName",
    "claimRules",
    "brandTone",
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
    "palette",
    "cta",
    "legalNotes",
  ] as (keyof FlowboardNodeData)[]) {
    const value = data[key];
    if (value !== undefined && value !== "") {
      profile[key] = value;
    }
  }
  return profile;
}

function buildVideoIterationPatch(
  data: FlowboardNodeData,
  title: string,
  prompt: string,
): Partial<FlowboardNodeData> {
  const inherited: Record<string, unknown> = {};
  for (const key of VIDEO_ITERATION_METADATA_KEYS) {
    const value = data[key];
    if (value !== undefined) inherited[key] = value;
  }
  return {
    title,
    prompt,
    status: "idle",
    variantCount: 1,
    mediaId: undefined,
    mediaIds: undefined,
    slotErrors: undefined,
    renderedAt: undefined,
    error: undefined,
    reviewVerdict: undefined,
    reviewNote: undefined,
    reviewedAt: undefined,
    bestMediaId: undefined,
    bestVariantIdx: undefined,
    ...inherited,
  };
}

/** Format Flow's aspect-ratio enum to the human label shown on the node
 *  card. Returns "—" when the value is missing or unrecognised so the
 *  metadata grid never displays a stale hardcoded fallback. */
function formatAspectRatio(value: string | undefined): string {
  switch (value) {
    case "IMAGE_ASPECT_RATIO_LANDSCAPE":
    case "VIDEO_ASPECT_RATIO_LANDSCAPE":
      return "16:9";
    case "IMAGE_ASPECT_RATIO_PORTRAIT":
    case "VIDEO_ASPECT_RATIO_PORTRAIT":
      return "9:16";
    case "IMAGE_ASPECT_RATIO_SQUARE":
      return "1:1";
    default:
      return "—";
  }
}

/** Format an ISO timestamp as a Vietnamese relative time string —
 *  "vừa xong", "5 phút trước", "2 giờ trước", "3 ngày trước". Falls
 *  back to "—" when the timestamp is missing or unparseable. */
function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 60) return "vừa xong";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} giờ trước`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} ngày trước`;
  return new Date(t).toLocaleDateString("vi-VN");
}

export function ResultViewer() {
  const openViewer = useGenerationStore((s) => s.openViewer);
  const closeResultViewer = useGenerationStore((s) => s.closeResultViewer);
  const openGenerationDialog = useGenerationStore((s) => s.openGenerationDialog);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const projectId = useGenerationStore((s) => s.projectId);
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const settingsImageModel = useSettingsStore((s) => s.imageModel);
  const settingsVideoQuality = useSettingsStore((s) => s.videoQuality);

  const [activeIdx, setActiveIdx] = useState(0);
  const [mediaReady, setMediaReady] = useState(false);
  const [cacheKey, setCacheKey] = useState(0);
  const [status, setStatus] = useState<MediaStatus | null>(null);
  // Save-to-library state. MUST live above the `if (!data) return null`
  // early-return below — React's Rules of Hooks require all hooks to be
  // called unconditionally on every render in the same order.
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewNoteDraft, setReviewNoteDraft] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const rfId = openViewer.rfId;
  const node = nodes.find((n) => n.id === rfId);
  const data = node?.data;
  const mediaIds = data?.mediaIds ?? (data?.mediaId ? [data.mediaId] : []);

  // METADATA model label. Two tiers:
  //   - `isBadge: true` — node was generated AFTER the model-stamp feature
  //     shipped, so we know the exact model that produced it. Render as
  //     a pill (matches the Settings "Ultra only" badge visual language).
  //   - `isBadge: false` — old node, or unrenderable type (prompt/note),
  //     or upload (no model). Render as plain text so the visual
  //     difference signals "estimate vs ground truth".
  const metadataModel: { label: string; isBadge: boolean } = (() => {
    if (data?.type === "video") {
      if (data.videoQuality) {
        return {
          label: VIDEO_QUALITY_LABELS[data.videoQuality] ?? data.videoQuality,
          isBadge: true,
        };
      }
      // Pre-feature node — fall back to the user's current preference.
      return {
        label: VIDEO_QUALITY_LABELS[settingsVideoQuality] ?? settingsVideoQuality,
        isBadge: false,
      };
    }
    if (data && ["image", "character", "visual_asset"].includes(data.type)) {
      if (data.imageModel) {
        return {
          label: IMAGE_MODEL_LABELS[data.imageModel] ?? data.imageModel,
          isBadge: true,
        };
      }
      return {
        label: IMAGE_MODEL_LABELS[settingsImageModel] ?? settingsImageModel,
        isBadge: false,
      };
    }
    return { label: "—", isBadge: false };
  })();

  // Upstream refs feeding this target. Walk EDGES (not just nodes) so
  // each entry resolves to the variant the edge is pinned to — same
  // logic as `collectUpstreamRefMediaIds` at dispatch. The chip then
  // shows the exact thumbnail Flow will receive instead of always
  // defaulting to the source's "active" mediaId.
  const REF_TYPES = new Set(["character", "image", "visual_asset", "product", "location"]);
  const refSourceNodes = rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || !REF_TYPES.has(n.data.type)) return null;
          const variants = Array.isArray(n.data.mediaIds) ? n.data.mediaIds : [];
          const pin = (e.data?.sourceVariantIdx ?? null) as number | null;
          let mediaId: string | undefined;
          let variantIdx: number | null = null;
          if (
            pin !== null
            && pin >= 0
            && pin < variants.length
            && typeof variants[pin] === "string"
            && variants[pin]
          ) {
            mediaId = variants[pin] as string;
            variantIdx = pin;
          } else if (typeof n.data.mediaId === "string" && n.data.mediaId) {
            mediaId = n.data.mediaId;
          } else if (
            variants.length > 0
            && typeof variants[0] === "string"
            && variants[0]
          ) {
            mediaId = variants[0] as string;
          }
          if (!mediaId) return null;
          return { node: n, mediaId, variantIdx };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  // Slot-aware mediaId resolution. When the node has a per-variant
  // `mediaIds` array, slot index activeIdx is authoritative even if
  // its value is `null` — the null means "this variant got blocked",
  // which is semantically distinct from "no per-variant array exists,
  // fall back to the legacy single mediaId". Using `??` chained the
  // two together and made every blocked slot silently render the
  // primary mediaId from slot 0 — i.e. clicking tile 4 played
  // tile 1's video.
  const slotMediaId = data?.mediaIds?.[activeIdx];
  const currentMediaId = rfId && data
    ? (data.mediaIds !== undefined
        ? (typeof slotMediaId === "string" && slotMediaId ? slotMediaId : null)
        : (data.mediaId ?? null))
    : null;
  const slotError = data?.slotErrors?.[activeIdx] ?? null;

  // Reset active variant index and media state when viewer opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      // Honor the idx the caller passed via openResultViewer(rfId, idx)
      // so clicking a specific tile in the node card opens at that
      // variant. Bound by current mediaIds length (best-effort).
      setActiveIdx(openViewer.idx ?? 0);
      setMediaReady(false);
      setStatus(null);
      triggerRef.current = document.activeElement;
      setReviewNoteDraft(typeof data?.reviewNote === "string" ? data.reviewNote : "");
    } else {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    }
  }, [rfId]);

  useEffect(() => {
    setReviewNoteDraft(typeof data?.reviewNote === "string" ? data.reviewNote : "");
  }, [rfId, data?.reviewNote]);

  // Reset media state when active variant changes
  useEffect(() => {
    setMediaReady(false);
    setStatus(null);
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, [currentMediaId]);

  // Keyboard handling
  useEffect(() => {
    if (rfId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeResultViewer();
      }
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % Math.max(mediaIds.length, 1));
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + Math.max(mediaIds.length, 1)) % Math.max(mediaIds.length, 1));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Focus trap
  useEffect(() => {
    if (rfId === null) return;
    const el = dialogRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = el.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [rfId]);

  if (rfId === null || !data) return null;

  const isVideo = data.type === "video";
  const shortMediaId = currentMediaId ? `${currentMediaId.slice(0, 12)}…` : "pending";
  const bestIdx = bestVariantIndex(data);
  const currentIsBest = !!currentMediaId && bestIdx === activeIdx;

  const cacheBust = cacheKey > 0 ? `?t=${cacheKey}` : "";

  function onImgLoad() {
    setMediaReady(true);
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function onImgError() {
    if (!currentMediaId) return;
    setMediaReady(false);
    if (pollTimerRef.current !== null) return; // already polling
    const mid = currentMediaId;
    pollTimerRef.current = setInterval(async () => {
      try {
        const s = await getMediaStatus(mid);
        setStatus(s);
        if (s.available) {
          setCacheKey((k) => k + 1);
          setMediaReady(true);
          if (pollTimerRef.current !== null) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        }
      } catch {
        // ignore transient errors; keep polling
      }
    }, 2000);
  }

  function handleRefresh() {
    setCacheKey((k) => k + 1);
  }

  let hintText: string;
  if (status === null) {
    hintText = "Loading…";
  } else if (!status.has_url) {
    hintText = "Open your project on labs.google/flow so Flowboard can capture the image URL.";
  } else {
    hintText = "Fetching bytes from Google…";
  }

  // Blocks the three generation-flow buttons (Edit prompt, Regenerate,
  // New variant) while the LLM layer is mid-flight on this node — same
  // signal as the canvas-side .node-card--llm-busy treatment so the user
  // can't fire a duplicate dispatch via the detail panel either.
  const llmBusy =
    data?.autoPromptStatus === "pending"
    || data?.aiBriefStatus === "pending";

  function handleRegenerate() {
    if (!rfId || !data || llmBusy) return;
    // Carry forward the node's persisted setup so regenerate matches the
    // original generation. Without this we silently snap to LANDSCAPE / 1
    // variant — wrong for portrait/square shots, character refs (square),
    // and multi-variant batches.
    const aspectRatio =
      typeof data.aspectRatio === "string" ? data.aspectRatio : undefined;
    const variantCount =
      typeof data.variantCount === "number" && data.variantCount > 0
        ? data.variantCount
        : 1;

    // Critical: video nodes must dispatch with `kind: "video"` AND the
    // upstream source(s). Without `kind`, the store falls back to
    // gen_image — silently produces a still image, overwriting the
    // actual video result on the node.
    if (data.type === "video") {
      const firstEdge =
        edges.find((e) => e.target === rfId && e.data?.refRole === "first_frame")
        ?? edges.find((e) => e.target === rfId && e.data?.refRole !== "last_frame");
      const lastEdge = edges.find((e) => e.target === rfId && e.data?.refRole === "last_frame");
      const upstreamNode = firstEdge
        ? nodes.find((n) => n.id === firstEdge.source)
        : undefined;
      const lastNode = lastEdge
        ? nodes.find((n) => n.id === lastEdge.source)
        : undefined;
      const lastMediaId = preferredMediaIds(lastNode?.data)[0];
      const storedMode = data.videoSourceMode ?? "first_frame";
      const sourceMode =
        storedMode === "auto"
          ? lastMediaId
            ? "first_last"
            : upstreamNode
              ? "first_frame"
              : "text"
          : storedMode;
      if (sourceMode === "text") {
        dispatchGeneration(rfId, {
          prompt: data.prompt ?? "",
          kind: "video",
          sourceMode: "text",
          aspectRatio,
          durationSec: data.videoDurationSec,
          variantCount: 1,
        });
        return;
      }
      if (sourceMode === "edit") {
        const sourceVideoMediaId =
          data.videoEditSourceMediaId ?? currentMediaId ?? data.mediaId;
        if (!sourceVideoMediaId) {
          useGenerationStore.setState({
            error: "Video edit re-gen needs a source video.",
          });
          return;
        }
        dispatchGeneration(rfId, {
          prompt: data.prompt ?? "",
          kind: "video",
          sourceMode: "edit",
          sourceVideoMediaId,
          aspectRatio,
          durationSec: data.videoDurationSec,
          variantCount: 1,
        });
        return;
      }
      if (sourceMode === "ingredients") {
        dispatchGeneration(rfId, {
          prompt: data.prompt ?? "",
          kind: "video",
          sourceMode: "ingredients",
          aspectRatio,
          durationSec: data.videoDurationSec,
          variantCount: 1,
        });
        return;
      }
      // Best-selected upstreams re-run only that chosen source. Otherwise
      // preserve existing batch behavior and re-run all rendered variants.
      const sourceMediaIds = preferredMediaIds(upstreamNode?.data);
      if (sourceMediaIds.length === 0) {
        useGenerationStore.setState({
          error: "Video re-gen needs an upstream image with rendered media.",
        });
        return;
      }
      const useMulti = sourceMediaIds.length > 1;
      dispatchGeneration(rfId, {
        prompt: data.prompt ?? "",
        kind: "video",
        sourceMode,
        sourceMediaId: useMulti ? undefined : sourceMediaIds[0],
        sourceMediaIds: useMulti ? sourceMediaIds : undefined,
        endMediaId: sourceMode === "first_last" ? lastMediaId : undefined,
        aspectRatio,
        durationSec: data.videoDurationSec,
        variantCount: sourceMediaIds.length,
      });
      return;
    }
    dispatchGeneration(rfId, {
      prompt: data.prompt ?? "",
      aspectRatio,
      variantCount,
    });
  }

  function handleEditPrompt() {
    if (!rfId || !data || llmBusy) return;
    closeResultViewer();
    openGenerationDialog(rfId, data.prompt ?? "");
  }

  async function handleExtendVideo() {
    if (!rfId || !data || data.type !== "video" || llmBusy) return;
    const newRfId = await useBoardStore
      .getState()
      .cloneNodeWithUpstream(rfId);
    if (!newRfId) return;
    const title = `${data.title} (extend)`;
    const prompt = [
      data.prompt ?? "",
      "Extend as the next connected beat after this clip. Preserve the same subject, product, wardrobe, lighting, location, camera language, audio mode, and commercial claim/safety constraints. Add one new action beat only.",
    ].filter(Boolean).join("\n\n");
    useBoardStore.getState().updateNodeData(newRfId, { title, prompt });
    const dbId = parseInt(newRfId, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, { data: { title, prompt } }).catch(() => {});
    }
    closeResultViewer();
    openGenerationDialog(newRfId, prompt);
  }

  async function handleNewVariant() {
    if (!rfId || llmBusy) return;
    const newRfId = await useBoardStore
      .getState()
      .cloneNodeWithUpstream(rfId);
    if (!newRfId) return;
    closeResultViewer();
    // Open the gen dialog on the fresh sibling so the user can hit
    // Generate immediately (or tweak prompt first) — that's the natural
    // next step after cloning.
    openGenerationDialog(newRfId, data?.prompt ?? "");
  }

  // Save the currently-viewed variant to the cross-board Reference
  // library. Backend POST is idempotent on media_id, so multi-clicking
  // is safe — we still flip the button to "Saved" for 1.5s for feedback.
  // (State declared at the top of the component to satisfy Rules of Hooks.)

  async function handleSaveToLibrary() {
    if (!rfId || !data || !currentMediaId || saving) return;
    setSaving(true);
    try {
      const kind: ReferenceKind =
        data.type === "Storyboard"
          ? "storyboard_shot"
          : data.type === "video"
            ? "video"
          : data.type === "character"
            ? "character"
            : data.type === "product"
              ? "product"
            : data.type === "location"
              ? "location"
            : data.type === "brand"
              ? "brand"
            : data.type === "campaign"
              ? "campaign"
            : data.type === "script"
              ? "script"
            : data.type === "audio"
              ? "audio"
            : data.type === "visual_asset"
              ? "visual_asset"
              : "image";
      await useReferencesStore.getState().save({
        media_id: currentMediaId,
        kind,
        ai_brief: typeof data.aiBrief === "string" ? data.aiBrief : null,
        aspect_ratio:
          typeof data.aspectRatio === "string" ? data.aspectRatio : null,
        label:
          typeof data.aiBrief === "string"
            ? data.aiBrief.slice(0, 80)
            : `#${data.shortId}`,
        source_board_id: useBoardStore.getState().boardId,
        source_node_short_id:
          typeof data.shortId === "string" ? data.shortId : null,
        profile: profileFromResult(currentMediaId, data),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch {
      // Surfaced via store.error
    } finally {
      setSaving(false);
    }
  }

  async function saveReviewVerdict(verdict: "good" | "redo" | "skip"): Promise<boolean> {
    if (!rfId || !data) return false;
    const reviewedAt = new Date().toISOString();
    const note = reviewNoteDraft.trim();
    let serverPatch: Record<string, unknown>;
    let localPatch: Partial<FlowboardNodeData>;
    if (verdict === "good") {
      if (!currentMediaId) return false;
      serverPatch = {
        mediaId: currentMediaId,
        bestMediaId: currentMediaId,
        bestVariantIdx: activeIdx,
        reviewVerdict: verdict,
        reviewNote: note || null,
        reviewedAt,
      };
      localPatch = {
        mediaId: currentMediaId,
        bestMediaId: currentMediaId,
        bestVariantIdx: activeIdx,
        reviewVerdict: verdict,
        reviewNote: note || undefined,
        reviewedAt,
      };
    } else {
      serverPatch = {
        bestMediaId: null,
        bestVariantIdx: null,
        reviewVerdict: verdict,
        reviewNote: note || null,
        reviewedAt,
      };
      localPatch = {
        bestMediaId: undefined,
        bestVariantIdx: undefined,
        reviewVerdict: verdict,
        reviewNote: note || undefined,
        reviewedAt,
      };
    }
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      try {
        await patchNode(dbId, { data: serverPatch });
      } catch (err) {
        useGenerationStore.setState({
          error: `Couldn't save review: ${err instanceof Error ? err.message : String(err)}`,
        });
        return false;
      }
    }
    useBoardStore.getState().updateNodeData(rfId, localPatch);
    try {
      await useBoardStore.getState().invalidateTimelineExportsForClip(rfId, "review_changed");
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't mark stale export: ${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
    return true;
  }

  async function handleMarkBest() {
    await saveReviewVerdict("good");
  }

  async function handleRedoFromNote() {
    if (!rfId || !data || !currentMediaId || llmBusy) return;
    const saved = await saveReviewVerdict("redo");
    if (!saved) return;
    const newRfId = await useBoardStore
      .getState()
      .cloneNodeWithUpstream(rfId);
    if (!newRfId) return;
    const fix = reviewNoteDraft.trim() || "Fix the marked issue only.";
    const title = `${data.title} (redo)`;
    const prompt = [
      data.prompt ?? "",
      `Redo from reviewed variant v${activeIdx + 1}. Fix only: ${fix}. Preserve the same subject, product/logo, character identity, wardrobe, lighting, location, camera language, audio mode, and claim/safety constraints.`,
    ].filter(Boolean).join("\n\n");
    const redoPatch = buildVideoIterationPatch(data, title, prompt);
    useBoardStore.getState().updateNodeData(newRfId, redoPatch);
    const dbId = parseInt(newRfId, 10);
    if (!isNaN(dbId)) {
      try {
        await patchNode(dbId, {
          status: "idle",
          data: {
            ...redoPatch,
            mediaId: null,
            mediaIds: null,
            slotErrors: null,
            renderedAt: null,
            error: null,
            reviewVerdict: null,
            reviewNote: null,
            reviewedAt: null,
            bestMediaId: null,
            bestVariantIdx: null,
          },
        });
      } catch (err) {
        useGenerationStore.setState({
          error: `Couldn't prepare redo clip: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    try {
      await useBoardStore.getState().rewireTimelineStoryboardPanels(rfId, newRfId);
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't rewire timeline redo: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    closeResultViewer();
    openGenerationDialog(newRfId, prompt);
  }

  async function handleRefineVideoFromNote() {
    if (!rfId || !data || data.type !== "video" || !currentMediaId || llmBusy) return;
    const note = reviewNoteDraft.trim();
    const reviewedAt = new Date().toISOString();
    if (note) {
      useBoardStore.getState().updateNodeData(rfId, { reviewNote: note, reviewedAt });
      const sourceDbId = parseInt(rfId, 10);
      if (!isNaN(sourceDbId)) {
        try {
          await patchNode(sourceDbId, {
            data: { reviewNote: note, reviewedAt },
          });
        } catch (err) {
          useGenerationStore.setState({
            error: `Couldn't save refine note: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }
    }

    const newRfId = await useBoardStore
      .getState()
      .cloneNodeWithUpstream(rfId);
    if (!newRfId) return;
    const fix = note || "Improve only one small issue without changing the scene identity.";
    const title = `${data.title} (refine)`;
    const prompt = [
      data.prompt ?? "",
      `Refine reviewed variant v${activeIdx + 1}. Change only: ${fix}. Preserve the same shot timing, subject, product/logo, character identity, wardrobe, lighting, location, camera language, audio mode, and claim/safety constraints.`,
    ].filter(Boolean).join("\n\n");
    const refinePatch = {
      ...buildVideoIterationPatch(data, title, prompt),
      videoSourceMode: "edit" as const,
      videoEditSourceMediaId: currentMediaId,
      videoDurationSec:
        typeof data.videoDurationSec === "number"
          ? data.videoDurationSec
          : typeof data.shotDurationSec === "number"
            ? data.shotDurationSec
            : 8,
    };
    useBoardStore.getState().updateNodeData(newRfId, refinePatch);
    const dbId = parseInt(newRfId, 10);
    if (!isNaN(dbId)) {
      try {
        await patchNode(dbId, {
          status: "idle",
          data: {
            ...refinePatch,
            mediaId: null,
            mediaIds: null,
            slotErrors: null,
            renderedAt: null,
            error: null,
            reviewVerdict: null,
            reviewNote: null,
            reviewedAt: null,
            bestMediaId: null,
            bestVariantIdx: null,
          },
        });
      } catch (err) {
        useGenerationStore.setState({
          error: `Couldn't prepare refine clip: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    try {
      await useBoardStore.getState().rewireTimelineStoryboardPanels(rfId, newRfId);
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't rewire timeline refine: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    closeResultViewer();
    useGenerationStore.getState().dispatchGeneration(newRfId, {
      prompt,
      kind: "video",
      sourceMode: "edit",
      sourceVideoMediaId: currentMediaId,
      aspectRatio:
        typeof data.aspectRatio === "string"
          ? data.aspectRatio
          : "VIDEO_ASPECT_RATIO_PORTRAIT",
      durationSec: refinePatch.videoDurationSec,
      audioMode:
        typeof data.videoAudioMode === "string" ? data.videoAudioMode : undefined,
      variantCount: 1,
    });
  }

  async function handleSkipVariant() {
    await saveReviewVerdict("skip");
  }

  async function handleRedoOnly() {
    await saveReviewVerdict("redo");
  }

  const reviewVerdict = data.reviewVerdict;
  const reviewIsRedo = reviewVerdict === "redo";
  const reviewIsSkip = reviewVerdict === "skip";
  const reviewIsGood = reviewVerdict === "good";

  /*
    Layout note: review controls live in the detail panel, not the media
    tile, matching Flowkit's sidecar review-board pattern.
  */
  const reviewNoteControl = (
    <div className="result-viewer__review-panel">
      <div className={`result-viewer__review-pill result-viewer__review-pill--${reviewVerdict ?? "none"}`}>
        {reviewVerdict ? REVIEW_LABELS[reviewVerdict] : "unreviewed / chưa duyệt"}
      </div>
      <textarea
        className="result-viewer__review-note"
        aria-label="Review note"
        value={reviewNoteDraft}
        onChange={(event) => setReviewNoteDraft(event.target.value)}
        placeholder="Fix note / ghi chú"
        rows={3}
      />
    </div>
  );

  return (
    <div
      className="result-viewer-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeResultViewer();
      }}
    >
      <div
        className="result-viewer"
        role="dialog"
        aria-labelledby="result-viewer-title"
        aria-modal="true"
        ref={dialogRef}
      >
        {/* Left panel — media tile */}
        <div className="result-viewer__left">
          <div
            className="media-placeholder"
            role={mediaReady ? undefined : "img"}
            aria-label={mediaReady ? undefined : `${data.title} — media pending`}
          >
            {currentMediaId ? (
              <>
                {/* Single media element — always mounted so load/error fires once and
                    there's no flicker from mount/unmount on state flip. */}
                {isVideo ? (
                  <video
                    className="media-placeholder__video"
                    style={mediaReady ? undefined : { display: "none" }}
                    src={mediaUrl(currentMediaId) + cacheBust}
                    controls
                    preload="metadata"
                    onError={onImgError}
                    onLoadedData={onImgLoad}
                  />
                ) : (
                  <img
                    className="media-placeholder__img"
                    style={mediaReady ? undefined : { display: "none" }}
                    src={mediaUrl(currentMediaId) + cacheBust}
                    alt={data.title as string}
                    onError={onImgError}
                    onLoad={onImgLoad}
                  />
                )}
                {!mediaReady && (
                  <div className="media-placeholder__content">
                    <span className="media-placeholder__icon" aria-hidden="true">
                      {ICON[data.type] ?? "□"}
                    </span>
                    <span className="media-placeholder__title">{data.title}</span>
                    <span className="media-placeholder__id">media_id: {shortMediaId}</span>
                  </div>
                )}
              </>
            ) : slotError ? (
              // Blocked variant — Veo's safety classifier rejected this
              // specific clip while the rest of the batch rendered.
              // Show the exact filter reason so the user can decide
              // whether to retry, change inputs, or accept the loss.
              <div className="media-placeholder__content media-placeholder__content--blocked">
                <span className="media-placeholder__icon media-placeholder__icon--warn" aria-hidden="true">⚠</span>
                <span className="media-placeholder__title">Variant blocked</span>
                <span className="media-placeholder__error-code">{slotError}</span>
                <span className="media-placeholder__error-hint">
                  This variant was rejected by Google&apos;s safety filter. The
                  other variants in this batch rendered normally — try
                  re-running just this slot, or tweak the upstream image /
                  prompt to avoid the trigger.
                </span>
              </div>
            ) : (
              <div className="media-placeholder__content">
                <span className="media-placeholder__icon" aria-hidden="true">
                  {ICON[data.type] ?? "□"}
                </span>
                <span className="media-placeholder__title">{data.title}</span>
                <span className="media-placeholder__id">media_id: {shortMediaId}</span>
              </div>
            )}
          </div>

          {currentMediaId && !mediaReady && (
            <p className="media-placeholder__hint">{hintText}</p>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {currentMediaId && (
              <button className="media-placeholder__refresh" onClick={handleRefresh}>
                Refresh
              </button>
            )}
            {/* Variant switcher — chips for each slot. Blocked slots
                get a warning treatment + tooltip with the error code so
                the user can scan the strip and see at a glance which
                variants succeeded vs failed. */}
            {mediaIds.length > 0 && (
              <div className="variant-switcher" role="group" aria-label="Variant selection">
                {mediaIds.map((_id, idx) => {
                  const chipError = data?.slotErrors?.[idx] ?? null;
                  const blocked = chipError !== null && chipError !== undefined;
                  const isBest = idx === bestIdx;
                  return (
                    <button
                      key={idx}
                      className={`variant-switcher__chip${idx === activeIdx ? " variant-switcher__chip--active" : ""}${blocked ? " variant-switcher__chip--blocked" : ""}${isBest ? " variant-switcher__chip--best" : ""}`}
                      onClick={() => setActiveIdx(idx)}
                      aria-label={blocked ? `Variant ${idx + 1} — blocked: ${chipError}` : isBest ? `Variant ${idx + 1} — best` : `Variant ${idx + 1}`}
                      title={blocked ? `Blocked: ${chipError}` : isBest ? "Best variant" : undefined}
                      aria-pressed={idx === activeIdx}
                    >
                      {blocked ? "⚠" : isBest ? "✓" : idx + 1}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right panel — metadata */}
        <div className="result-viewer__right">
          <div className="result-viewer__status-pill">Rendered</div>

          <h2 id="result-viewer-title" className="result-viewer__node-title">
            {data.title}
          </h2>
          <span className="result-viewer__node-id">#{data.shortId}</span>

          <hr className="result-viewer__divider" />

          <span className="result-viewer__section-label">PROMPT</span>
          <p className="result-viewer__prompt">{data.prompt ?? "(no prompt)"}</p>
          <button
            className="result-viewer__edit-prompt"
            onClick={handleEditPrompt}
            disabled={llmBusy}
            title={llmBusy ? "Backend is composing — try again in a moment" : undefined}
          >
            {isVideo ? "Edit video prompt →" : "Edit prompt →"}
          </button>

          {refSourceNodes.length > 0 && (
            <>
              <hr className="result-viewer__divider" />
              <span className="result-viewer__section-label">
                SOURCE REFERENCES ({refSourceNodes.length})
              </span>
              <div className="ref-source-row">
                {refSourceNodes.map((r) => (
                  <div
                    key={r.node.id}
                    className="ref-source-chip"
                    title={
                      r.variantIdx !== null
                        ? `${r.node.data.title} — variant ${r.variantIdx + 1}`
                        : r.node.data.title
                    }
                  >
                    <img
                      className="ref-source-chip__img"
                      src={mediaUrl(r.mediaId)}
                      alt={r.node.data.title}
                    />
                    {r.variantIdx !== null && (
                      <span className="ref-source-chip__variant">
                        v{r.variantIdx + 1}
                      </span>
                    )}
                    <span className="ref-source-chip__id">
                      #{r.node.data.shortId}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <hr className="result-viewer__divider" />

          <span className="result-viewer__section-label">METADATA</span>
          <dl className="result-viewer__metadata-grid">
            <dt>model</dt>
            <dd>
              {metadataModel.isBadge ? (
                <span className="model-badge">{metadataModel.label}</span>
              ) : (
                metadataModel.label
              )}
            </dd>
            {data?.type === "character" && countryLabel(data.charCountry) && (
              <>
                <dt>country</dt>
                <dd>
                  <span className="model-badge">{countryLabel(data.charCountry)}</span>
                </dd>
              </>
            )}
            {data?.type === "character" && vibeLabel(data.charVibe) && (
              <>
                <dt>vibe</dt>
                <dd>
                  <span className="model-badge">{vibeLabel(data.charVibe)}</span>
                </dd>
              </>
            )}
            <dt>aspect</dt>
            <dd>{formatAspectRatio(data?.aspectRatio)}</dd>
            {data?.type === "video" && data.videoSourceMode && (
              <>
                <dt>source</dt>
                <dd>{data.videoSourceMode}</dd>
              </>
            )}
            {data?.type === "video" && typeof data.videoDurationSec === "number" && (
              <>
                <dt>duration</dt>
                <dd>{data.videoDurationSec}s</dd>
              </>
            )}
            <dt>time</dt>
            <dd>{formatRelativeTime(data?.renderedAt)}</dd>
            {bestIdx !== null && (
              <>
                <dt>best</dt>
                <dd>v{bestIdx + 1}</dd>
              </>
            )}
            {reviewVerdict && (
              <>
                <dt>review</dt>
                <dd>{REVIEW_LABELS[reviewVerdict]}</dd>
              </>
            )}
          </dl>

          <hr className="result-viewer__divider" />
          <span className="result-viewer__section-label">REVIEW</span>
          {reviewNoteControl}

          <div className="result-viewer__actions">
            {llmBusy && (
              // Inline busy banner explains why the action buttons are
              // disabled — without this the disabled state looks like a bug.
              <div className="result-viewer__busy-banner" role="status">
                <span className="node-header__llm-spinner" aria-hidden="true" />
                {data?.autoPromptStatus === "pending"
                  ? "Composing prompt — actions disabled until done"
                  : "Analyzing image — actions disabled until done"}
              </div>
            )}
            <button
              className="result-viewer__btn result-viewer__btn--primary"
              onClick={handleRegenerate}
              disabled={llmBusy}
              title={llmBusy ? "Backend is busy on this node — try again in a moment" : undefined}
            >
              Regenerate ⌘R
            </button>
            {isVideo && (
              <button
                className="result-viewer__btn"
                onClick={handleRefineVideoFromNote}
                disabled={!currentMediaId || llmBusy}
                title="Create a refined clip node from this review note and replace the timeline shot"
              >
                Refine video from note
              </button>
            )}
            {isVideo && (
              <button
                className="result-viewer__btn"
                onClick={handleExtendVideo}
                disabled={llmBusy}
                title="Create a follow-up clip node with same upstream refs"
              >
                Extend clip +
              </button>
            )}
            <button
              className="result-viewer__btn"
              onClick={handleNewVariant}
              disabled={llmBusy}
              title={
                llmBusy
                  ? "Backend is busy on this node — try again in a moment"
                  : "Clone this node onto the canvas with the same upstream refs"
              }
            >
              New variant +
            </button>
            <button
              className={
                "result-viewer__btn result-viewer__btn--best"
                + (currentIsBest && reviewIsGood ? " result-viewer__btn--best-active" : "")
              }
              onClick={handleMarkBest}
              disabled={!currentMediaId}
              title={
                !currentMediaId
                  ? "Wait for this variant to render"
                  : "Use this variant as the active clip/image for downstream generation and export"
              }
            >
              {currentIsBest && reviewIsGood ? "✓ Best variant" : "Mark best"}
            </button>
            <button
              className={
                "result-viewer__btn result-viewer__btn--redo"
                + (reviewIsRedo ? " result-viewer__btn--redo-active" : "")
              }
              onClick={handleRedoOnly}
              disabled={!currentMediaId}
              title="Mark this clip as needing redo"
            >
              {reviewIsRedo ? "Redo marked" : "Mark redo"}
            </button>
            {isVideo && (
              <button
                className="result-viewer__btn result-viewer__btn--redo"
                onClick={handleRedoFromNote}
                disabled={!currentMediaId || llmBusy}
                title="Create a redo clip node with same upstream refs"
              >
                Redo from note
              </button>
            )}
            <button
              className={
                "result-viewer__btn result-viewer__btn--skip"
                + (reviewIsSkip ? " result-viewer__btn--skip-active" : "")
              }
              onClick={handleSkipVariant}
              title="Omit this clip from timeline export, even if this slot has no media"
            >
              {reviewIsSkip ? "Skipped" : "Skip"}
            </button>
            <button
              className={
                "result-viewer__btn result-viewer__btn--save"
                + (savedFlash ? " result-viewer__btn--saved" : "")
              }
              onClick={handleSaveToLibrary}
              disabled={!currentMediaId || saving}
              title={
                !currentMediaId
                  ? "Wait for the generation to finish"
                  : "Save this variant to the cross-board Reference library"
              }
            >
              {savedFlash ? "★ Saved" : saving ? "…" : "★ Save to library"}
            </button>
            {projectId ? (
              <a
                className="result-viewer__btn result-viewer__btn--link"
                href={`https://labs.google/fx/tools/flow/project/${projectId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in Flow ↗
              </a>
            ) : (
              <button className="result-viewer__btn" disabled>
                Open in Flow ↗
              </button>
            )}
          </div>
        </div>

        {/* Footer hint */}
        <div className="result-viewer__footer-hint">
          esc close · ←/→ variants
        </div>

        {/* Close button */}
        <button
          className="result-viewer__close"
          onClick={closeResultViewer}
          aria-label="Close result viewer"
        >
          ×
        </button>
      </div>
    </div>
  );
}
