# Video Production Standard Flows

Last updated: 2026-05-24

This document answers the workflow question before implementation: what inputs
are needed, which flow applies to each video type, and what prompt structure is
needed at each AI step.

It is based on:

- local corpus: `prompt.txt`, `link.txt`
- Google Cloud Veo 3.1 prompting guide: https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1/
- Google Veo prompt guide: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide
- Google Flow supported features: https://support.google.com/flow/answer/16352836
- OpenAI Sora prompting guide: https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide
- TikTok Creative Codes: https://ads.tiktok.com/business/en-US/creative-codes
- community/prompt-library patterns from PromptVeo3, VeoTemplate, ClipVela,
  YouMind, and the collected Facebook/comment prompts.

## Direct Answers

### 1. Does each video type have a different flow?

Yes. Each type has a different required input set, reference role mapping,
generation path, and quality check.

Examples:

- A fashion fit-check needs character + outfit + full-body first frame.
- An unbox video needs product + package + hands/tabletop + reveal endpoint.
- A skincare TVC needs product + model + storyboard + per-shot prompts.
- A mirror selfie needs character + outfit + room/mirror + phone-camera style.

Trying to force all of these through one generic video prompt makes the system
unreliable.

### 2. Should Flowboard have one common flow for all video types?

Use one common scaffold, not one universal flow.

Common scaffold:

```text
Input -> asset roles -> recipe selection -> planning artifact -> source frame(s)
-> video prompt -> generation -> review/refine -> export
```

Specialized branch:

```text
Recipe decides which inputs are required, which prompts are needed, and which
model path should be used.
```

This matches official model guidance: Google describes prompt components and
advanced workflows such as ingredients-to-video, first/last frame, and timestamp
prompting; OpenAI's Sora guide treats each shot as a creative unit and separates
generation settings from prompt prose.

### 3. Does every step need a separate prompt?

No. Only AI-producing steps need prompts.

Use separate prompts when the step produces a different artifact:

- brief generation
- asset spec / role classification
- product or character reference image
- first frame / last frame image
- storyboard plan
- per-scene video prompt
- final video generation prompt
- refine/edit instruction

Do not create prompts for mechanical steps like selecting a node, storing a
role, or exporting a file.

## Common Flow Scaffold

| Step | Purpose | AI prompt needed? | Output |
| --- | --- | --- | --- |
| 1. Intent brief | Decide what video is being made | Yes, if user input is vague | Structured brief |
| 2. Asset intake | Classify uploaded/generated media | Yes, if roles are unknown | Asset role map |
| 3. Recipe selection | Pick video workflow | Usually yes | Recipe ID + missing inputs |
| 4. Pre-production | Make storyboard, shot list, or first-frame plan | Yes | Planning artifact |
| 5. Source asset generation | Generate/compose image refs | Yes | character/product/location/first frame |
| 6. Video prompt generation | Write model-ready prompt | Yes | video prompt |
| 7. Generate variants | Call video model | No extra LLM prompt if prompt is ready | video candidates |
| 8. Review/refine | Pick best, fix one thing | Yes for edit/refine | improved candidate |
| 9. Export/stitch | Assemble final | No, unless generating captions/VO | final asset |

## Shared Prompt Blocks

The flows below reference these blocks. They are intentionally structured so
Flowboard can later turn them into recipe templates.

### Prompt A: Intent Brief Builder

Use when the user gives a loose request.

```text
You are an AI video creative planner. Turn the user's request into a concise
production brief for a short AI video.

Return:
- video_type
- platform/aspect_ratio
- target_duration
- audience
- product_or_subject
- available_inputs
- missing_inputs
- intended_style
- output_count
- audio_mode
- safety_or_claim_constraints

User request:
[USER_REQUEST]
```

### Prompt B: Asset Role Classifier

Use when the graph has multiple upstream images.

