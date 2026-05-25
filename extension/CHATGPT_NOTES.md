# ChatGPT Node — Audit & Notes

Baseline audit produced during M0 of the ChatGPT-web-automation initiative.
Living document — update whenever ChatGPT's surface changes.

## M0 Baseline (2026-05-24)

### Test status

| Suite | Result |
|---|---|
| `agent/tests/test_processor_chatgpt.py` | 8 / 8 pass |
| `extension/tests/parser.test.js` | 6 / 6 pass |

### Architecture currently in place

```
Pipeline executor
  → request row {type: "gen_chatgpt", params: {prompt, model?}}
Worker processor (_handle_gen_chatgpt)
  → flow_client.chatgpt_request(prompt, model)
WebSocket (:9223) → extension background
  → handleChatGPTRequest → finds/spawns chatgpt.com tab
chrome.tabs.sendMessage CHATGPT_GEN → content_chatgpt.js (ISOLATED)
  → CustomEvent FLOWBOARD_CHATGPT_GEN → injected_chatgpt.js (MAIN)
  → POST /backend-api/sentinel/chat-requirements
  → SHA3-512 proof-of-work (mirror of gpt4free generate_proof_token)
  → POST /backend-api/conversation (SSE)
  → parse stream → {text, asset_pointers, conversation_id}
  → for each pointer: GET /backend-api/conversation/{cid}/attachment/{fid}/download
  → fetch CDN URL → ArrayBuffer → base64
  → CustomEvent FLOWBOARD_CHATGPT_RESULT
Bubble back: content_chatgpt.js → background → HTTP callback :8101/api/ext/callback
  → flow_client resolves pending future
  → processor decodes b64, ingests via media_service.ingest_inline_bytes
  → returns {text, asset_pointers, conversation_id, media_ids, image_errors}
```

### What works today

- Prompt-only generation against `/backend-api/conversation`
- SHA3-512 proof-of-work for free-tier sentinel
- Access-token bootstrap via `window.__remixContext` / `__NEXT_DATA__` / `/api/auth/session`
- Tab management: auto-spawn, revive discarded, hard cap on candidates
- HTTP-callback channel (callback secret) — survives WS drops
- Image OUTPUT (asset pointers → CDN download → base64 → inline ingest)
- Per-image failure tolerance (CDN_403, expired URL) without dropping the batch

### What is missing — and what M1+ adds

| Gap | Where | M1 fix |
|---|---|---|
| **Image INPUT** (upload an image with the prompt) | `flow_client.chatgpt_request` only accepts `prompt + model`; `injected_chatgpt.buildRequestBody` only emits a `text` content type | Extend signature → `image_b64`, `image_mime`. New `uploadImageAsAttachment(blob)` helper hits `/backend-api/files` 3-step flow. Switch body to `multimodal_text` parts + `attachments` metadata. |
| Upstream image refs ignored by pipeline executor | `pipeline_executor.py` resolves upstream `mediaId` for image/video nodes but not for `chatgpt` type | Add ChatGPT branch to upstream resolution: pick first upstream `mediaId`, load bytes via `media_service`, pass as `params.image_media_id`. |
| `ARKOSE_REQUIRED` and `TURNSTILE_REQUIRED` are dead ends | `injected_chatgpt.js::runGeneration` throws — caller has nowhere to go | M2 adds DOM-automation fallback (`injected_chatgpt_dom.js`). M2.5 adds optional CloakBrowser launcher to bypass Turnstile entirely. |
| No retry on `RATE_LIMITED` | `background.js::handleChatGPTRequest` returns first error verbatim | M3 adds exponential backoff (5s → 15s → 45s, max 3 tries) and queue (1-at-a-time per tab + 3s + jitter gap). |
| No keepalive against ChatGPT session | Token rotates silently; session can lapse | M3 schedules a `/backend-api/me` ping every 5 min while bridge is connected. |
| Frontend has no image-input slot on the chatgpt node | `NodeCard.tsx` renders a generic card | M4 adds an input slot + error surface + DALL-E quota hint. |

