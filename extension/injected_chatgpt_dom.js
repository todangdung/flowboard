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
    asstMsg: '[data-message-author-role=assistant]',
    // ChatGPT renames this chip frequently. Cover the historical
    // data-testid plus newer variants (preview card, preview img,
    // attach-button image, blob/data URL preview inside composer).
    attachThumb: '[data-testid="attachment-thumbnail"], [data-testid="attachments-preview-card"], [data-testid="attachments-preview-img"], [data-testid*="attachment"], button[aria-label*="ttach" i] img, [class*="composer"] img[src^="blob:"], [class*="composer"] img[src^="data:"]',
    newChat: 'a[href="/"]:has(svg), nav a[href="/"]',
    // Match every oaiusercontent regional CDN variant (sdmntpr*, files,
    // dalle), plus cdn.openai.com (older path) and chatgpt.com-served
    // /files/* relative URLs. Lazy-load placeholders (data:, blob:) are
    // filtered downstream in extractResponseDOM, not here.
    cdnImg: 'img[src*="oaiusercontent"], img[src*="cdn.openai.com"], img[src*="/files/file-"]',
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
    composer.focus();
    // Clear any prior selection / stale composer text first so we
    // never append to leftover content.
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(composer);
    sel.addRange(range);
    try { document.execCommand('delete', false); } catch (_) { /* tolerate */ }

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
    const started = await waitFor(
      () =>
        document.querySelector(SEL.stopBtn) ||
        document.querySelectorAll(SEL.asstMsg).length > beforeCount,
      { timeout: 12000, interval: SAMPLE_INTERVAL_MS },
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

  /** DALL-E renders in the assistant message AFTER the text stream
   *  finishes — usually 1-4 s after stop-button disappears. Poll the
   *  last assistant block until the CDN-image count is stable for
   *  `stableMs` so extractResponseDOM doesn't snapshot mid-render. */
  async function waitForImagesStableDOM({ stableMs = 1500, timeout = 30000 } = {}) {
    const target = (() => {
      const msgs = document.querySelectorAll(SEL.asstMsg);
      return msgs[msgs.length - 1];
    })();
    if (!target) return;
    const isReal = (src) =>
      typeof src === 'string' && src && !src.startsWith('data:') && !src.startsWith('blob:');
    const countReal = () =>
      Array.from(target.querySelectorAll(SEL.cdnImg)).filter((i) => isReal(i.src)).length;
    const deadline = Date.now() + timeout;
    let lastCount = -1;
    let stableSince = null;
    while (Date.now() < deadline) {
      const c = countReal();
      if (c !== lastCount) {
        lastCount = c;
        stableSince = null;
      } else if (c === 0) {
        // No image arrived — give it a brief chance to start, then exit.
        if (stableSince === null) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return;
      } else if (stableSince === null) {
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableMs) {
        return;
      }
      await sleep(200);
    }
  }

  /** Read the last assistant message: text from innerText, images from
   *  CDN-hosted `<img>` tags. Each CDN image is fetched same-origin so
   *  Cloudflare cookies attach; the bytes are base64-encoded and packed
   *  into the same `{media_id, bytes_b64, mime, asset_pointer}` record
   *  shape `_handle_gen_chatgpt` already understands.
   *
   *  The conversation_id is recovered from `location.pathname` when
   *  ChatGPT has redirected to `/c/<id>` — chatgpt.com always rewrites
   *  the URL once the first turn lands, so this is reliable. */
  async function extractResponseDOM() {
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

    // Snapshot text BEFORE we touch any images — innerText excludes the
    // image alt-text on most browsers, which is what we want.
    const text = (target.innerText || target.textContent || '').trim();

    const cdnImgs = target.querySelectorAll(SEL.cdnImg);
    const images = [];
    for (const img of cdnImgs) {
      const src = img.src;
      if (!src) continue;
      // Skip placeholders / inline data URIs / blob previews. The CDN
      // selector is broad enough that lazy-load placeholders sneak in
      // before the real DALL-E URL swaps in.
      if (src.startsWith('data:') || src.startsWith('blob:')) continue;
      // Skip avatars/icons (≤ 64 px on either side). DALL-E outputs are
      // ≥ 512 px and the assistant block sometimes nests a profile
      // glyph that would otherwise be ingested as a stray image.
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w && h && (w < 96 || h < 96)) continue;
      try {
        const resp = await fetch(src, { credentials: 'include' });
        if (!resp.ok) {
          images.push({
            media_id: crypto.randomUUID(),
            error: `CDN_${resp.status}`,
            asset_pointer: src,
          });
          continue;
        }
        const buf = await resp.arrayBuffer();
        let mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!mime.startsWith('image/')) mime = 'image/webp';
        images.push({
          media_id: crypto.randomUUID(),
          bytes_b64: arrayBufferToBase64(buf),
          mime,
          asset_pointer: src,
        });
      } catch (err) {
        images.push({
          media_id: crypto.randomUUID(),
          error: err?.message || String(err),
          asset_pointer: src,
        });
      }
    }

    // conversation_id sources, in priority order:
    //   1. data-turn-id-container / data-turn-id on the assistant block
    //      (chatgpt 2026 stamps these on every turn — works even when
    //      the URL stays at `/` instead of redirecting to `/c/<id>`).
    //   2. URL `/c/<id>` (older chats that did redirect).
    //   3. null (we still return text + images; the agent tolerates
    //      a missing conversation_id).
    let conversation_id = null;
    const turnEl = target.closest(SEL.turnContainer);
    if (turnEl) {
      conversation_id =
        turnEl.getAttribute('data-turn-id-container') ||
        turnEl.getAttribute('data-turn-id') ||
        null;
    }
    if (!conversation_id) {
      const m = location.pathname.match(/^\/c\/([0-9a-f-]{8,})/i);
      if (m) conversation_id = m[1];
    }

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
      { timeout: 90000, interval: 250 },
    );
    // DALL-E images render AFTER the text stream finishes. Block until
    // the assistant message's image count settles so we don't snapshot
    // a half-rendered turn (no-op when ChatGPT replies text-only).
    await waitForImagesStableDOM();
    return await extractResponseDOM();
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
    _SEL: SEL,
    _loadedAt: new Date().toISOString(),
  };
  console.log('[Flowboard] DOM helper loaded at', window.__FLOWBOARD_CHATGPT_DOM__._loadedAt);
})();