```text
Classify each available asset by its production role. Use only these roles:
character_ref, product_ref, package_ref, background_ref, style_ref,
first_frame, last_frame, storyboard_ref, shot_panel_ref, brand_ref, audio_ref.

For each asset, return:
- asset_label
- role
- what_to_preserve
- what_can_change
- confidence: high | medium | low
- missing_metadata

Assets:
[ASSET_DESCRIPTIONS]
```

### Prompt C: Recipe Selector

Use after the brief and asset roles are known.

```text
Select the best video production recipe from this list:
fashion_fit_check, mirror_selfie, grwm, product_unbox, product_demo,
ugc_quick_review, product_beauty_macro, skincare_tvc, before_after_reveal,
soft_dance, beat_sync_dance, day_in_life, food_asmr, location_reveal,
app_walkthrough, educational_infographic_motion, cinematic_one_shot,
silent_mini_skit, storyboard_sequence, storyboard_montage.

Return:
- recipe_id
- why_this_recipe
- required_inputs_present
- missing_inputs
- recommended_generation_path: text_to_video | image_to_video |
  ingredients_to_video | first_last_frame | per_shot_sequence | edit_extend
- planning_artifacts_needed

Brief:
[BRIEF]

Asset roles:
[ASSET_ROLES]
```

### Prompt D: Product Fidelity Contract

Append to image/video prompts when product accuracy matters.

```text
Use the product reference as the source of truth. Preserve the exact product
shape, logo, label, packaging, color, material finish, scale, and visible design
details. Do not invent new text, new branding, new buttons, new labels, or a
different package shape. Only change the environment, lighting, camera angle,
and allowed interaction described in the prompt.
```

### Prompt E: Character Consistency Contract

Append when a person/creator/model should stay consistent.

```text
Preserve the same character identity across the output: same face, hairstyle,
hair color, body proportions, age range, outfit, and overall persona. Natural
micro-expressions and small pose changes are allowed, but do not change the
person's identity, wardrobe, or styling unless explicitly requested.
```

### Prompt F: First Frame Image Prompt

Use to create a strong i2v anchor.

```text
Create a photorealistic first frame for a [VIDEO_TYPE] short video.

Subject/product:
[SUBJECT_OR_PRODUCT]

Reference locks:
[CHARACTER_OR_PRODUCT_LOCKS]

Scene:
[LOCATION_AND_PROPS]

Composition:
[SHOT_SIZE], [ANGLE], [ASPECT_RATIO], main subject clearly readable.

Lighting and style:
[LIGHTING], [PALETTE], [MOOD], [CAMERA_STYLE]

The frame must be suitable as the opening frame of an AI image-to-video clip:
clear action potential, no clutter, no unreadable text, no extra limbs, no
watermark.
```

### Prompt G: One-Shot Video Prompt

Use for a single i2v clip.

```text
The uploaded image is the first frame. Generate a [DURATION] [ASPECT_RATIO]
[VIDEO_TYPE] video.

Style intent: [STYLE_INTENT]
Main subject/product: [SUBJECT_OR_PRODUCT]
Action: [ONE_CLEAR_ACTION]
Timing: [0-3s HOOK], [3-8s ACTION], [FINAL_SECONDS PAYOFF/HOLD]
Camera: [CAMERA_MOVEMENT_OR_STATIC]
Lighting/mood: [LIGHTING_AND_MOOD]
Audio: [MUSIC_OR_AMBIENT_OR_SFX], no speech unless explicitly requested.
Preserve: [IDENTITY_OR_PRODUCT_LOCKS]
Avoid: [NEGATIVE_RULES]
```

### Prompt H: Storyboard Plan Prompt

Use when creating a multi-scene ad or story.

```text
You are an AI Creative Director. Create a [PANEL_COUNT]-panel storyboard for a
short [VIDEO_TYPE] video based on the product/brief below.

Analyze:
- product/category
- audience
- core benefit
- brand tone
- visual mood
- required references
- safety/claim constraints

Storyboard arc:
Hook -> product/context intro -> use/demo -> experience/result -> beauty shot
-> CTA or final hero moment.

For each panel, output:
- panel number
- suggested duration
- scene description
- subject action
- product position
- camera angle
- background
- mood/lighting
- audio or voiceover if needed
- continuity notes

Return only the storyboard.

Brief/product info:
[BRIEF_OR_PRODUCT_INFO]
```