### Failure modes (observed in code)

These are the strings the extension surfaces today. Treat them as the
contract `_handle_gen_chatgpt` callers may receive.

| Error code | Meaning | Recovery |
|---|---|---|
| `MISSING_PROMPT` | Prompt blank | User must fill the node |
| `NO_ACCESS_TOKEN[…]` | Window context + `/api/auth/session` + `/backend-api/auth/session` all miss | User must open chatgpt.com and log in |
| `ARKOSE_REQUIRED` | Free-tier Funcaptcha gate | M2: fall back to DOM mode. If DOM also fails, surface `needs_human` to UI |
| `TURNSTILE_REQUIRED` | Cloudflare widget required | M2.5: CloakBrowser auto-resolves |
| `PoW_FAILED` (server-side conversation 4xx after fallback) | Difficulty too high | Retry; if persistent, document and patch the iteration cap |
| `RATE_LIMITED` (HTTP 429) | Free-tier message cap hit | M3: exponential backoff; surface `retry_after` to UI |
| `CONVERSATION_HTTP_4xx/5xx` | Generic SSE failure | Bubble up; logs |
| `CHAT_REQ_<status>` | Sentinel handshake failed | Retry once on 5xx; surface verbatim on 4xx |
| `ATTACHMENT_META_<status>` / `CDN_<status>` / `NO_DOWNLOAD_URL` / `INVALID_ASSET_POINTER` | Image-out download failed | Tolerated per-image; bubbled in `image_errors` |
| `CONTENT_TIMEOUT` | 120 s cap in `content_chatgpt.js` | Increase only with caution — worker has 150 s outer |
| `CHATGPT_TAB_OPENING` / `NO_LIVE_CHATGPT_TAB` | Tab spawn race / all candidates dead | M3: retry once after 5 s; M2.5 Cloak skips this entirely |

## Selectors reference (verify before each release)

Tab structure on chatgpt.com — used by M2 DOM mode. Audit weekly because
OpenAI rewrites these regularly.

| Purpose | Selector | Notes |
|---|---|---|
| Composer (contenteditable) | `#prompt-textarea` | NOT a `<textarea>` — use `execCommand('insertText', ...)` or InputEvent. |
| Send button | `[data-testid="send-button"]` | Disabled until composer has content. |
| Stop button (streaming indicator) | `[data-testid="stop-button"]` | Present iff stream in progress. Disappearance = stream complete. |
| Assistant message | `[data-message-author-role="assistant"]` | Take last child for the most recent response. |
| Attachment thumbnail | `[data-testid="attachment-thumbnail"]` | Appears ~300 ms after paste. |
| Image in assistant message | `img[src*="oaiusercontent"], img[src*="files."]` | Use `credentials: 'include'` to fetch. |
| New chat link | `a[href="/"]` in sidebar | Used by `startNewChatDOM`. |

## ChatGPT internal endpoints we touch

| Endpoint | Direction | Notes |
|---|---|---|
| `/backend-api/sentinel/chat-requirements` POST | M1 | Returns `{token, proofofwork:{seed,difficulty}, arkose:{required}, turnstile:{required}}` |
| `/backend-api/conversation` POST SSE | M1 | Streams `data: ` lines; ends with `data: [DONE]` |
| `/backend-api/files` POST | **NEW in M1** | Body: `{file_name, file_size, use_case:"multimodal"}` → `{upload_url, file_id}` |
| `<upload_url>` PUT | **NEW in M1** | Raw bytes; signed Azure Blob URL |
| `/backend-api/files/{file_id}/uploaded` POST | **NEW in M1** | Confirms upload. Body: `{}` |
| `/backend-api/conversation/{cid}/attachment/{fid}/download` GET | M1 | `{download_url}` |
| `/api/auth/session` GET / `/backend-api/auth/session` GET | M1 | Fallback access-token bootstrap |
| `/backend-api/me` GET | **NEW in M3** | Keepalive ping every 5 min |

