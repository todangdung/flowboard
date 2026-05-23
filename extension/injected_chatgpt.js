/**
 * Injected into MAIN world on chatgpt.com.
 *
 * Drives ChatGPT prompt → response via the same `/backend-api/conversation`
 * SSE endpoint the page itself uses. Running in MAIN world means our
 * fetch carries the user's Cloudflare bot-detection fingerprint plus
 * the page's `credentials: include` cookies, so OpenAI sees a normal
 * page request rather than a service-worker proxy.
 *
 * Parsing approach (verified against gpt4free's OpenaiChat provider):
 *   - SSE deltas live on lines starting with `data: ` and the stream
 *     ends with `data: [DONE]`.
 *   - Each JSON payload has a `message.content` object whose `parts[]`
 *     enumerate the content chunks. We accumulate `parts[]` where
 *     `content_type === "text"` for the final text answer.
 *   - Image deltas (M2) arrive with `content_type === "image_asset_pointer"`
 *     and an `asset_pointer: "file-service://file-XXXX"` field.
 *
 * The function is a pure parser — easy to unit-test by feeding fixture
 * chunks via a fake reader.
 */
(function () {
  // ChatGPT's bootstrap path keeps moving — Apr 2026 the auth session
  // endpoint at `/backend-api/auth/session` returns 404 because the
  // frontend now hydrates the access token into `window.__remixContext`
  // and skips the network round-trip entirely (see gpt4free's
  // `OpenaiChat.py::nodriver_auth`).
  //
  // We try every known bootstrap in order so the extension keeps
  // working across OpenAI's tinkering. Each path returns null on miss
  // (rather than throwing), so the caller can fall through to the next.
  const CONVERSATION_URL = '/backend-api/conversation';
  const AUTH_FETCH_FALLBACKS = [
    '/api/auth/session',          // NextAuth.js default (current best guess)
    '/backend-api/auth/session',  // legacy custom OpenAI endpoint
  ];

  let cachedAccessToken = null;

  /** Convert an ArrayBuffer to base64. Chunked so we don't blow the
   *  argument count limit on String.fromCharCode for ~3 MB DALL-E images. */
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  /** UUID v4. Mirrors `crypto.randomUUID` but kept inline so the parser
   *  unit-test sandbox can stub it without breaking image dispatch. */
  function uuid() {
    return crypto.randomUUID();
  }

  /** Resolve a `file-service://file-XXXX` asset pointer to bytes.
   *  Two-step:
   *    1. GET /backend-api/conversation/{cid}/attachment/{fid}/download
   *       → JSON with a `download_url` field (pre-signed CDN URL).
   *    2. fetch(download_url) → ArrayBuffer.
   *
   *  The CDN URL is on files.oaiusercontent.com which serves with
   *  `credentials: include` from the chatgpt.com origin. Inferred MIME
   *  defaults to image/webp (current ChatGPT image format); we sniff the
   *  Content-Type header but keep webp as the floor. */
  async function downloadAsset(token, conversationId, assetPointer) {
    const fileId = assetPointer.replace(/^file-service:\/\//, '');
    if (!fileId) throw new Error('INVALID_ASSET_POINTER');

    const metaUrl = `/backend-api/conversation/${encodeURIComponent(conversationId)}/attachment/${encodeURIComponent(fileId)}/download`;
    let metaResp = await fetch(metaUrl, {
      credentials: 'include',
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    });
    if (metaResp.status === 401) {
      const fresh = await getAccessToken(true);
      metaResp = await fetch(metaUrl, {
        credentials: 'include',
        headers: { authorization: 'Bearer ' + fresh, accept: 'application/json' },
      });
    }
    if (!metaResp.ok) {
      throw new Error(`ATTACHMENT_META_${metaResp.status}`);
    }
    const meta = await metaResp.json();
    const url = meta?.download_url;
    if (typeof url !== 'string' || !url) throw new Error('NO_DOWNLOAD_URL');

    // CDN fetch — usually doesn't require Bearer (the URL itself is
    // signed), but `credentials: include` is harmless and preserves any
    // cookie auth ChatGPT layers in.
    const cdnResp = await fetch(url, { credentials: 'include' });
    if (!cdnResp.ok) throw new Error(`CDN_${cdnResp.status}`);
    const bytes = await cdnResp.arrayBuffer();
    let mime = cdnResp.headers.get('content-type') || '';
    mime = mime.split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) mime = 'image/webp';
    return { bytes, mime };
  }

  /** Extract the access token from one of three known locations:
   *    1. `window.__remixContext` — current ChatGPT hydrates the token here
   *       (cheapest, no network). Pattern from gpt4free OpenaiChat.py.
   *    2. `window.__NEXT_DATA__` — Next.js Pages Router hydration blob.
   *    3. Network fallback to `/api/auth/session` (NextAuth) and
   *       `/backend-api/auth/session` (legacy).
   *
   *  We surface a structured error listing what we tried so the agent's
   *  activity log makes the failure mode obvious. */
  function readTokenFromWindowContext() {
    const candidates = [
      () => window.__remixContext,
      () => window.__NEXT_DATA__,
      // Next.js App Router stuffs server context into __next_f as a stream
      // of `["0", "..."]` payloads; the token shows up inside one of them.
      () => window.__next_f,
    ];
    for (const get of candidates) {
      try {
        const ctx = get();
        if (!ctx) continue;
        const json = typeof ctx === 'string' ? ctx : JSON.stringify(ctx);
        const m = json.match(/"accessToken":"([^"\\]{20,})"/);
        if (m && m[1]) return m[1];
      } catch {
        // continue
      }
    }
    return null;
  }

  async function getAccessToken(force = false) {
    if (!force && cachedAccessToken) return cachedAccessToken;

    const fromCtx = readTokenFromWindowContext();
    if (fromCtx) {
      cachedAccessToken = fromCtx;
      return cachedAccessToken;
    }

    const errors = [];
    for (const url of AUTH_FETCH_FALLBACKS) {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) {
          errors.push(`${url}=${resp.status}`);
          continue;
        }
        const data = await resp.json();
        if (data?.accessToken) {
          cachedAccessToken = data.accessToken;
          return cachedAccessToken;
        }
        errors.push(`${url}=no_token`);
      } catch (err) {
        errors.push(`${url}=${err?.message || 'fetch_error'}`);
      }
    }
    throw new Error(`NO_ACCESS_TOKEN[ctx_miss,${errors.join(',')}]`);
  }

  function buildRequestBody(prompt, model) {
    return {
      action: 'next',
      messages: [
        {
          id: crypto.randomUUID(),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [prompt] },
          metadata: {},
        },
      ],
      // `auto` lets ChatGPT route to the appropriate underlying model
      // (currently `gpt-5-5`). Override only when the caller pins a value.
      model: model || 'auto',
      // null = start a fresh conversation. We deliberately do NOT reuse
      // any prior id so the user's manual ChatGPT chat never bleeds
      // into a Flowboard generation.
      conversation_id: null,
      parent_message_id: crypto.randomUUID(),
      conversation_mode: { kind: 'primary_assistant' },
      history_and_training_disabled: false,
      force_paragen: false,
      suggestions: [],
    };
  }

  /**
   * Pure SSE parser exported for unit tests.
   * Accepts an async iterable of decoded string chunks (already split
   * by the caller) and accumulates the final text + asset pointers.
   * Returns `{ text, asset_pointers, conversation_id }`.
   */
  async function parseSSEStream(chunkIter) {
    let buffer = '';
    let finalText = '';
    const assetPointers = [];
    let conversationId = null;

    for await (const chunk of chunkIter) {
      buffer += chunk;
      // SSE messages are separated by blank lines; handle line-by-line
      // so a chunk split in the middle of an event still parses.
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return { text: finalText, asset_pointers: assetPointers, conversation_id: conversationId };
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        if (evt.conversation_id) conversationId = evt.conversation_id;
        const msg = evt?.message;
        if (!msg) continue;
        const content = msg.content;
        if (!content) continue;
        // Snapshot text: each delta replaces (not appends to) the
        // current text body. We mirror that — keep the latest, longest
        // text we see so the final value at [DONE] is the full answer.
        if (content.content_type === 'text' && Array.isArray(content.parts)) {
          const joined = content.parts.filter((p) => typeof p === 'string').join('');
          if (joined.length > finalText.length) finalText = joined;
        }
        // M2: image asset pointers (left as a stub for now; harmless on M1).
        if (Array.isArray(content.parts)) {
          for (const p of content.parts) {
            if (p && typeof p === 'object' && p.content_type === 'image_asset_pointer' && typeof p.asset_pointer === 'string') {
              if (!assetPointers.includes(p.asset_pointer)) assetPointers.push(p.asset_pointer);
            }
          }
        }
      }
    }
    return { text: finalText, asset_pointers: assetPointers, conversation_id: conversationId };
  }

  // Expose parser for the unit-test harness. Detected via
  // `window.__FLOWBOARD_CHATGPT_PARSE__` in tests/parser.test.js.
  window.__FLOWBOARD_CHATGPT_PARSE__ = parseSSEStream;

  async function streamReaderToChunks(reader, decoder) {
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const { value, done } = await reader.read();
            if (done) return { value: undefined, done: true };
            return { value: decoder.decode(value, { stream: true }), done: false };
          },
        };
      },
    };
  }

  async function runGeneration(prompt, model) {
    const token = await getAccessToken();
    const body = buildRequestBody(prompt, model);

    let resp = await fetch(CONVERSATION_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'authorization': 'Bearer ' + token,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 401) {
      // Session token rotated — refetch once and retry. Don't loop;
      // a second 401 means cookies are gone and the user must re-login.
      const fresh = await getAccessToken(true);
      resp = await fetch(CONVERSATION_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'authorization': 'Bearer ' + fresh,
          'content-type': 'application/json',
          'accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
    }

    if (resp.status === 429) {
      let payload = null;
      try { payload = await resp.json(); } catch {}
      const err = new Error('RATE_LIMITED');
      err.retry_after = payload?.detail?.clears_in || payload?.retry_after || null;
      err.payload = payload;
      throw err;
    }

    if (!resp.ok) {
      throw new Error(`CONVERSATION_HTTP_${resp.status}`);
    }
    if (!resp.body) {
      throw new Error('NO_RESPONSE_BODY');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const iter = await streamReaderToChunks(reader, decoder);
    return await parseSSEStream(iter);
  }

  async function runGenerationWithImages(prompt, model) {
    const token = await getAccessToken();
    const parsed = await runGeneration(prompt, model);

    // M2: resolve any asset_pointers into bytes. Each pointer maps to
    // exactly one image attachment — DALL-E variants come as multiple
    // pointers in the same stream. We assign a fresh UUID per image
    // (agent-side keying) so media_service.ingest_inline_bytes can write
    // them straight into the local cache.
    const images = [];
    const conversationId = parsed.conversation_id;
    if (conversationId && Array.isArray(parsed.asset_pointers)) {
      for (const ptr of parsed.asset_pointers) {
        try {
          const { bytes, mime } = await downloadAsset(token, conversationId, ptr);
          const base64 = arrayBufferToBase64(bytes);
          images.push({
            media_id: uuid(),
            bytes_b64: base64,
            mime,
            asset_pointer: ptr,
          });
        } catch (err) {
          // Surface a per-image failure but keep going so a single
          // expired URL doesn't drop the whole batch.
          images.push({
            media_id: uuid(),
            error: err?.message || String(err),
            asset_pointer: ptr,
          });
        }
      }
    }
    return { ...parsed, images };
  }

  window.addEventListener('FLOWBOARD_CHATGPT_GEN', async (e) => {
    const { requestId, prompt, model } = e.detail || {};
    try {
      const result = await runGenerationWithImages(prompt, model);
      window.dispatchEvent(new CustomEvent('FLOWBOARD_CHATGPT_RESULT', {
        detail: {
          requestId,
          text: result.text,
          asset_pointers: result.asset_pointers,
          images: result.images,
          conversation_id: result.conversation_id,
        },
      }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent('FLOWBOARD_CHATGPT_RESULT', {
        detail: {
          requestId,
          error: err?.message || String(err),
          retry_after: err?.retry_after ?? null,
        },
      }));
    }
  });
})();