### Prompt I: Storyboard Panel To Video Prompt

Use when generating one video clip per panel.

```text
Convert this storyboard panel into a model-ready video prompt.

Use the provided references as visual guides. Match the panel exactly, while
preserving all consistency locks across the larger storyboard.

Return:
- scene_id
- duration
- visual prompt
- camera movement
- subject/product action
- lighting/mood
- audio/voiceover
- continuity locks
- avoid rules

Global consistency locks:
[CONSISTENCY_LOCKS]

Storyboard panel:
[PANEL]
```

### Prompt J: Timestamp Sequence Prompt

Use only when the model path supports a single prompt with timed beats.

```text
Create a [DURATION] video as a timed sequence. Keep all shots visually
consistent and preserve the referenced subject/product.

[00:00-00:02] [SHOT_1: framing, action, camera, audio]
[00:02-00:04] [SHOT_2]
[00:04-00:06] [SHOT_3]
[00:06-00:08] [SHOT_4]

Overall style: [STYLE]
Continuity locks: [LOCKS]
Avoid: [NEGATIVE_RULES]
```

### Prompt K: Refine/Edit Prompt

Use after a draft video is close.

```text
Keep the same shot, subject identity, product details, lighting, composition,
and overall timing. Change only this:
[ONE_CHANGE]

Do not change:
[LOCKED_ELEMENTS]

Fix these issues if present:
[OBSERVED_FAILURES]
```

## Standard Flow Summary Table

| Video type | Minimum inputs | Best generation path | Planning artifact | Prompt blocks |
| --- | --- | --- | --- | --- |
| Fashion fit check | character/model, outfit/product, first frame | image_to_video | first-frame plan | A/B/C/F/G/K |
| Mirror selfie | character, outfit, mirror room | image_to_video | first-frame plan | A/B/C/F/G/K |
| GRWM | character, beauty/fashion items, room | image_to_video or per_shot_sequence | shot list | A/B/C/F/G/I/K |
| Product unbox | product, package, hands/tabletop | first_last_frame or per_shot_sequence | reveal plan | A/B/C/D/F/G/I/K |
| Product demo | product, use-case setting, hand/model | image_to_video or ingredients_to_video | demo action plan | A/B/C/D/F/G/K |
| UGC quick review | creator, product, room, optional script | ingredients_to_video or image_to_video | talking/silent plan | A/B/C/D/E/F/G/K |
| Product beauty macro | product, surface/props/style | image_to_video | hero shot plan | A/B/C/D/F/G/K |
| Skincare/beauty TVC | product, model, brand tone, location | per_shot_sequence | storyboard | A/B/C/D/E/H/I/K |
| Before/after reveal | start state, end state, subject/product | first_last_frame | transition plan | A/B/C/D/E/F/G/K |
| Soft dance | character, outfit/location, music mood | image_to_video | performance beat | A/B/C/E/F/G/K |
| Beat-sync dance | character, outfit, music/tempo | image_to_video | beat map | A/B/C/E/F/G/J/K |
| Day-in-life slice | character/product, location, routine | per_shot_sequence or image_to_video | micro-story | A/B/C/D/E/H/I/K |
| Food/ASMR | food/object, macro setup, SFX | image_to_video | sensory action plan | A/B/C/F/G/K |
| Location/interior reveal | empty/finished space or location ref | first_last_frame or image_to_video | reveal plan | A/B/C/F/G/K |
| App/software walkthrough | app screens, device frame, script | per_shot_sequence | screen shot list | A/B/C/H/I/K |
| Educational/infographic motion | topic, steps/data, visual style | text_to_video or image_to_video | step board | A/B/C/H/I/J/K |
| Cinematic one-shot | character/location/object | image_to_video or text_to_video | shot brief | A/B/C/F/G/K |
| Silent mini skit | character(s), setup, prop/location | per_shot_sequence | 3-beat skit | A/B/C/E/H/I/K |
| Storyboard sequence | brief, refs, storyboard panels | per_shot_sequence | storyboard + shot list | A/B/C/H/I/K |
| Storyboard montage | composite storyboard image | image_to_video | panel order | G/K |

