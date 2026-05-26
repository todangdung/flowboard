# Node types reference

Last updated: 2026-05-26

Cheat sheet cho node types hiện có trong Flowboard. Mỗi node là 1 ô
trên canvas; edges nối chúng đại diện cho **data dependency** — node
upstream feed vào node downstream qua các port handles trái (target) /
phải (source).

Top add-node palette chỉ giữ compact defaults: Character, Image,
Storyboard, Video, Visual asset, Prompt, Note. Product / Location /
Brand / Audio và recipe workflow shortcuts nằm trong Projects sidebar
như folder group kiểu VS Code.

## Tổng quan

| Node | Icon | Có media? | Có generate? | Vai trò chính |
|---|---|---|---|---|
| **Character** | ◎ | ✅ portrait | ✅ via builder | Anchor identity 1 nhân vật cố định |
| **Visual asset** | ◇ | ✅ asset | ✅ via prompt/upload | Anchor 1 sản phẩm / object vật lý |
| **Product** | ▤ | ✅ optional | ❌ profile node | Product/package metadata + fidelity lock |
| **Location** | ⌂ | ✅ optional | ❌ profile node | Background/place metadata + continuity lock |
| **Brand** | ◈ | ✅ optional | ❌ profile node | Brand tone, CTA, palette, claim rules |
| **Audio** | ♪ | ✅ optional | ❌ profile node | Voice/music/SFX direction and script hints |
| **Image** | ▣ | ✅ image | ✅ via Flow | Compose ảnh từ ref + prompt |
| **Storyboard** | ▦ | ✅ image composite | ✅ via Flow image | Contact sheet / visual planning grid |
| **Video** | ▶ | ✅ video | ✅ via Veo / Omni / edit | Text, first-frame, first+last, ingredients, edit |
| **Prompt** | ✦ | ❌ text only | ❌ chỉ save text | Style direction / vibe text feed |
| **Note** | ✎ | ❌ | ❌ | UI label; timeline nodes also use this type with workflow metadata |

---

## ◎ Character

**Mục đích:** một con người cụ thể mà bạn muốn xuất hiện ổn định
qua nhiều shot trong cùng campaign. Hard-anchored bởi
frontal/closed-mouth portrait để Veo i2v giữ identity không drift
giữa các clip downstream.

**Cách tạo:**
- Click ◎ trong palette → drop xuống canvas → node mới
- Click **▶ Generate** → mở dialog character builder:
  - **Gender**: Nam / Nữ
  - **Quốc gia**: VN / JP / KR / CN / TH / US / FR / ...
  - **Vibe** (preset tokens): douyin / clean / editorial / vintage / ...
  - **Extras** (free text): "tóc ngắn", "kính tròn", etc.
- Backend [`buildCharacterPrompt`](../frontend/src/components/GenerationDialog.tsx)
  ghép thành prompt locked-down (front-facing, closed-mouth, neutral)
  → dispatch qua `gen_image`
- Hoặc **upload** sẵn 1 portrait nếu đã có

**Output:** `mediaId` (image), `aiBrief` (vision describe tự chạy
sau khi gen).

**Wire downstream:** vào Image / Video / Storyboard node → Flow
nhận làm `IMAGE_INPUT_TYPE_REFERENCE` → identity bám theo.

**Khi nào dùng:** e-commerce campaign có 1 model chính qua nhiều
shot, narrative cần 1 nhân vật xuyên suốt (vlog couple, lifestyle
campaign cùng 1 người), virtual influencer setup.

---

## ◇ Visual asset

**Mục đích:** một sản phẩm / quần áo / đồ vật cần xuất hiện chính
xác trong scenes (không re-design, không re-interpret).

**Cách tạo:**
- Drag drop file ảnh lên node → upload (PNG/JPG/WebP)
- Hoặc paste URL → backend fetch + cache local
- Hoặc gen từ prompt (nếu chưa có asset thật)
- Có nút **Refine** trong node — chỉnh sửa asset bằng
  `edit_image` (BASE_IMAGE preserve, ref optional), không mất bản gốc

**Output:** `mediaId`, `aiBrief`, `aspectRatio`.

**Wire downstream:** vào Image / Video node → Flow nhận làm
`IMAGE_INPUT_TYPE_REFERENCE` → ảnh kết quả có chính xác asset đó
(áo, túi, sản phẩm).