## DALL-E free-tier expectations

- 2-3 image generations per UTC day on free accounts
- E2E test plan must avoid burning the quota — keep image-out tests behind a `FLOWBOARD_E2E_DALLE=1` env flag, run manually
- After quota exhausted, ChatGPT replies with an explanatory text (no image), the conversation still returns 200, our `images[]` array is empty. UI must show "DALL-E quota exhausted (free tier)" cleanly rather than treating it as a failure

## Cloak Mode (M2.5)

Optional. Off by default. Activated by `FLOWBOARD_CHATGPT_USE_CLOAK=1`.

- Spawns a persistent CloakBrowser Chromium with our `extension/` loaded
- Profile stored at `~/.flowboard/chatgpt_profile/`
- User logs in once via the spawned window — subsequent restarts reuse the profile
- Bypasses Cloudflare Turnstile + reCAPTCHA v3 automatically per CloakBrowser docs
- Does NOT bypass Arkose Funcaptcha — verify in practice; if it appears, fall back to M2 DOM mode and surface `needs_human` if both fail
- Resource cost: ~200 MB extra disk for the binary, ~250 MB resident RAM while running

## Implementation checklist (high-level)

- [x] M1.a — `injected_chatgpt.js`: add `uploadImageAsAttachment` + multimodal body shape
- [x] M1.b — `content_chatgpt.js` + `background.js`: forward `image_b64` / `image_mime`
- [x] M1.c — `flow_client.chatgpt_request`: new optional args
- [x] M1.d — `processor._handle_gen_chatgpt`: load upstream image, b64 encode, pass through
- [x] M1.e — `pipeline_executor`: collect first upstream `mediaId` for `chatgpt` nodes
- [x] M1.f — Unit tests: multimodal fixture; processor with `image_media_id`
- [x] M2.a — `injected_chatgpt_dom.js`: paste / send / wait / extract
- [x] M2.b — Fallback ladder in `runGenerationWithImages`
- [ ] M2.5.a — `cloak_launcher.py` + optional dep
- [ ] M2.5.b — Bootstrap on agent startup when env flag set
- [ ] M3.a — Queue + retry + keepalive
- [ ] M4.a — Frontend node: image input slot, error surfaces, quota hint
- [ ] M5 — Manual E2E smoke with the four input/output combinations

## M1 — Done (2026-05-24)

### Files changed

| File | Change |
|---|---|
| `extension/manifest.json` | Bump version 0.0.5 → 0.0.6 |
| `extension/injected_chatgpt.js` | Added `uploadImageAsAttachment`, `readImageDims`, `base64ToBlob`, multimodal body in `buildRequestBody`, image kwargs through `runGeneration` + `runGenerationWithImages` + window event handler |
| `extension/content_chatgpt.js` | Forward `image_b64`, `image_mime`, `image_name` through CustomEvent |
| `extension/background.js` | Forward image fields through `handleChatGPTRequest` → `sendChatGPTToTab`; pass `images` array through to agent |
| `extension/tests/fixtures/chatgpt_sse_multimodal_echo.txt` | New fixture |
| `extension/tests/parser.test.js` | New `multimodal echo` test case |
| `agent/flowboard/services/flow_client.py` | `chatgpt_request` accepts `image_b64`, `image_mime`, `image_name` kwargs |
| `agent/flowboard/worker/processor.py` | `_handle_gen_chatgpt` resolves `image_media_id` → cached_path → fetch_and_cache fallback → b64; new failure modes `invalid_image_media_id`, `upstream_image_missing`, `upstream_image_read_failed`, `upstream_image_empty` |
| `agent/flowboard/services/pipeline_executor.py` | `chatgpt` added to `_VALID_NODE_TYPES`; new branch dispatches `gen_chatgpt` with optional `image_media_id` from first upstream image/character/visual_asset/Storyboard node; ChatGPT node skips Flow `project_id` gate; result patch adds `text`, `conversationId` |
| `agent/tests/test_processor_chatgpt.py` | 4 new tests covering cached-path, fetch-and-cache fallback, invalid media_id, missing upstream image |