## Detailed Flows

### 1. Fashion Fit Check

Confidence: high. Supported by local fashion motion prompt and common i2v
short-form practice.

Inputs:

- character/model image
- outfit or garment/product reference
- optional studio/bedroom/street background
- target duration and aspect ratio

Flow:

1. Build brief with Prompt A.
2. Classify character/outfit/background with Prompt B.
3. Generate or compose full-body first frame with Prompt F.
4. Generate video with Prompt G.
5. Refine with Prompt K.

Ready video prompt template:

```text
The uploaded image is the first frame. Generate a [10s/8s] vertical fashion
fit-check video. The model stands naturally, then walks forward at a relaxed
pace, subtly opens the arms to show the silhouette, turns slightly, and finishes
with a clean full-outfit hold. Camera is stable at chest-to-full-body framing,
with gentle fashion commercial lighting and realistic fabric movement. Preserve
the same face, hairstyle, outfit, body proportions, and garment details. Avoid
exaggerated posing, shaky camera, warped hands, distorted fabric, text overlays,
or product drift.
```

### 2. Mirror Selfie

Confidence: medium-high. Common short-form format; local corpus includes
fashion/portrait and location references, but not a dedicated mirror prompt.

Inputs:

- character/model image
- outfit/product reference
- bedroom/bathroom/walk-in closet background
- phone/mirror visual cue

Flow:

1. Brief with Prompt A.
2. Classify character, outfit, and background with Prompt B.
3. Generate first frame with mirror/phone composition using Prompt F.
4. Generate one-shot video with Prompt G.
5. Refine phone/mirror/body consistency with Prompt K.

Ready video prompt template:

```text
The uploaded image is the first frame. Generate a vertical mirror-selfie outfit
short. The subject holds the phone naturally in the mirror, shifts weight from
one leg to the other, tilts the phone slightly, adjusts one outfit detail, then
holds the final pose so the full outfit remains readable. Camera style feels
like realistic handheld phone footage through a mirror, with soft room light and
natural fabric motion. Preserve the same face, hair, outfit, phone position, and
room mood. Avoid extra phones, warped reflections, duplicated hands, sudden cuts,
lip-sync, speech, subtitles, or text overlays.
```

### 3. GRWM

Confidence: medium. Common short-form format; best as multi-shot if more than
one routine step is needed.

Inputs:

- character
- beauty/fashion items
- room/vanity background
- optional product/brand constraints

Flow:

1. Brief with Prompt A.
2. Asset roles with Prompt B.
3. If one step only: generate first frame with Prompt F and video with Prompt G.
4. If several steps: create 3-5 panel routine storyboard with Prompt H.
5. Convert panels to video prompts with Prompt I.
6. Refine clips with Prompt K.

Ready storyboard prompt:

```text
Create a 5-panel GRWM storyboard for a vertical short. Keep the same creator,
room, lighting, outfit direction, and beauty/fashion items. Arc: hook with the
unfinished look, one close-up product/use step, one outfit/accessory adjustment,
one mirror check, final confident reveal. Each panel needs duration, action,
camera angle, product/prop placement, lighting, and audio cue. No exaggerated
claims, no text overlays unless requested.
```

### 4. Product Unbox

Confidence: high. Supported by community prompt-library categories and social ad
patterns: hook -> context -> reveal/payoff.

Inputs:

- exact product reference
- package/box reference or generated package
- hands/model or tabletop setup
- optional final hero frame

Flow:

1. Brief with Prompt A.
2. Product/package roles with Prompt B.
3. Apply Prompt D for product fidelity.
4. Generate first frame: closed box/product setup with Prompt F.
5. Optional: generate last frame hero reveal with Prompt F.
6. Generate first-last frame transition or per-shot sequence.
7. Refine product/logo fidelity with Prompt K.

