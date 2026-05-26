import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { buildShotPlan, type ShotPlanItem, type ShotPlanResponse } from "../api/client";
import { FLOW_SCAFFOLD_RECIPES } from "../lib/videoRecipes";
import { useBoardStore } from "../store/board";
import type { NodeType, VideoRecipeId } from "../store/board";

interface SidebarNodeItem {
  type: NodeType;
  icon: string;
  label: string;
}

const DOMAIN_NODES: SidebarNodeItem[] = [
  { type: "product", icon: "▤", label: "Product" },
  { type: "location", icon: "⌂", label: "Location" },
  { type: "brand", icon: "◈", label: "Brand" },
  { type: "audio", icon: "♪", label: "Audio" },
];

const STORYBOARD_RECIPE_ID: VideoRecipeId = "storyboard_sequence";
const SIDEBAR_RECIPE_LIMIT = 5;

const SIDEBAR_RECIPES = [
  ...FLOW_SCAFFOLD_RECIPES.filter((recipe) => recipe.key === STORYBOARD_RECIPE_ID),
  ...FLOW_SCAFFOLD_RECIPES.filter((recipe) => recipe.key !== STORYBOARD_RECIPE_ID),
];

export function NodeLibrarySidebar() {
  const { screenToFlowPosition } = useReactFlow();
  const boardId = useBoardStore((s) => s.boardId);
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const addFlowFromRecipe = useBoardStore((s) => s.addFlowFromRecipe);
  const [domainExpanded, setDomainExpanded] = useState(false);
  const [recipesExpanded, setRecipesExpanded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sequenceShotCount, setSequenceShotCount] = useState(3);
  const [sequenceDurationSec, setSequenceDurationSec] = useState(4);
  const [sequenceBrief, setSequenceBrief] = useState("");
  const [sequenceUseAi, setSequenceUseAi] = useState(false);
  const [shotPlanPreview, setShotPlanPreview] = useState<ShotPlanResponse | null>(null);
  const [shotPlanLoading, setShotPlanLoading] = useState(false);
  const [shotPlanError, setShotPlanError] = useState<string | null>(null);

  const visibleDomainNodes = domainExpanded ? DOMAIN_NODES : DOMAIN_NODES.slice(0, 3);
  const visibleRecipes = recipesExpanded
    ? SIDEBAR_RECIPES
    : SIDEBAR_RECIPES.slice(0, SIDEBAR_RECIPE_LIMIT);

  function nodePosition() {
    return screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
  }

  function sequencePosition() {
    return screenToFlowPosition({
      x: window.innerWidth / 2 - 320,
      y: window.innerHeight / 2 - 120,
    });
  }

  function handleAdd(type: NodeType) {
    void addNodeOfType(type, nodePosition());
  }

  function handleRecipe(recipeId: VideoRecipeId) {
    void addFlowFromRecipe(
      recipeId,
      sequencePosition(),
      recipeId === STORYBOARD_RECIPE_ID
        ? {
            shotCount: sequenceShotCount,
            shotDurationSec: sequenceDurationSec,
            brief: sequenceBrief.trim(),
            useLLM: sequenceUseAi,
            openGeneration: false,
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
        recipe_id: STORYBOARD_RECIPE_ID,
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
    const createdId = await addFlowFromRecipe(STORYBOARD_RECIPE_ID, sequencePosition(), {
      shotCount: shotPlanPreview.shots.length,
      shotDurationSec: sequenceDurationSec,
      brief: shotPlanPreview.brief,
      useLLM: false,
      shotPlan: shotPlanPreview.shots.map((shot, index) => ({
        ...shot,
        shot_index: index + 1,
      })),
      openGeneration: false,
    });
    if (createdId !== null) {
      setShotPlanPreview(null);
    }
  }

  return (
    <>
      <aside
        className={`node-library-sidebar${
          sidebarCollapsed ? " node-library-sidebar--collapsed" : ""
        }`}
        aria-label="Node library"
      >
        <header className="node-library-sidebar__header">
          {!sidebarCollapsed && <span>Nodes</span>}
          <button
            type="button"
            className="node-library-sidebar__collapse"
            aria-label={sidebarCollapsed ? "Expand node sidebar" : "Collapse node sidebar"}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
        </header>

        {sidebarCollapsed ? (
          <div className="node-library-sidebar__rail" aria-hidden="true">
            <span>▤</span>
            <span>▱</span>
          </div>
        ) : (
          <div className="node-library-sidebar__body">
            <section className="node-library-section">
              <div className="node-library-section__header">
                <span>Domain nodes</span>
                <button
                  type="button"
                  onClick={() => setDomainExpanded((expanded) => !expanded)}
                >
                  {domainExpanded ? "Show less" : "Show more"}
                </button>
              </div>
              <div className="node-library-list">
                {visibleDomainNodes.map((node) => (
                  <button
                    key={node.type}
                    type="button"
                    className="node-library-item"
                    aria-label={`Add ${node.label} node`}
                    onClick={() => handleAdd(node.type)}
                  >
                    <span aria-hidden="true">{node.icon}</span>
                    <span>{node.label}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="node-library-section">
              <div className="node-library-section__header">
                <span>Video workflows</span>
                <button
                  type="button"
                  onClick={() => setRecipesExpanded((expanded) => !expanded)}
                >
                  {recipesExpanded ? "Show less" : "Show more"}
                </button>
              </div>
              <div className="node-library-list node-library-list--recipes">
                {visibleRecipes.map((recipe) => (
                  <button
                    key={recipe.key}
                    type="button"
                    className="node-library-item node-library-item--recipe"
                    aria-label={`Create ${recipe.label} flow`}
                    onClick={() => handleRecipe(recipe.key)}
                  >
                    <span aria-hidden="true">▱</span>
                    <span>{recipe.label}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="node-library-section node-library-section--sequence">
              <div className="node-library-section__header">
                <span>Storyboard sequence</span>
              </div>
              <div className="node-library-sequence-controls">
                <span className="node-library-stepper" aria-label="Shot count / Số cảnh">
                  <button
                    type="button"
                    aria-label="Decrease shot count"
                    onClick={() => setSequenceShotCount((n) => Math.max(2, n - 1))}
                    disabled={sequenceShotCount <= 2}
                  >
                    −
                  </button>
                  <span>{sequenceShotCount} shots</span>
                  <button
                    type="button"
                    aria-label="Increase shot count"
                    onClick={() => setSequenceShotCount((n) => Math.min(6, n + 1))}
                    disabled={sequenceShotCount >= 6}
                  >
                    +
                  </button>
                </span>
                <span className="node-library-stepper" aria-label="Shot duration / Giây mỗi cảnh">
                  <button
                    type="button"
                    aria-label="Decrease shot duration"
                    onClick={() => setSequenceDurationSec((n) => Math.max(2, n - 1))}
                    disabled={sequenceDurationSec <= 2}
                  >
                    −
                  </button>
                  <span>{sequenceDurationSec}s</span>
                  <button
                    type="button"
                    aria-label="Increase shot duration"
                    onClick={() => setSequenceDurationSec((n) => Math.min(10, n + 1))}
                    disabled={sequenceDurationSec >= 10}
                  >
                    +
                  </button>
                </span>
                <label className="node-library-brief">
                  <span className="visually-hidden">Sequence brief / Ý tưởng chuỗi cảnh</span>
                  <input
                    aria-label="Sequence brief / Ý tưởng chuỗi cảnh"
                    value={sequenceBrief}
                    onChange={(event) => setSequenceBrief(event.target.value)}
                    placeholder="Brief / Ý tưởng"
                    maxLength={220}
                  />
                </label>
                <label
                  className={`node-library-toggle${
                    sequenceUseAi ? " node-library-toggle--active" : ""
                  }`}
                  title="Use AI shot plan / Dùng AI dựng cảnh"
                >
                  <input
                    type="checkbox"
                    checked={sequenceUseAi}
                    onChange={(event) => setSequenceUseAi(event.target.checked)}
                    aria-label="Use AI shot plan / Dùng AI dựng cảnh"
                  />
                  <span>AI plan</span>
                </label>
                <div className="node-library-sequence-actions">
                  <button
                    type="button"
                    className="node-library-primary"
                    aria-label="Create storyboard sequence / Tạo chuỗi cảnh"
                    onClick={() => handleRecipe(STORYBOARD_RECIPE_ID)}
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    className="node-library-secondary"
                    aria-label="Plan storyboard sequence / Lập cảnh chuỗi"
                    onClick={handlePreviewSequence}
                    disabled={shotPlanLoading}
                  >
                    {shotPlanLoading ? "Planning" : "Plan"}
                  </button>
                </div>
                {shotPlanError && (
                  <span className="node-library-error" role="alert">
                    {shotPlanError}
                  </span>
                )}
              </div>
            </section>
          </div>
        )}
      </aside>

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
