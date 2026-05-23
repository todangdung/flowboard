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
    addFlowFromRecipe(recipeId, position);
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
        <button
          key={recipe.key}
          className="add-node-chip add-node-chip--recipe"
          aria-label={`Create ${recipe.label} flow`}
          onClick={() => handleRecipe(recipe.key)}
          title={`Create ${recipe.label} flow`}
        >
          <span aria-hidden="true">▱</span>
          {recipe.label}
        </button>
      ))}
    </div>
  );
}
