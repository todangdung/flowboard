import { create } from "zustand";

/**
 * Per-user model preferences. Survives page reload via localStorage —
 * single-user, single-host app, so no need for server persistence.
 *
 * Image model: Flow ships two checkpoints — "NANO_BANANA_PRO" (premium,
 * higher quality, slower) and "NANO_BANANA_2" (faster, lighter). Users
 * pick once in the dashboard Settings panel; every gen_image / edit_image
 * dispatch reads the cached preference and forwards it to the worker.
 *
 * Video model is currently derived from paygate tier + aspect (resolved
 * server-side via VIDEO_MODEL_KEYS), so it's a *display* on the panel
 * rather than a switchable preference. When/if Flow ships variants per
 * tier (e.g. fast vs quality) we extend this store with `videoModelKey`.
 */
export type ImageModelKey = "NANO_BANANA_PRO" | "NANO_BANANA_2";
// Veo 3.1 ships in four flavours:
//   - Lite (smaller checkpoint, fastest, lower fidelity)
//   - Fast (default — bigger model, balanced)
//   - Quality (highest fidelity, slowest)
//   - Lite Relaxed (Lite on a low-priority queue, 0 credits — Ultra only)
// Choice applies globally across both portrait and landscape; backend
// resolves the actual model key at dispatch time from [tier][quality][aspect].
// Tier 1 (Pro) users picking `lite_relaxed` fall back to Fast on the
// backend (and the Settings UI locks that radio for them).
export type VideoQuality =
  | "fast"
  | "lite"
  | "quality"
  | "lite_relaxed";

// Video model family. "veo" = the existing Veo 3.1 i2v family controlled
// by videoQuality (lite/fast/quality/...). "omni_flash" = the new
// reference-image r2v model with per-duration credit cost and no
// per-tier quality variants — duration is picked per dispatch in the
// GenerationDialog. The video dispatch path branches on this.
export type VideoModelFamily = "veo" | "omni_flash";

export type VideoAudioMode =
  | "no_speech"
  | "music"
  | "sfx"
  | "ambient"
  | "speech";

// Omni Flash duration → credit cost (informational, surfaced in the
// dialog so the user sees the cost before submit). Mirrors the backend
// OMNI_FLASH_CREDIT_COST table — pin both via tests.
export const OMNI_FLASH_CREDIT_COST: Record<4 | 6 | 8 | 10, number> = {
  4: 15,
  6: 20,
  8: 25,
  10: 30,
};
export type OmniFlashDuration = 4 | 6 | 8 | 10;
export const OMNI_FLASH_DURATIONS: OmniFlashDuration[] = [4, 6, 8, 10];

interface SettingsState {
  imageModel: ImageModelKey;
  videoQuality: VideoQuality;
  videoModel: VideoModelFamily;
  videoAudioMode: VideoAudioMode;
  omniFlashDuration: OmniFlashDuration;
  // When ON, every dispatch (gen_image, edit_image, gen_video,
  // gen_video_omni) routes through Flow's 0-credit low-priority queue —
  // the only path that works on the free Google Flow tier. The backend
  // rewrites the envelope userPaygateTier to TIER_TWO for these dispatches
  // (Flow gates the low-priority models behind the TIER_TWO envelope value
  // regardless of the caller's actual SKU). OFF by default so Pro/Ultra
  // users keep their existing paid-queue behaviour.
  lowPriority: boolean;
  setImageModel(model: ImageModelKey): void;
  setVideoQuality(q: VideoQuality): void;
  setVideoModel(m: VideoModelFamily): void;
  setVideoAudioMode(m: VideoAudioMode): void;
  setOmniFlashDuration(d: OmniFlashDuration): void;
  setLowPriority(v: boolean): void;
}

const STORAGE_KEY = "flowboard.settings.v2";
const STORAGE_KEY_V1 = "flowboard.settings.v1";

