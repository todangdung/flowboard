# Flowboard Video Gap And Roadmap

Last updated: 2026-05-26

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
- Export version/stale UX: timeline exports are stamped with version/source
  metadata, review or clip-set changes mark existing exports stale without
  deleting the old link, and re-export supersedes stale output as fresh.
- Export history UI: previous timeline exports remain accessible after
  re-export with version/status/clip metadata and stale reason shown inline.
- Video refine loop: reviewed clips can spawn a refined replacement from the
  review note while preserving shot metadata/upstream refs and marking the
  timeline export stale.
- Project node library placement: the top add-node palette remains the default
  compact set, while Product, Location, Brand, Campaign, Audio, and recipe workflow
  shortcuts live inside the existing Projects sidebar as collapsible folder
  groups. This prevents the canvas palette from wrapping over the board.
- Recipe catalog sync: backend and frontend recipe entries now expose scaffold,
  sidebar/dialog placement, source-mode defaults, and QA status so prompt-only
  recipes stay out of the Projects sidebar while scaffold-ready workflows stay
  discoverable.
- Reusable tests: backend export/status/recipe tests and Playwright shot
  workflow coverage verify the full mocked sequence path.

Additional gap closure in this pass:

- Timeline active-clip chooser: timeline rows now expose same-shot clip
  candidates and can switch the active storyboard-panel edge without deleting
  redo/refine history.
- Video source modes: Generate Video supports Auto, Text-to-video,
  First frame, First+last frame, and Omni Ingredients paths.
- First+last frame dispatch: `last_frame` edge role now drives Flow's
  start/end-image endpoint. Veo duration remains persisted for timeline/
  export planning because current Flow Veo endpoints ignore explicit duration.
- Text-to-video dispatch: video nodes can generate without image refs through
  a dedicated `gen_video_text` request path.
- Video edit/refine dispatch: reviewed clip refine now creates a replacement
  node and dispatches `edit_video_omni` against the existing video media id
  instead of falling back to first-frame i2v.
- Domain nodes and profiles: Product, Location, Brand, Campaign, and Audio
  nodes have profile fields; saved references persist reusable
  product/location/brand/campaign/audio metadata.
- Campaign Brief node: `campaign` nodes and `campaign_ref` edges carry
  objective, audience, offer, CTA, claim limits, tone, platform, and
  must-include/avoid rules into video recipe prompt synthesis, preflight
  warnings, and storyboard/timeline scaffolds.
- Asset library profiles: reference rows now store a JSON `profile`, and
  library spawn/drag preserves it back onto new nodes.
- Export preflight/presets: timeline export opens a preflight with clip
  source/version list plus 9:16, 16:9, and 1:1 1080p presets.
- Duration model: Veo 4/6/8s and Omni 4/6/8/10s durations are request params
  and persisted on video nodes. Omni sends duration-specific model keys; Veo
  keeps duration as planning/export metadata because Flow rejects or ignores
  explicit `videoLengthSeconds` on current text/i2v endpoints.

Real Flow QA on 2026-05-25:

- Text-to-video real dispatch passed via `gen_video_text`; Flow accepted
  `/v1/video:batchAsyncGenerateVideoText`, returned workflow media
  `577ed1c0-7d78-4636-a62a-58966d461f7d`, and local `/media/{id}` served
  `video/mp4`.
- First+last frame real dispatch passed via
  `/v1/video:batchAsyncGenerateVideoStartAndEndImage`, returned media
  `2a2a51d5-79f7-4a02-86ef-de1c20ddcf20`, and local `/media/{id}` served
  `video/mp4`.
- Edit-video real probe found the current Flow contract:
  `/v1/video:batchAsyncGenerateVideoEditVideo` with
  `videoInput {mediaId,startFrameIndex,endFrameIndex}` and no
  `useV2ModelConfig`. The free-tier test account (`G1_FREEMIUM`) still returns
  Flow `500 INTERNAL`; Flow UI strings indicate video editing is paid/V2V gated.

Real Flow QA on 2026-05-26 after the video recipe library:

- Account: `dungg.coco@gmail.com`, `G1_FREEMIUM`,
  `PAYGATE_TIER_ONE`, reported credits `10`.
- Project under test: `fa239fb7-c4e4-409f-9712-278e8127e55d`.
- `product_demo` via first-frame i2v passed with request `109`
  (`gen_video`, source mode `first_frame`, quality `lite`). Flow returned media
  `2d80e9a2-53a4-4a1b-bccf-0caf2b768606`, and local
  `/api/media/{id}/status` reports `video/mp4`.
- `brand_bumper` via text-to-video was blocked by Flow quota on request `108`
  (`429 RESOURCE_EXHAUSTED`,
  `PUBLIC_ERROR_USER_QUOTA_REACHED`). A `lite_relaxed` retry on request `113`
  hit the same quota response.
- `before_after` via first+last frame was blocked by Flow quota on request
  `110` (`429 RESOURCE_EXHAUSTED`, `PUBLIC_ERROR_USER_QUOTA_REACHED`).
  A `lite_relaxed` retry on request `114` returned `403 PERMISSION_DENIED`,
  `PUBLIC_ERROR_MODEL_ACCESS_DENIED` for the free-tier account.