**Khi nào dùng:** quần áo cụ thể có sẵn (catalog item), sản phẩm
e-commerce (chai, hộp, packaging), logo, đồ vật cần độ chính xác cao.

**Khác Character ở chỗ:** Character anchor 1 người, Visual asset
anchor 1 vật. Cả 2 đều là ref nhưng Flow phân biệt qua structured
prompt hint khi auto-prompt synth chạy.

---

## ▤ Product

**Mục đích:** product/package profile dùng lại cho ads. Node này giữ
metadata rõ hơn Visual asset: category, product details, material,
packaging, exact fields to preserve, claims to avoid.

**Cách tạo:** mở Projects sidebar → Node library → Domain nodes →
Product. Có thể save output tốt thành reference kind `product` /
`package`; khi kéo từ References library ra canvas, profile được
restore vào Product node.

**Wire downstream:** vào Image / Video / Storyboard / recipe workflow
với role `product_ref` hoặc `package_ref`. Prompt synth thêm product
fidelity contract: giữ shape, logo/label area, color, material, scale;
không invent label/text/features.

---

## ⌂ Location

**Mục đích:** background/place anchor. Dùng khi setting phải ổn định:
cafe, bathroom, studio, street, kitchen, tabletop, store.

**Profile fields:** place type, time of day, lighting, palette, props,
usable camera zones, notes.

**Wire downstream:** role `background_ref`. Prompt synth dùng node này
làm scene/location context, không cho nó cạnh tranh với product hoặc
character identity.

---

## ◈ Brand

**Mục đích:** brand kit / campaign brief. Giữ tone, CTA, palette,
tagline, legal/claim constraints, style direction.

**Wire downstream:** thường role `style_ref`, đôi khi product/logo media
đi kèm role `product_ref`. Recipe `brand_bumper`, `lifestyle_ad`,
`product_demo` đọc Brand để chọn tone và avoid rules.

---

## ♪ Audio

**Mục đích:** voiceover/music/SFX direction. Không phải timeline audio
editor đầy đủ; hiện là prompt/profile guidance cho video generation.

**Profile fields:** speech allowed/forbidden, language, voiceover text,
music mood, SFX layer, risk notes.

**Wire downstream:** role `audio_ref`. Video prompt nhận audio mode /
audio direction; recipe `audio_led` dùng nó làm required node.

---

## ▣ Image

**Mục đích:** node tổng hợp — gen 1 ảnh mới từ N upstream refs +
prompt. Đây là **node chính** của pipeline; mọi ref đều đổ vào đây
trước khi đi tiếp xuống Video.

**Cách tạo:**
- Drop Image node → wire upstream refs (Character / Visual asset /
  Image khác / Storyboard / Prompt)
- Click ▶ Generate:
  - **Aspect ratio**: 1:1 / 9:16 / 16:9 (auto-default từ upstream
    aspect; mismatched → fallback 9:16)
  - **Variants**: 1–4 (mỗi variant 1 prompt riêng, pose-distinct)
  - **Prompt**: type tay hoặc bỏ trống → auto-synth từ upstream
  - **Image model**: Banana Pro (GEM_PIX_2, premium) / Banana 2
    (NARWHAL, faster)

**Output:** `mediaId` (active variant), `mediaIds[]` (full N
variants), `aspectRatio`, `aiBrief` (auto-vision describe sau gen).

**Wire downstream:** vào Image khác (compose chain), Video (i2v
source), Storyboard (làm tile), v.v. — output là first-class image
ref cho mọi downstream.

**Per-variant pinning:** click thumbnail của variant nào → set thành
`mediaId` active → downstream ref-edge dùng variant đó (per-edge
`sourceVariantIdx` pin).

---

## ▦ Storyboard

**Mục đích:** generate **N tiles của 1 câu chuyện trong cùng 1 ảnh
composite** (2 rows × 2 cols = 4 tiles, hoặc 2×3, 2×4). Mỗi tile là
1 beat của story, đánh số, có caption phía dưới.

**Cách tạo:**
- Drop Storyboard node → có thể wire ref (Character / Visual asset)
- Click ▶ Generate:
  - Type topic ngắn ("unbox → try-on → đi café")
  - Pick grid: 2x2 / 2x3 / 2x4
  - Aspect ratio
