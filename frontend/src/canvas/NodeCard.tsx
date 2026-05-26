import { useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  useBoardStore,
  type ExportHistoryItem,
  type FlowboardNodeData,
  type FlowNode,
  type NodeStatus,
} from "../store/board";
import { useGenerationStore } from "../store/generation";
import {
  exportTimeline,
  mediaUrl,
  patchEdge,
  patchNode,
  uploadImage,
  uploadImageFromUrl,
  type ReferenceKind,
} from "../api/client";
import { requestAutoBrief } from "../api/autoBrief";
import { useReferencesStore } from "../store/references";
import {
  normaliseStoryboardGrid,
  resolveStoryboardLayout,
} from "../lib/storyboardPrompt";
import {
  bestVariantIndex,
  nodeMediaIds,
  preferredMediaIds,
} from "../lib/bestVariant";
import {
  findVideoRecipeDefinition,
  labelForExportPreset,
  type VideoExportPresetKey,
} from "../lib/videoRecipeLibrary";

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
  audio: "♪",
};

const STATUS_COLOR: Record<string, string> = {
  idle: "transparent",
  queued: "rgba(245, 179, 1, 0.6)",
  running: "var(--accent)",
  done: "rgba(110, 231, 183, 0.8)",
  error: "#ef4444",
};

function StatusStrip({ status }: { status?: string }) {
  const color = STATUS_COLOR[status ?? "idle"] ?? "transparent";
  const isRunning = status === "running";
  return (
    <div
      className={isRunning ? "status-strip status-strip--running" : "status-strip"}
      style={{ background: color }}
    />
  );
}

const ACCEPT_MIME = "image/png,image/jpeg,image/webp,image/gif";

function BriefHint({ data }: { data: FlowboardNodeData }) {
  if (data.autoPromptStatus === "pending") {
    return <p className="brief-hint brief-hint--pending">✨ Composing prompt…</p>;
  }
  if (data.aiBriefStatus === "pending") {
    return <p className="brief-hint brief-hint--pending">✨ Analyzing…</p>;
  }
  if (data.aiBrief) {
    return <p className="brief-hint" title={data.aiBrief}>✨ {data.aiBrief}</p>;
  }
  return null;
}

/**
 * True while the LLM layer is doing work on this node — composing an
 * auto-prompt or describing media for an aiBrief. Used to add a busy
 * treatment + disable Generate so the user can't double-fire.
 */
function isLLMBusy(data: FlowboardNodeData): boolean {
  return (
    data.autoPromptStatus === "pending"
    || data.aiBriefStatus === "pending"
  );
}

function CharacterBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const mediaId = data.mediaId;
  const isProcessing = data.status === "queued" || data.status === "running";
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      // Backend merges `data`, so we only need to send the deltas.
      // `null` is the explicit "clear this key" sentinel — undefined
      // gets dropped by JSON.stringify and would leave the stale brief
      // in place after the merge.
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    // Background vision call — fire-and-forget. Sets aiBrief on the node
    // when it returns; failure is silent.
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, projectId, isNaN(dbId) ? undefined : dbId);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  function onPick() {
    fileInputRef.current?.click();
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) uploadOwn(f);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadOwn(f);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragOver) setDragOver(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  // Filled state — show the avatar circle. Drag-drop on the avatar replaces it.
  if (mediaId) {
    return (
      <div
        className="node-body node-body--character"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <div
          className={`character-avatar${dragOver ? " character-avatar--over" : ""}${uploading ? " character-avatar--uploading" : ""}`}
          onClick={onPick}
          role="button"
          aria-label="Replace character image"
          tabIndex={0}
        >
          <img
            className="character-avatar__img"
            src={mediaUrl(mediaId)}
            alt={data.title}
          />
          {uploading && <span className="character-drop__overlay">…</span>}
        </div>
        <BriefHint data={data} />
        <button
          type="button"
          className="visual-asset__action"
          onClick={(e) => {
            e.stopPropagation();
            saveTileToLibrary({
              mediaId,
              nodeType: data.type,
              data,
            });
          }}
          title="Save this character to the library"
          aria-label="Save to library"
        >
          ★ Save
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_MIME}
          style={{ display: "none" }}
          onChange={onChange}
        />
        {error && <p className="character-drop__error" role="alert">{error}</p>}
      </div>
    );
  }

  // Empty state — compact action row (no oversized placeholder), but the
  // whole body still accepts drag-drop.
  return (
    <div
      className="node-body node-body--character"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div
        className={`character-empty${dragOver ? " character-empty--over" : ""}${isProcessing ? " character-empty--processing" : ""}`}
      >
        {isProcessing ? (
          <span className="visual-asset__hint">Generating…</span>
        ) : dragOver ? (
          <span className="visual-asset__hint">Drop image</span>
        ) : (
          <>
            <button
              type="button"
              className="visual-asset__action"
              onClick={onPick}
              disabled={uploading}
            >
              {uploading ? "Uploading…" : "Upload"}
            </button>
            <button
              type="button"
              className="visual-asset__action"
              onClick={openGenerate}
              disabled={uploading}
            >
              Generate
            </button>
          </>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_MIME}
        style={{ display: "none" }}
        onChange={onChange}
      />
      {error && <p className="character-drop__error" role="alert">{error}</p>}
    </div>
  );
}

// ── Reference-library save helpers ────────────────────────────────────────
//
function referenceKindFor(
  nodeType: string,
  data?: FlowboardNodeData,
): ReferenceKind {
  const text = [
    data?.title,
    data?.aiBrief,
    data?.prompt,
    nodeType,
  ]
    .filter((x): x is string => typeof x === "string")
    .join(" ")
    .toLowerCase();
  if (nodeType === "Storyboard") return "storyboard_shot";
  if (nodeType === "character") return "character";
  if (nodeType === "product") return "product";
  if (nodeType === "location") return "location";
  if (nodeType === "brand") return "brand";
  if (nodeType === "campaign") return "campaign";
  if (nodeType === "audio") return "audio";
  if (nodeType === "prompt") return "style";
  if (/(package|packaging|box|unbox)/.test(text)) return "package";
  if (/(background|location|room|cafe|street|park|interior|exterior)/.test(text)) return "location";
  if (/(style|mood|palette|lighting|aesthetic)/.test(text)) return "style";
  if (nodeType === "visual_asset") return "product";
  return "image";
}

function profileFromNodeData(
  mediaId: string,
  nodeType: string,
  data: FlowboardNodeData,
): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    kind: referenceKindFor(nodeType, data),
    mediaId,
    sourceNodeShortId: data.shortId,
    name: data.title,
  };
  const keys: (keyof FlowboardNodeData)[] = [
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
    "claimsAllowed",
    "claimsAvoid",
    "tone",
    "platform",
    "mustInclude",
    "mustAvoid",
    "palette",
    "cta",
    "legalNotes",
  ];
  for (const key of keys) {
    const value = data[key];
    if (value !== undefined && value !== "") {
      profile[key] = value;
    }
  }
  return profile;
}

