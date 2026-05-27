/**
 * Injected into MAIN world on chatgpt.com — DOM-automation fallback.
 *
 * Used when the HTTP-direct path in `injected_chatgpt.js` cannot reach
 * `/backend-api/conversation` (Turnstile / Arkose gate, 403 on free tier,
 * or sentinel chat-requirements blocks the request). Driving the page's
 * own composer lets ChatGPT's first-party JS render the Turnstile widget
 * and post the proof token transparently — no manual challenge solving
 * required.
 *
 * Strategy:
 *   1. Click the "new chat" link so we never bleed into an existing
 *      conversation (per the same isolation invariant as HTTP mode).
 *   2. If an image is supplied, simulate a `paste` event on the composer
 *      carrying a `DataTransfer` clipboard — that is the same code path
 *      the page's own paste-handler exercises when a user drops or
 *      pastes an image, so the attachment chip + upload happen for free.
 *   3. Type the prompt by dispatching synthetic InputEvents on the
 *      contenteditable composer. `document.execCommand('insertText')` is
 *      the only path that triggers React's synthetic-event bridge —
 *      directly assigning `innerText` leaves React's value tracker out
 *      of sync and the send button stays disabled.
 *   4. Click the send button.
 *   5. Wait for the assistant's stream to settle: while ChatGPT is
 *      streaming, a `[data-testid="stop-button"]` is present in the
 *      composer footer. Polling for its absence (plus a small grace
 *      period) gives us a clean "done" signal across UI redesigns.
 *   6. Read the last assistant message: text from its `innerText`,
 *      images from `<img>` tags whose `src` is hosted on the OpenAI
 *      file CDN. Each image is fetched (same-origin to chatgpt.com so
 *      cookies + Cloudflare context attach) and base64-encoded for
 *      transport back to the agent — same shape the HTTP-direct path
 *      produces.
 *
 * Selectors here are pinned to specific data-testid attributes and the
 * contenteditable composer id. Audit them weekly — when OpenAI ships a
 * UI refresh the file's top-most consts are the only thing that needs
 * patching.
 */
