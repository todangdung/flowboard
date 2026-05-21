// Locked prompt template for Storyboard nodes. The node IS an image
// node — it just wraps the user's topic in a deterministic preamble
// so Flow renders a single composite grid that visually narrates the
// topic. Tweak wording here, never inline at the dispatch site.
import type { StoryboardGrid } from "../store/board";

export function buildStoryboardPrompt(
  topic: string,
  grid: StoryboardGrid = "3x3",
): string {
  const n = grid === "2x2" ? 2 : 3;
  const t = topic.trim() || "untitled story";
  return `Create visual storyboard for "${t}" as SINGLE IMAGE arranged in a ${n}x${n} layout (${n} rows, ${n} columns)`;
}

// Locked motion prompt for video nodes whose upstream image is a
// Storyboard composite. Forces Flow to animate the panels in order
// (1 → N) rather than re-interpret the composite as one scene.
//   3x3 grid → 9 panels → "frame 1 to frame 9"
//   2x2 grid → 4 panels → "frame 1 to frame 4"
// Other refs (character / location / visual_asset) still flow into
// the video request alongside the storyboard source — the prompt
// itself is what's locked.
export function buildStoryboardVideoPrompt(
  grid: StoryboardGrid = "3x3",
): string {
  const lastFrame = grid === "2x2" ? 4 : 9;
  return `A 10-seconds cinematic animated film trailer following narrative progression from exactly frame 1 to frame ${lastFrame} of the image reference`;
}