Ready video prompt template:

```text
The uploaded image is the first frame. Generate a vertical product unboxing
short. The hands open the package slowly, lift the product into view, rotate it
just enough to show the label and material, then end on a clean product hero
hold. Camera is stable, close tabletop framing, premium soft studio light,
subtle paper/cardboard SFX, no speech. Preserve the exact product shape, logo,
label, color, packaging, and material finish. Avoid invented text, wrong logo,
warped fingers, sudden cuts, shaky camera, or unreadable branding.
```

### 5. Product Demo

Confidence: high. Supported by product prompt corpus and prompt-library product
demo categories.

Inputs:

- product reference
- use-case setting
- hand/model if needed
- one function or benefit to demonstrate

Flow:

1. Brief with Prompt A.
2. Asset roles with Prompt B.
3. Lock product with Prompt D.
4. Generate a first frame where the product can be used clearly.
5. Generate one-shot video with one concrete operation.
6. Refine if function, hands, or product details drift.

Ready video prompt template:

```text
The uploaded image is the first frame. Generate a [DURATION] product demo video.
One hand uses the product in a single clear action: [ACTION]. The product remains
centered and readable, with the key detail visible throughout. Camera is stable
medium close-up, soft commercial lighting, realistic hand motion, subtle SFX for
the product action, no speech. Preserve exact product shape, label, color,
material, and scale. Avoid extra features, incorrect packaging, distorted hands,
motion blur, text overlays, or exaggerated results.
```

### 6. UGC Quick Review

Confidence: high for the flow, medium for speech reliability. Use silent review
by default if speech/lip-sync causes failures.

Inputs:

- creator/character
- product
- room/background
- optional review angle or script

Flow:

1. Brief with Prompt A.
2. Choose audio mode: silent gesture, voiceover, or dialogue.
3. Roles with Prompt B; add Prompt D and E.
4. Generate first frame with creator holding product.
5. Generate one-shot review or per-shot review.
6. Refine speech/product drift separately.

Ready silent review prompt:

```text
The uploaded image is the first frame. Generate a vertical UGC-style quick
review without speech. The creator looks at the product, reacts with a natural
closed-mouth smile, points to one detail, brings the product closer to the
camera, then ends with a confident product hold. Handheld phone-camera feel,
soft bedroom/desk lighting, quiet room tone and light product handling SFX.
Preserve the same creator identity and exact product design. Avoid lip-sync,
spoken dialogue, subtitles, fake labels, distorted hands, or over-polished ad
lighting.
```

### 7. Product Beauty Macro

Confidence: high. Supported by product photography corpus and Veo camera/macro
guidance.

Inputs:

- product reference
- surface/props/background
- lighting/style direction

Flow:

1. Brief with Prompt A.
2. Product/background roles with Prompt B.
3. Generate product hero first frame with Prompt F and Prompt D.
4. Generate macro motion: dolly, rotation, water droplets, light sweep.
5. Refine material/logo if needed.

Ready video prompt template:

```text
The uploaded image is the first frame. Generate a premium product beauty macro
video. The camera performs a slow controlled dolly-in while soft highlights move
across the product surface. Tiny droplets/props remain realistic and still, with
only subtle sparkle and depth-of-field shift. Ambient studio tone, gentle
cinematic music, no speech. Preserve exact logo, label, product shape, color,
material finish, and prop arrangement. Avoid extra text, warped label, flicker,
oversaturation, or chaotic camera movement.
```

### 8. Skincare / Beauty TVC

Confidence: high. Directly supported by the local product-to-storyboard and
storyboard-to-video system prompts.

Inputs:

- product reference
- model/character
- location: bathroom/vanity/bright room
- brand tone
- claims to avoid

Flow:

1. Brief with Prompt A.
2. Roles with Prompt B.
3. Apply Prompt D and E.
4. Create 6-9 panel storyboard with Prompt H.
5. Generate panel/shot images or select refs.
6. Convert each panel to video prompt with Prompt I.
7. Generate per-shot clips.
8. Review continuity, then stitch/export.