// Double-init guard. See injected_chatgpt.js for the rationale —
// background.js can re-inject content_chatgpt.js, re-loading both
// MAIN-world scripts. Without the guard the helper object on
// window.__FLOWBOARD_CHATGPT_DOM__ stays consistent but the IIFE
// re-runs its closures, leaving multiple SEL maps and waitFor
// pollers floating around.
if (window.__FLOWBOARD_CHATGPT_DOM_INJECTED__) {
  console.log('[Flowboard] injected_chatgpt_dom.js already loaded; skipping re-init');
} else {
  window.__FLOWBOARD_CHATGPT_DOM_INJECTED__ = true;
(function () {
  // Selectors mirror KudoAI/chatgpt.js v4.3.0 (src/chatgpt.js) where
  // they overlap, with a couple of pragmatic fallbacks for the cases
  // KudoAI doesn't model:
  //   - `attachThumb` covers ChatGPT's chat-bar paste-upload chip,
  //     which KudoAI never queries (their library only handles text).
  //   - `paragenRoot` flags ChatGPT's 2026 parallel-generation mode
  //     where the model emits two candidate replies and waits for the
  //     user to pick one. We pick the first variant automatically so
  //     pipeline runs don't stall on a UI prompt.
  const SEL = {
    composer: '#prompt-textarea',
    sendBtn: 'button[data-testid=send-button]',
    stopBtn: 'button[data-testid=stop-button]',
    // ChatGPT (May 2026 build) no longer stamps
    // data-message-author-role="assistant" on assistant turns — only
    // the user turn carries that attribute. Match assistant by exclusion:
    // a [data-testid^="conversation-turn"] block that does NOT contain
    // a user-role descendant. Keeps the legacy author-role selector
    // first in the list so older accounts still hit a direct match.
    // (Falls back to [data-turn-id-container] for builds that drop the
    // testid attribute entirely.)
    asstMsg: '[data-message-author-role=assistant], [data-testid^="conversation-turn"]:not(:has([data-message-author-role=user])), [data-turn-id-container]:not(:has([data-message-author-role=user]))',
    // ChatGPT renames this chip frequently. Cover the historical
    // data-testid plus newer variants (preview card, preview img,
    // attach-button image, blob/data URL preview inside composer).
    attachThumb: '[data-testid="attachment-thumbnail"], [data-testid="attachments-preview-card"], [data-testid="attachments-preview-img"], [data-testid*="attachment"], button[aria-label*="ttach" i] img, [class*="composer"] img[src^="blob:"], [class*="composer"] img[src^="data:"]',
    newChat: 'a[href="/"]:has(svg), nav a[href="/"]',
    // Match every CDN ChatGPT serves DALL-E from. Confirmed live (May
    // 2026): backend-api/estuary/content is the new primary host —
    // image bytes are proxied through the auth'd ChatGPT origin rather
    // than oaiusercontent.com. The older hosts stay in the list for
    // back-compat with older accounts/regions. Lazy-load placeholders
    // (data:, blob:) are filtered downstream in extractResponseDOM.
    cdnImg: 'img[src*="/backend-api/estuary/content"], img[src*="oaiusercontent"], img[src*="cdn.openai.com"], img[src*="/files/file-"]',
    paragenRoot: '[data-paragen-root]',
    turnContainer: '[data-turn-id-container],[data-turn-id]',
  };

  // Stability-based completion detection (pattern from
  // improveTheWorld/ChatGPT-Bridge src/content.js): we treat the
  // response as finished when the last assistant message's text has
  // been stable for `STABLE_MS` consecutive milliseconds AND the stop
  // button is no longer present. This catches three cases the original
  // stop-button-only watcher missed:
  //
  //   1. Instant non-streamed responses ("OK") where the stop button
  //      blinks under the 150 ms poll interval.
  //   2. Paragen mode where the second candidate finishes a beat
  //      after the stop button removes itself.
  //   3. UI refreshes that re-render the message tree post-stream
  //      (action buttons mount, code-block syntax-highlight runs).
  const DEFAULT_STABLE_MS = 1200;
  const DEFAULT_TIMEOUT_MS = 120000;
  const SAMPLE_INTERVAL_MS = 200;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Poll until `pred()` returns truthy or the deadline elapses. Returns
   *  the final value or null on timeout. Uses requestAnimationFrame so
   *  we don't burn CPU during long streams. */
  async function waitFor(pred, { timeout = 5000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const v = pred();
        if (v) return v;
      } catch {
        // continue polling
      }
      await sleep(interval);
    }
    return null;
  }

  /** Convert an ArrayBuffer to base64 — duplicated from injected_chatgpt.js
   *  rather than imported because the IIFE wrapper isolates each file. */
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  /** Open a fresh conversation. On chatgpt.com the sidebar "new chat"
   *  anchor points at `/`; clicking it resets the composer + URL without
   *  a full reload. If the link is absent (sidebar collapsed) we fall
   *  back to navigating the URL directly. */
  async function startNewChatDOM() {
    const link = document.querySelector(SEL.newChat);
    if (link) {
      link.click();
    } else if (location.pathname !== '/') {
      history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    // Wait for SPA to navigate to '/' so old messages are removed before we
    // snapshot beforeCount. Without this, beforeCount captures messages from
    // the previous conversation and the post-send count never exceeds it.
    await waitFor(() => location.pathname === '/', { timeout: 3000 });
    const composer = await waitFor(() => document.querySelector(SEL.composer), { timeout: 8000 });
    if (!composer) throw new Error('DOM_NO_COMPOSER');
    return composer;
  }

  /** Paste an image blob into the composer. Synthetic `paste` event with
   *  a populated `DataTransfer` matches what the page's own paste-handler
   *  consumes, so the file upload + thumbnail render happen via
   *  ChatGPT's own pipeline (no manual /backend-api/files call). */
  async function attachImageDOM(composer, blob, fileName) {
    composer.focus();
    const dt = new DataTransfer();
    const name = fileName || `flowboard-${Date.now()}.png`;
    dt.items.add(new File([blob], name, { type: blob.type || 'image/png' }));
    const evt = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(evt);
    // Thumbnail chip appears ~300-800 ms after paste once the upload
    // completes. If our selector misses (ChatGPT renames the chip
    // every few weeks), don't hard-fail — log and proceed, the send
    // button's disabled-while-uploading gate covers the genuine
    // upload-failure case downstream.
    const ok = await waitFor(() => document.querySelector(SEL.attachThumb), { timeout: 15000 });
    if (!ok) {
      console.warn('[Flowboard] attachThumb selector missed; proceeding (send-button gate will catch a true upload failure)');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /** Type a prompt into the contenteditable composer.
   *
   *  ChatGPT's composer is a Slate-React contenteditable. Slate ignores
   *  raw DOM mutations it didn't author and re-syncs from its internal
   *  value model on the next render — so setting textContent + an
   *  `input` event leaves the composer visually populated for ~one
   *  frame, then Slate clears it and the send fires empty (observed
   *  symptom: image arrives but assistant asks "what do you want me
   *  to do with this image?").
   *
   *  `document.execCommand('insertText')` is the only path that
   *  routes through the same beforeinput → input → value-update chain
   *  Slate subscribes to. It's marked deprecated but Chrome keeps it
   *  shipping precisely because automation tooling depends on it.
   *
   *  Fallback dispatches a synthetic beforeinput + textContent path
   *  in case execCommand returns false (Firefox-style refusal). */
  // Random integer in [min, max] inclusive — used for humanized typing
  // jitter so the inter-keystroke timing matches a real user instead of
  // a uniform 30 ms machine cadence (OpenAI fingerprints keystroke
  // entropy server-side per leaked anti-bot heuristics).
  function rand(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  async function typePromptDOM(composer, text) {
    // Re-query the composer reference. Slate re-mounts the
    // contenteditable between startNewChatDOM and the moment we type;
    // the original ref ends up document-detached and addRange() fails
    // with "The given range isn't in document.", which leaves the
    // selection unset → the first execCommand('insertText') lands at
    // an undefined caret and Slate drops the leading character
    // (observed: "Cho tôi" arrived as "ho tôi").
    const live = document.querySelector(SEL.composer);
    if (live && live.isConnected) composer = live;
    composer.focus();
    // Wait one microtask for focus() to commit before manipulating
    // selection, otherwise Chrome can race the focus event with the
    // addRange call on slow renders.
    await sleep(0);
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (composer.isConnected) {
      try {
        const range = document.createRange();
        range.selectNodeContents(composer);
        sel.addRange(range);
      } catch (_) { /* tolerate stale node */ }
    }
    // Only run select-all + delete when the composer actually has
    // content. After startNewChatDOM the composer is empty, and
    // running an unnecessary `delete` immediately before the first
    // `insertText` made Slate's pending deletion swallow the first
    // typed character.
    const composerText = (composer.innerText || composer.textContent || '').trim();
    if (composerText.length > 0) {
      try { document.execCommand('delete', false); } catch (_) { /* tolerate */ }
      // Give Slate a tick to flush the deletion before we start typing.
      await sleep(60);
    }

    // Per-character typing. Each insertText fires a single beforeinput
    // Slate intercepts and accepts. Inter-key delay 35-110 ms with
    // occasional 150-350 ms "thinking pauses" every 6-12 chars to
    // mimic a real typist's irregular cadence.
    let nextPauseAt = rand(6, 12);
    for (let i = 0; i < text.length; i++) {
      try { document.execCommand('insertText', false, text[i]); } catch (_) { /* tolerate */ }
      if (i === text.length - 1) break;
      if (i + 1 >= nextPauseAt) {
        await sleep(rand(150, 350));
        nextPauseAt = i + 1 + rand(6, 12);
      } else {
        await sleep(rand(35, 110));
      }
    }

    // Slate accepted the typed chars → done.
    if ((composer.innerText || composer.textContent || '').trim().length > 0) return;

    // Fallback: composer empty after looping. Replace <p> manually
    // and fire ONE input event so send-button enables.
    const msgP = document.createElement('p');
    msgP.textContent = text;
    const existing = composer.querySelector('p');
    if (existing) existing.replaceWith(msgP);
    else { composer.textContent = ''; composer.appendChild(msgP); }
    composer.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
  }

  /** Submit the composer.
   *
   *  Two parallel paths, mirroring KudoAI v4.3.0's send loop (line 1559):
   *    1. Click `button[data-testid=send-button]` when it's enabled.
   *    2. Dispatch Enter keydown on the composer as a fallback when the
   *       button selector momentarily misses (UI A/B tests, mobile-style
   *       chatbar variants), or as a belt-and-braces second-attempt.
   *
   *  We don't try to verify "send actually landed" here — short
   *  responses (e.g. "OK") can complete the entire stream before our
   *  150 ms poll catches the stop button rising/falling. The verifier
   *  lives in `waitForIdleDOM`, which compares the assistant message
   *  count against the pre-send snapshot. */
  async function clickSendDOM(composer) {
    const btn = await waitFor(() => {
      const el = document.querySelector(SEL.sendBtn);
      if (!el) return null;
      // KudoAI v4.3.0 only checks the `disabled` attribute (line 1558).
      // Avoid over-checking with `aria-disabled` — ChatGPT applies it
      // briefly during animations even when the button is functional.
      if (el.hasAttribute('disabled')) return null;
      return el;
    }, { timeout: 5000 });
    if (btn) {
      btn.click();
      return;
    }
    // Fallback path — KudoAI uses Enter keydown when the button stays
    // disabled. Composer must be focused for the page's keymap to
    // intercept the event.
    if (composer) composer.focus();
    const target = composer || document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
  }

  /** Wait until the assistant has finished responding to the message
   *  we just sent.
   *
   *  Text-stability detection, pattern from
   *  improveTheWorld/ChatGPT-Bridge src/content.js
   *  (`checkForNewCommands` / `messageCompletionTime`): sample the
   *  last assistant message's text on `SAMPLE_INTERVAL_MS` and treat
   *  the response as finished when the text has been unchanged AND
   *  the stop button has been absent for `stableMs` consecutive ms.
   *
   *  Two pre-conditions before stability counts:
   *    1. A new assistant message must have appeared (count > beforeCount).
   *    2. The current text must be non-empty (an empty <div> reaching
   *       `stableMs` of "stability" would otherwise complete in zero
   *       work scenarios).
   *
   *  Robust against:
   *    - Instant non-streamed replies ("OK") — text settles immediately
   *      and the stop button never visible to our poll.
   *    - Paragen mode where two candidates finish a beat apart.
   *    - Streamed long responses — text growing during stream resets
   *      `stableSince`; only the post-stream pause is counted. */
  async function waitForIdleDOM(beforeCount, { stableMs = DEFAULT_STABLE_MS, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    // Phase 1: wait for generation to START — stop-button appears (streaming)
    // OR a new assistant message lands (instant sub-200ms response).
    // 30 s timeout (was 12 s) — DALL-E mode shows neither stop-button
    // nor asstMsg for ~10-15 s while the tool planner spins up.
    const started = await waitFor(
      () =>
        document.querySelector(SEL.stopBtn) ||
        document.querySelectorAll(SEL.asstMsg).length > beforeCount,
      { timeout: 30000, interval: SAMPLE_INTERVAL_MS },
    );
    if (!started) throw new Error('DOM_NO_NEW_MESSAGE');

    // Phase 2: wait for streaming to FINISH — stop-button gone.
    // If the response was instant the stop-button was never present so
    // waitFor returns immediately (null → stop absent = stream not running).
    await waitFor(
      () => !document.querySelector(SEL.stopBtn),
      { timeout, interval: SAMPLE_INTERVAL_MS },
    );

    // Phase 3: text-stability check on the prose content only.
    // We read from the innermost markdown/prose container rather than the
    // whole message block so that action buttons (copy, thumbs, share) that
    // mount after streaming ends do not contribute to innerText and
    // endlessly reset the stable-since timer.
    const stabilityDeadline = Date.now() + stableMs * 3;
    let lastText = null;
    let stableSince = null;
    while (Date.now() < stabilityDeadline) {
      const msgs = document.querySelectorAll(SEL.asstMsg);
      const last = msgs[msgs.length - 1];
      const proseEl =
        last?.querySelector('.markdown, .prose, [class*="markdown"], [class*="prose"]') || last;
      const currentText = (proseEl?.innerText || proseEl?.textContent || '').trim();

      if (currentText !== lastText) {
        stableSince = null;
        lastText = currentText;
      } else if (stableSince === null) {
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableMs) {
        return true;
      }
      await sleep(SAMPLE_INTERVAL_MS);
    }
    // Stream already finished (phase 2 passed) — return whatever text we have
    // even if the stability window never settled (e.g. live-updating UI badges).
    return true;
  }

  /** Wrap window.fetch to capture DALL-E image download URLs directly
   *  from ChatGPT's own API traffic. Returns:
   *    - `dalleStarted`: SSE conversation stream contains a DALL-E tool
   *      marker (early signal, fires within seconds of submit).
   *    - `imageReady`: ChatGPT called /files/download/{file_id} (late
   *      signal, fires when the image bytes are ready server-side).
   *    - `downloadInfos`: array of {file_id, download_url, mime_type,
   *      file_name} extracted from the cloned /files/download/ JSON
   *      responses — used by extractResponseDOM to bypass DOM image
   *      scraping entirely.
   *    - `teardown()`: restore original window.fetch.
   *
   *  ChatGPT's frontend pipeline (verified via Network tab curls):
   *    1. POST /backend-api/f/conversation → SSE stream containing tool
   *       calls ("dalle.text2im" / "image_gen_async") and content
   *       patches ("image_asset_pointer"). Markers appear within the
   *       first 1-3 s of the stream.
   *    2. GET /backend-api/files/download/{file_id}?conversation_id=...
   *       → JSON { status, download_url, mime_type, file_name, ... }.
   *       Fires after DALL-E completes (T = 30-60 s after submit).
   *       download_url is a same-origin signed estuary link, fetch with
   *       credentials: 'include' to get the bytes. */
  function installDalleDetector() {
    let dalleStarted = false;
    let imageReady = false;
    let conversationId = null;
    const downloadInfos = [];
    const origFetch = window.fetch;

    // SSE markers indicating DALL-E (vs. pure-text) response. Pinned to
    // ChatGPT 2026 backend payload shape — audit if false-positives
    // (text-only flagged as DALL-E) or false-negatives (DALL-E missed).
    const DALLE_MARKERS = [
      '"dalle.text2im"',
      '"image_gen_async"',
      '"image_asset_pointer"',
    ];

    window.fetch = function (input, init) {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
          ? input.url
          : '';
      const fetchPromise = origFetch.apply(this, arguments);

      // (1) /backend-api/files/download/{file_id} — capture download_url.
      const dlMatch = url.match(/\/backend-api\/files\/download\/(file_[a-f0-9]+)/i);
      if (dlMatch) {
        const fileId = dlMatch[1];
        imageReady = true;
        // The query string carries the real conversation_id (UUID) — far
        // more reliable than scraping a transient turn-id from the DOM.
        try {
          const cid = new URL(url, location.origin).searchParams.get('conversation_id');
          if (cid && !conversationId) conversationId = cid;
        } catch {}
        return fetchPromise.then((response) => {
          try {
            if (response && response.ok) {
              response
                .clone()
                .json()
                .then((data) => {
                  if (data && typeof data.download_url === 'string') {
                    downloadInfos.push({
                      file_id: fileId,
                      download_url: data.download_url,
                      mime_type: data.mime_type || null,
                      file_name: data.file_name || null,
                    });
                    console.log('[Flowboard] DALL-E download captured', fileId);
                  }
                })
                .catch(() => {});
            }
          } catch {}
          return response;
        });
      }

      // (2) /backend-api/f/conversation (May 2026) or /backend-api/conversation
      //     — scan SSE for DALL-E tool markers (early-detection signal).
      const isConv =
        url.includes('/backend-api/f/conversation') ||
        url.includes('/backend-api/conversation');
      if (!isConv) return fetchPromise;

      return fetchPromise.then((response) => {
        try {
          if (!response || !response.body || dalleStarted) return response;
          const reader = response.clone().body.getReader();
          const decoder = new TextDecoder('utf-8', { fatal: false });
          let buffer = '';
          (async () => {
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                for (const m of DALLE_MARKERS) {
                  if (buffer.includes(m)) {
                    dalleStarted = true;
                    break;
                  }
                }
                if (dalleStarted) {
                  console.log('[Flowboard] DALL-E SSE marker detected');
                  try { reader.cancel(); } catch {}
                  break;
                }
                // Trim buffer to avoid unbounded growth on long streams.
                // Keep tail so markers straddling chunk boundaries match.
                if (buffer.length > 8000) buffer = buffer.slice(-400);
              }
            } catch {}
          })();
        } catch {}
        return response;
      });
    };

    return {
      get dalleStarted() { return dalleStarted; },
      get imageReady() { return imageReady; },
      get fired() { return dalleStarted || imageReady; },
      get downloadInfos() { return downloadInfos.slice(); },
      get conversationId() { return conversationId; },
      teardown() { window.fetch = origFetch; },
    };
  }

  /** Block until DALL-E output is ready, so extractResponseDOM doesn't
   *  snapshot a half-rendered turn. Completion is driven by ChatGPT's
   *  own API traffic (captured by the detector) rather than by the DOM:
   *
   *  Primary success signal — `detector.downloadInfos.length > 0`:
   *    ChatGPT fetched /files/download/{file_id} and we captured the
   *    signed estuary download_url. The image bytes are now reachable
   *    regardless of whether the <img> has painted, so we wait a short
   *    grace period for the DOM text to swap past "Creating image" and
   *    return.
   *
   *  DALL-E in-progress signals (keep the loop alive, no early exit):
   *    1. `detector.dalleStarted` — SSE stream carried a DALL-E tool
   *       marker (fires within seconds of submit).
   *    2. `detector.imageReady` — /files/download/ fired (bytes ready).
   *    3. `[id^="image-"]` container present in the assistant turn.
   *    4. A fully-loaded CDN <img> (naturalWidth > 0) — DOM fallback if
   *       the download interception missed.
   *
   *  Text matching was removed: ChatGPT rotates through many localised
   *  placeholder strings ("Creating image", "Đang tạo ảnh", "Drawing…")
   *  and finishes on a completion sentence matching no fixed list.
   *
   *  Exit conditions:
   *    - downloadInfos captured → grace period, return (image path).
   *    - CDN <img> loaded and stable for stableMs (DOM fallback path).
   *    - No DALL-E signal at all for stableMs → text-only reply. */
  async function waitForImagesStableDOM({ stableMs = 1500, timeout = 120000, detector } = {}) {
    const isReal = (src) =>
      typeof src === 'string' && src && !src.startsWith('data:') && !src.startsWith('blob:');
    const pollTarget = () => {
      const msgs = document.querySelectorAll(SEL.asstMsg);
      return msgs[msgs.length - 1] || null;
    };
    const countLoaded = (t) => {
      if (!t) return 0;
      const srcs = new Set();
      for (const img of t.querySelectorAll(SEL.cdnImg)) {
        if (isReal(img.src) && img.naturalWidth > 0 && img.naturalHeight > 0)
          srcs.add(img.src);
      }
      return srcs.size;
    };
    const isDallePending = (t) =>
      (detector && detector.fired) ||
      (t != null && t.querySelector('[id^="image-"]') !== null);

    const deadline = Date.now() + timeout;
    let lastLoaded = -1;
    let stableSince = null;
    let noImgSince = null;

    while (Date.now() < deadline) {
      // Primary: download_url captured from ChatGPT's /files/download/
      // response → image bytes are reachable now. Give the DOM a beat to
      // swap the placeholder text for the final message, then return.
      if (detector && detector.downloadInfos.length > 0) {
        await sleep(2000);
        return;
      }

      const t = pollTarget();
      const loaded = countLoaded(t);

      if (loaded !== lastLoaded) {
        lastLoaded = loaded;
        stableSince = null;
      }

      if (loaded > 0) {
        // DOM fallback: a CDN image painted even though we never saw the
        // download fetch. Treat a stable count as completion.
        noImgSince = null;
        if (stableSince === null) stableSince = Date.now();
        else if (Date.now() - stableSince >= stableMs) return;
      } else if (isDallePending(t)) {
        // DALL-E in progress — reset timers and keep polling.
        noImgSince = null;
        stableSince = null;
      } else {
        // No loaded images, no DALL-E signal → probably a text-only reply.
        // Wait stableMs before giving up to avoid a false-positive on the
        // 0-frame gap between assistant turn creation and image-container mount.
        if (noImgSince === null) noImgSince = Date.now();
        if (Date.now() - noImgSince >= stableMs) return;
      }

      await sleep(300);
    }
  }

  /** Fetch an image URL same-origin (Cloudflare cookies attach) and pack
   *  it into the `{media_id, bytes_b64, mime, asset_pointer}` record shape
   *  `_handle_gen_chatgpt` understands. Returns the record (with an
   *  `error` field instead of bytes on failure). */
  async function fetchImageRecord(url, { mimeHint, fileId } = {}) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) {
        return { media_id: crypto.randomUUID(), error: `CDN_${resp.status}`, asset_pointer: url };
      }
      const buf = await resp.arrayBuffer();
      let mime =
        mimeHint ||
        (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!mime || !mime.startsWith('image/')) mime = 'image/png';
      const rec = {
        media_id: crypto.randomUUID(),
        bytes_b64: arrayBufferToBase64(buf),
        mime,
        asset_pointer: url,
      };
      if (fileId) rec.file_id = fileId;
      return rec;
    } catch (err) {
      return { media_id: crypto.randomUUID(), error: err?.message || String(err), asset_pointer: url };
    }
  }

  /** Read the last assistant message: text from innerText, images from
   *  the detector's captured download URLs (preferred) or CDN-hosted
   *  `<img>` tags (fallback). Bytes are base64-encoded and packed into
   *  the `{media_id, bytes_b64, mime, asset_pointer}` record shape
   *  `_handle_gen_chatgpt` already understands.
   *
   *  The conversation_id is recovered from `location.pathname` when
   *  ChatGPT has redirected to `/c/<id>` — chatgpt.com always rewrites
   *  the URL once the first turn lands, so this is reliable. */
  async function extractResponseDOM(detector, { trustDownloads = true } = {}) {
    // waitForIdleDOM already verified that an assistant message
    // appeared and stabilised, so we can read straight away. Bail
    // loudly if it somehow disappeared between idle and extract.
    const msgs = document.querySelectorAll(SEL.asstMsg);
    if (!msgs.length) throw new Error('DOM_NO_ASSISTANT_MESSAGE');

    // ChatGPT's 2026 parallel-generation experiment renders two
    // candidate replies and waits for the user to thumbs-up one of
    // them. For automation we just take the first — both variants
    // satisfy the prompt, and we'd otherwise stall waiting for a
    // human click. Surface the paragen flag in the result so the
    // activity log can show whether the response went through a
    // picker UI.
    const paragenActive = !!document.querySelector(SEL.paragenRoot);
    const target = paragenActive ? msgs[0] : msgs[msgs.length - 1];

    // Read prose from the markdown/prose container, NOT the whole turn.
    // The turn block also contains action-button labels (Edit, Download,
    // Share) that mount over a DALL-E image — reading target.innerText
    // directly grabbed "Edit" as the message text. Decision (made at
    // return, once we know whether images were found):
    //   - prose container present → use its text (text reply, or a
    //     DALL-E reply with a caption).
    //   - no prose + image present → image-only reply, text is ''.
    //   - no prose + no image → rare text reply without a markdown
    //     wrapper; fall back to the raw turn text so we don't drop it.
    const proseEl = target.querySelector(
      '.markdown, .prose, [class*="markdown"], [class*="prose"]',
    );
    const proseText = proseEl ? (proseEl.innerText || proseEl.textContent || '').trim() : null;
    const rawTurnText = (target.innerText || target.textContent || '').trim();

    const images = [];
    const seenSrc = new Set();

    // Path 1 (preferred): use download URLs captured from ChatGPT's own
    // /files/download/ responses. Robust against DOM image-swap races —
    // the bytes are reachable the instant ChatGPT resolves the signed
    // URL, no waiting for the <img> to paint or guessing CDN selectors.
    //
    // Gated by `trustDownloads`: when the prompt carried an INPUT image,
    // ChatGPT may also call /files/download/ to re-render the user's
    // upload, which would otherwise be ingested as a spurious OUTPUT
    // image. The caller only trusts the captured downloads when no input
    // image was attached, or when the SSE stream confirmed a DALL-E tool
    // call (dalleStarted) — i.e. an image was genuinely generated.
    const infos = trustDownloads && detector ? detector.downloadInfos : [];
    for (const info of infos) {
      if (!info || !info.download_url || seenSrc.has(info.download_url)) continue;
      seenSrc.add(info.download_url);
      images.push(
        await fetchImageRecord(info.download_url, {
          mimeHint: info.mime_type,
          fileId: info.file_id,
        }),
      );
    }

    // Path 2 (fallback): scrape CDN <img> tags from the assistant turn.
    // Only runs when the download interception captured nothing (e.g.
    // ChatGPT served the image inline without a /files/download/ call).
    // Dedup by src — DALL-E renders 3 layered <img> per image.
    if (images.length === 0) {
      const cdnImgs = target.querySelectorAll(SEL.cdnImg);
      for (const img of cdnImgs) {
        const src = img.src;
        if (!src) continue;
        if (src.startsWith('data:') || src.startsWith('blob:')) continue;
        if (seenSrc.has(src)) continue;
        seenSrc.add(src);
        // Skip avatars/icons (≤ 64 px). Only filter on a positive
        // measurement — lazy-loaded imgs report naturalWidth=0 pre-decode.
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        if (w > 0 && h > 0 && (w < 96 || h < 96)) continue;
        images.push(await fetchImageRecord(src));
      }
    }

    // conversation_id sources, in priority order:
    //   1. detector.conversationId — parsed from the /files/download/
    //      query string; the canonical conversation UUID.
    //   2. URL `/c/<uuid>` (chat that redirected after the first turn).
    //   3. data-turn-id-container / data-turn-id on the assistant block,
    //      but ONLY if it looks like a UUID. ChatGPT 2026 sometimes
    //      stamps a transient "request-WEB:..." id here that is NOT the
    //      conversation id (observed: "request-WEB:fd71...-0").
    //   4. null (the agent tolerates a missing conversation_id).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    let conversation_id = (detector && detector.conversationId) || null;
    if (!conversation_id) {
      const m = location.pathname.match(/\/c\/([0-9a-f-]{8,})/i);
      if (m) conversation_id = m[1];
    }
    if (!conversation_id) {
      const turnEl = target.closest(SEL.turnContainer);
      if (turnEl) {
        const cand =
          turnEl.getAttribute('data-turn-id-container') ||
          turnEl.getAttribute('data-turn-id') ||
          '';
        if (UUID_RE.test(cand)) conversation_id = cand;
      }
    }

    const text = proseText !== null ? proseText : images.length ? '' : rawTurnText;

    return {
      text,
      asset_pointers: images.map((i) => i.asset_pointer).filter(Boolean),
      conversation_id,
      images,
      mode: 'dom',
      paragen: paragenActive,
      assistant_count: msgs.length,
    };
  }

  /** Top-level driver: orchestrate the five DOM steps. Type the prompt
   *  FIRST, then attach the image — the paste-event handler reorders
   *  composer focus/state in a way that drops subsequent input-event
   *  text on the floor (observed: ChatGPT received only the image and
   *  asked "what do you want me to do with this image?"). Typing first
   *  banks the prompt before the paste handler runs. */
  async function runGenerationDOM(prompt, imageBlob, imageName) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('MISSING_PROMPT');
    }
    const composer = await startNewChatDOM();
    // Wait for old messages from the previous conversation to clear.
    // After SPA navigation the DOM update is async — URL flips to '/'
    // before React removes old <div data-message-author-role> nodes.
    await waitFor(() => document.querySelectorAll(SEL.asstMsg).length === 0, { timeout: 2000 });
    // Humanize: small pause after landing on new-chat before touching
    // the composer (mimics a user reading the empty page).
    await sleep(rand(250, 600));
    const beforeCount = document.querySelectorAll(SEL.asstMsg).length;

    // Install the DALL-E detector BEFORE submitting the prompt so it
    // can catch the /files/download/ fetch that fires when DALL-E
    // completes server-side (potentially 30-60 s later). Teardown runs
    // in the finally block whether or not generation succeeds.
    const detector = installDalleDetector();
    try {
      await typePromptDOM(composer, prompt.trim());
      if (imageBlob) {
        // Brief pause between finishing the prompt and attaching the
        // image — matches the natural beat where a user reaches for
        // their clipboard / file picker.
        await sleep(rand(400, 900));
        await attachImageDOM(composer, imageBlob, imageName);
      }
      // Final "review before send" pause. Real users almost never send
      // 0 ms after the last keystroke.
      await sleep(rand(500, 1200));
      await clickSendDOM(composer);
      await waitForIdleDOM(beforeCount);
      // DALL-E mode: ChatGPT's stop-button disappears early (the text
      // "tool" turn completes in seconds) while the actual assistant
      // message containing the generated image arrives 20-60 s later.
      // Wait for at least one assistant block past `beforeCount` to
      // exist before extracting, otherwise extractResponseDOM throws
      // DOM_NO_ASSISTANT_MESSAGE the moment the placeholder disappears.
      await waitFor(
        () => document.querySelectorAll(SEL.asstMsg).length > beforeCount,
        { timeout: 180000, interval: 250 },
      );
      // DALL-E images render AFTER the text stream finishes. Block until
      // the assistant message's image count settles (detector provides the
      // DALL-E-in-progress signal; no-op for text-only replies).
      await waitForImagesStableDOM({ detector });
      // Trust captured download URLs as OUTPUT images only when no INPUT
      // image was attached, or when the SSE stream confirmed a DALL-E
      // tool call. Prevents a re-rendered user upload from being ingested
      // as a generated image in the multimodal (image + prompt) path.
      const trustDownloads = !imageBlob || detector.dalleStarted;
      return await extractResponseDOM(detector, { trustDownloads });
    } finally {
      detector.teardown();
    }
  }

  // Expose for the fallback ladder in injected_chatgpt.js AND for a
  // manual smoke harness from the DevTools console.
  window.__FLOWBOARD_CHATGPT_DOM__ = {
    runGenerationDOM,
    startNewChatDOM,
    attachImageDOM,
    typePromptDOM,
    waitForImagesStableDOM,
    clickSendDOM,
    waitForIdleDOM,
    extractResponseDOM,
    installDalleDetector,
    _SEL: SEL,
    _loadedAt: new Date().toISOString(),
  };
  console.log('[Flowboard] DOM helper loaded at', window.__FLOWBOARD_CHATGPT_DOM__._loadedAt);
})();
}
