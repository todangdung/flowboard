# Flowboard Video Gap And Roadmap

Last updated: 2026-05-25

## 2026-05-25 Implementation Checkpoint

Completed vertical slices:

- Phase 5 shot workflow MVP: storyboard sequence creates shot frame, shot clip,
  and timeline nodes without auto-opening generation.
- Video status parsing: rejected, failed, cancelled, expired, and similar Flow
  media statuses now terminate as node errors instead of polling forever.
- Reference role UX/backend: video references are valid saved references, role
  labels are preserved, and recipe validation blocks generation until required
  roles are ready.
- Recipe router contracts: catalog responses include safety hints; prompt
  preview includes a safety section.
- Consistency and claim layer: video recipe prompts include product, logo,
  character, and skincare/health/beauty claim-safety constraints.
- Audio controls: video audio mode is a persisted setting and is appended to
  dispatch prompts/request params.
- Iteration tools: video results can be saved as references, refined from the
  current prompt, or extended into a cloned follow-up clip node.
- Quality review loop: rendered variants can be marked best/good, redo, or
  skip with notes; best choices feed downstream/export, redo blocks export,
  and skip clips are omitted from export.
- Export: timeline clips can be stitched through ffmpeg and registered as a
  final `/media/{id}` video asset.
- Reusable tests: backend export/status/recipe tests and Playwright shot
  workflow coverage verify the full mocked sequence path.

This file is split out from `video-production-workflow-map.md`. It focuses only
on what Flowboard currently lacks and the development direction suggested by
the video-production workflow research.

## Current Flowboard Capabilities

Already present:

- Node graph with `image`, `video`, `character`, `prompt`, `note`,
  `visual_asset`, and `Storyboard` nodes.
- Upstream media references for image generation.
- Video generation from an upstream source image.
- Omni Flash ingredient-style collection of upstream refs.
- Prompt nodes as text guidance.
- Storyboard node as composite image generation.
- Auto-prompt synthesis from upstream context.
- Static/dynamic camera option for video prompt synthesis.
- Variant handling for image and video source variants.
- Best-variant selection stored on node data for downstream generation/export.

Main limitation:

- References are mostly generic media links, not typed production roles.
- Storyboard is treated as a composite media asset, not as a production plan
  with separate shots.
- Prompt synthesis is intent-first but not recipe-routed.

## Gap Map

| Area | Current gap | Why it matters |
| --- | --- | --- |
| Data model | No `product` node or product role metadata | Product ads need logo, packaging, material, and claim constraints. |
| Data model | No `location` / `background` node | Background refs should not compete with character/product refs. |
| Data model | No `brand` / campaign brief node | Ads need brand tone, CTA, colors, legal/claim rules. |
| Data model | No `audio` / voiceover node or setting | Veo/Omni/Sora-style video workflows require sound direction. |
| Data model | No shot/panel node type | Storyboard production needs per-shot generation, not only a grid image. |
| Data model | No edge role metadata | A ref can mean first frame, character, product, background, style, final frame, or ingredient. |
| Data model | Duration is not first-class enough | Official model docs treat duration as a generation setting, not prose inside the prompt. |
| Data model | No prompt recipe ID stored with output | Hard to debug or repeat which recipe generated a result. |
| Prompt system | No recipe router | Auto-prompt cannot reliably choose unbox vs review vs mirror vs TVC. |
| Prompt system | No reusable recipe library | One large system prompt becomes hard to maintain. |
| Prompt system | No structured prompt contracts per recipe | Different video types need different required fields. |
| Prompt system | Product fidelity contract is implicit | Product/logo drift is a major commercial failure. |
| Prompt system | Character consistency contract is implicit | Character drift breaks influencer/story workflows. |
| Prompt system | No claim/safety filter layer | Skincare/health/beauty prompts need compliance wording. |
| Prompt system | One-shot short vs storyboard sequence not separated | Current storyboard-to-video path can push content toward montage/anime/blog behavior. |
| UI | No video style selector | Users must know prompt terms manually. |
| UI | No duration selector tied to model capability | Users can request unsupported durations in prose. |
| UI | No audio mode selector | Speech/music/SFX/ambient/no-speech should be explicit. |
| UI | No reference role picker | Users cannot say which upstream image is product vs background vs first frame. |
| UI | No storyboard panel selector | Users cannot generate one panel as one shot. |
| UI | No shot list / timeline view | Multi-scene production cannot be managed end to end. |
| UI | Generated prompt preview is not sectioned | Hard for users to debug camera/action/audio/avoid rules. |
| Pipeline | No clear text-to-video mode | Useful for concept exploration without refs. |
| Pipeline | No first+last frame mode | Needed for transformation/reveal workflows. |
| Pipeline | No video edit/refine | AI video production usually needs controlled iteration. |
| Pipeline | No video extend | Longer sequences should be built from strong clips. |
| Pipeline | No per-shot batch generation | Storyboard-to-video should generate multiple scene clips. |
| Pipeline | No stitch/export final sequence | Multi-scene workflows stop before final video assembly. |
| Pipeline | No quality review loop | Best outputs need selection, scoring, and targeted fixes. |
| Asset library | No saved product profiles | Product details must be reused across boards. |
| Asset library | No saved character profiles | Influencer/series workflows need reusable identity. |
| Asset library | No saved locations | Lifestyle/UGC scenes reuse common rooms, cafes, streets. |
| Asset library | No saved brand kits | Ads need repeatable brand constraints. |
| Asset library | No accepted-output-as-reference flow | Good outputs should become stronger future references. |
| Asset library | No prompt recipe catalog | The researched corpus is not yet operationalized. |