Ready storyboard prompt:

```text
Create a 6-panel clean skincare commercial storyboard. Use the product reference
as the exact source of truth. Keep the same model, bathroom/vanity setting,
soft daylight, white/pastel palette, and premium clean beauty mood. Arc: visual
hook, product discovery, texture/application close-up, refreshed routine moment,
product beauty shot, final confident hero frame. Avoid medical claims, acne
cure claims, whitening claims, extreme before/after, subtitles, and extra brand
text. Each panel must include duration, action, camera angle, product position,
lighting, mood, and optional short Vietnamese voiceover.
```

### 9. Before / After Reveal

Confidence: high when first+last frame is available; medium otherwise.

Inputs:

- start state image
- end state image
- subject/product lock
- transition style

Flow:

1. Brief with Prompt A.
2. Classify start and end frames with Prompt B.
3. Generate missing frame if needed with Prompt F.
4. Use first+last frame path when supported.
5. Refine transition only with Prompt K.

Ready video prompt template:

```text
Use the first image as the opening frame and the second image as the ending
frame. Generate a smooth [DURATION] before/after reveal. The camera and subject
move naturally from the first state to the final state using [TRANSITION: hand
wipe / turn / dolly / object pass]. Preserve the same subject/product identity,
scene logic, and lighting continuity. Audio is a soft transition whoosh plus
ambient music, no speech. Avoid jump cuts, identity drift, impossible morphing,
extra text, or exaggerated claims.
```

### 10. Soft Dance

Confidence: medium-high. Common short-form style; best with simple movements.

Inputs:

- character/model
- outfit/location
- music mood

Flow:

1. Brief with Prompt A.
2. Roles with Prompt B and identity lock with Prompt E.
3. Generate first frame with clear full-body or half-body framing.
4. Generate video with one simple dance phrase.
5. Refine if body/limbs distort.

Ready video prompt template:

```text
The uploaded image is the first frame. Generate a vertical soft-dance short.
The subject performs a simple relaxed step-touch, gentle shoulder sway, small
hand movement, and natural hair/fabric bounce, then returns to a confident final
pose. Camera stays stable with slight handheld phone energy. Audio is gentle
instrumental pop/lo-fi rhythm, no lyrics, no singing, no lip-sync. Preserve the
same face, outfit, hairstyle, and body proportions. Avoid complex choreography,
extra limbs, foot sliding, sudden cuts, or exaggerated gestures.
```

### 11. Beat-Sync Dance

Confidence: medium. AI video can struggle with exact beat sync, so keep moves
simple and use a beat map.

Inputs:

- character
- outfit/location
- beat/tempo or music mood

Flow:

1. Brief with Prompt A.
2. Generate beat map with Prompt J.
3. Generate first frame with full-body readability.
4. Generate video with 2-4 simple beat actions.
5. Refine limb/foot consistency.

Ready timestamp prompt:

```text
The uploaded image is the first frame. Generate a vertical beat-sync dance
short with simple readable movement, not complex choreography.

[00:00-00:02] Subject catches the beat with a small shoulder bounce and eye
contact.
[00:02-00:04] Step-touch to the side with one clean hand gesture.
[00:04-00:06] Small turn or hip shift, outfit fabric moves naturally.
[00:06-00:08] Return to front-facing pose and hold.

Audio: upbeat instrumental rhythm, no vocals or lip-sync. Preserve identity,
outfit, and body proportions. Avoid extra limbs, foot sliding, distorted hands,
camera shake, or sudden scene cuts.
```

### 12. Day-In-Life / Lifestyle Product Placement

Confidence: medium-high. Common ad/short format; multi-shot is more reliable
than one long shot.

Inputs:

- character or product
- location/routine setting
- product use context

Flow:

1. Brief with Prompt A.
2. Roles with Prompt B.
3. Use Prompt H for 3-5 beat micro-story.
4. Convert key panels with Prompt I.
5. Generate and stitch clips.

Ready storyboard prompt:

