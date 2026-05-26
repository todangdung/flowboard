# Video Production Workflow Map

Last updated: 2026-05-26

This document summarizes how short AI videos can be produced from different
starting inputs, using the local prompt corpus in `prompt.txt` / `link.txt`
plus public guidance from Google Flow/Veo and OpenAI Sora. The goal is not to
define an implementation yet. The goal is to expose the full production shape
so Flowboard can decide what is missing before adding features.

Status note: this is now a research/concept map. Many `Missing`,
`Flowboard gap`, and `Project gaps` bullets below were true on 2026-05-24 but
have since been implemented: reference roles, product/location/brand/audio
nodes, recipe library, source modes, storyboard sequence workflow,
review/refine, timeline export, and asset profiles. Current implementation
status lives in `docs/flowboard-video-gap-roadmap.md`.

## Source Observations

The collected prompts are not one single "video prompt" pattern. They fall into
several production layers:

- Image generation prompts for product, character, location, campaign poster,
  infographic, and mood-board assets.
- Character/product consistency prompts, often using strict reference
  instructions or JSON-like structure.
- Grid/storyboard prompts, usually 3x3 or 4/9 panels, meant for visual planning
  or shot variants.
- Product-to-storyboard system prompts, converting product info into a 6-9
  panel ad narrative.
- Storyboard-to-video system prompts, converting each panel into a separate
  video prompt with consistency locks.
- One-shot motion prompts, especially fashion/product prompts where one source
  image becomes one short clip.

Public docs reinforce the same shape:

- Google Veo prompt guidance emphasizes subject, action, camera movement,
  lens/optical effects, pacing, temporal evolution, and safety filters.
- Google Flow model support differs by model: some paths support text-to-video,
  first-frame video, ingredient/reference video, edit, extend, and different
  durations.
- OpenAI Sora's guide is useful as a general AI-video production reference: the
  API/container controls duration/resolution, while the prompt controls subject,
  motion, lighting, and style. It also recommends using image inputs as visual
  anchors and treating each shot as a creative unit.

References:

- Google Veo prompt guide: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide
- Google Flow supported features: https://support.google.com/flow/answer/16352836
- OpenAI Sora prompting guide: https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide
- Local prompt corpus: `prompt.txt`, `link.txt`

## Core Principle

Do not treat "generate video" as one generic operation.

A reliable short-video system needs to know:

1. What source inputs are available.
2. What each input is supposed to control.
3. What kind of video is being made.
4. Whether the output is a single shot, multiple variations, or a multi-scene
   sequence.
5. Which model path supports that input shape and duration.

The same uploaded image can mean different things:

- first frame / start frame
- character identity reference
- product fidelity reference
- location/background reference
- visual style reference
- storyboard panel reference
- final-frame reference
- ingredient/reference image for a multi-ref model

Flowboard needs to eventually represent those roles explicitly.

## Input Asset Types

### Character Reference

Purpose:

- Keep the same face, hairstyle, outfit, body proportions, and identity.
- Drive influencer, fashion, UGC, review, dancing, GRWM, mirror selfie, or
  story continuity workflows.

Useful metadata:

- age range / persona
- facial identity lock
- hairstyle
- outfit
- body framing
- allowed expression range
- forbidden changes
- character name or label

Flowboard has partial support via `character` nodes.

Missing:

- explicit identity-lock contract
- character role labels for multi-character scenes
- reusable character profile separate from a generated image
- support for model-native avatar/character references where available

### Product Reference

Purpose:

- Preserve product shape, logo, packaging, color, material, label, and scale.
- Used for product photography, unbox, review, demo, campaign poster, and TVC.

Useful metadata:

- product category
- brand / logo
- exact product details to preserve
- material finish
- packaging constraints
- allowed backgrounds
- claims to avoid

Flowboard currently uses `visual_asset` for this, but it does not distinguish
product from generic visual asset.

Missing:

- first-class `product` role or product metadata
- strict "do not alter product" prompt contract
- product claim safety filters, especially skincare/health/beauty

### Location / Background Reference