- Backend [`buildStoryboardPrompt`](../frontend/src/lib/storyboardPrompt.ts)
  wrap topic vào template locked (grid layout, numbering, captions)
  → dispatch qua `gen_image` (1 composite image, không phải N images
  riêng lẻ)

**Output:** 1 `mediaId` composite (N tiles trong 1 ảnh).

**Wire downstream:** vào Video node → motion prompt auto-locked thành
"animate panels in order from frame 1 to frame N" — Flow Veo i2v sẽ
animate qua từng tile theo thứ tự.

**Production path mới:** recipe `storyboard_sequence` không phụ thuộc
vào việc animate composite grid. Nó tạo shot frame nodes, shot clip
nodes, và timeline note node (`workflowKind: "timeline"`). Timeline
generate frames/clips theo shot, review, chọn active clip, rồi export.

**Khi nào dùng:** narrative arc nhanh (4–8 beat), shot list cho
e-commerce sequence (refer/try-on/wear), preview before committing
production resources.

---

## ▶ Video

**Mục đích:** generate video từ prompt / refs / source clip.

**Source modes:**
- **Text-to-video**: không cần media source.
- **First frame**: dùng `first_frame` / source image làm opening frame.
- **First+last**: dùng `first_frame` + `last_frame` cho transition /
  before-after / reveal.
- **Ingredients**: Omni-style multi-reference conditioning; refs không
  nhất thiết là frame 0.
- **Edit**: refine/edit từ video media id đã render.

**2 family models:**

### Veo i2v (default)
- **Input:** 1 ảnh source (`start_media_id`) hoặc N (multi-source
  batch — gen N video từ N variant của upstream Image)
- **Camera:** Static (locked-off, e-commerce default) hoặc Dynamic
  (synth pick dolly/pan)
- **Quality:** Fast / Lite / Quality / Lite Low Priority (free)
- **Duration:** 4/6/8s persisted for planning/export. Flow's current
  Veo web endpoints reject/ignore explicit duration for some paths, so
  duration is not blindly sent when Flow does not accept it.
- **Output:** 1 video MP4 per source

### Omni Flash (r2v)
- **Input:** N reference images (không phải start frame — references
  conditioned)
- **Duration:** 4s / 6s / 8s / 10s (variable, credit cost scaled)
- **Output:** 1 video MP4

**Cách tạo:**
- Drop Video node → wire upstream Image
- Pick model family ở Generation dialog
- Generate
- Or create workflow from Projects sidebar → Video workflows.

**Auto-prompt synth** (motion-aware): đọc scene của source image →
chọn motion vocab phù hợp (studio → editorial pose-shift; street →
walk + glance; café → sip + lean; outdoor → hair flutter).

**Review/export loop:** Result viewer hỗ trợ mark best / redo / skip,
note-based refine, follow-up clone, save as reference, and timeline
stale/export history updates.

---

## ✦ Prompt

**Mục đích:** chứa **text-only seed** (không có media). Truyền
style / vibe / direction text xuống downstream image/video nodes
qua auto-prompt synth.

**Cách tạo:**
- Drop Prompt node
- Double-click vào body → mở textarea → type
- Click ngoài hoặc Ctrl+Enter để save

**Output:** chỉ `prompt` field (string), không có media.

**Wire downstream:** vào Image / Video → auto-prompt synth đọc text
này làm style context khi compose final prompt:

```
[Prompt "cinematic warm tone, magazine editorial mood"] ─┐
                                                         ├─→ [Image]
[Character #model] ──────────────────────────────────────┘
```

Image's auto-prompt → text từ Prompt được splice vào → output bám
theo vibe đó.

**Khi nào dùng:** 1 vibe nhất quán cho nhiều downstream nodes mà
không phải type lại mỗi lần. Mood/style direction cần preserve. So
sánh: tạo 1 Prompt "vlog cuộc sống indoor, soft natural light" → wire
vào 5 Image node → cả 5 cùng vibe.

**Khác với typing trực tiếp vào Image node:** Prompt node là
**reusable** (wire vào N downstream); typing vào Image chỉ ảnh hưởng
node đó.

---

## ✎ Note

**Mục đích:** label / TODO / annotation cho canvas. **KHÔNG dispatch
gì cả.** Pure UI.