## Recommended Development Direction

### Phase 1: Document And Normalize Recipes

Do this before UI changes.

Deliverables:

- recipe list
- recipe input requirements
- recipe prompt skeletons
- safety/claim rules
- examples from the local corpus and public references

Why:

- Prevents one huge system prompt from becoming unmaintainable.
- Lets Flowboard map user intent to the right production path.

### Phase 2: Add Reference Roles Without New Node Types

Minimal implementation:

- Keep existing node types.
- Add edge/reference role metadata.
- Let source chips show role labels.

Initial roles:

- first frame
- character
- product
- background
- style
- ingredient
- final frame

Why:

- This unlocks better prompts without changing the graph too much.

### Phase 3: Prompt-Only Recipe Router

Before new UI:

- Auto-prompt reads upstream roles.
- It picks a recipe.
- It generates a prompt using the right structure.

Examples:

- product + model + video target -> product demo or UGC review
- character + mirror/background + video target -> mirror selfie
- storyboard target -> storyboard plan, not direct video by default

Why:

- Low UI risk.
- Better output quality quickly.

### Phase 4: Add Video Style And Duration Controls

UI additions:

- Auto
- Fashion fit check
- Mirror selfie
- GRWM
- Product unbox
- Product demo
- Quick review
- Soft dance
- Beat dance
- Product beauty shot
- Before/after reveal
- Cinematic one-shot
- Storyboard scene

Duration:

- expose only model-supported values
- do not rely on prompt prose to control actual duration

Why:

- Makes the system understandable for non-prompt users.

### Phase 5: Redesign Storyboard Into Shot Workflow

Target model:

- Storyboard plan node
- Panel/shot nodes
- Each shot can generate first frame and video
- Timeline collects generated clips

Keep current composite storyboard as:

- Storyboard contact sheet
- Montage experiment

Why:

- Aligns with production prompts in the corpus.
- Avoids forcing one-shot shorts into blog/anime/montage behavior.

### Phase 6: Add Iteration, Edit, Extend, And Export

Features:

- save best variant
- refine one thing at a time
- extend video
- edit video with preserved constraints
- stitch clips
- export final short

Why:

- AI video production is iterative. The first generation is usually a draft.

## Immediate Project Takeaways

1. Do not jump straight to more prompt text.
2. The first missing abstraction is reference role, not another node UI.
3. The second missing abstraction is recipe selection.
4. Storyboard should become planning/shot generation, not the default video
   source.
5. Product and character consistency need explicit contracts.
6. Audio and duration should be settings, not hidden prompt prose.
7. Commercial workflows need safety/claim filters as part of prompt quality.