const DOMAIN_PROFILE_FIELDS: Record<string, readonly {
  key: keyof FlowboardNodeData;
  label: string;
  multiline?: boolean;
}[]> = {
  product: [
    { key: "productName", label: "Product" },
    { key: "brandName", label: "Brand" },
    { key: "claimRules", label: "Claims", multiline: true },
  ],
  location: [
    { key: "locationName", label: "Location" },
    { key: "palette", label: "Palette" },
    { key: "legalNotes", label: "Limits", multiline: true },
  ],
  brand: [
    { key: "brandName", label: "Brand" },
    { key: "brandTone", label: "Tone" },
    { key: "palette", label: "Palette" },
    { key: "cta", label: "CTA" },
    { key: "legalNotes", label: "Legal", multiline: true },
  ],
  campaign: [
    { key: "objective", label: "Objective", multiline: true },
    { key: "audience", label: "Audience" },
    { key: "offer", label: "Offer" },
    { key: "cta", label: "CTA" },
    { key: "claimsAllowed", label: "Claims allowed", multiline: true },
    { key: "claimsAvoid", label: "Claims avoid", multiline: true },
    { key: "tone", label: "Tone" },
    { key: "platform", label: "Platform" },
    { key: "mustInclude", label: "Must include", multiline: true },
    { key: "mustAvoid", label: "Must avoid", multiline: true },
  ],
  audio: [
    { key: "voiceName", label: "Voice" },
    { key: "brandTone", label: "Tone" },
    { key: "legalNotes", label: "Audio limits", multiline: true },
  ],
};

