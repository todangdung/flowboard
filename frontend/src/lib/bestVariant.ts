import type { FlowboardNodeData } from "../store/board";

export function nodeMediaIds(data: FlowboardNodeData | undefined): string[] {
  if (!data) return [];
  const ids = Array.isArray(data.mediaIds)
    ? data.mediaIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length > 0) return ids;
  return typeof data.mediaId === "string" && data.mediaId ? [data.mediaId] : [];
}

export function bestVariantIndex(data: FlowboardNodeData | undefined): number | null {
  if (!data || typeof data.bestVariantIdx !== "number" || data.bestVariantIdx < 0) {
    return null;
  }
  const idx = data.bestVariantIdx;
  const expected = typeof data.bestMediaId === "string" && data.bestMediaId
    ? data.bestMediaId
    : null;
  if (Array.isArray(data.mediaIds)) {
    const current = data.mediaIds[idx];
    if (typeof current !== "string" || !current) return null;
    return expected === null || expected === current ? idx : null;
  }
  if (idx !== 0 || typeof data.mediaId !== "string" || !data.mediaId) {
    return null;
  }
  return expected === null || expected === data.mediaId ? idx : null;
}

export function bestVariantMediaId(data: FlowboardNodeData | undefined): string | null {
  const idx = bestVariantIndex(data);
  if (idx === null || !data) return null;
  if (Array.isArray(data.mediaIds)) {
    const current = data.mediaIds[idx];
    return typeof current === "string" && current ? current : null;
  }
  return typeof data.mediaId === "string" && data.mediaId ? data.mediaId : null;
}

export function preferredMediaIds(data: FlowboardNodeData | undefined): string[] {
  const best = bestVariantMediaId(data);
  return best ? [best] : nodeMediaIds(data);
}