### Test results

- agent: 401 passed (12 in `test_processor_chatgpt.py`)
- extension parser: 7 passed
- ruff: clean on changed files

### What still cannot work without M2 / M2.5

- `ARKOSE_REQUIRED` → dead-end (need DOM fallback or Cloak)
- `TURNSTILE_REQUIRED` → dead-end (need Cloak)
- 429 → no retry (M3)
- No frontend slot for piping an upstream image (M4) — pipeline path works, single-node manual dispatch still text-only

## M2 — Done (2026-05-24)

### Files changed

| File | Change |
|---|---|
| `extension/manifest.json` | Bump 0.0.6 → 0.0.7; register `injected_chatgpt_dom.js` in `web_accessible_resources` |
| `extension/injected_chatgpt_dom.js` | **NEW** — DOM-mode helpers (`startNewChatDOM`, `attachImageDOM`, `typePromptDOM`, `clickSendDOM`, `waitForIdleDOM`, `extractResponseDOM`, `runGenerationDOM`). Exposed on `window.__FLOWBOARD_CHATGPT_DOM__` for fallback ladder + smoke harness |
| `extension/content_chatgpt.js` | Inject `injected_chatgpt_dom.js` before `injected_chatgpt.js` so the fallback symbol exists at first request |
| `extension/injected_chatgpt.js` | New fallback ladder in `runGenerationWithImages`: HTTP-direct first, then DOM on `TURNSTILE_REQUIRED` / `ARKOSE_REQUIRED` / `NO_ACCESS_TOKEN` / `CONVERSATION_HTTP_403` / `CONVERSATION_HTTP_429` / `CHAT_REQ_4xx` / `PoW_FAILED`. Result envelope now carries `mode` + `http_fallback_reason` |
| `extension/background.js` | Pass `mode` + `http_fallback_reason` through to agent |
| `agent/flowboard/worker/processor.py` | Extract `mode` + `http_fallback_reason` from extension envelope, surface on result for the activity log |

### Fallback ladder triggers

| HTTP error | DOM fallback? |
|---|---|
| `TURNSTILE_REQUIRED` | Yes |
| `ARKOSE_REQUIRED` | Yes |
| `NO_ACCESS_TOKEN[…]` | Yes (DOM uses cookie session, no Bearer needed) |
| `CONVERSATION_HTTP_403` | Yes |
| `CONVERSATION_HTTP_429` | Yes |
| `CHAT_REQ_403` / `CHAT_REQ_429` | Yes |
| `PoW_FAILED…` | Yes |
| `RATE_LIMITED` (HTTP 429 with retry_after) | **No** — surface to UI verbatim, M3 handles backoff |
| `CONVERSATION_HTTP_5xx` | **No** — transient, retry HTTP later |
| `FILE_REGISTER_…` / `FILE_PUT_…` / `FILE_CONFIRM_…` | **No** — image upload failures are separate from gating; DOM mode uses a different upload path |

## DOM smoke harness

Use this snippet in DevTools on `chatgpt.com` after reloading the extension.
Verifies the DOM path in isolation without touching the agent.

```javascript
// Text-only via DOM mode — should succeed even when HTTP-direct sees TURNSTILE_REQUIRED.
const dom = window.__FLOWBOARD_CHATGPT_DOM__;
console.log('DOM exposed:', !!dom);
const out = await dom.runGenerationDOM('Hello, reply with the word "OK".');
console.log('TEXT:', out.text);
console.log('CONVERSATION:', out.conversation_id);
console.log('IMAGES:', out.images.length);
```