function DomainProfileFields({
  rfId,
  data,
}: {
  rfId: string;
  data: FlowboardNodeData;
}) {
  const fields = DOMAIN_PROFILE_FIELDS[data.type] ?? [];
  if (fields.length === 0) return null;

  function saveField(key: keyof FlowboardNodeData, raw: string) {
    const value = raw.trim();
    const next = value || undefined;
    if ((data[key] ?? undefined) === next) return;
    const localPatch = { [key]: next } as Partial<FlowboardNodeData>;
    useBoardStore.getState().updateNodeData(rfId, localPatch);
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, { data: { [key]: value || null } }).catch(() => {});
    }
  }

  return (
    <div
      className="domain-profile nodrag"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {fields.map((field) => {
        const value = typeof data[field.key] === "string"
          ? (data[field.key] as string)
          : "";
        return (
          <label key={field.key} className="domain-profile__field">
            <span>{field.label}</span>
            {field.multiline ? (
              <textarea
                className="domain-profile__input domain-profile__input--area"
                defaultValue={value}
                rows={2}
                onBlur={(event) => saveField(field.key, event.target.value)}
              />
            ) : (
              <input
                className="domain-profile__input"
                defaultValue={value}
                onBlur={(event) => saveField(field.key, event.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

/** Fire-and-forget save of a tile's media into the reference library.
 * Errors surface via useReferencesStore.error; UI doesn't need to
 * await for the save to succeed before letting the user keep working. */
function saveTileToLibrary(opts: {
  mediaId: string;
  nodeType: string;
  data: FlowboardNodeData;
}) {
  const { mediaId, nodeType, data } = opts;
  const label =
    typeof data.aiBrief === "string" && data.aiBrief.trim().length > 0
      ? data.aiBrief.slice(0, 80)
      : `#${data.shortId}`;
  void useReferencesStore.getState().save({
    media_id: mediaId,
    kind: referenceKindFor(nodeType, data),
    ai_brief: typeof data.aiBrief === "string" ? data.aiBrief : null,
    aspect_ratio: typeof data.aspectRatio === "string" ? data.aspectRatio : null,
    profile: profileFromNodeData(mediaId, nodeType, data),
    label,
    source_board_id: useBoardStore.getState().boardId ?? null,
    source_node_short_id:
      typeof data.shortId === "string" ? data.shortId : null,
  });
}

const MAX_IMG_RETRIES = 5;

function tileCountFor(data: FlowboardNodeData): number {
  const fromVariants = data.variantCount;
  const fromMedia = data.mediaIds?.length;
  const n = fromVariants && fromVariants > 0 ? fromVariants : fromMedia ?? 1;
  return Math.max(1, Math.min(n, 4));
}

function ImageTile({
  rfId,
  mediaId,
  isBest,
  isProcessing,
  alt,
  onClick,
  onUseAsRef,
  onSaveToLibrary,
}: {
  rfId: string;
  mediaId: string | undefined;
  isBest?: boolean;
  isProcessing: boolean;
  alt: string;
  onClick?: () => void;
  /** When provided, render an overlay button on hover that pins this
   * variant to a downstream edge and triggers Generate on the target.
   * The parent only sets this when the node has multi-variant output
   * AND has a downstream image/video target — keeps the affordance
   * scoped to cases where it actually does something. */
  onUseAsRef?: () => void;
  /** When provided, render a "★" overlay (top-right corner, opposite
   * the "Use →" affordance) that snapshots this tile's media + aiBrief
   * into the cross-board reference library. Parents only pass this when
   * the tile has a real mediaId — saving a placeholder makes no sense. */
  onSaveToLibrary?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoaded(false);
    setAttempt(0);
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [mediaId, rfId]);

  if (!mediaId) {
    return (
      <div
        className={`thumbnail-tile${isProcessing ? " thumbnail-tile--processing" : ""}`}
        aria-hidden="true"
      >
        <span className="thumbnail-tile__icon">▣</span>
      </div>
    );
  }

  const givenUp = attempt >= MAX_IMG_RETRIES;
  const src = attempt > 0 ? `${mediaUrl(mediaId)}?retry=${attempt}` : mediaUrl(mediaId);
  const cls =
    `thumbnail-tile thumbnail-tile--filled` +
    (onClick ? " thumbnail-tile--clickable" : "");

  return (
    <div
      className={cls}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Open variant ${alt}` : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {!loaded && (
        <div className="thumbnail-tile__placeholder" aria-hidden="true" />
      )}
      {!givenUp && (
        <img
          key={attempt}
          className="thumbnail-tile__img"
          src={src}
          alt={alt}
          style={loaded ? undefined : { display: "none" }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      )}
      {onUseAsRef && (
        // Overlay action — visible on hover via CSS. Stops propagation
        // so clicking the chip doesn't also trigger the tile's
        // openResultViewer. Title doubles as accessible label.
        <button
          type="button"
          className="thumbnail-tile__use-btn"
          onClick={(e) => {
            e.stopPropagation();
            onUseAsRef();
          }}
          title="Use this variant as the reference for a downstream node"
          aria-label="Use this variant as reference"
        >
          Use →
        </button>
      )}
      {onSaveToLibrary && (
        // ★ overlay — top-right corner, opposite the "Use →" chip in
        // the bottom-right. Fire-and-forget save into the cross-board
        // reference library. Same stopPropagation pattern so clicking
        // the star doesn't also open the result viewer.
        <button
          type="button"
          className="thumbnail-tile__save-btn"
          onClick={(e) => {
            e.stopPropagation();
            onSaveToLibrary();
          }}
          title="Save this variant to the library"
          aria-label="Save to library"
        >
          ★
        </button>
      )}
      {isBest && (
        <span className="variant-best-badge" aria-label="Best variant">
          Best
        </span>
      )}
    </div>
  );
}

// ── Variant-click → bind upstream variant to a downstream edge ───────────
//
// Workflow: user clicks "Use →" on a specific variant tile of an
// upstream multi-variant node. We find the downstream image/video
// targets connected to it, pin the chosen variant index on the right
// edge (PATCH /api/edges/{id}), refresh the local edge.data so the
// `v{N+1}` chip surfaces immediately, and then dispatch Generate on
// the target. One click → one pinned ref → one Flow API call.
//
// Multi-target case: when the upstream has 2+ outgoing edges to gen
// targets, we surface a small picker so the user disambiguates which
// downstream this variant should feed.

interface VariantTarget {
  edgeId: string;
  targetRfId: string;
  title: string;
  kind: "image" | "video";
  hasPrompt: boolean;
}

interface VariantPickerState {
  variantIdx: number;
  targets: VariantTarget[];
}

function collectGenTargets(srcRfId: string): VariantTarget[] {
  const { nodes, edges } = useBoardStore.getState();
  const out: VariantTarget[] = [];
  for (const e of edges) {
    if (e.source !== srcRfId) continue;
    const t = nodes.find((n) => n.id === e.target);
    if (!t) continue;
    if (t.data.type !== "image" && t.data.type !== "video") continue;
    out.push({
      edgeId: e.id,
      targetRfId: t.id,
      title: t.data.title || `#${t.data.shortId}`,
      kind: t.data.type as "image" | "video",
      hasPrompt: typeof t.data.prompt === "string" && t.data.prompt.trim().length > 0,
    });
  }
  return out;
}

async function applyVariantToTarget(variantIdx: number, target: VariantTarget) {
  const edgeDbId = parseInt(target.edgeId, 10);
  if (!isNaN(edgeDbId)) {
    try {
      const updated = await patchEdge(edgeDbId, {
        source_variant_idx: variantIdx,
      });
      useBoardStore.getState().updateEdgeData(target.edgeId, {
        sourceVariantIdx: updated.source_variant_idx,
      });
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't pin variant: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  }
  // If the target doesn't have a prompt yet, we open the GenerationDialog
  // instead of dispatching blind — the dialog gives the user the
  // auto-prompt path or a place to type. The pin we just persisted will
  // apply to whichever Generate is fired from the dialog.
  const targetNode = useBoardStore
    .getState()
    .nodes.find((n) => n.id === target.targetRfId);
  if (!targetNode) return;
  const prompt = (targetNode.data.prompt ?? "").trim();
  if (!prompt) {
    useGenerationStore.getState().openGenerationDialog(target.targetRfId, "");
    return;
  }
  await useGenerationStore.getState().dispatchGeneration(target.targetRfId, {
    prompt,
    kind: target.kind,
    aspectRatio: targetNode.data.aspectRatio,
    variantCount: targetNode.data.variantCount,
  });
}

function VariantPicker({
  state,
  onPick,
  onCancel,
}: {
  state: VariantPickerState;
  onPick(target: VariantTarget): void;
  onCancel(): void;
}) {
  return (
    <div className="variant-picker" role="dialog" aria-label="Pick downstream target">
      <div className="variant-picker__heading">
        Use variant v{state.variantIdx + 1} for:
      </div>
      <ul className="variant-picker__list">
        {state.targets.map((t) => (
          <li key={t.edgeId}>
            <button
              type="button"
              className="variant-picker__btn"
              onClick={() => onPick(t)}
            >
              {t.title}
              <span className="variant-picker__kind">
                {t.kind === "video" ? "video" : "image"}
                {!t.hasPrompt ? " · empty" : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="variant-picker__cancel"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

function ImageBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const tileCount = tileCountFor(data);
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const hasMedia = ids.length > 0;
  const isProcessing = data.status === "queued" || data.status === "running";
  const bestIdx = bestVariantIndex(data);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Variant-picker state for the multi-downstream "Use →" flow. MUST be
  // declared above the empty-state early-return below — Rules of Hooks
  // require the same call order on every render, and the empty/filled
  // branches change which JSX renders but not which hooks run.
  const [picker, setPicker] = useState<VariantPickerState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      mediaIds: undefined,
      variantCount: 1,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      // Backend merges `data`. `null` is the explicit "delete this key"
      // sentinel — used here to drop stale variant arrays + cached brief
      // when the user replaces a generated set with a single uploaded image.
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          mediaIds: null,
          variantCount: 1,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, projectId, isNaN(dbId) ? undefined : dbId);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  function onPick() {
    fileInputRef.current?.click();
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) uploadOwn(f);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadOwn(f);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragOver) setDragOver(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  const hiddenFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept={ACCEPT_MIME}
      style={{ display: "none" }}
      onChange={onChange}
    />
  );

  // Empty state — same action-bar UX as character/visual_asset so users
  // can drop a reference image directly onto an image node instead of
  // having to wire one up via a separate visual_asset node.
  if (!hasMedia && !isProcessing) {
    return (
      <div
        className="node-body node-body--image"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <div className={`character-empty${dragOver ? " character-empty--over" : ""}`}>
          {dragOver ? (
            <span className="visual-asset__hint">Drop image</span>
          ) : (
            <>
              <button
                type="button"
                className="visual-asset__action"
                onClick={onPick}
                disabled={uploading}
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={openGenerate}
                disabled={uploading}
              >
                Generate
              </button>
            </>
          )}
        </div>
        <BriefHint data={data} />
        {hiddenFileInput}
        {error && <p className="character-drop__error" role="alert">{error}</p>}
      </div>
    );
  }

  // Variant-click flow: when this node is multi-variant AND has a
  // downstream image/video target, each tile gets a "Use →" overlay
  // button. Clicking it pins this variant on the appropriate edge and
  // dispatches Generate on the target. See `applyVariantToTarget` above.
  const isMultiVariant = ids.length >= 2;

  function onUseVariantClick(variantIdx: number) {
    const targets = collectGenTargets(rfId);
    if (targets.length === 0) {
      useGenerationStore.setState({
        error: "Connect this image to a downstream image/video target first.",
      });
      return;
    }
    if (targets.length === 1) {
      void applyVariantToTarget(variantIdx, targets[0]);
      return;
    }
    setPicker({ variantIdx, targets });
  }

  const tiles: JSX.Element[] = [];
  for (let i = 0; i < tileCount; i++) {
    const rawMid = ids[i];
    const mid = typeof rawMid === "string" && rawMid ? rawMid : undefined;
    const isBest = i === bestIdx;
    // Click a tile → open viewer at that variant. The "Use →" overlay
    // (when present) is a separate action handled by onUseAsRef.
    const onClick = mid
      ? () => useGenerationStore.getState().openResultViewer(rfId, i)
      : undefined;
    tiles.push(
      <ImageTile
        key={i}
        rfId={rfId}
        mediaId={mid}
        isBest={isBest}
        isProcessing={isProcessing && !mid}
        alt={data.title}
        onClick={onClick}
        onUseAsRef={
          isMultiVariant && mid && !isProcessing
            ? () => onUseVariantClick(i)
            : undefined
        }
        onSaveToLibrary={
          mid
            ? () =>
                saveTileToLibrary({
                  mediaId: mid,
                  nodeType: data.type,
                  data,
                })
            : undefined
        }
      />
    );
  }

  return (
    <div
      className={`node-body node-body--image${dragOver ? " node-body--image--over" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className={`thumbnail-grid thumbnail-grid--${tileCount}`}>
        {tiles}
      </div>
      {picker && (
        <VariantPicker
          state={picker}
          onPick={(target) => {
            void applyVariantToTarget(picker.variantIdx, target);
            setPicker(null);
          }}
          onCancel={() => setPicker(null)}
        />
      )}
      <BriefHint data={data} />
      {hiddenFileInput}
      {error && <p className="character-drop__error" role="alert">{error}</p>}
    </div>
  );
}

const MAX_VIDEO_RETRIES = 5;

function VideoTile({
  mediaId,
  posterMediaId,
  isBest,
  isProcessing,
  isError,
  slotError,
  alt,
  onClick,
}: {
  mediaId: string | undefined;
  isBest?: boolean;
  // Upstream image's mediaId — used as the static poster so the tile
  // shows the source-image framing (subject centered, just like the
  // image-tile preview) instead of the video's frame-0 which often
  // catches a setup beat (ceiling, empty room) before the subject is
  // composed in.
  posterMediaId?: string | undefined;
  isProcessing: boolean;
  isError: boolean;
  // Per-slot error code (e.g. "PUBLIC_ERROR_UNSAFE_GENERATION") when
  // this specific variant got blocked by Veo's safety classifier. Only
  // surfaced for the partial-batch case so the tile can render a
  // distinctive ⚠ + tooltip instead of the generic empty placeholder.
  slotError?: string | null;
  alt: string;
  onClick?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoaded(false);
    setAttempt(0);
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [mediaId]);

  const blockedTitle = slotError
    ? `Variant blocked: ${slotError} — click for details`
    : undefined;

  const placeholder = (
    <div
      className={`video-placeholder${isProcessing ? " video-placeholder--processing" : ""}${isError ? " video-placeholder--error" : ""}${slotError ? " video-placeholder--blocked" : ""}`}
      aria-hidden="true"
      title={blockedTitle}
    >
      {slotError ? (
        <>
          <span className="video-blocked-icon">⚠</span>
          <span className="video-blocked-label">Blocked</span>
        </>
      ) : (
        <>
          <span className="video-play">▶</span>
          <span className="video-duration">0:00</span>
        </>
      )}
    </div>
  );

  if (!mediaId) {
    // Pending / failed tile — just the placeholder. When `slotError` is
    // set the placeholder swaps to the warning treatment above. We
    // still attach onClick so the user can click through to the
    // detail viewer to read the full error.
    const cls = `video-tile${slotError ? " video-tile--blocked" : ""}${onClick ? " video-tile--clickable" : ""}`;
    return (
      <div
        className={cls}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-label={blockedTitle ?? (onClick ? `Open variant ${alt}` : undefined)}
        title={blockedTitle}
        onClick={onClick}
        onKeyDown={(e) => {
          if (!onClick) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {placeholder}
      </div>
    );
  }

  const givenUp = attempt >= MAX_VIDEO_RETRIES;
  const src = attempt > 0 ? `${mediaUrl(mediaId)}?retry=${attempt}` : mediaUrl(mediaId);
  const cls =
    `video-tile video-tile--filled` +
    (onClick ? " video-tile--clickable" : "");

  return (
    <div
      className={cls}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Open variant ${alt}` : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {!loaded && placeholder}
      {!givenUp && posterMediaId ? (
        // Thumbnail = static poster image (the upstream i2v source).
        // Mounting a <video> here decodes frame 0 in Chrome and
        // overrides the poster attribute, which is what made every
        // tile display the video's setup beat (often empty ceiling)
        // instead of the subject-centered framing. The full video
        // with controls plays in the ResultViewer modal — clicking
        // a tile already routes there.
        <img
          key={`poster-${attempt}`}
          className="video-tile__poster"
          src={mediaUrl(posterMediaId)}
          alt={alt}
          onLoad={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      ) : !givenUp ? (
        // Fallback: no upstream poster available (orphan video node).
        // Mount the <video> directly with `preload="none"` so the
        // browser shows the bare frame instead of decoding frame 0.
        <video
          key={attempt}
          className="node-card__thumbnail"
          data-kind="video"
          src={src}
          preload="none"
          muted
          aria-label={alt}
          style={loaded ? undefined : { display: "none" }}
          onLoadedData={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      ) : null}
      {posterMediaId && (
        <span className="video-tile__play-badge" aria-hidden="true">▶</span>
      )}
      {isBest && (
        <span className="variant-best-badge" aria-label="Best variant">
          Best
        </span>
      )}
    </div>
  );
}

function VideoBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const tileCount = tileCountFor(data);
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const isProcessing = data.status === "queued" || data.status === "running";
  const isError = data.status === "error";
  const bestIdx = bestVariantIndex(data);
  // Partial-batch case: status="done" + an error string means some
  // variants succeeded and others got blocked (filter / timeout).
  // Slot-level signal: `mediaIds[i] === null` is a positional
  // placeholder for a blocked variant — render the tile as filtered
  // rather than empty/processing.
  const isPartial = data.status === "done" && Boolean(data.error);

  // Resolve the upstream image used as the i2v source — its variants
  // become the per-tile poster so the static preview shows the same
  // subject-centered framing as the upstream image card. Multi-source
  // i2v: variant i of the video came from variant i of the upstream
  // image; single-source: every tile shares the same poster.
  const { nodes, edges } = useBoardStore.getState();
  const incomingEdges = edges.filter((e) => e.target === rfId);
  const upstreamEdge = incomingEdges.find((e) => e.data?.refRole === "first_frame")
    ?? incomingEdges.find((e) => {
      const n = nodes.find((node) => node.id === e.source);
      return n?.data.type === "image" || n?.data.type === "Storyboard";
    })
    ?? incomingEdges[0];
  const upstreamNode = upstreamEdge
    ? nodes.find((n) => n.id === upstreamEdge.source)
    : undefined;
  const posterIds: (string | null)[] =
    upstreamNode?.data.mediaIds ??
    (upstreamNode?.data.mediaId ? [upstreamNode.data.mediaId] : []);

  const tiles: JSX.Element[] = [];
  for (let i = 0; i < tileCount; i++) {
    const rawMid = ids[i];
    const mid = typeof rawMid === "string" && rawMid ? rawMid : undefined;
    const isBest = i === bestIdx;
    const slotError = data.slotErrors?.[i] ?? null;
    const slotBlocked = isPartial && rawMid === null;
    // Even blocked tiles get a click handler so the user can open the
    // detail viewer and read the full filter reason — without it the
    // tile is dead and the user has no way to understand why it's
    // empty.
    const onClick =
      mid || slotBlocked || slotError || isError
        ? () => useGenerationStore.getState().openResultViewer(rfId, i)
        : undefined;
    // Pick the i-th source variant if available; fall back to the
    // first non-null source for single-source i2v where every video
    // shares it.
    const rawPoster = posterIds[i] ?? posterIds.find((p) => Boolean(p)) ?? null;
    const poster = typeof rawPoster === "string" ? rawPoster : undefined;
    tiles.push(
      <VideoTile
        key={i}
        mediaId={mid}
        posterMediaId={poster}
        isBest={isBest}
        isProcessing={isProcessing && !mid}
        isError={(isError && !mid) || slotBlocked}
        slotError={slotError}
        alt={data.title}
        onClick={onClick}
      />,
    );
  }

  return (
    <div className="node-body node-body--video">
      <div className={`video-grid video-grid--${tileCount}`}>
        {tiles}
      </div>
      {(isError || isPartial) && data.error && (
        <p
          className={`node-error${isPartial ? " node-error--partial" : ""}`}
          role={isError ? "alert" : "status"}
        >
          {data.error}
        </p>
      )}
    </div>
  );
}

function VisualAssetBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const mediaId = data.mediaId;
  const isProcessing = data.status === "queued" || data.status === "running";
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState("");
  const [refRefreshKey, setRefRefreshKey] = useState(0);
  const [refMediaId, setRefMediaId] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      mediaIds: [newMediaId],
      variantCount: 1,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      // Backend merges `data`, so we only need to send the deltas.
      // `null` clears aiBrief explicitly (undefined would be dropped
      // by JSON.stringify and leave the stale brief in place).
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          mediaIds: [newMediaId],
          variantCount: 1,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, projectId, isNaN(dbId) ? undefined : dbId);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function uploadFromLink(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setUploading(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImageFromUrl(
        trimmed,
        projectId,
        isNaN(dbId) ? undefined : dbId,
      );
      persistMedia(resp.media_id, resp.aspect_ratio);
      setLinkMode(false);
      setLinkValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "link upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function uploadRef(file: File) {
    setError(null);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      if (!projectId) {
        setError("no project");
        return;
      }
      const resp = await uploadImage(file, projectId);
      setRefMediaId(resp.media_id);
      setRefRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ref upload failed");
    }
  }

  async function submitRefine() {
    if (!mediaId) return;
    if (!refinePrompt.trim()) return;
    await useGenerationStore.getState().refineImage(rfId, {
      prompt: refinePrompt.trim(),
      refMediaIds: refMediaId ? [refMediaId] : [],
    });
    setRefineOpen(false);
    setRefinePrompt("");
    setRefMediaId(null);
  }

  function openGenerate() {
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  if (!mediaId) {
    return (
      <div className="node-body node-body--visual-asset">
        <div
          className={`visual-asset__empty${isProcessing ? " visual-asset__empty--processing" : ""}`}
        >
          {isProcessing ? (
            <span className="visual-asset__hint">Generating…</span>
          ) : linkMode ? (
            <div className="visual-asset__link-row">
              <input
                type="url"
                className="visual-asset__link-input"
                placeholder="https://… (png/jpg/webp)"
                value={linkValue}
                onChange={(e) => setLinkValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") uploadFromLink(linkValue);
                  if (e.key === "Escape") {
                    setLinkMode(false);
                    setLinkValue("");
                    setError(null);
                  }
                }}
                disabled={uploading}
                autoFocus
              />
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => uploadFromLink(linkValue)}
                disabled={uploading || !linkValue.trim()}
              >
                {uploading ? "Fetching…" : "Save"}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => {
                  setLinkMode(false);
                  setLinkValue("");
                  setError(null);
                }}
                disabled={uploading}
              >
                ×
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => {
                  setError(null);
                  setLinkMode(true);
                }}
                disabled={uploading}
              >
                Add link
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={openGenerate}
                disabled={uploading}
              >
                Generate
              </button>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadOwn(f);
            e.target.value = "";
          }}
        />
        {error && <p className="visual-asset__error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="node-body node-body--visual-asset node-body--visual-asset-with-media">
      <div className="visual-asset__media">
        <img
          className="visual-asset__image"
          src={mediaUrl(mediaId)}
          alt={data.title}
        />
        {!isProcessing && (
          <button
            type="button"
            className="visual-asset__refine-btn"
            onClick={() => setRefineOpen((o) => !o)}
            aria-label="Refine image"
          >
            Refine
          </button>
        )}
      </div>
      <BriefHint data={data} />
      {!isProcessing && (
        <button
          type="button"
          className="visual-asset__action"
          onClick={(e) => {
            e.stopPropagation();
            saveTileToLibrary({
              mediaId,
              nodeType: data.type,
              data,
            });
          }}
          title="Save this asset to the library"
          aria-label="Save to library"
        >
          ★ Save
        </button>
      )}
      {refineOpen && (
        <div className="visual-asset__refine-panel" role="region" aria-label="Refine">
          <textarea
            className="visual-asset__refine-textarea"
            placeholder="Describe the change…"
            rows={2}
            value={refinePrompt}
            onChange={(e) => setRefinePrompt(e.target.value)}
          />
          <div className="visual-asset__refine-actions">
            <button
              type="button"
              className="visual-asset__refine-ref"
              onClick={() => refInputRef.current?.click()}
            >
              {refMediaId ? `Ref ✓ (${refRefreshKey})` : "Add ref"}
            </button>
            <button
              type="button"
              className="visual-asset__refine-submit"
              disabled={!refinePrompt.trim()}
              onClick={submitRefine}
            >
              Refine →
            </button>
          </div>
          <input
            ref={refInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadRef(f);
              e.target.value = "";
            }}
          />
        </div>
      )}
      {error && <p className="visual-asset__error">{error}</p>}
    </div>
  );
}

// Shared editable body for prompt + note nodes. Both store free-form text
// in `data.prompt`; only display markup differs. Double-click swaps to a
// textarea; blur or Cmd/Ctrl+Enter saves; Esc cancels.
function EditableTextBody({
  rfId,
  data,
  variant,
}: {
  rfId: string;
  data: FlowboardNodeData;
  variant: "prompt" | "note";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.prompt ?? "");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(data.prompt ?? "");
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
  }, [editing]);

  function save() {
    const next = draft;
    if (next !== (data.prompt ?? "")) {
      useBoardStore.getState().updateNodeData(rfId, { prompt: next });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) {
        // Backend merges `data`, so only the prompt delta needs shipping.
        patchNode(dbId, { data: { prompt: next } }).catch(() => {});
      }
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <div className={`node-body node-body--${variant} node-body--${variant}-edit`}>
        <textarea
          ref={taRef}
          className={`${variant}-editor`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder={
            variant === "prompt"
              ? "Style direction (e.g. cinematic warm tone, magazine editorial mood). Connect into image/video to feed downstream auto-prompt."
              : "Note, TODO, label…"
          }
        />
      </div>
    );
  }

  const text = data.prompt ?? "";
  const placeholder =
    variant === "prompt"
      ? "Double-click to add direction…"
      : "Double-click to add note…";

  return (
    <div
      className={`node-body node-body--${variant}`}
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
    >
      {variant === "prompt" ? (
        <pre className="prompt-text">{text || placeholder}</pre>
      ) : (
        <p className="note-text">{text || placeholder}</p>
      )}
    </div>
  );
}

// ── Shot workflow ─────────────────────────────────────────────────────────
// Phase5 MVP stores shot/timeline semantics in node.data so the backend can
// create a production layer without a DB migration or new ReactFlow type.

function ShotBadge({ data, kind }: { data: FlowboardNodeData; kind: "frame" | "clip" }) {
  const index = typeof data.shotIndex === "number" ? data.shotIndex : null;
  const duration = typeof data.shotDurationSec === "number" ? data.shotDurationSec : null;
  return (
    <div className="shot-badge" title={data.shotId}>
      <span>{index ? `Shot ${index} / Cảnh ${index}` : "Shot / Cảnh"}</span>
      <span>{kind === "frame" ? "First frame / Khung đầu" : "Clip / Video"}</span>
      {duration && <span>{duration}s</span>}
    </div>
  );
}

function ShotFrameBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  return (
    <div className="shot-wrap">
      <ShotBadge data={data} kind="frame" />
      <ImageBody rfId={rfId} data={data} />
    </div>
  );
}

function ShotClipBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  return (
    <div className="shot-wrap">
      <ShotBadge data={data} kind="clip" />
      <VideoBody rfId={rfId} data={data} />
    </div>
  );
}

const STATUS_LABEL_VI: Record<NodeStatus, string> = {
  idle: "chờ",
  queued: "đợi",
  running: "đang",
  done: "xong",
  error: "lỗi",
};
const REVIEW_LABEL_VI: Record<"good" | "redo" | "skip", string> = {
  good: "good / tốt",
  redo: "redo / làm lại",
  skip: "skip / bỏ qua",
};

type TimelineExportUiState = "none" | "fresh" | "stale";
type TimelineExportPresetKey = VideoExportPresetKey;

const TIMELINE_EXPORT_PRESETS: readonly {
  key: TimelineExportPresetKey;
  label: string;
  width: number;
  height: number;
}[] = [
  { key: "portrait_1080", label: "9:16 1080p", width: 1080, height: 1920 },
  { key: "landscape_1080", label: "16:9 1080p", width: 1920, height: 1080 },
  { key: "square_1080", label: "1:1 1080p", width: 1080, height: 1080 },
];

function timelineExportUiState(data: FlowboardNodeData): TimelineExportUiState {
  if (!data.exportMediaId) return "none";
  return data.exportStatus === "stale" ? "stale" : "fresh";
}

function timelineExportStateLabel(
  state: TimelineExportUiState,
  version?: number,
): string {
  const suffix = typeof version === "number" ? ` v${version}` : "";
  if (state === "fresh") return `Export fresh${suffix} / mới`;
  if (state === "stale") return `Export stale${suffix} / bản cũ`;
  return "Export none / chưa xuất";
}

function timelineExportHistory(data: FlowboardNodeData): ExportHistoryItem[] {
  const raw = Array.isArray(data.exportHistory) ? data.exportHistory : [];
  return raw
    .filter((item): item is ExportHistoryItem =>
      !!item && typeof item.mediaId === "string" && item.mediaId.length > 0,
    )
    .slice()
    .reverse();
}

function timelineHistoryLabel(item: ExportHistoryItem): string {
  const version = typeof item.version === "number" ? `v${item.version}` : "old";
  const status = item.status ?? "fresh";
  const clips = typeof item.clipCount === "number" ? `${item.clipCount} clips` : "clips ?";
  return `${version} · ${status} · ${clips}`;
}

function timelineHistoryDateLabel(iso?: string): string {
  if (!iso) return "time ?";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "time ?";
  return new Date(t).toLocaleString("vi-VN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timelineDefaultExportPreset(data: FlowboardNodeData): TimelineExportPresetKey {
  if (
    data.exportPreset === "landscape_1080"
    || data.exportPreset === "square_1080"
    || data.exportPreset === "portrait_1080"
  ) {
    return data.exportPreset;
  }
  const recipe = findVideoRecipeDefinition(data.timelineRecipeId ?? data.videoRecipeId);
  return recipe?.exportPreset ?? "portrait_1080";
}

function isNodeBusy(data: FlowboardNodeData): boolean {
  return data.status === "queued" || data.status === "running";
}

function TimelineBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const paygateTier = useGenerationStore((s) => s.paygateTier);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const setTimelineActiveClip = useBoardStore((s) => s.setTimelineActiveClip);
  const [runnerBusy, setRunnerBusy] = useState<"frames" | "clips" | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportPreflightOpen, setExportPreflightOpen] = useState(false);
  const [exportPresetKey, setExportPresetKey] = useState<TimelineExportPresetKey>(
    timelineDefaultExportPreset(data),
  );
  const incoming = edges
    .filter((e) => e.target === rfId)
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter((n): n is FlowNode => !!n && n.data.workflowKind === "shot_clip")
    .sort((a, b) => (a.data.shotIndex ?? 0) - (b.data.shotIndex ?? 0));
  const shotPairs = incoming.map((clip) => {
    const frameEdge = edges.find(
      (e) => e.target === clip.id && e.data?.refRole === "first_frame",
    );
    const frame = frameEdge
      ? nodes.find(
        (n) => n.id === frameEdge.source && n.data.workflowKind === "shot_frame",
      )
      : undefined;
    return { clip, frame };
  });
  const frameTargets = shotPairs
    .map((pair) => pair.frame)
    .filter((frame): frame is FlowNode =>
      !!frame && nodeMediaIds(frame.data).length === 0 && !isNodeBusy(frame.data),
    );
  const clipTargets = shotPairs.filter(
    ({ clip, frame }) =>
      !!frame
      && nodeMediaIds(frame.data).length > 0
      && nodeMediaIds(clip.data).length === 0
      && clip.data.reviewVerdict !== "skip"
      && !isNodeBusy(clip.data),
  );
  const framesReady = shotPairs.filter(({ frame }) => !!frame && nodeMediaIds(frame.data).length > 0).length;
  const clipsReady = shotPairs.filter(({ clip }) => nodeMediaIds(clip.data).length > 0).length;
  const redoCount = shotPairs.filter(({ clip }) => clip.data.reviewVerdict === "redo").length;
  const skippedCount = shotPairs.filter(({ clip }) => clip.data.reviewVerdict === "skip").length;
  const nonSkipClipCount = shotPairs.length - skippedCount;
  const exportableClipCount = shotPairs.filter(
    ({ clip }) =>
      nodeMediaIds(clip.data).length > 0
      && clip.data.reviewVerdict !== "skip",
  ).length;
  const allFramesReady = shotPairs.length > 0 && framesReady === shotPairs.length;
  const runnerBlocked = paygateTier === null;
  const canRunFrames = frameTargets.length > 0 && runnerBusy === null && !runnerBlocked;
  const canRunClips = allFramesReady && clipTargets.length > 0 && runnerBusy === null && !runnerBlocked;
  const canExport =
    shotPairs.length > 0
    && nonSkipClipCount > 0
    && exportableClipCount === nonSkipClipCount
    && redoCount === 0
    && !exportBusy;
  const exportState = timelineExportUiState(data);
  const exportButtonLabel = exportBusy
    ? "Exporting / Đang xuất"
    : exportState === "stale"
      ? "Re-export fresh / Xuất lại"
      : exportState === "fresh"
        ? "Re-export / Xuất lại"
        : "Export short / Xuất video";
  const exportLinkLabel = exportState === "stale"
    ? "Open stale export / Mở bản cũ"
    : "Open export / Mở file";
  const exportStateTitle = data.exportStaleReason
    ? `Export status: ${exportState}. Reason: ${data.exportStaleReason}`
    : `Export status: ${exportState}`;
  const exportHistory = timelineExportHistory(data);
  const exportPreset =
    TIMELINE_EXPORT_PRESETS.find((p) => p.key === exportPresetKey)
    ?? TIMELINE_EXPORT_PRESETS[0];
  const exportRecipe = findVideoRecipeDefinition(data.timelineRecipeId ?? data.videoRecipeId);
  const shotIds = Array.isArray(data.timelineShotIds) ? data.timelineShotIds : [];
  const rows = incoming.length > 0
    ? incoming
    : shotIds.map((shotId, idx) => ({
      id: shotId,
      data: {
        type: "video" as const,
        shortId: shotId,
        title: `Shot ${idx + 1}`,
        shotId,
        shotIndex: idx + 1,
        status: "idle" as NodeStatus,
      },
      position: { x: 0, y: 0 },
      type: "video",
    } as FlowNode));

  async function runFrames() {
    if (!canRunFrames) return;
    setRunnerBusy("frames");
    try {
      for (const frame of frameTargets) {
        await dispatchGeneration(frame.id, {
          kind: "image",
          prompt: frame.data.prompt ?? "",
          aspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT",
          variantCount: 1,
        });
      }
    } finally {
      setRunnerBusy(null);
    }
  }

  async function runClips() {
    if (!canRunClips) return;
    setRunnerBusy("clips");
    try {
      for (const { clip, frame } of clipTargets) {
        const sourceMediaIds = preferredMediaIds(frame!.data);
        await dispatchGeneration(clip.id, {
          kind: "video",
          prompt: clip.data.prompt ?? "",
          aspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
          sourceMode: "first_frame",
          sourceMediaId: sourceMediaIds[0],
          sourceMediaIds: sourceMediaIds.length > 1 ? sourceMediaIds : undefined,
          durationSec:
            typeof clip.data.shotDurationSec === "number"
              ? clip.data.shotDurationSec
              : typeof clip.data.videoDurationSec === "number"
                ? clip.data.videoDurationSec
                : 8,
        });
      }
    } finally {
      setRunnerBusy(null);
    }
  }

  async function runExport() {
    if (!canExport) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) return;
      const result = await exportTimeline(dbId, {
        width: exportPreset.width,
        height: exportPreset.height,
      });
      useBoardStore.getState().updateNodeData(rfId, {
        status: "done",
        exportMediaId: result.media_id,
        exportClipCount: result.clip_count,
        exportSize: `${result.width}x${result.height}`,
        exportedAt: result.exported_at ?? new Date().toISOString(),
        exportStatus: result.export_status ?? "fresh",
        exportVersion: result.export_version,
        exportSourceMediaIds: result.source_media_ids,
        exportHistory: result.export_history,
        exportStaleAt: undefined,
        exportStaleReason: undefined,
        exportPreset: exportPreset.key,
        exportWidth: exportPreset.width,
        exportHeight: exportPreset.height,
      });
      const timelineDbId = parseInt(rfId, 10);
      if (!isNaN(timelineDbId)) {
        patchNode(timelineDbId, {
          data: {
            exportPreset: exportPreset.key,
            exportWidth: exportPreset.width,
            exportHeight: exportPreset.height,
          },
        }).catch(() => {});
      }
      setExportPreflightOpen(false);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <div className="node-body node-body--timeline">
      <div className="timeline-header">
        <span>Timeline / Dòng dựng</span>
        <span>{rows.length} shots / cảnh</span>
      </div>
      <div className="timeline-actions">
        <button
          type="button"
          className="timeline-run-btn"
          onClick={(event) => {
            event.stopPropagation();
            void runFrames();
          }}
          disabled={!canRunFrames}
          title={runnerBlocked ? "Open Flow to detect tier / Mở Flow để nhận diện gói" : undefined}
        >
          {runnerBusy === "frames" ? "Queueing frames / Đang xếp ảnh" : "Generate frames / Tạo ảnh cảnh"}
        </button>
        <button
          type="button"
          className="timeline-run-btn"
          onClick={(event) => {
            event.stopPropagation();
            void runClips();
          }}
          disabled={!canRunClips}
          title={
            runnerBlocked
              ? "Open Flow to detect tier / Mở Flow để nhận diện gói"
              : allFramesReady
              ? undefined
              : "Generate first frames first / Tạo ảnh cảnh trước"
          }
        >
          {runnerBusy === "clips" ? "Queueing clips / Đang xếp video" : "Generate clips / Tạo video"}
        </button>
        <button
          type="button"
          className="timeline-run-btn"
          onClick={(event) => {
            event.stopPropagation();
            setExportPreflightOpen(true);
          }}
          disabled={!canExport}
          title={
            redoCount > 0
              ? "Fix redo clips first / Sửa cảnh redo trước"
              : exportableClipCount === 0
                ? "No exportable clips / Không có cảnh xuất"
                : exportableClipCount === nonSkipClipCount
                  ? undefined
                  : "Generate non-skipped clips first / Tạo video cảnh chưa bỏ trước"
          }
        >
          {exportButtonLabel}
        </button>
        {data.exportMediaId && (
          <a
            className={`timeline-run-btn${exportState === "stale" ? " timeline-run-btn--stale" : ""}`}
            href={mediaUrl(data.exportMediaId)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {exportLinkLabel}
          </a>
        )}
      </div>
      {exportPreflightOpen && (
        <div
          className="timeline-preflight nodrag"
          role="dialog"
          aria-label="Export preflight"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="timeline-preflight__header">
            <span>Export preflight / Kiểm tra xuất</span>
            <button
              type="button"
              className="timeline-preflight__close"
              onClick={() => setExportPreflightOpen(false)}
            >
              esc
            </button>
          </div>
          {exportRecipe && (
            <div className="timeline-preflight__recipe">
              <span>{exportRecipe.label}</span>
              <small>Default {labelForExportPreset(exportRecipe.exportPreset)}</small>
            </div>
          )}
          <div className="timeline-preflight__presets">
            {TIMELINE_EXPORT_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={`timeline-preflight__preset${
                  exportPresetKey === preset.key ? " timeline-preflight__preset--active" : ""
                }`}
                onClick={() => setExportPresetKey(preset.key)}
              >
                <span>{preset.label}</span>
                <small>{preset.width}x{preset.height}</small>
              </button>
            ))}
          </div>
          <div className="timeline-preflight__clips">
            {shotPairs
              .filter(({ clip }) =>
                nodeMediaIds(clip.data).length > 0
                && clip.data.reviewVerdict !== "skip",
              )
              .map(({ clip }) => {
                const idx = clip.data.shotIndex ?? 0;
                const bestIdx = bestVariantIndex(clip.data);
                const sourceIds = preferredMediaIds(clip.data);
                return (
                  <div key={clip.id} className="timeline-preflight__clip">
                    <span>Shot {idx || "?"}</span>
                    <strong>
                      {bestIdx !== null ? `v${bestIdx + 1}` : "active"} · {clip.data.reviewVerdict ?? "unreviewed"}
                    </strong>
                    <code>{sourceIds[0] ?? "no-media"}</code>
                  </div>
                );
              })}
          </div>
          <div className="timeline-preflight__footer">
            <span>
              {exportableClipCount} clips · {exportPreset.width}x{exportPreset.height}
            </span>
            <button
              type="button"
              className="timeline-run-btn"
              onClick={() => void runExport()}
              disabled={exportBusy}
            >
              {exportBusy ? "Exporting / Đang xuất" : "Confirm export / Xuất"}
            </button>
          </div>
        </div>
      )}
      <div
        className={`timeline-export-state timeline-export-state--${exportState}`}
        aria-label={`Export status: ${exportState}`}
        title={exportStateTitle}
      >
        <span>{timelineExportStateLabel(exportState, data.exportVersion)}</span>
        {data.exportMediaId && (
          <span>{data.exportClipCount ?? exportableClipCount} clips</span>
        )}
      </div>
      <div className="timeline-run-summary">
        {framesReady}/{shotPairs.length} frames / ảnh · {clipsReady}/{shotPairs.length} clips / video
        {exportableClipCount !== clipsReady ? ` · ${exportableClipCount} exportable / xuất` : ""}
        {skippedCount > 0 ? ` · ${skippedCount} skip / bỏ` : ""}
        {redoCount > 0 ? ` · ${redoCount} redo blocks export` : ""}
        {data.exportMediaId ? ` · ${exportState} export ${data.exportClipCount ?? clipsReady} clips` : ""}
      </div>
      {exportHistory.length > 0 && (
        <details className="timeline-export-history">
          <summary>History / Lịch sử ({exportHistory.length})</summary>
          <div className="timeline-export-history__list">
            {exportHistory.map((item, index) => {
              const versionSuffix = typeof item.version === "number" ? ` v${item.version}` : "";
              const reason = item.staleReason ?? item.status ?? "export";
              return (
                <a
                  key={`${item.mediaId}-${item.version ?? index}`}
                  className="timeline-export-history__item"
                  href={mediaUrl(item.mediaId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  <span>{timelineHistoryLabel(item)}</span>
                  <span>{timelineHistoryDateLabel(item.exportedAt)}</span>
                  <span>{reason}</span>
                  <strong>Open history export{versionSuffix} / Mở bản cũ{versionSuffix}</strong>
                </a>
              );
            })}
          </div>
        </details>
      )}
      {exportError && (
        <div className="timeline-run-summary timeline-run-summary--error" role="alert">
          {exportError}
        </div>
      )}
      <div className="timeline-shot-list">
        {rows.map((clip) => {
          const index = clip.data.shotIndex ?? 0;
          const hasMedia = nodeMediaIds(clip.data).length > 0;
          const bestIdx = bestVariantIndex(clip.data);
          const reviewVerdict = clip.data.reviewVerdict;
          const status = clip.data.status ?? "idle";
          const shotId = clip.data.shotId;
          const candidates = typeof shotId === "string" && shotId
            ? nodes
              .filter((candidate) =>
                candidate.data.workflowKind === "shot_clip"
                && candidate.data.shotId === shotId,
              )
              .sort((a, b) => {
                const at = a.data.renderedAt ?? "";
                const bt = b.data.renderedAt ?? "";
                return at.localeCompare(bt) || a.id.localeCompare(b.id);
              })
            : [];
          const openClip = () => {
            if (hasMedia) {
              useGenerationStore.getState().openResultViewer(clip.id, bestIdx ?? 0);
            } else if (/^\d+$/.test(clip.id)) {
              useGenerationStore
                .getState()
                .openGenerationDialog(clip.id, clip.data.prompt ?? "");
            }
          };
          return (
            <div
              key={clip.id}
              role="button"
              tabIndex={0}
              className={`timeline-shot-row timeline-shot-row--${status}${reviewVerdict ? ` timeline-shot-row--review-${reviewVerdict}` : ""}`}
              onClick={openClip}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openClip();
                }
              }}
              title={clip.data.title}
            >
              <div className="timeline-shot-row__main">
                <span className="timeline-shot-row__name">
                  Shot {index || "?"} / Cảnh {index || "?"}
                </span>
                {candidates.length > 1 && shotId && (
                  <select
                    className="timeline-shot-row__active-select"
                    value={clip.id}
                    aria-label={`Active clip for shot ${index || "?"}`}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      event.stopPropagation();
                      void setTimelineActiveClip(rfId, shotId, event.target.value);
                    }}
                  >
                    {candidates.map((candidate) => {
                      const candidateBest = bestVariantIndex(candidate.data);
                      const candidateStatus = candidate.data.status ?? "idle";
                      const suffix =
                        candidate.id === clip.id
                          ? "active"
                          : candidate.data.reviewVerdict ?? candidateStatus;
                      return (
                        <option key={candidate.id} value={candidate.id}>
                          #{candidate.data.shortId} {candidateBest !== null ? `v${candidateBest + 1}` : candidateStatus} · {suffix}
                        </option>
                      );
                    })}
                  </select>
                )}
              </div>
              <span className="timeline-shot-row__status">
                {hasMedia ? "done / xong" : `${status} / ${STATUS_LABEL_VI[status] ?? status}`}
                {hasMedia && bestIdx !== null && (
                  <span className="timeline-shot-row__best">
                    best v{bestIdx + 1}
                  </span>
                )}
                {reviewVerdict && (
                  <span className="timeline-shot-row__review">
                    {REVIEW_LABEL_VI[reviewVerdict]}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Storyboard ────────────────────────────────────────────────────────────
// Storyboard is a thin image-node wrapper. It dispatches via the standard
// `gen_image` handler with a locked prompt template that asks Flow to render
// the user's topic as a single composite NxN grid (see
// frontend/src/lib/storyboardPrompt.ts). Rendering reuses `ImageBody` — up
// to 4 composite variants in the tile grid — with a small `2×2`/`2×3`/`2×4`
// corner badge (flipped for portrait composites) reminding the user of
// the active layout.

function StoryboardBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  // Show the concrete rows × cols (post-orientation flip), not the
  // user-picker key. So a node with grid="2x3" on a portrait composite
  // shows "3×2" — matches what Flow actually rendered.
  const g = normaliseStoryboardGrid(data.storyboardGrid);
  const { rows, cols } = resolveStoryboardLayout(g, data.aspectRatio);
  const label = `${rows}×${cols}`;
  return (
    <div className="storyboard-wrap">
      <span
        className="storyboard-grid-badge"
        title={`Composite layout: ${label} (${rows * cols} panels)`}
      >
        {label}
      </span>
      <ImageBody rfId={rfId} data={data} />
    </div>
  );
}

function NodeBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  switch (data.type) {
    case "character":
      return <CharacterBody rfId={rfId} data={data} />;
    case "image":
      if (data.workflowKind === "shot_frame") {
        return <ShotFrameBody rfId={rfId} data={data} />;
      }
      return <ImageBody rfId={rfId} data={data} />;
    case "video":
      if (data.workflowKind === "shot_clip") {
        return <ShotClipBody rfId={rfId} data={data} />;
      }
      return <VideoBody rfId={rfId} data={data} />;
    case "prompt":
      return <EditableTextBody rfId={rfId} data={data} variant="prompt" />;
    case "note":
      if (data.workflowKind === "timeline") {
        return <TimelineBody rfId={rfId} data={data} />;
      }
      return <EditableTextBody rfId={rfId} data={data} variant="note" />;
    case "visual_asset":
      return <VisualAssetBody rfId={rfId} data={data} />;
    case "product":
    case "location":
      return (
        <>
          <DomainProfileFields rfId={rfId} data={data} />
          <VisualAssetBody rfId={rfId} data={data} />
        </>
      );
    case "brand":
    case "campaign":
    case "audio":
      return (
        <>
          <DomainProfileFields rfId={rfId} data={data} />
          <EditableTextBody rfId={rfId} data={data} variant="prompt" />
        </>
      );
    case "Storyboard":
      return <StoryboardBody rfId={rfId} data={data} />;
  }
}

function downloadExt(type: string): string {
  if (type === "video") return "mp4";
  return "png";
}

export function NodeCard(props: NodeProps<FlowNode>) {
  const data = props.data;
  const isNote = data.type === "note";
  const isGenerable = [
    "image",
    "prompt",
    "video",
    "visual_asset",
    "product",
    "location",
    "brand",
    "campaign",
    "audio",
    "character",
    "Storyboard",
  ].includes(data.type);
  const isRunning = data.status === "running";
  const llmBusy = isLLMBusy(data);
  const downloadable = !!data.mediaId && data.type !== "prompt" && data.type !== "note";

  function handleGenerate(e: React.MouseEvent) {
    e.stopPropagation();
    if (llmBusy) return; // guard: backend still composing for this node
    useGenerationStore.getState().openGenerationDialog(props.id, data.prompt ?? "");
  }

  function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    // Download every variant, not just the first. `mediaIds` is the full
    // list — `mediaId` is just the active variant — so a 4-variant image
    // node was previously losing 3 of its 4 outputs. Filter out null
    // placeholders that the partial-batch path may leave in `mediaIds`.
    const rawIds =
      data.mediaIds && data.mediaIds.length > 0
        ? data.mediaIds
        : data.mediaId
          ? [data.mediaId]
          : [];
    const ids = rawIds.filter((m): m is string => typeof m === "string" && m.length > 0);
    if (ids.length === 0) return;
    const safeTitle = (data.title || data.type).replace(/[^A-Za-z0-9_-]+/g, "_");
    const ext = downloadExt(data.type);
    // `<a download>` only honours the suggested filename when the resource
    // is same-origin — `/media/<id>` *is* same-origin (proxied by FastAPI),
    // so the title-based filename sticks.
    ids.forEach((mid, i) => {
      const a = document.createElement("a");
      a.href = mediaUrl(mid);
      const suffix = ids.length > 1 ? `-${i + 1}` : "";
      a.download = `${safeTitle}-${data.shortId}${suffix}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  return (
    <div
      className={`node-card${isNote ? " node-card--note" : ""}${
        props.selected ? " node-card--selected" : ""
      }${llmBusy ? " node-card--llm-busy" : ""}`}
    >
      <StatusStrip status={data.status} />
      <Handle type="target" position={Position.Left} className="node-handle" />

      <div className="node-header">
        <span className="node-icon" aria-hidden="true">{ICON[data.type] ?? "□"}</span>
        <span className="node-title">{data.title}</span>
        {llmBusy && (
          // Compact pill so the busy state reads at a glance even if the
          // body is collapsed. Title is contextual: composing vs. analysing.
          <span className="node-header__llm-pill" aria-live="polite">
            <span className="node-header__llm-spinner" aria-hidden="true" />
            {data.autoPromptStatus === "pending" ? "Composing…" : "Analyzing…"}
          </span>
        )}
        <div className="node-header__actions">
          {downloadable && (
            <button
              className="node-header__btn"
              onClick={handleDownload}
              aria-label="Download media"
              title="Download"
              tabIndex={0}
            >
              ⬇
            </button>
          )}
          {isGenerable && (
            <button
              className={`node-header__btn${isRunning ? " node-header__btn--running" : ""}`}
              onClick={handleGenerate}
              aria-label="Generate from this node"
              title={llmBusy ? "Backend is still composing — try again in a moment" : "Generate"}
              tabIndex={0}
              disabled={llmBusy}
            >
              ▶
            </button>
          )}
        </div>
        <span className="node-short-id">#{data.shortId}</span>
      </div>

      <NodeBody rfId={props.id} data={data} />

      <Handle type="source" position={Position.Right} className="node-handle" />
    </div>
  );
}