Purpose:

- Preserve setting, mood, environment, lighting, and spatial context.
- Used for cafe lifestyle, bedroom mirror shot, studio, street, bathroom,
  product tabletop, kitchen, desk, store, etc.

Useful metadata:

- place type
- time of day
- lighting
- color palette
- props
- camera usable zones
- whether the location is a background only or an active scene

Flowboard currently has no first-class location node.

Missing:

- `location` or `background` node type
- role-aware reference passing: background reference should not be treated like
  product or character identity.

### Visual Style Reference

Purpose:

- Preserve look: cinematic, UGC phone video, Korean cafe, skincare commercial,
  idol photobook, editorial fashion, realistic product ad, etc.

Useful metadata:

- style name
- lighting recipe
- palette anchors
- grain/texture
- camera language
- platform feel

Flowboard has `prompt` nodes for style notes, but they are plain text only.

Missing:

- style presets
- style reference role
- reusable prompt recipes

### Storyboard / Shot Reference

Purpose:

- Plan a video sequence before generation.
- Either produce a grid/contact sheet or produce separate scene prompts.

Important distinction:

- A composite storyboard image is good for planning or visual reference.
- It is usually not the best source image for a one-shot video.
- For production, each panel should become a separate shot/scene reference or a
  separate prompt.

Flowboard has a `Storyboard` node, but today it generates one composite image
and video downstream locks the prompt to "animate panels in order".

Missing:

- first-class panel/shot objects
- ability to extract or select a panel as a video source
- storyboard-to-scene-prompt generation
- multi-scene timeline output

### Audio Reference / Audio Direction

Purpose:

- Control ambient sound, music bed, SFX, voiceover, dialogue, or no speech.

Useful metadata:

- speech allowed or forbidden
- language
- speaker labels
- music mood
- SFX layer
- filter-risk notes

Flowboard currently only includes audio guidance inside prompts.

Missing:

- audio mode setting
- voiceover script field
- per-scene audio direction
- safety handling for speech/lip-sync over face references

### Brand Kit

Purpose:

- Keep brand tone, colors, typography, logo, CTA, legal constraints, and claim
  style consistent.

Useful metadata:

- brand name
- logo media
- primary/secondary colors
- tagline
- allowed claims
- forbidden claims
- campaign message

Flowboard currently has no brand kit node.

Missing:

- `brand` node or campaign metadata
- claim filter
- CTA and typography constraints for image/poster outputs

## Workflow Levels

### Level 0: Raw Idea To Creative Brief

Input can be very small:

- "Make a 15s skincare ad"
- "Create a mirror outfit check"
- "Unbox this product"
- "Make a review video from this product image"

Required output:

- video purpose
- platform/aspect ratio
- duration target
- style intent
- available assets
- missing assets
- risk constraints

Brief schema:

```text
Goal:
Platform:
Duration:
Audience:
Product / Character / Location:
Style intent:
Output count:
Must preserve:
Must avoid:
Audio mode:
```

Flowboard gap:

- No dedicated brief node.
- Chat/planner can create nodes, but the generation dialog does not expose this
  structured brief as first-class data.

### Level 1: Asset Intake And Role Assignment

The system needs to classify uploaded/generated assets:

```text
asset_id:
asset_type: character | product | location | style | storyboard | shot | brand | audio
role_in_video: first_frame | identity_ref | product_ref | background_ref | style_ref | panel_ref | final_frame | ingredient
locked_details:
editable_details:
notes:
```

Flowboard gap:

- Edges currently mean "reference" generally.
- The same edge cannot yet say "this is the product lock" vs "this is the
  background mood" vs "this is the start frame".

### Level 2: Recipe Selection

The system should pick one recipe before generating prompts.

Common recipes from the corpus:

| Recipe | Best starting inputs | Output shape |
| --- | --- | --- |
| Fashion one-shot | character image, outfit/product image, optional location | one short i2v clip |
| Try-on / fit check | character, garment/product, mirror/studio/bedroom | one or several variants |
| Mirror selfie | character, outfit, room/background, phone/mirror cue | one vertical clip |
| Product unbox | product, package/box, hand/model, tabletop/location | one short reveal or 3-shot sequence |
| Product demo | product, use-case location, hand/model | one shot or multi-shot demo |
| Quick review / UGC | product, creator, room/background | one talking/silent review shot |
| Skincare TVC storyboard | product, model, bathroom/vanity/location, brand tone | 6-9 panel storyboard, then scenes |
| Character consistency grid | character spec/reference | 3x3 image grid/contact sheet |
| Product campaign poster | product reference, brand kit, campaign line | static image/poster |
| Location lifestyle | location prompt/reference, character/product | scene image or short ambient video |

Flowboard gap:

- No explicit style/recipe selector.
- Auto-prompt infers motion, but it is not organized around reusable recipes.

### Level 3: Pre-Production Outputs

Depending on recipe, the system should produce one or more planning artifacts:

1. Creative brief
2. Asset checklist
3. Storyboard
4. Shot list
5. Per-shot prompt
6. Negative prompt / avoid rules
7. Voiceover/audio script
8. Generation settings
9. Iteration plan

Flowboard currently has:

- Prompt nodes
- Note nodes
- Storyboard node
- Image/video nodes

Missing:

- structured shot list
- per-shot prompt bundle
- per-shot duration
- per-shot source asset roles
- separate storyboard planning vs storyboard image generation

### Level 4: Asset Generation

Before video, many workflows need source assets:

| Asset | How it is produced | Why it matters |
| --- | --- | --- |
| Character portrait/reference | character prompt or uploaded image | identity continuity |
| Product hero image | product ref or product photography prompt | product fidelity |
| Location/background | generated image or uploaded ref | scene consistency |
| Style/mood board | generated image grid or prompt note | aesthetic consistency |
| Storyboard grid | product/brief to 4/6/9 panels | planning and alignment |
| First frame | composed image from character/product/location | best i2v anchor |
| Last frame | optional generated target frame | better reveal/transition control |

Flowboard gap:

- It can generate images and use upstream refs, but it does not yet separate
  "composed first frame" from "general reference ingredients".
- It has no first/last-frame flow.

### Level 5: Video Generation Path

There are several different generation paths.

#### Path A: Text To Video

Use when:

- no visual references are available
- exploring broad creative direction
- low consistency requirement

Inputs:

- brief
- style intent
- prompt
- duration/aspect/model settings

Output:

- one or more video variants

Flowboard gap:

- Current video path expects upstream media for Veo i2v.
- Omni ingredients path exists, but text-only video exploration is not a clear
  first-class mode.

#### Path B: Image To Video / First Frame

Use when:

- one source image should become a short clip
- most one-shot short use cases
- fashion, mirror selfie, product demo, product beauty shot

Inputs:

- first-frame image
- motion prompt
- camera mode
- duration/aspect/model settings
- optional audio guidance

Output:

- one short video

Flowboard has:

- video node from upstream image for Veo i2v
- source variant selection
- camera static/dynamic

Missing:

- explicit first-frame role
- duration selector tied to model capability
- style recipe selector
- audio mode selector

#### Path C: Ingredients / Multi-Reference To Video

Use when:

- character, product, background, and style references should all condition the
  video, but none is necessarily the literal first frame.
- product demo with separate product and person references.

Inputs:

- character ref
- product ref
- location/background ref
- style note/ref
- video prompt

Output:

- video conditioned by ingredients

Flowboard has:

- Omni Flash ingredient-style path that collects upstream media refs.

Missing:

- role labels for ingredients
- conflict handling when product ref and character ref both compete for focus
- UI explaining that this is not literal i2v start-frame mode

#### Path D: First + Last Frame

Use when:

- reveal/transition needs a target endpoint
- before/after, transformation, product reveal, outfit change

Inputs:

- first frame
- last frame
- motion prompt
- duration/aspect/model settings

Output:

- clip transitioning between two visual anchors

Flowboard gap:

- No first+last frame edge semantics.
- No UI for selecting a target frame.