```javascript
// Image-input via DOM mode — paste a small image into the composer, ask for a description.
const blob = await (await fetch('https://placebear.com/300/200')).blob();
const out = await window.__FLOWBOARD_CHATGPT_DOM__.runGenerationDOM(
  'In one sentence describe this image.',
  blob,
  'bear.png',
);
console.log('TEXT:', out.text);
```

```javascript
// Full agent-side flow — drives the event listener so the fallback ladder fires.
// Use this once DOM mode is verified above; reproduces what the agent emits.
window.dispatchEvent(new CustomEvent('FLOWBOARD_CHATGPT_GEN', {
  detail: {
    requestId: 'smoke-' + Date.now(),
    prompt: 'Reply with the word "OK".',
  },
}));
window.addEventListener('FLOWBOARD_CHATGPT_RESULT', (e) => {
  console.log('RESULT', e.detail);
}, { once: true });
```

Expected result shape:

```json
{
  "requestId": "smoke-…",
  "text": "OK",
  "asset_pointers": [],
  "images": [],
  "conversation_id": "…",
  "mode": "dom",
  "http_fallback_reason": "TURNSTILE_REQUIRED"
}
```

If `mode === "dom"` and `http_fallback_reason === "TURNSTILE_REQUIRED"`, the
fallback ladder did its job.

---

## DOM Automation Debug Guide (2026-05-25)

Post-mortem từ quá trình fix 3 lỗi liên tiếp trên `injected_chatgpt_dom.js`.
Mục đích: lần sau ChatGPT đổi UI, debug nhanh hơn.

### Nguồn tham khảo đáng tin cậy

| Repo | Dùng để làm gì |
|---|---|
| `tmp/chatgpt.js` (KudoAI/chatgpt.js) | Selectors chuẩn, `send()` pattern, `isIdle()` structure |
| `extension/CHATGPT_NOTES.md` § Selectors reference | Selectors đã verify cho Flowboard — đọc đây trước |

**Quy tắc**: khi selector bị nghi ngờ, đọc `tmp/chatgpt.js/src/chatgpt.js` object `selectors` (line ~33) trước khi đoán. KudoAI maintain repo này actively.

**Giới hạn của KudoAI**: `isIdle()` chờ `<pre>` trước khi check stop-button → broken cho text-only response ("OK"). Không copy `isIdle()` cho completion detection của chúng ta.

---

### Bug 1: `DOM_NO_NEW_MESSAGE` (v0.0.10)

**Triệu chứng**: `waitForIdleDOM` timeout sau 10s dù ChatGPT đã hiện "OK" trên màn hình.

**Root cause**: Selector `asstMsg` trong code dùng `div[data-message-author-role=assistant]` nhưng `CHATGPT_NOTES.md` § Selectors reference đã ghi đúng là `[data-message-author-role=assistant]` (không có `div`). Code bị drift so với doc.

**Cách phát hiện**: So sánh selector trong code với `CHATGPT_NOTES.md` và `tmp/chatgpt.js/src/chatgpt.js` line 58.

**Fix**: Bỏ tag `div`. Thêm combined condition `stopBtn || count > beforeCount` để handle instant response dưới 200ms poll interval.

```js
// Sai
asstMsg: 'div[data-message-author-role=assistant]'
// Đúng
asstMsg: '[data-message-author-role=assistant]'
```

---

### Bug 2: `DOM_STREAM_TIMEOUT` (v0.0.11)

**Triệu chứng**: stability loop chạy đủ 120s rồi throw, dù response đã xong.

**Root cause**: `innerText` của toàn bộ container `[data-message-author-role=assistant]` thay đổi liên tục sau khi stream xong — ChatGPT mount action buttons (copy, thumbs, share) vào trong container, làm `innerText` reset `stableSince` mãi mãi.

**Cách phát hiện**:
```js
// Chạy trong DevTools SAU khi ChatGPT trả lời xong
const last = document.querySelectorAll('[data-message-author-role=assistant]');
setInterval(() => console.log(last[last.length-1]?.innerText?.length), 200);
// Nếu length thay đổi liên tục → container có dynamic children
```