```text
Create a 4-panel day-in-life short storyboard where [PRODUCT] appears naturally
inside [ROUTINE/LOCATION]. Keep the same character, product, lighting, color
palette, and lifestyle mood. Arc: opening routine hook, product enters the
moment, one natural use/action, final calm lifestyle hero. Each panel needs
duration, action, camera, product position, background, and audio cue. Avoid
hard selling, random scene jumps, fake text overlays, or product/logo drift.
```

### 13. Food / ASMR / Texture Video

Confidence: high for object/food macro; use synchronized SFX.

Inputs:

- food/object reference
- surface/background
- action: cut, pour, slice, stir, crack, steam, fizz

Flow:

1. Brief with Prompt A.
2. Roles with Prompt B.
3. Generate macro first frame with Prompt F.
4. Generate one clear sensory action with Prompt G.
5. Refine texture/audio sync.

Ready video prompt template:

```text
The uploaded image is the first frame. Generate a macro ASMR-style video. The
camera stays close as [FOOD_OR_OBJECT] is [ACTION] slowly and cleanly. Emphasize
realistic texture, small particles, steam/liquid movement if present, and crisp
synchronized SFX. Camera is stable macro close-up with shallow depth of field
and soft studio light. No speech, no music unless requested. Avoid messy cuts,
unrealistic physics, extra objects, flicker, distorted utensils, or text.
```

### 14. Location / Interior Reveal

Confidence: high when start/end frames are available; medium for text-only.

Inputs:

- empty room or location reference
- final styled room/location reference
- style palette

Flow:

1. Brief with Prompt A.
2. Classify start/end/background/style roles with Prompt B.
3. Use first+last frame if supported.
4. Otherwise generate one shot with slow camera reveal.
5. Refine geometry/furniture consistency.

Ready video prompt template:

```text
Use the first image as the starting room and the second image as the final room.
Generate a smooth interior transformation reveal. The camera slowly pushes in as
the space changes from [START_STATE] to [END_STATE], preserving room geometry,
window placement, wall layout, and perspective. Lighting becomes [LIGHTING],
with subtle ambient room tone and no speech. Avoid warped architecture, floating
furniture, impossible layout changes, flicker, or unreadable text.
```

### 15. App / Software Walkthrough

Confidence: medium. AI video often struggles with exact text/UI, so use real
screen captures or post-production overlays when possible.

Inputs:

- app screenshots or screen recording frames
- device frame
- feature/script

Flow:

1. Brief with Prompt A.
2. Use real UI screenshots as refs; avoid asking model to invent exact UI text.
3. Create shot list with Prompt H.
4. Generate supporting creator/device shots or motion background.
5. Add exact UI/text in editor, not generation, if precision matters.

Ready planning prompt:

```text
Create a 5-shot vertical app walkthrough plan for [APP/FEATURE]. Use real app
screens as fixed visual references; do not invent UI text. Arc: hook/problem,
open feature, show one key action, show result, final CTA. For each shot, define
screen reference, camera/device framing, hand/cursor action, caption idea,
duration, and audio cue. Keep all exact UI copy for post-production overlay.
```

### 16. Educational / Infographic Motion

Confidence: medium. Best when infographic is generated as an image first and
motion is simple.

Inputs:

- topic/data/steps
- visual style
- optional infographic image

Flow:

1. Brief with Prompt A.
2. Generate infographic/static board first.
3. Generate motion as camera moves through sections or use post-production.
4. Keep text minimal; exact text should be added after generation.

Ready prompt template:

```text
Create a clean vertical educational motion concept for [TOPIC]. Structure it as
[NUMBER] simple visual steps with large readable shapes, minimal text, icons,
and generous spacing. Camera moves slowly from the hero visual to each step in
order. Use [STYLE] colors and soft studio lighting. Audio is light ambient music
with subtle UI click SFX. Avoid dense paragraphs, tiny text, cluttered layout,
watermarks, or random extra data.
```

### 17. Cinematic One-Shot

Confidence: high. Directly matches official prompt formulas: cinematography,
subject, action, context, style/ambiance.

