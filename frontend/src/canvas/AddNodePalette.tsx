import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { buildShotPlan, type ShotPlanItem, type ShotPlanResponse } from "../api/client";
import { useBoardStore } from "../store/board";
import type { NodeType, VideoRecipeId } from "../store/board";
import { FLOW_SCAFFOLD_RECIPES } from "../lib/videoRecipes";

interface Chip {
  type: NodeType;
  icon: string;
  label: string;
}

const CHIPS: Chip[] = [
  { type: "character", icon: "◎", label: "Character" },
  { type: "image", icon: "▣", label: "Image" },
  { type: "Storyboard", icon: "▦", label: "Storyboard" },
  { type: "video", icon: "▶", label: "Video" },
  { type: "visual_asset", icon: "◇", label: "Visual asset" },
  { type: "prompt", icon: "✦", label: "Prompt" },
  { type: "note", icon: "✎", label: "Note" },
];

export function AddNodePalette() {
  const { screenToFlowPosition } = useReactFlow();
  const boardId = useBoardStore((s) => s.boardId);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const addFlowFromRecipe = useBoardStore((s) => s.addFlowFromRecipe);
  const [sequenceShotCount, setSequenceShotCount] = useState(3);
  const [sequenceDurationSec, setSequenceDurationSec] = useState(4);
  const [sequenceBrief, setSequenceBrief] = useState("");
  const [sequenceUseAi, setSequenceUseAi] = useState(false);
  const [shotPlanPreview, setShotPlanPreview] = useState<ShotPlanResponse | null>(null);
  const [shotPlanLoading, setShotPlanLoading] = useState(false);
  const [shotPlanError, setShotPlanError] = useState<string | null>(null);

  function handleAdd(type: NodeType) {
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    addNodeOfType(type, position);
  }

  function sequencePosition() {
    return screenToFlowPosition({
      x: window.innerWidth / 2 - 360,
      y: window.innerHeight / 2 - 140,
    });
  }

  function handleRecipe(recipeId: VideoRecipeId) {
    const position = sequencePosition();
    addFlowFromRecipe(
      recipeId,
      position,
      recipeId === "storyboard_sequence"
        ? {
            shotCount: sequenceShotCount,
            shotDurationSec: sequenceDurationSec,
            brief: sequenceBrief.trim(),
            useLLM: sequenceUseAi,
          }
        : undefined,
    );
  }

  async function handlePreviewSequence() {
    if (boardId === null) {
      setShotPlanError("No board / Chưa có board");
      return;
    }
    setShotPlanLoading(true);
    setShotPlanError(null);
    try {
      const plan = await buildShotPlan({
        board_id: boardId,
        recipe_id: "storyboard_sequence",
        shot_count: sequenceShotCount,
        shot_duration_sec: sequenceDurationSec,
        brief: sequenceBrief.trim(),
        use_llm: sequenceUseAi,
      });
      setShotPlanPreview(plan);
    } catch (err) {
      setShotPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setShotPlanLoading(false);
    }
  }

  function updatePreviewShot(index: number, patch: Partial<ShotPlanItem>) {
    setShotPlanPreview((plan) => {
      if (plan === null) return plan;
      return {
        ...plan,
        shots: plan.shots.map((shot, shotIndex) =>
          shotIndex === index ? { ...shot, ...patch } : shot,
        ),
      };
    });
  }

  async function handleCreateFromPreview() {
    if (shotPlanPreview === null) return;
    const createdId = await addFlowFromRecipe(
      "storyboard_sequence",
      sequencePosition(),
      {
        shotCount: shotPlanPreview.shots.length,
        shotDurationSec: sequenceDurationSec,
        brief: shotPlanPreview.brief,
        useLLM: false,
        shotPlan: shotPlanPreview.shots.map((shot, index) => ({
          ...shot,
          shot_index: index + 1,
        })),
      },
    );
    if (createdId !== null) {
      setShotPlanPreview(null);
    }
  }

  return (
    <>
      <div className="add-node-palette" aria-label="Add node">
        <span className="add-node-plus" aria-hidden="true">+</span>
        {CHIPS.map((chip) => (
          <button
            key={chip.type}
            className="add-node-chip"
            aria-label={`Add ${chip.label} node`}
            onClick={() => handleAdd(chip.type)}
          >
            <span aria-hidden="true">{chip.icon}</span>
            {chip.label}
          </button>
        ))}
        <span className="add-node-divider" aria-hidden="true" />
        {FLOW_SCAFFOLD_RECIPES.map((recipe) => (
          <span key={recipe.key} className="add-node-recipe-wrap">
            <button
              className="add-node-chip add-node-chip--recipe"
              aria-label={`Create ${recipe.label} flow`}
              onClick={() => handleRecipe(recipe.key)}
              title={`Create ${recipe.label} flow`}
            >
              <span aria-hidden="true">▱</span>
              {recipe.label}
            </button>
            {recipe.key === "storyboard_sequence" && (
              <span
                className="add-node-shot-controls"
                aria-label="Shot settings / Cài đặt cảnh"
              >
                <span
                  className="add-node-shot-stepper"
                  aria-label="Shot count / Số cảnh"
                >
                  <button
                    type="button"
                    aria-label="Decrease shot count"
                    onClick={() => setSequenceShotCount((n) => Math.max(2, n - 1))}
                    disabled={sequenceShotCount <= 2}
                  >
                    −
                  </button>
                  <span>{sequenceShotCount} shots / cảnh</span>
                  <button
                    type="button"
                    aria-label="Increase shot count"
                    onClick={() => setSequenceShotCount((n) => Math.min(6, n + 1))}
                    disabled={sequenceShotCount >= 6}
                  >
                    +
                  </button>
                </span>
                <span
                  className="add-node-shot-stepper"
                  aria-label="Shot duration / Giây mỗi cảnh"
                >
                  <button
                    type="button"
                    aria-label="Decrease shot duration"
                    onClick={() => setSequenceDurationSec((n) => Math.max(2, n - 1))}
                    disabled={sequenceDurationSec <= 2}
                  >
                    −
                  </button>
                  <span>{sequenceDurationSec}s / cảnh</span>
                  <button
                    type="button"
                    aria-label="Increase shot duration"
                    onClick={() => setSequenceDurationSec((n) => Math.min(10, n + 1))}
                    disabled={sequenceDurationSec >= 10}
                  >
                    +
                  </button>
                </span>
                <label className="add-node-shot-brief">
                  <span className="visually-hidden">
                    Sequence brief / Ý tưởng chuỗi cảnh
                  </span>
                  <input
                    aria-label="Sequence brief / Ý tưởng chuỗi cảnh"
                    value={sequenceBrief}
                    onChange={(event) => setSequenceBrief(event.target.value)}
                    placeholder="Brief / Ý tưởng"
                    maxLength={220}
                  />
                </label>
                <label
                  className={`add-node-ai-toggle${sequenceUseAi ? " add-node-ai-toggle--active" : ""}`}
                  title="Use AI shot plan / Dùng AI dựng cảnh"
                >
                  <input
                    type="checkbox"
                    checked={sequenceUseAi}
                    onChange={(event) => setSequenceUseAi(event.target.checked)}
                    aria-label="Use AI shot plan / Dùng AI dựng cảnh"
                  />
                  <span>AI plan / AI dựng</span>
                </label>
                <button
                  className="add-node-plan-btn"
                  type="button"
                  aria-label="Plan storyboard sequence / Lập cảnh chuỗi"
                  onClick={handlePreviewSequence}
                  disabled={shotPlanLoading}
                >
                  {shotPlanLoading ? "Planning / Đang lập" : "Plan / Lập cảnh"}
                </button>
                {shotPlanError && (
                  <span className="add-node-plan-error" role="alert">
                    {shotPlanError}
                  </span>
                )}
              </span>
            )}
          </span>
        ))}
      </div>
      {shotPlanPreview && (
        <div className="shot-plan-modal-backdrop">
          <div
            className="shot-plan-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Shot plan / Kế hoạch cảnh"
          >
            <header className="shot-plan-modal__header">
              <div>
                <h2>Shot plan / Kế hoạch cảnh</h2>
                <span>
                  {shotPlanPreview.shot_count} shots / {shotPlanPreview.shot_count} cảnh
                </span>
              </div>
              <span className="shot-plan-source">
                {shotPlanPreview.source === "llm" ? "AI" : "Fallback"} / Nguồn
              </span>
              <button
                type="button"
                className="shot-plan-close"
                aria-label="Close shot plan / Đóng kế hoạch cảnh"
                onClick={() => setShotPlanPreview(null)}
              >
                ×
              </button>
            </header>

            <div className="shot-plan-list">
              {shotPlanPreview.shots.map((shot, index) => {
                const shotNumber = index + 1;
                return (
                  <section className="shot-plan-card" key={shot.shot_index}>
                    <header className="shot-plan-card__header">
                      <strong>Shot {shotNumber} / Cảnh {shotNumber}</strong>
                      <label className="shot-plan-duration">
                        <span>Duration / Giây</span>
                        <input
                          aria-label={`Shot ${shotNumber} duration / Thời lượng cảnh ${shotNumber}`}
                          type="number"
                          min={1}
                          max={10}
                          value={shot.duration_sec}
                          onChange={(event) =>
                            updatePreviewShot(index, {
                              duration_sec: Math.min(
                                10,
                                Math.max(1, Number(event.target.value) || 1),
                              ),
                            })
                          }
                        />
                      </label>
                    </header>
                    <div className="shot-plan-grid">
                      <label>
                        <span>Title EN</span>
                        <input
                          aria-label={`Shot ${shotNumber} title EN`}
                          value={shot.title_en}
                          onChange={(event) =>
                            updatePreviewShot(index, { title_en: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>Tiêu đề VI</span>
                        <input
                          aria-label={`Shot ${shotNumber} title VI`}
                          value={shot.title_vi}
                          onChange={(event) =>
                            updatePreviewShot(index, { title_vi: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>Action / Hành động</span>
                        <textarea
                          aria-label={`Shot ${shotNumber} action / Hành động cảnh ${shotNumber}`}
                          value={shot.action}
                          rows={2}
                          onChange={(event) =>
                            updatePreviewShot(index, { action: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        <span>Camera</span>
                        <textarea
                          aria-label={`Shot ${shotNumber} camera`}
                          value={shot.camera}
                          rows={2}
                          onChange={(event) =>
                            updatePreviewShot(index, { camera: event.target.value })
                          }
                        />
                      </label>
                      <label className="shot-plan-field--wide">
                        <span>Frame prompt / Prompt ảnh</span>
                        <textarea
                          aria-label={`Shot ${shotNumber} frame prompt / Prompt ảnh cảnh ${shotNumber}`}
                          value={shot.frame_prompt}
                          rows={3}
                          onChange={(event) =>
                            updatePreviewShot(index, { frame_prompt: event.target.value })
                          }
                        />
                      </label>
                      <label className="shot-plan-field--wide">
                        <span>Video prompt / Prompt video</span>
                        <textarea
                          aria-label={`Shot ${shotNumber} video prompt / Prompt video cảnh ${shotNumber}`}
                          value={shot.video_prompt}
                          rows={3}
                          onChange={(event) =>
                            updatePreviewShot(index, { video_prompt: event.target.value })
                          }
                        />
                      </label>
                    </div>
                  </section>
                );
              })}
            </div>

            <footer className="shot-plan-modal__footer">
              <button
                type="button"
                className="shot-plan-secondary"
                onClick={handlePreviewSequence}
                disabled={shotPlanLoading}
              >
                Replan / Lập lại
              </button>
              <button
                type="button"
                className="shot-plan-primary"
                onClick={handleCreateFromPreview}
              >
                Create workflow / Tạo flow
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