interface PersistShape {
  imageModel?: ImageModelKey;
  videoQuality?: VideoQuality;
  videoModel?: VideoModelFamily;
  videoAudioMode?: VideoAudioMode;
  omniFlashDuration?: OmniFlashDuration;
  lowPriority?: boolean;
}

function loadPersisted(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    }
    // One-shot migration: copy v1 fields, default lowPriority off, drop v1.
    const legacy = localStorage.getItem(STORAGE_KEY_V1);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      const migrated: PersistShape =
        typeof parsed === "object" && parsed !== null
          ? { ...(parsed as PersistShape), lowPriority: false }
          : {};
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        localStorage.removeItem(STORAGE_KEY_V1);
      } catch {
        // Quota/disabled — fine to skip; we still return the migrated state.
      }
      return migrated;
    }
    return {};
  } catch {
    return {};
  }
}

function persist(state: PersistShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled / quota — non-fatal, just lose persistence.
  }
}

const persisted = loadPersisted();

const VALID_VIDEO_QUALITIES: VideoQuality[] = ["fast", "lite", "quality", "lite_relaxed"];
const VALID_AUDIO_MODES: VideoAudioMode[] = [
  "no_speech",
  "music",
  "sfx",
  "ambient",
  "speech",
];

export const useSettingsStore = create<SettingsState>((set, get) => ({
  imageModel: persisted.imageModel ?? "NANO_BANANA_2",
  videoQuality:
    persisted.videoQuality && VALID_VIDEO_QUALITIES.includes(persisted.videoQuality)
      ? persisted.videoQuality
      : "fast",
  videoModel: persisted.videoModel ?? "veo",
  videoAudioMode:
    persisted.videoAudioMode && VALID_AUDIO_MODES.includes(persisted.videoAudioMode)
      ? persisted.videoAudioMode
      : "music",
  omniFlashDuration: persisted.omniFlashDuration ?? 4,
  lowPriority: persisted.lowPriority ?? false,
  setImageModel(model) {
    set({ imageModel: model });
    persist({
      imageModel: model,
      videoQuality: get().videoQuality,
      videoModel: get().videoModel,
      videoAudioMode: get().videoAudioMode,
      omniFlashDuration: get().omniFlashDuration,
      lowPriority: get().lowPriority,
    });
  },
  setVideoQuality(q) {
    set({ videoQuality: q });
    persist({
      imageModel: get().imageModel,
      videoQuality: q,
      videoModel: get().videoModel,
      videoAudioMode: get().videoAudioMode,
      omniFlashDuration: get().omniFlashDuration,
      lowPriority: get().lowPriority,
    });
  },
  setVideoModel(m) {
    set({ videoModel: m });
    persist({
      imageModel: get().imageModel,
      videoQuality: get().videoQuality,
      videoModel: m,
      videoAudioMode: get().videoAudioMode,
      omniFlashDuration: get().omniFlashDuration,
      lowPriority: get().lowPriority,
    });
  },
  setVideoAudioMode(m) {
    set({ videoAudioMode: m });
    persist({
      imageModel: get().imageModel,
      videoQuality: get().videoQuality,
      videoModel: get().videoModel,
      videoAudioMode: m,
      omniFlashDuration: get().omniFlashDuration,
      lowPriority: get().lowPriority,
    });
  },
  setOmniFlashDuration(d) {
    set({ omniFlashDuration: d });
    persist({
      imageModel: get().imageModel,
      videoQuality: get().videoQuality,
      videoModel: get().videoModel,
      videoAudioMode: get().videoAudioMode,
      omniFlashDuration: d,
      lowPriority: get().lowPriority,
    });
  },
  setLowPriority(v) {
    set({ lowPriority: v });
    persist({
      imageModel: get().imageModel,
      videoQuality: get().videoQuality,
      videoModel: get().videoModel,
      videoAudioMode: get().videoAudioMode,
      omniFlashDuration: get().omniFlashDuration,
      lowPriority: v,
    });
  },
}));
