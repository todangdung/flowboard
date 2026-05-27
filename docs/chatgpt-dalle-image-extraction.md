# ChatGPT DALL-E image extraction (DOM-fallback mode)

How we pull the **generated image** out of a ChatGPT DALL-E reply when the
HTTP-direct path is blocked (Turnstile) and we are driving the page in
DOM-fallback mode (`extension/injected_chatgpt_dom.js`). If image output
stops coming back (empty `media_ids`, or `text: "Creating image"`), start
here — this records what we tried, what actually worked, and how to
re-derive the technique when OpenAI changes things.

Captured: **2026-05-27** (Vietnam time). Verified live against the May 2026
ChatGPT build (`gpt-5-5`, client build `6844271`).

---

## The problem

In DOM-fallback mode we type the prompt into the composer and read the
reply back out of the DOM. Text replies are easy. DALL-E image replies are
not, because:

1. **The image renders late.** ChatGPT streams a short text turn first
   ("Creating image…"), the stop-button disappears, and only 30–60 s later
   does the actual `<img>` appear. Extracting when the text stream settles
   gives `text: "Creating image", media_ids: []`.
2. **Placeholder text rotates and is localised.** During generation the
   turn cycles through many strings ("Creating image", "Đang tạo ảnh",
   "Drawing…") and finishes on a completion sentence that matches no fixed
   list. String-matching to detect "still generating" is unreliable.
3. **The image element is layered + lazy.** Each DALL-E image renders as
   ~3 `<img>` (main + transition + blur) all pointing at the same URL, and
   `naturalWidth` is 0 until decode finishes.

## Approaches that did NOT work

- **Text matching for a "pending" state.** Broke as soon as ChatGPT showed
  a placeholder string not in our list. False-exits to text-only.
- **DOM-only: poll for a CDN `<img>` with `naturalWidth > 0`.** The gap
  between "text settled" and "image element exists" has no DOM signal, so
  we exited early as text-only before the image ever mounted.
- **`GET /backend-api/conversation/{cid}` to read asset_pointers.**
  Returns **404** in this build (`keys: ['detail']`, empty mapping).
  Conversation-fetch API is blocked.

## What works: capture ChatGPT's own download call

ChatGPT's frontend, when the generated image is ready server-side, calls:

```
GET /backend-api/files/download/{file_id}?conversation_id={cid}&inline=false
```

and gets back JSON:

```json
{
  "status": "success",
  "download_url": "https://chatgpt.com/backend-api/estuary/content?id=file_...&ts=...&p=fs&cid=1&sig=...&v=0",
  "metadata": null,
  "file_name": "user-.../<uuid>.png",
  "mime_type": null,
  "file_size_bytes": 2665279
}
```

`download_url` is a **same-origin, signed estuary link**. Fetching it with
`credentials: 'include'` returns the raw image bytes.

So the technique is: **monkey-patch `window.fetch` in the MAIN world before
submitting the prompt, watch for the `/files/download/{file_id}` call,
clone its response, read `download_url`, then fetch that URL ourselves for
the bytes.** This bypasses DOM image scraping entirely — bytes are
reachable the instant ChatGPT resolves the signed URL, regardless of
whether the `<img>` has painted or what placeholder text is showing.

Implemented in `installDalleDetector()`.

## Signals the detector exposes

| Signal | Source | Fires when | Used for |
|---|---|---|---|
| `dalleStarted` | SSE stream scan of `/backend-api/f/conversation` for markers `"dalle.text2im"`, `"image_gen_async"`, `"image_asset_pointer"` | Within ~1–3 s of submit | Early "this is an image-gen reply" signal; gates trusting downloads on the multimodal (input-image) path |
| `imageReady` | A `/backend-api/files/download/` request was seen | When bytes are ready server-side (T≈30–60 s) | "DALL-E in progress / done" guard |
| `downloadInfos[]` | Cloned JSON of the `/files/download/` response | Same as `imageReady`, once body parses | **Primary OUTPUT extraction** — `{file_id, download_url, mime_type, file_name}` |
| `conversationId` | `conversation_id` query param on the `/files/download/` URL | Same | Canonical conversation UUID (DOM turn-id is an unreliable `request-WEB:…`) |

`waitForImagesStableDOM` returns as soon as `downloadInfos.length > 0`
(plus a 2 s grace for the DOM text to swap past the placeholder).
`extractResponseDOM` then fetches each `download_url` for bytes.

## Important gotchas

- **The endpoint has a `/f/` infix.** The conversation SSE is
  `POST /backend-api/f/conversation` in this build (older builds:
  `/backend-api/conversation`). The detector matches both.
- **fetch monkey-patch must be installed before the call fires, not
  cached.** We install in `runGenerationDOM` (after page load) and it
  works — ChatGPT's bundle calls global `fetch` at call-time, not a cached
  reference. If a future build caches `window.fetch` at module init, move
  the patch to `document_start` (persistent, before ChatGPT's bundle runs)
  and have the detector read from a shared buffer.
- **Multimodal INPUT images can also trigger `/files/download/`.** When the
  prompt carries an input image, ChatGPT may re-fetch it for display. We
  gate OUTPUT trust with `trustDownloads = !imageBlob || dalleStarted` so a
  re-rendered user upload isn't ingested as a generated image.
- **Text comes from the prose container, not the turn.** Reading the whole
  turn's `innerText` grabbed the "Edit" action-button label. Read
  `.markdown / .prose` only; image-only replies legitimately have no text.
- **Concurrency.** Each `runGenerationDOM` wraps/unwraps `window.fetch`. If
  two DOM generations ever run concurrently in one tab, the wrap/restore
  could mis-nest. Today the worker serialises ChatGPT gens per tab; revisit
  if that changes.

## How to re-derive if it breaks

1. Open DevTools → Network on `chatgpt.com`. Send an image prompt
   ("vẽ cho tôi…"). Watch the requests fired during the 30–60 s gen.
2. Look for the request that returns a signed image URL. Today it is
   `GET /backend-api/files/download/{file_id}?conversation_id=…`. If the
   path moved, update the `dlMatch` regex in `installDalleDetector`.
3. Confirm the response JSON still has `download_url` (or find the new
   field) and that it fetches with `credentials: 'include'`.
4. Click the `POST .../conversation` SSE request → Response/EventStream.
   Search for the DALL-E tool marker (today `"dalle.text2im"` /
   `"image_gen_async"` / `"image_asset_pointer"`). Update `DALLE_MARKERS`
   if renamed.
5. The estuary URL host (`/backend-api/estuary/content`) may also change —
   it's only used as a DOM-scrape fallback selector (`SEL.cdnImg`).

## Reference

- Code: `extension/injected_chatgpt_dom.js` — `installDalleDetector`,
  `waitForImagesStableDOM`, `extractResponseDOM`.
- Sibling doc: `docs/chatgpt-extension-references.md` (HTTP-direct path,
  SSE shape, anti-bot context).