#### Path E: Storyboard To Scene Videos

Use when:

- producing a multi-scene short, ad, or TVC
- product-to-storyboard corpus workflow

Inputs:

- storyboard panels
- per-panel scene prompt
- consistency locks
- per-scene duration
- audio/voiceover per scene

Output:

- separate video clips, then timeline/stitch/export

Important:

- This is the production-friendly storyboard path.
- It should not depend on animating the entire composite grid as one source
  image.

Flowboard gap:

- Storyboard is currently a composite image node.
- Downstream video locks the prompt to animate frame 1 to N.
- There is no panel extraction, shot node, clip list, timeline, or stitcher.

#### Path F: Storyboard Composite Montage

Use when:

- user explicitly wants a quick animated storyboard montage
- experimental frame-by-frame composite animation

Inputs:

- composite storyboard image
- locked or semi-locked "animate panels in order" prompt

Output:

- one video that moves through panels

Flowboard has:

- current Storyboard -> Video behavior.

Risk:

- Can feel like blog/anime/montage.
- Reduces manual motion prompt control.
- Not ideal for one-shot short production.

#### Path G: Edit / Refine / Extend

Use when:

- output is close but needs controlled change
- user wants longer sequence from a good clip
- user wants to change palette, camera, product position, or motion intensity

Inputs:

- existing video
- edit instruction
- preserved elements
- one small change

Output:

- edited or extended video

Flowboard gap:

- Image refine exists.
- Video edit/extend is not a first-class workflow.

## Prompt Structures To Learn From The Corpus

### Image Prompt Structure

Use for product, character, location, poster, campaign, style, and first-frame
asset generation.

```text
Reference instruction:
Subject/product:
Setting:
Composition:
Lighting:
Camera/lens:
Material/texture:
Mood/style:
Text/typography constraints:
Must keep:
Must avoid:
Aspect ratio:
```

Best for:

- product hero image
- product poster
- character portrait
- location mood image
- first frame for i2v

### JSON Spec Structure

Use when identity/product consistency matters.

```json
{
  "subject": {},
  "product": {},
  "wardrobe": {},
  "pose": {},
  "environment": {},
  "photography": {},
  "style": {},
  "constraints": {
    "must_keep": [],
    "avoid": []
  },
  "negative_prompt": []
}
```

Best for:

- reusable character profile
- product fidelity
- brand kit
- multi-generation consistency

Risk:

- Some copied JSON prompts include sexualized details. A commercial product
  workflow should normalize or filter those into safe fashion/beauty language.

### Storyboard Prompt Structure

Use for planning a multi-scene video, not necessarily for direct video
generation.

```text
Role:
Product/brief analysis:
Storyboard length:
Panel schema:
- panel number
- duration
- scene description
- character action
- product placement
- camera angle
- setting
- mood
- voiceover if needed
Narrative arc:
Hook -> product intro -> use/demo -> experience -> beauty shot -> CTA
Continuity constraints:
Safety/claim constraints:
Output only storyboard:
```

Best for:

- TVC
- product ad
- skincare/beauty routine
- multi-scene short

### Scene Video Prompt Structure

Use after storyboard or when generating a single scene.

```text
Scene / panel number:
Duration:
Use these references:
Consistency locks:
Action beat:
Camera:
Lighting:
Mood:
Product position:
Audio / voiceover:
Avoid:
```

Best for:

- generating one clip per storyboard panel
- keeping multi-scene ads consistent

### One-Shot Short Video Prompt Structure

Use for most short-form social clips.

```text
Source image is the first frame.
Style intent:
Subject/product:
One clear motion:
Secondary natural motion:
Camera behavior:
Timing:
Lighting/mood:
Audio:
Avoid:
```

Best for:

- fashion walk / fit check
- mirror selfie
- soft dance
- product beauty shot
- UGC review without dialogue
- unbox reveal if the source frame already contains the box/product

## Use-Case Workflows

### 1. Fashion Try-On / Fit Check

Minimum inputs:

- character or model image
- outfit/product reference
- optional studio/bedroom/mirror background

