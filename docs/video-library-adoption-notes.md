# Flowboard Video Library Adoption Notes

Last reviewed: 2026-05-27

This note records the library review for the short-video roadmap so future
work does not need to repeat the same research. Current stance: add libraries
only where they replace fragile local code or unlock a roadmap slice. Keep
FFmpeg as the media-processing core unless a library clearly beats it for a
specific task.

## Current Baseline

Frontend dependencies are intentionally small:

- `@xyflow/react`
- `react`
- `react-dom`
- `zod`
- `zustand`

Backend dependencies are also small:

- `fastapi`
- `uvicorn`
- `sqlmodel`
- `pydantic`
- `websockets`
- `python-multipart`
- `httpx`

This has helped keep the local agent portable. The tradeoff is that some
features are now using hand-rolled code where mature libraries would reduce
risk.

## Adoption Policy

Use a library when:

- It owns a hard domain: schema validation, subtitles, waveform UI, scene
  detection, state machines, media probing.
- It replaces escaping-heavy or format-heavy code.
- It has active docs, stable API, permissive license, and small operational
  cost.
- It can be adopted in one vertical slice with tests.

Do not use a library when:

- It hides FFmpeg in ways that reduce control over exact filtergraphs.
- It pulls large binary/runtime requirements without closing a roadmap gap.
- It forces a rewrite of existing working export paths.
- It is source-only/no-license or has unclear maintenance status.

## Recommended Additions

### 1. `zod` - Adopted

Status: **adopted for first frontend API-validation slice**

Source: https://zod.dev/

Why:

- TypeScript types do not validate API JSON at runtime.
- Flowboard now has many structured payloads: export options, node profiles,
  recipe catalog, QA payloads, timeline metadata.
- `zod` is TypeScript-first, supports static type inference, works in browsers,
  and has no external dependencies.

First slice shipped:

- Added timeline export request/response schemas.
- Added timeline QA request/response schemas.
- Validated export history, clip edit, transition, caption, and audio metadata
  returned by timeline export.
- Timeline export/QA now surface labeled errors for malformed JSON or missing
  required fields instead of accepting unchecked payloads.

Next useful slices:

- Add schemas for node `profile` and key `FlowboardNodeData` slices.
- Validate recipe catalog/shot-plan responses at the API boundary.

Do not use it for:

- Every internal object immediately.
- Backend validation, because backend already uses Pydantic.

Install:

```bash
rtk npm install zod
```

Expected tests:

- `rtk npm run lint`
- `rtk npm run build`
- `rtk npm run test:e2e`

### 2. `pysubs2` - Adopt For Caption Phase 2

Status: **recommended when captions advance**

Source: https://pysubs2.readthedocs.io/

Why:

- Current burn-in caption path uses FFmpeg `drawtext` directly.
- `drawtext` escaping and timing gets brittle as captions become multiline,
  styled, localized, or imported/exported.
- `pysubs2` supports ASS/SSA, SRT, WebVTT, TTML, and other formats, and can
  generate subtitle files that FFmpeg burns with the subtitles filter.

Good slice:

- Convert timeline captions to temporary `.ass` via `pysubs2`.
- Burn captions with FFmpeg `subtitles=...`.
- Keep existing `caption_mode: none | burn_in`.
- Stamp subtitle format/style metadata.

Do not use it for:

- Simple one-line caption metadata in the frontend.
- General timeline editing.

Install:

```bash
rtk uv add pysubs2
```

Expected tests:

- backend focused export caption tests
- `rtk uv run pytest tests/test_exports.py -q`
- full backend when feasible

### 3. `wavesurfer.js` - Adopt For Audio Editor UX

Status: **defer until audio UI phase**

Source: https://wavesurfer.xyz/docs/

Why:

- Timeline Audio Mix currently only needs media IDs and volume values.
- Once Flowboard supports voiceover/BGM trimming, markers, waveform selection,
  or caption/audio sync, a waveform UI is a real domain problem.
- `wavesurfer.js` is built for interactive browser waveform rendering and audio
  playback.

Good slice:

- Add audio node waveform preview.
- Add trim handles/markers for voiceover and BGM.
- Feed trim values into export audio mix payload.

Do not use it for:

- Backend mixing.
- Current simple volume controls.

Install when needed:

```bash
rtk npm install wavesurfer.js
```

### 4. `scenedetect` / PySceneDetect - Adopt For Timeline QA Phase 2

Status: **defer until QA phase 2**

Source: https://www.scenedetect.com/docs/latest/

Why:

- Local QA now uses ffprobe/ffmpeg heuristics for black/frozen frames,
  duration drift, aspect mismatch, and audio gaps.
