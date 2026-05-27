# ChatGPT extension — open-source references

This document tracks the open-source projects and technical resources we
referenced when building the ChatGPT bridge in `extension/`
(`content_chatgpt.js`, `injected_chatgpt.js`, `background.js`
`handleChatGPTRequest`). If the current technique stops working — most
likely because OpenAI changes the SSE payload shape, renames a field,
moves an endpoint, or tightens Cloudflare anti-bot — start here. Each
repo's maintainer reverse-engineers the same surface we depend on, so
their recent commits are the best signal for "what does ChatGPT
currently expect."

Captured: **2026-05-23** (Vietnam time, today's date when we shipped M1+M2).

---

## Pattern overview (so future-you knows what to compare against)

The implementation uses **MAIN-world `window.fetch` monkey-patch** on
`chatgpt.com`. Concretely:

1. Bootstrap an access token from `GET /backend-api/auth/session`
   (`accessToken` field, ~7-day JWT expiry, refresh on 401).
2. POST a chat request to `/backend-api/conversation` with an SSE
   `accept: text/event-stream` header, body shape:
   `{action, messages[{id, author, content: {content_type, parts}}],
   model, conversation_id: null, parent_message_id, conversation_mode: {kind: "primary_assistant"}, ...}`.
3. Stream `data: {...}` lines, watch each event's `message.content.parts[]`:
   - `content_type: "text"` → accumulate the longest text snapshot.
   - `content_type: "image_asset_pointer"` → push `asset_pointer`
     (format `file-service://file-XXXX`) into a list.
4. For each asset pointer (after `data: [DONE]`):
   - `GET /backend-api/conversation/{conv_id}/attachment/{file_id}/download`
     → JSON with `download_url` (signed CDN URL on
     `files.oaiusercontent.com`).
   - `fetch(download_url)` with `credentials: include` → ArrayBuffer.
   - base64-encode and forward via the existing HMAC HTTP callback
     channel (`/api/ext/callback`) to the agent's worker.

If any step starts failing in production, the field/endpoint names below
are the most likely renames to chase.

---

## Reference repositories (sorted by relevance)

### 1. xtekky/gpt4free

- **URL**: <https://github.com/xtekky/gpt4free>
- **Specifically**:
  [`g4f/Provider/needs_auth/OpenaiChat.py`](https://github.com/xtekky/gpt4free/blob/main/g4f/Provider/needs_auth/OpenaiChat.py)
- **Last release seen**: v7.5.5 (15 May 2026), Python library + FastAPI
  OpenAI-compatible API + local web GUI. 66.3k stars.
- **What we lifted from it**:
  - The exact field path for image extraction:
    `part.get("content_type") == "image_asset_pointer"` →
    `part.get("asset_pointer")`.
  - The two attachment download endpoints:
    `/backend-api/conversation/{conv_id}/attachment/{file_id}/download`
    and `/backend-api/files/{file_id}/download`. The response carries
    `download_url`.
  - Multimodal upload shape (M3 reference if we ever support inbound
    images): `"asset_pointer": "file-service://{file_id}"` inside a part
    with `content_type: "multimodal_text"`.
- **Caveat we hit**:
  [`issue #2354`](https://github.com/xtekky/gpt4free/issues/2354) —
  Plus paid features (image creation, browsing, file analysis) don't
  work when authenticating via a saved HAR file. That's why we POST
  from the chatgpt.com tab itself instead of replaying a HAR.

**If our parser breaks**: read this file's diff between commits. They
react fastest to any field rename.

### 2. 11me/light-session

- **URL**: <https://github.com/11me/light-session>
- **Last release seen**: v1.7.5 (9 Apr 2026), MIT, TypeScript MV3
  extension. 130 stars.
- **What we lifted from it**:
  - The Chrome MV3 fetch-monkey-patch pattern: inject a page script
    before any of ChatGPT's bundle runs, replace `window.fetch` with a
    wrapper that delegates to the original while observing
    `/backend-api/conversation` JSON responses.
  - The split between page script (MAIN world) + content script
    (ISOLATED world) + background service worker that mirrors our
    `injected_chatgpt.js` / `content_chatgpt.js` / `background.js`
    separation.
- **Where they're different from us**: they only OBSERVE responses to
  trim the conversation client-side (perf optimisation for long
  chats). We additionally INITIATE the request from MAIN world. The
  observation pipe is the part that translates 1:1.

**If MAIN-world monkey-patch stops being possible** (MV3 lockdown
changes), this repo is where the community will iterate first.

### 3. ChatGPTBox-dev/chatGPTBox

- **URL**: <https://github.com/ChatGPTBox-dev/chatGPTBox>
- **Last release seen**: v2.6.0 (22 May 2026), 10.7k stars. Cross-browser
  extension (Chrome/Edge/Firefox/Safari).
- **What we lifted from it**: validation that fetch/XHR intercept on
  chatgpt.com works at production scale for both Free and Plus
  accounts. We didn't copy code directly but pattern-matched their
  approach.

**If our extension stops working on a Chromium update**, check whether
this repo's release notes mention the same regression.

### 4. terminalcommandnewsletter/everything-chatgpt

- **URL**: <https://github.com/terminalcommandnewsletter/everything-chatgpt>
- **Last release seen**: 74 commits, 594 stars. Reverse-engineering
  notes (not code).
- **What we lifted from it**:
  - Catalogue of backend endpoints:
    `/backend-api/conversation`, `/backend-api/conversations`,
    `/backend-api/conversation/<id>`, `/backend-api/moderations`,
    `/backend-api/models`, `/backend-api/message_feedback`.
  - The SSE stream ends with `data: [DONE]` sentinel.
  - Image-related endpoints are NOT yet documented here (we discovered
    them via gpt4free).

**If we need a new endpoint** (e.g. listing user's models, fetching
account state), this gist is the search index.

### 5. 0xdevalias frontend reverse-engineering gist

- **URL**: <https://gist.github.com/0xdevalias/4ac297ee3f794c17d0997b4673a2f160>
- **Content**: Notes on reverse engineering ChatGPT's frontend web app +
  deep dive explorations of the code, including how the React app
  packages requests and parses streams.

**If ChatGPT migrates to a different SSE framing** (e.g. WebSocket,
binary chunks), this is where the community catalogues the new format
first.

### 6. GautamVhavle/CatGPT-Gateway

- **URL**: <https://github.com/GautamVhavle/CatGPT-Gateway>
- **Approach**: 79 stars, MIT, Patchright-based (Playwright fork with
  stealth patches). DOM scripting + selectors centralized in
  `selectors.py`.
- **Why we did NOT copy from this**: DOM scripting is brittle —
  ProseMirror editor selectors change frequently. Our fetch-intercept
  path is more robust.
- **When to fall back to it**: if Cloudflare ever locks down
  programmatic fetch from MAIN world (i.e. checks the request was
  initiated by a real user action), the only remaining path is DOM
  scripting + waiting for the user's natural fetch to fire. This repo
  documents that path.

---

## Repositories we evaluated but rejected

These came up in research but didn't fit our requirements:

- **CJackHwang/ds2api** — archived May 2026, DeepSeek-only (not
  ChatGPT). Not relevant.
- **Amm1rr/WebAI-to-API** — last commit Jun 2025 (>10 months stale).
  Delegates ChatGPT support to gpt4free anyway.
- **Sergon10/calliope-bots** — only 6 stars, uses Puppeteer DOM
  scripting (the technique we explicitly rejected).
- **redjules/Create-a-Chrome-Extension-with-Manifest-V3-for-ChatGPT**,
  **kazuki-sf/ChatGPT_Extension**, **TechBot505/ChatGPT-Chrome-Extension**,
  **gragland/chatgpt-chrome-extension** — MV3 boilerplate /
  text-selection helpers, but none drive the SSE conversation API.
  Useful as MV3 reference if Flowboard's extension structure ever
  needs rebuilding.

---

## Risks ranked by break frequency (re-validate when something breaks)

1. **SSE field rename** (`asset_pointer` → something else). First to
   break historically. Check `OpenaiChat.py` diff.
2. **Cloudflare anti-bot detection** on programmatic fetch. We sit
   inside the chatgpt.com origin so we *should* always look like a
   real page — but if OpenAI introduces Web Worker fingerprinting or
   requires real user-initiated requests, we may need to fall back to
   DOM scripting. Watch CatGPT-Gateway for that pivot.
3. **`/backend-api/conversation` versioning** (`/v2`, etc.). Surface
   `API_VERSION_CHANGED` from the content script when SSE shape
   doesn't match expectations.
4. **Rate limit / quota changes**: Plus rotates limits periodically;
   429 detection should still work but `retry_after` field name might
   change. Check the error body shape in `injected_chatgpt.js`.
5. **Auth endpoint rotation** (`/backend-api/auth/session` →
   something else). gpt4free's `OpenaiChat.py` always reflects the
   current bootstrap.

---

## How to use this doc when something breaks

1. Open <https://github.com/xtekky/gpt4free/commits/main/g4f/Provider/needs_auth/OpenaiChat.py>
   and look at commits in the last ~30 days. Diff against the
   field/endpoint names hard-coded in `extension/injected_chatgpt.js`.
2. If the rename is small (a field name), patch
   `injected_chatgpt.js` only — the agent doesn't need redeployment.
3. If it's an endpoint rename, update both `injected_chatgpt.js` and
   the `chatgpt_request` docstring in
   `agent/flowboard/services/flow_client.py`.
4. Add a fixture in `extension/tests/fixtures/` capturing the new SSE
   shape, run `node tests/parser.test.js` to confirm the parser still
   recognises text + asset pointers.

The parser is intentionally quarantined to a single file so a hot-fix
is a single edit + extension reload — no agent redeploy.
