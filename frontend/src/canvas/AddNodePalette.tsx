import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
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
  const addNodeOfType = useBoardStore((s) => s.addNodeOfType);
  const addFlowFromRecipe = useBoardStore((s) => s.addFlowFromRecipe);
  const [sequenceShotCount, setSequenceShotCount] = useState(3);
  const [sequenceDurationSec, setSequenceDurationSec] = useState(4);

  function handleAdd(type: NodeType) {
    const position = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    addNodeOfType(type, position);
  }

  function handleRecipe(recipeId: VideoRecipeId) {
    const position = screenToFlowPosition({
      x: window.innerWidth / 2 - 360,
      y: window.innerHeight / 2 - 140,
    });
    addFlowFromRecipe(
      recipeId,
      position,
      recipeId === "storyboard_sequence"
        ? {
            shotCount: sequenceShotCount,
            shotDurationSec: sequenceDurationSec,
          }
        : undefined,
    );
  }

  return (
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
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
