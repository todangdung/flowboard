# Recipe Flow Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured video recipe catalog and a one-click flow scaffold for the three MVP short-video recipes: fashion fit check, mirror selfie, and product demo.

**Architecture:** Backend owns the authoritative recipe contracts used by prompt synthesis. Frontend owns a matching lightweight catalog for UI/scaffold defaults and creates the node graph directly through existing node/edge APIs. The scaffold produces empty/input nodes plus a video node with pre-labeled edge roles and opens the video generation dialog with the selected recipe already set.

**Tech Stack:** FastAPI, SQLModel, pytest, React, Zustand, TypeScript, Vite.

---

### Task 1: Backend Recipe Catalog

**Files:**
- Create: `agent/flowboard/services/video_recipes.py`
- Modify: `agent/flowboard/services/prompt_synth.py`
- Modify: `agent/flowboard/routes/prompt.py`
- Test: `agent/tests/test_prompt_synth.py`

- [ ] Write tests proving `/api/prompt/video-recipes` returns recipe metadata for `fashion_fit_check`, `mirror_selfie`, and `product_demo`, including required roles, default camera, default aspect ratio, and prompt contract text.
- [ ] Run `rtk agent/.venv/bin/pytest agent/tests/test_prompt_synth.py::test_route_lists_video_recipe_catalog -q` and confirm it fails because the route does not exist.
- [ ] Add `VideoRecipe` dataclass, `VIDEO_RECIPES`, `get_video_recipe`, `normalize_video_recipe_id`, `infer_video_recipe_id`, and `video_recipe_clauses` in `video_recipes.py`.
- [ ] Update `prompt_synth.py` to import recipe helpers instead of keeping recipe clauses inline.
- [ ] Add `GET /api/prompt/video-recipes` in `routes/prompt.py`.
- [ ] Run `rtk agent/.venv/bin/pytest agent/tests/test_prompt_synth.py -q` and confirm all prompt tests pass.

### Task 2: Frontend Recipe Catalog

**Files:**
- Create: `frontend/src/lib/videoRecipes.ts`
- Modify: `frontend/src/components/GenerationDialog.tsx`
- Modify: `frontend/src/api/client.ts`

- [ ] Move the local recipe and ref-role option arrays out of `GenerationDialog.tsx` into `videoRecipes.ts`.
- [ ] Export typed `VIDEO_RECIPES`, `REF_ROLE_OPTIONS`, and helper `isVideoRecipeId`.
- [ ] Keep `GenerationDialog.tsx` behavior identical while importing the shared catalog.
- [ ] Run `rtk npm run lint` from `frontend/` and confirm TypeScript passes.

### Task 3: Board Store Flow Scaffold

**Files:**
- Modify: `frontend/src/store/board.ts`
- Modify: `frontend/src/store/generation.ts` only if dialog-open behavior needs extra metadata.

- [ ] Add `addFlowFromRecipe(recipeId, position)` to `BoardState`.
- [ ] For `product_demo`, create visual asset, first-frame image, and video nodes; connect asset→image as `product_ref`, image→video as `first_frame`, asset→video as `product_ref`; stamp `videoRecipeId: "product_demo"` on the video.
- [ ] For `fashion_fit_check`, create character, visual asset, optional background prompt, first-frame image, and video nodes; connect character/product/background into image and video with roles; stamp `videoRecipeId: "fashion_fit_check"`.
- [ ] For `mirror_selfie`, create character, background/style prompt, first-frame image, and video nodes; connect roles; stamp `videoRecipeId: "mirror_selfie"`.
- [ ] After scaffold, call `openGenerationDialog(videoNodeId, "")` so the user lands on the video step with auto-prompt ready.

### Task 4: UI Entry Point

**Files:**
- Modify: `frontend/src/canvas/AddNodePalette.tsx`
- Modify: `frontend/src/styles.css`

- [ ] Add a compact “Recipe” group to the add-node palette for the three MVP recipes.
- [ ] Clicking a recipe uses `screenToFlowPosition` and calls `addFlowFromRecipe`.
- [ ] Style recipe buttons consistently with existing chips and keep text fitting at normal sidebar/canvas widths.

### Task 5: Verification and Commit

**Files:**
- All touched files.

- [ ] Run `rtk agent/.venv/bin/pytest agent/tests/test_prompt_synth.py agent/tests/test_edges.py -q`.
- [ ] Run `rtk agent/.venv/bin/pytest agent/tests -q`.
- [ ] Run `rtk npm run lint` from `frontend/`.
- [ ] Run `rtk npm run build` from `frontend/`.
- [ ] Commit with message `Add video recipe flow scaffolds`.
