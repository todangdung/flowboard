import { create } from "zustand";
import {
  runPlan as apiRunPlan,
  rerunFromNode as apiRerunFromNode,
  getPipelineRun,
  type PipelineRunDTO,
  type RunPlanOptions,
} from "../api/client";
import { useBoardStore } from "./board";
import { useChatStore } from "./chat";

interface PipelineState {
  activeRun: PipelineRunDTO | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  error: string | null;

  startRun(planId: number, opts?: RunPlanOptions): Promise<void>;
  rerunFromNode(nodeId: number): Promise<void>;
  stopPolling(): void;
  clearError(): void;
}

const POLL_INTERVAL_MS = 1500;

export const usePipelineStore = create<PipelineState>((set, get) => ({
  activeRun: null,
  pollTimer: null,
  error: null,

  async startRun(planId: number, opts?: RunPlanOptions) {
    if (get().activeRun !== null) return;
    try {
      const run = await apiRunPlan(planId, opts);
      set({ activeRun: run, error: null });
      // Pull the freshly materialised nodes onto the canvas immediately so the
      // user sees the layout before the first generation completes.
      await useBoardStore.getState().refreshBoardState();
      schedulePoll(get, set, run.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to start plan" });
    }
  },

  async rerunFromNode(nodeId: number) {
    if (get().activeRun !== null) return;
    try {
      const run = await apiRerunFromNode(nodeId);
      set({ activeRun: run, error: null });
      await useBoardStore.getState().refreshBoardState();
      schedulePoll(get, set, run.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "failed to rerun" });
    }
  },

  stopPolling() {
    const t = get().pollTimer;
    if (t !== null) clearTimeout(t);
    set({ pollTimer: null });
  },

  clearError() {
    set({ error: null });
  },
}));

function schedulePoll(
  get: () => PipelineState,
  set: (partial: Partial<PipelineState>) => void,
  runId: number,
) {
  const timer = setTimeout(async () => {
    set({ pollTimer: null });
    try {
      const run = await getPipelineRun(runId);
      // Always refresh board so per-node status (queued/running/done/error)
      // and freshly-arrived mediaId values land on the canvas during the run.
      await useBoardStore.getState().refreshBoardState();
      if (run.status === "done" || run.status === "failed") {
        // Sync the chat-sidebar's cached plan.status so the Run button
        // relabels to "Re-run ↻" instead of staying stuck on "Run".
        useChatStore.getState().setPlanStatus(run.plan_id, run.status);
        set({
          activeRun: null,
          error: run.status === "failed" ? run.error ?? "pipeline failed" : null,
        });
        return;
      }
      set({ activeRun: run });
      schedulePoll(get, set, runId);
    } catch (err) {
      // Transient — keep polling; surface only after a few failures? For now
      // a single network blip keeps trying.
      console.warn("pipeline poll failed", err);
      schedulePoll(get, set, runId);
    }
  }, POLL_INTERVAL_MS);
  set({ pollTimer: timer });
}