Inputs:

- subject/object/location or text brief
- style and mood
- one action

Flow:

1. Brief with Prompt A.
2. Select image_to_video if a source frame exists; otherwise text_to_video.
3. Use one strong camera direction and one action.
4. Refine one variable at a time.

Ready video prompt template:

```text
[SHOT_TYPE], [SUBJECT], [ONE_ACTION], in [SETTING]. Camera: [ONE_CAMERA_MOVE].
Lighting: [LIGHTING]. Style and ambiance: [STYLE/MOOD]. Audio: [AMBIENT/SFX].
Keep the shot continuous and physically plausible. Avoid sudden cuts, extra
characters, text overlays, distorted anatomy, flicker, or camera chaos.
```

### 18. Silent Mini Skit

Confidence: medium. Works best as 3 short shots rather than one overpacked shot.

Inputs:

- character(s)
- location
- prop/product
- simple problem/payoff

Flow:

1. Brief with Prompt A.
2. Use Prompt H for 3-beat story.
3. Generate each shot with Prompt I.
4. Stitch and add captions/audio externally if exact timing matters.

Ready storyboard prompt:

```text
Create a 3-shot silent mini skit storyboard. No dialogue. Use only facial
expression, body language, product/prop interaction, and camera framing. Arc:
setup/problem, attempted action, visual payoff. Keep the same character,
location, product, lighting, and style. Each shot needs duration, action,
camera, SFX/music cue, and avoid rules.
```

### 19. Storyboard Sequence / Multi-Scene Short

Confidence: high. This is directly supported by the local system prompts and
official multi-shot/timestamp guidance.

Inputs:

- brief
- character/product/location refs
- storyboard panels or generated storyboard

Flow:

1. Brief with Prompt A.
2. Asset roles with Prompt B.
3. Generate storyboard with Prompt H.
4. Convert panels to scene prompts with Prompt I.
5. Generate one clip per panel.
6. Review continuity and stitch.

Ready scene-conversion prompt:

```text
Use the storyboard panel as the visual guide for this scene. Match the numbered
panel, preserve the same character, product, wardrobe, logo, setting, lighting,
and style as the full storyboard. Convert the panel into a [DURATION] video
prompt with one clear action, one camera movement, product placement, audio cue,
and avoid rules. Do not merge multiple panels into one scene.
```

### 20. Storyboard Composite Montage

Confidence: medium. This is the current Flowboard behavior, but it should be
explicitly labeled as montage/experimental.

Inputs:

- composite storyboard image
- panel count

Flow:

1. Use existing composite storyboard as first frame/reference.
2. Generate prompt that animates through frame 1 -> N.
3. Avoid treating it as a normal one-shot short.

Ready video prompt template:

```text
Use the uploaded storyboard composite as the visual reference. Animate the
numbered panels in exact order from frame 1 to frame [N], following the intended
narrative progression. Keep the motion clear and readable, like an animated
storyboard montage. Do not reinterpret the entire grid as one single physical
scene. Avoid panel order confusion, random cuts, altered captions, or changed
character/product identity.
```

## What Flowboard Should Build First

Minimum useful implementation sequence:

1. Add recipe catalog as data, not UI first.
2. Add reference role metadata.
3. Make auto-prompt select a recipe from roles + user text.
4. Add generated prompt preview sections: brief, refs, action, camera, audio,
   avoid.
5. Add style/duration/audio controls only after the recipe router works.
6. Split Storyboard into two paths: contact-sheet montage and shot workflow.

## Notes On Certainty

- High confidence: prompt anatomy, camera/action/audio structure, first-frame
  i2v, ingredients/reference workflows, storyboard-to-scene workflows. These are
  supported by official docs and local corpus.
- Medium confidence: exact quality of dance, mirror, app walkthrough, and
  beat-sync flows. These are common short-form formats, but AI video models vary
  in body/limb/text precision.
- Low confidence: asking the model to render exact UI text, long dialogue, or
  dense typography inside generated video. Use post-production overlays instead.