Ideal workflow:

1. Create or upload character reference.
2. Create or upload garment/product reference.
3. Compose a first frame showing full fit clearly.
4. Generate one-shot video with controlled movement: walk, turn, gesture,
   fabric motion.
5. Generate 3-4 variants for pose/camera.
6. Pick best result, optionally refine.

Project gaps:

- no garment/product role
- no video style preset for fit check
- no explicit "show full product/fit for entire clip" control

### 2. Mirror Selfie / GRWM

Minimum inputs:

- character reference
- outfit/product reference
- room/mirror background

Ideal workflow:

1. Generate first frame: subject in mirror, phone visible, outfit readable.
2. Motion: small pose adjustment, phone tilt, hair/fabric movement.
3. Keep camera language like real phone/mirror footage.
4. Optional music/ambient audio, no speech by default.

Project gaps:

- no mirror/phone preset
- no location/background role
- no UGC camera-style setting

### 3. Product Unbox

Minimum inputs:

- product image
- packaging/box image or generated box
- hand/model or tabletop background

Ideal workflow:

1. Lock exact product design.
2. Generate first frame with product box and hands.
3. Motion: open flap, remove product, reveal hero angle.
4. End on product beauty hold.

Project gaps:

- no package/product distinction
- no hand/model role
- no final-frame target for reveal endpoint

### 4. Product Review / UGC

Minimum inputs:

- creator/character
- product
- room/location
- optional voiceover/script

Ideal workflow:

1. Choose silent review or spoken review.
2. If silent: gestures, product close-up, reaction, product hero.
3. If spoken: short script and speaker labels; avoid long monologues.
4. Generate one short clip or multiple shots.

Project gaps:

- no audio/speech mode
- no script field
- no safety handling for speech/lip-sync filter risk

### 5. Product Demo

Minimum inputs:

- product
- use-case setting
- hand/model

Ideal workflow:

1. Identify one visible function to demonstrate.
2. Compose first frame with product usable and readable.
3. Motion: one concrete operation, not many.
4. End on result/benefit visual.

Project gaps:

- no recipe for "operation/action/use-case"
- no step/demo structure
- no product result frame

### 6. Skincare / Beauty TVC

Minimum inputs:

- product
- model/character
- bathroom/vanity/bright room
- brand tone

Ideal workflow:

1. Product info -> 6-9 panel storyboard.
2. Validate claims and avoid medical/extreme promises.
3. Generate or select panels/first frames per scene.
4. Convert each panel into one scene prompt.
5. Generate clips per scene.
6. Stitch into timeline with voiceover/music.

Project gaps:

- no product-to-storyboard planning step
- no per-panel video generation
- no claim safety filter
- no timeline/stitch/export

### 7. Character Consistency / Virtual Influencer

Minimum inputs:

- character portrait or JSON profile
- style/location/product references

Ideal workflow:

1. Create character profile.
2. Generate contact sheet or 3x3 pose grid.
3. Select best references.
4. Use character as identity anchor for images/videos.
5. Track accepted outputs as stronger references.

Project gaps:

- no persistent character profile beyond node data
- no accepted-reference library for identity improvement
- no character-reference role in video generation settings

### 8. Storyboard Sequence / Multi-Scene Short

Minimum inputs:

- brief
- character/product/location references
- storyboard or shot list

Ideal workflow:

1. Generate storyboard plan.
2. Convert storyboard to shot nodes.
3. Generate each shot as its own video.
4. Review continuity.
5. Stitch/export final short.

Project gaps:

- current storyboard is a composite image, not a shot graph
- no shot nodes
- no timeline
- no continuity review UI

## Related Documents

This file is now only the concept map for AI-video production. The project gap
analysis and roadmap have been moved to:

- [Flowboard Video Gap And Roadmap](flowboard-video-gap-roadmap.md)

A more practical table of standard video flows and step-level prompt templates
is tracked in:

- [Video Production Standard Flows](video-production-standard-flows.md)

<!-- Historical gap/roadmap notes moved to docs/flowboard-video-gap-roadmap.md. -->