**Cách tạo:**
- Drop Note node → double-click body → type text → click ngoài save

**Output:** chỉ `prompt` field (lưu text), nhưng backend bỏ qua
hoàn toàn — không feed downstream, không trigger gen.

**Wire downstream:** technically có thể nối, nhưng **vô tác dụng** —
auto-prompt synth ignore Note node trong upstream walk.

**Khi nào dùng:**
- Section markers ("Layer 1 — Refs", "Layer 2 — Composition")
- TODO list trên canvas ("rerun shot #3 tuần sau", "check legal")
- Doc giải thích flow phức tạp cho người khác xem
- Ý tưởng draft chưa muốn implement

**Khác với Prompt node:** Note **không** affect generation; Prompt
**có** affect (qua auto-prompt synth).

---

## ✨ ChatGPT (legacy experiment — Plus only)

**Mục đích:** bridge ra chatgpt.com (Plus account) để gen text + ảnh
qua ChatGPT thay vì Flow.

**Status hiện tại:**
- Code path đã đầy đủ (`extension/injected_chatgpt.js`,
  `_handle_gen_chatgpt` ở worker, ChatGPT body ở NodeCard)
- Hoạt động trên **ChatGPT Plus** — bypass Turnstile native
- **KHÔNG hoạt động trên free tier** — Cloudflare Turnstile yêu
  cầu user-interaction widget, không bypass được từ extension
- Toàn bộ code lưu ở nhánh `chatgpt-experiment` trên fork (đã reset
  ra khỏi main vì chỉ dùng được trên Plus)

**Khi nào dùng:** không có trong branch hiện tại. Nếu cần, xem branch
`chatgpt-experiment`.

---

## Sync points để thêm node type mới

Khi muốn thêm node type mới (vd `gemini`, `pollinations`), phải sync
các chỗ dưới — quên chỗ nào là 422 silent error hoặc default render trắng:

| File | Thay đổi |
|---|---|
| `agent/flowboard/routes/nodes.py:13-24` | Add to `NodeType` Literal |
| `agent/flowboard/worker/processor.py:_DEFAULT_HANDLERS` | Register `_handle_xxx` if dispatching |
| `frontend/src/api/client.ts:113` | Add to `NodeType` union |
| `frontend/src/canvas/Board.tsx:23` | Add to `nodeTypes` ReactFlow registry (**đã sync bug 1 lần**) |
| `frontend/src/canvas/AddNodePalette.tsx` hoặc `frontend/src/components/ProjectNodeLibrary.tsx` | Add entry vào top palette hoặc Projects sidebar node library |
| `frontend/src/canvas/NodeCard.tsx:13` (ICON), `1456-1472` (switch), `~1483` (isGenerable) | 3 chỗ |
| `frontend/src/store/board.ts:137` (TYPE_TITLE), import | 2 chỗ |
| `frontend/src/store/generation.ts:147` | Add new `kind` branch nếu cần dispatch riêng |
| `frontend/e2e/project-node-library.spec.ts` | Nếu thêm vào sidebar library, update guardrail |

## Edge / connection semantics

Mỗi edge từ upstream → downstream là 1 **data dependency**:
- Image/Character/Visual_asset → ref input (mediaId thành
  `IMAGE_INPUT_TYPE_REFERENCE` vào Flow)
- Product/Location/Brand/Audio → role/profile context; nếu có mediaId
  thì cũng có thể làm ref input
- Prompt → text feed (text vào auto-prompt synth)
- Note → ignored

**Ref roles:** `first_frame`, `last_frame`, `character_ref`,
`product_ref`, `package_ref`, `background_ref`, `style_ref`,
`storyboard_ref`, `storyboard_panel`, `audio_ref`, `ingredient`.

**Per-edge variant pin (`sourceVariantIdx`):** upstream có 4 variants
→ edge nhớ user chọn variant nào → downstream dùng đúng variant đó
khi gen. Click variant tile trên upstream để pin.

## Reference / library

Mọi mediaId từ Character / Visual asset / Product / Location / Brand /
Audio / Image / Storyboard / Video có thể được lưu vào **References
library** (sidebar phải). Reference rows lưu `profile` JSON cho
product/location/brand/audio; drag/click restore lại đúng kind/profile
thay vì luôn thành generic visual_asset.