**Fix**:
1. Tách `waitForIdleDOM` thành 3 phase: start → stop-button gone → stability
2. Phase 3 dùng `stableMs * 3` deadline rồi `return true` (không throw) vì stream đã xong
3. Đọc text từ inner prose element thay vì toàn container:

```js
const proseEl = last?.querySelector('.markdown, .prose, [class*="markdown"], [class*="prose"]') || last;
```

---

### Bug 3: `beforeCount` stale — navigation race (v0.0.12)

**Triệu chứng**: Lần test thứ 2 trở đi bị `DOM_NO_NEW_MESSAGE` dù selector đúng. Lần đầu trên tab mới thì OK.

**Root cause**: `startNewChatDOM()` click new chat link rồi `waitFor(composer)` — nhưng `#prompt-textarea` tồn tại cả ở trang cũ lẫn trang mới. Hàm return ngay với composer của trang cũ (conversation cũ). `beforeCount` snapshot N messages cũ. Sau khi navigate, response mới = 1 message, `1 > N` = false → timeout.

**Timeline lỗi**:
```
[old chat: 3 assistant msgs] → click new chat
startNewChatDOM() → waitFor(#prompt-textarea) → RETURN (vẫn còn trang cũ!)
beforeCount = 3
navigate → old msgs clear → count = 0
new response → count = 1
waitFor(1 > 3) → TIMEOUT → DOM_NO_NEW_MESSAGE
```

**Fix**: Trong `startNewChatDOM`, wait `location.pathname === '/'` trước khi return. Trong `runGenerationDOM`, wait `asstMsg.length === 0` trước khi snapshot `beforeCount`.

```js
// startNewChatDOM
await waitFor(() => location.pathname === '/', { timeout: 3000 });

// runGenerationDOM  
await waitFor(() => document.querySelectorAll(SEL.asstMsg).length === 0, { timeout: 2000 });
const beforeCount = document.querySelectorAll(SEL.asstMsg).length;
```

---

### Checklist debug DOM mode

Khi DOM mode fail, chạy theo thứ tự này trong DevTools:

```js
// 1. Extension loaded?
console.log('DOM helper:', !!window.__FLOWBOARD_CHATGPT_DOM__);
console.log('loaded at:', window.__FLOWBOARD_CHATGPT_DOM__?._loadedAt);

// 2. Selectors hiện tại có match không?
console.log('composer:', !!document.querySelector('#prompt-textarea'));
console.log('sendBtn:', !!document.querySelector('button[data-testid=send-button]'));
console.log('stopBtn:', !!document.querySelector('button[data-testid=stop-button]'));
console.log('asstMsg:', document.querySelectorAll('[data-message-author-role=assistant]').length);
console.log('url:', location.pathname);

// 3. Sau khi ChatGPT trả lời, inspect container text stability:
const msgs = document.querySelectorAll('[data-message-author-role=assistant]');
const last = msgs[msgs.length - 1];
console.log('tag:', last?.tagName);
console.log('innerText snippet:', last?.innerText?.substring(0, 100));
console.log('children count:', last?.children?.length);

// 4. Smoke test đơn giản nhất:
const out = await window.__FLOWBOARD_CHATGPT_DOM__.runGenerationDOM('Reply with the word "OK".');
console.log('TEXT:', out.text, '| MODE:', out.mode);
```

**Nếu selector không match**: so với `tmp/chatgpt.js/src/chatgpt.js` line 33-67, update `SEL` trong `injected_chatgpt_dom.js`.

**Nếu `innerText` length thay đổi sau stream**: ChatGPT thêm UI mới vào container. Tìm class prose/markdown chính xác hơn để dùng làm text source.

**Nếu `location.pathname` không đổi về `/`**: ChatGPT thay đổi routing. Update `startNewChatDOM` wait condition.