- `lifestyle_ad` via Omni ingredients was blocked by Flow quota on request
  `111` (`429 RESOURCE_EXHAUSTED`, `PUBLIC_ERROR_USER_QUOTA_REACHED`).
- `edit_video_omni` still reaches the real edit-video endpoint but Flow returns
  `500 INTERNAL` on request `112`, matching the earlier paid/V2V gate finding.
- Follow-up free-account Veo Lite batch attempted five first-frame i2v recipe
  requests with `video_quality: "lite"` and `duration_s: 4`: product demo
  request `115`, packshot loop request `116`, cinematic reveal request `117`,
  UGC testimonial request `118`, and lifestyle ad request `119`. All five
  returned `429 RESOURCE_EXHAUSTED` with
  `PUBLIC_ERROR_USER_QUOTA_REACHED`, so no new media ids were created.
- A low-priority first-frame retry with `video_quality: "lite_relaxed"`
  returned `403 PERMISSION_DENIED`, `PUBLIC_ERROR_MODEL_ACCESS_DENIED` on
  request `120`. Current free account can validate request wiring, but further
  real video output needs quota reset or a video-enabled account.
- Real Flow QA runner added: `scripts/real_flow_qa.py`. Use
  `agent/.venv/bin/python scripts/real_flow_qa.py --mode fixtures` to create a
  reusable QA board/manifest, and
  `agent/.venv/bin/python scripts/real_flow_qa.py --mode videos --video-profile free-lite`
  or `--video-profile full` to rerun matrix cases after quota/account changes.
- Fixture pack created on board `10`, project
  `4c3ff49e-5404-4712-8b3b-72f9ef8546c5`, with saved references for product,
  location, brand, character, first-frame, and last-frame:
  product `e8db2a90-5b80-4ed8-b691-08e0cb01d0d4`, location
  `067273b8-542b-4ab6-90f3-7932319c089c`, brand
  `cb011ac1-3b4b-4f18-8e10-f39fad70403e`, character
  `0ac02a83-2e22-41ab-9723-01b160db7fa1`, first-frame
  `67ee6bc3-9624-4fe2-831e-cc7c6787d919`, and last-frame
  `bf7c5b11-aedd-4dcb-8356-ee8d03326a09`.
- The runner's one-case video smoke on request `133` reached Flow but failed
  with `PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed`, likely
  from rapid repeated video attempts during quota probing.
- After reloading the Chrome extension, a follow-up runner smoke request `134`
  still reached Flow and failed with
  `PUBLIC_ERROR_UNUSUAL_ACTIVITY: reCAPTCHA evaluation failed`. Extension
  connection was healthy (`last_error: null`), so remaining blocker is Flow's
  reCAPTCHA/quota side rather than local request wiring.

This file is split out from `video-production-workflow-map.md`. It focuses only
on what Flowboard currently lacks and the development direction suggested by
the video-production workflow research.

## Current Flowboard Capabilities

Already present:

- Node graph with `image`, `video`, `character`, `prompt`, `note`,
  `visual_asset`, `product`, `location`, `brand`, `audio`, and
  `Storyboard` nodes.
- Upstream media references plus per-edge production roles.
- Video generation from text, first frame, first+last frame, Omni ingredients,
  and edit-video source modes.
- Prompt nodes as text guidance.
- Storyboard node as composite image generation.
- Storyboard sequence recipe as shot-frame/shot-clip/timeline workflow.
- Auto-prompt synthesis from upstream context.
- Static/dynamic camera option, duration planning, audio mode, and recipe
  contracts for video prompt synthesis.
- Variant handling for image and video source variants.
- Best-variant selection stored on node data for downstream generation/export.
- Review/refine/export loop with stale exports and export history.
- Recipe library/preflight/scaffold for the main commercial short-video types.

Remaining limitations:

- Real Flow validation is partial because the current free account hit quota,
  model access, reCAPTCHA, and edit-video/V2V gates.
- Native video extend is not yet validated as a first-class Flow endpoint.
- Campaign brief, script/voiceover asset pipeline, per-shot edit controls,
  and auto-review scoring are still future work.

## Original Gap Map (Historical)

Status note: the table below is the original gap map from the research pass.
Most rows are now closed by the 2026-05-25/26 implementation checkpoint above.
Use this status overlay for current planning:

| Status | Areas |
| --- | --- |
| Closed | Product/location/brand/audio nodes, edge roles, recipe catalog/router, product/character/claim prompt contracts, source modes, duration planning, audio guidance, reference role picker, shot workflow, timeline/export/review/refine, asset library profiles, accepted-output references. |
| Partial | Real Flow QA across all recipes, edit-video real validation, character profile depth, brand kit depth, audio/voiceover pipeline, storyboard panel/source editing, native video extend. |
| Open | Structured campaign brief node, per-shot trim/reorder/transition/caption/audio mix, auto-review scoring, multi-provider media abstraction beyond Flow. |

| Area | Original gap | Why it mattered |
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

## Recommended Development Direction (Historical)

This sequence explains the original implementation order. Most phases below
are now implemented; keep this section as rationale, not as current TODO.

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