- Advanced QA needs scene/cut/fade detection, scene list output, and frame
  snapshots. PySceneDetect already owns this domain.

Good slice:

- Add optional scene-detection pass for timeline exports.
- Report likely unexpected cuts/fades and generate per-scene thumbnails.
- Use `detect-content` or `detect-adaptive` before adding custom heuristics.

Do not use it for:

- Simple ffprobe metadata.
- Export stitching.

Install when needed:

```bash
rtk uv add scenedetect
```

## Deferred / Not Recommended Now

### Remotion

Status: **defer**

Source: https://v3.remotion.dev/

Why not now:

- Remotion is strong for programmatic React-based video and motion graphics.
- Flowboard's current roadmap is stitched AI video clips, local ffmpeg export,
  captions, audio mix, and QA.
- Adding Remotion now would introduce a second render architecture and a
  browser/Chromium render pipeline.

Use later if:

- Flowboard adds template/motion-graphics ads, kinetic text, animated overlays,
  product cards, lower thirds, or social templates.

### MoviePy

Status: **defer**

Source: https://pypi.org/project/moviepy/

Why not now:

- MoviePy is useful for Pythonic video compositing.
- For trim/concat/fade/audio/subtitle export, FFmpeg CLI is faster, lower-level,
  and more predictable.
- MoviePy can pull frames into Python/numpy, which is unnecessary for current
  export work.

Use later if:

- We need Python-level frame transforms, animated overlays, generated preview
  GIFs, or prototype-only compositing.

### PyAV

Status: **not recommended for current export**

Source: https://pyav.org/docs/6.1.0/

Why not now:

- PyAV is Pythonic FFmpeg binding with direct packet/frame/container access.
- Its own docs note that if FFmpeg commands do the job without heavy pain,
  PyAV can be more hindrance than help.
- Current export needs exact FFmpeg filtergraphs, not frame-level decoding.

Use later if:

- We need frame-accurate analysis, custom packet handling, or direct numpy/Pillow
  frame operations.

### `ffmpeg-python`

Status: **not recommended now**

Source: https://github.com/kkroening/ffmpeg-python

Why not now:

- It can build complex FFmpeg graphs, but our service already emits explicit
  args and tests behavior through FFmpeg.
- Direct args make debugging easier when FFmpeg errors must be shown to users.

Use later if:

- Filtergraph construction becomes too large to reason about safely.

### `pydub`

Status: **defer**

Source: https://pydub.com/

Why not now:

- Good high-level audio manipulation API.
- Current video export audio mix is best kept in FFmpeg because audio and video
  duration/muxing happen together.

Use later if:

- Flowboard adds audiobook/narration workflows, voice chunk assembly, silence
  padding, or standalone audio render pipelines.

### `react-hook-form`

Status: **not recommended now**

Source: https://www.react-hook-form.com/

Why not now:

- Flowboard uses inline controls and onBlur persistence, not large submit-form
  pages.
- It would not reduce current timeline/inspector complexity much.

Use later if:

- Domain nodes become large structured forms with validation, dirty state,
  submit/cancel semantics, and field arrays.

### XState

Status: **defer**

Source: https://xstate.js.org/api

Why not now:

- Zustand is enough for current board and generation state.
- XState is valuable for state-machine-shaped problems, but a broad migration
  would be churn.

Use later if:

- Generation/export/QA gains many explicit states, retries, cancellation,
  resume, parallel actors, and model-based tests.

## Repo-Inspired Notes

FlowKit and KJAudioBook-v2 had useful design ideas, but should not be copied
wholesale:

- FlowKit is useful for Flow browser bridge patterns, reference/entity
  planning, model/tier compatibility, and error taxonomy.
- KJAudioBook-v2 is useful for audio/export progress and narration workflow
  shape.
- Do not copy source from repos without a clear license.
- Do not integrate reCAPTCHA-solving or quota-bypass behavior.

## Suggested Order

1. `zod` for API/runtime validation. First slice adopted.
2. `pysubs2` for caption phase 2.
3. `wavesurfer.js` for audio trim/waveform UX.
4. `scenedetect` for Timeline QA phase 2.
5. Reconsider Remotion only for template/motion-graphics ads.

## Decision Summary

Keep:

- FFmpeg CLI as export/render core.
- Zustand for current store.
- Pydantic for backend request validation.
- React Flow for graph editing.

Add:

- `zod` for frontend API/runtime validation.
- `pysubs2`, `wavesurfer.js`, and `scenedetect` when their roadmap slices
  begin.

Avoid for now:

- Remotion, MoviePy, PyAV, `ffmpeg-python`, `pydub`, `react-hook-form`, XState.
