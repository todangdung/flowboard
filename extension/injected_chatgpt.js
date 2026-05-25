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
  const CHAT_REQUIREMENTS_URL = '/backend-api/sentinel/chat-requirements';
  const FILES_URL = '/backend-api/files';
  const AUTH_FETCH_FALLBACKS = [
    '/api/auth/session',          // NextAuth.js default (current best guess)
    '/backend-api/auth/session',  // legacy custom OpenAI endpoint
  ];

  const MIME_TO_EXT = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };

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

  /** Read width/height from an image blob via createImageBitmap, falling back
   *  to a hidden <img> element when bitmap decoding fails (animated GIFs and
   *  oversized images sometimes do). Returns {width, height} — both default
   *  to 0 if every probe fails, which the attachment metadata still accepts. */
  async function readImageDims(blob) {
    try {
      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(blob);
        const out = { width: bmp.width, height: bmp.height };
        if (typeof bmp.close === 'function') bmp.close();
        return out;
      }
    } catch {
      // fall through to <img> path
    }
    return await new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const out = { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
        URL.revokeObjectURL(url);
        resolve(out);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ width: 0, height: 0 });
      };
      img.src = url;
    });
  }

  /** Upload an image blob to ChatGPT's file storage. Three-step flow
   *  mirrored from lanqian528/chat2api `chatgpt/ChatService.py`
   *  (`get_upload_url`, `upload`, `get_download_url_from_upload`):
   *    1. POST /backend-api/files with the full chat2api body shape —
   *       `reset_rate_limits: false` + `timezone_offset_min` are
   *       required by the server in 2026; missing them returns 400.
   *    2. PUT raw bytes to the signed Azure Blob URL with the full
   *       Azure header set: `x-ms-blob-type` + `x-ms-version`. Without
   *       `x-ms-version` Azure returns 403 on some regions.
   *    3. POST /backend-api/files/{file_id}/uploaded — confirms upload
   *       and surfaces the CDN `download_url`.
   *    4. Poll /backend-api/files/{file_id} for
   *       `retrieval_index_status === "success"`. The conversation
   *       endpoint rejects asset_pointers whose retrieval indexing has
   *       not converged, so this poll is mandatory not optional.
   *
   *  Returns `{file_id, name, size, mime, width, height}` for embedding
   *  into the conversation body. Throws a structured code on any step
   *  failure so the agent surface gives an actionable error. */
  async function uploadImageAsAttachment(blob, name, token) {
    const mime = blob.type || 'image/png';
    const ext = MIME_TO_EXT[mime.toLowerCase()] || '.png';
    const fileName = name || `flowboard-${Date.now()}${ext}`;
    // chat2api convention: send the browser's actual timezone offset
    // in minutes, signed so positive = west of UTC (matches JS's
    // Date.getTimezoneOffset).
    const timezoneOffsetMin = new Date().getTimezoneOffset();

    // Step 1: register the file.
    const reg = await fetch(FILES_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'authorization': 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        file_name: fileName,
        file_size: blob.size,
        reset_rate_limits: false,
        timezone_offset_min: timezoneOffsetMin,
        use_case: 'multimodal',
      }),
    });
    if (!reg.ok) throw new Error(`FILE_REGISTER_${reg.status}`);
    const regJson = await reg.json();
    const uploadUrl = regJson.upload_url;
    const fileId = regJson.file_id;
    if (typeof uploadUrl !== 'string' || !uploadUrl) throw new Error('NO_UPLOAD_URL');
    if (typeof fileId !== 'string' || !fileId) throw new Error('NO_FILE_ID');

    // Step 2: PUT the raw bytes to Azure Blob. Headers cribbed from
    // chat2api `ChatService.upload`: `x-ms-version: 2020-04-08`
    // covers the regional rollouts that otherwise return 403.
    const putResp = await fetch(uploadUrl, {
      method: 'PUT',
      credentials: 'omit',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': mime,
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-version': '2020-04-08',
      },
      body: blob,
    });
    // Azure Blob returns 201 Created on success — chat2api's check
    // uses status_code == 201 explicitly. We accept any 2xx so a
    // future Azure rollout that switches to 200 doesn't break us.
    if (!putResp.ok) throw new Error(`FILE_PUT_${putResp.status}`);

    // Step 3: notify ChatGPT the upload completed.
    const confirm = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}/uploaded`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'authorization': 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!confirm.ok) throw new Error(`FILE_CONFIRM_${confirm.status}`);

    // Step 4: wait for retrieval indexing. chat2api polls 30 times at
    // 1 s — same cap here. The conversation call right after will
    // reject the asset_pointer with a 422 if we skip this step.
    let indexed = false;
    for (let i = 0; i < 30; i++) {
      const probe = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}`, {
        credentials: 'include',
        headers: {
          'authorization': 'Bearer ' + token,
          'accept': 'application/json',
        },
      });
      if (probe.ok) {
        let probeJson = {};
        try { probeJson = await probe.json(); } catch { /* tolerate */ }
        if (probeJson?.retrieval_index_status === 'success') {
          indexed = true;
          break;
        }
      }
      // 1 s sleep mirrors chat2api's poll cadence — slower than the
      // typical 200-300 ms indexing latency, but lighter on the
      // server than tighter polling.
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!indexed) throw new Error('FILE_INDEX_TIMEOUT');

    const { width, height } = await readImageDims(blob);
    return {
      file_id: fileId,
      name: fileName,
      size: blob.size,
      mime,
      width,
      height,
    };
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

  /** Replicate Python's `json.dumps(value)` default output (ensure_ascii=True,
   *  `, ` and `: ` separators). Critical for proof-of-work: the server
   *  recomputes SHA3-512 over the exact bytes we send, so a single
   *  whitespace difference breaks the proof.
   *
   *  Handles strings (with full \uXXXX escaping for non-ASCII), numbers,
   *  null, booleans, arrays. Plain objects aren't needed by the PoW
   *  payload (it's all top-level arrays) so we leave them unsupported. */
  function pyJsonEncode(v) {
    if (v === null) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') {
      let out = '"';
      for (let i = 0; i < v.length; i++) {
        const code = v.charCodeAt(i);
        const ch = v[i];
        if (ch === '\\') out += '\\\\';
        else if (ch === '"') out += '\\"';
        else if (code === 0x08) out += '\\b';
        else if (code === 0x09) out += '\\t';
        else if (code === 0x0a) out += '\\n';
        else if (code === 0x0c) out += '\\f';
        else if (code === 0x0d) out += '\\r';
        else if (code < 0x20 || code > 0x7e) {
          out += '\\u' + code.toString(16).padStart(4, '0');
        } else {
          out += ch;
        }
      }
      return out + '"';
    }
    if (Array.isArray(v)) {
      return '[' + v.map(pyJsonEncode).join(', ') + ']';
    }
    return JSON.stringify(v);
  }

  /** Build the proof token that satisfies the chat-requirements PoW.
   *  Mirrors gpt4free's `generate_proof_token` (Python) field-for-field
   *  so the server-side hash check passes. Returns the `gAAAAAB…` string
   *  or null when `required=false`. */
  function generateProofToken(required, seed, difficulty, userAgent) {
    if (!required) return null;
    if (typeof globalThis.sha3_512 !== 'function') {
      // Should never trigger — content script injects sha3.js first.
      throw new Error('SHA3_NOT_LOADED');
    }
    const screen = [3008, 4010, 6000][Math.floor(Math.random() * 3)]
      * [1, 2, 4][Math.floor(Math.random() * 3)];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const parseTime =
      dayNames[now.getUTCDay()] + ', ' +
      String(now.getUTCDate()).padStart(2, '0') + ' ' +
      monthNames[now.getUTCMonth()] + ' ' +
      now.getUTCFullYear() + ' ' +
      String(now.getUTCHours()).padStart(2, '0') + ':' +
      String(now.getUTCMinutes()).padStart(2, '0') + ':' +
      String(now.getUTCSeconds()).padStart(2, '0') + ' GMT';
    const reactListeners = ['_reactListeningcfilawjnerp', '_reactListening9ne2dfo1i47', '_reactListening410nzwhan2a'];
    const events = ['alert', 'ontransitionend', 'onprogress'];
    const proofToken = [
      screen, parseTime,
      null, 0, userAgent,
      'https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js',
      'dpl=1440a687921de39ff5ee56b92807faaadce73f13', 'en', 'en-US',
      null,
      'plugins−[object PluginArray]',
      reactListeners[Math.floor(Math.random() * 3)],
      events[Math.floor(Math.random() * 3)],
    ];
    const diffLen = (difficulty || '').length;
    for (let i = 0; i < 100000; i++) {
      proofToken[3] = i;
      const jsonData = pyJsonEncode(proofToken);
      const base = btoa(unescape(encodeURIComponent(jsonData)));
      const hashHex = globalThis.sha3_512(seed + base);
      if (diffLen > 0 && hashHex.slice(0, diffLen) <= difficulty) {
        return 'gAAAAAB' + base;
      }
    }
    // Fallback — matches gpt4free's last-resort string when difficulty is
    // unsolvable in 100k iters. Server sometimes accepts it; if not, we
    // surface a clear PoW_FAILED error from the conversation call.
    const fallback = btoa(unescape(encodeURIComponent('"' + seed + '"')));
    return 'gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + fallback;
  }

  /** Hit `/backend-api/sentinel/chat-requirements` to get the
   *  `openai-sentinel-chat-requirements-token` and any proof-of-work /
   *  turnstile / arkose challenges the server wants us to clear.
   *
   *  Returns null if the endpoint 404s (older accounts that skipped this
   *  gate) — callers proceed without sentinel headers. */
  async function fetchChatRequirements(token) {
    const resp = await fetch(CHAT_REQUIREMENTS_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'authorization': 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p: null }),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`CHAT_REQ_${resp.status}`);
    return await resp.json();
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

  function buildRequestBody(prompt, model, attachment) {
    // When an image attachment is supplied, switch the user message to
    // ChatGPT's `multimodal_text` shape. Order matters — the image
    // descriptor must precede the prompt text in `parts[]` for the
    // model to treat the text as referencing the image. The asset
    // descriptor uses bare `{asset_pointer, width, height, size_bytes}`
    // (NO content_type field on the descriptor itself — that field
    // only appears on the *response* side when ChatGPT echoes images).
    // The attachments[] metadata entry uses camelCase `mimeType` to
    // match what the ChatGPT web UI emits.
    const content = attachment
      ? {
          content_type: 'multimodal_text',
          parts: [
            {
              asset_pointer: 'file-service://' + attachment.file_id,
              size_bytes: attachment.size,
              width: attachment.width || 0,
              height: attachment.height || 0,
            },
            prompt,
          ],
        }
      : { content_type: 'text', parts: [prompt] };

    const metadata = attachment
      ? {
          attachments: [
            {
              id: attachment.file_id,
              name: attachment.name,
              size: attachment.size,
              mimeType: attachment.mime,
              width: attachment.width || 0,
              height: attachment.height || 0,
            },
          ],
        }
      : {};

    return {
      action: 'next',
      messages: [
        {
          id: crypto.randomUUID(),
          author: { role: 'user' },
          content,
          metadata,
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

  async function runGeneration(prompt, model, imageBlob, imageName) {
    const token = await getAccessToken();
    // Upload the image attachment first when present. We do this before
    // chat-requirements so a failure here surfaces as `FILE_REGISTER_*`
    // rather than burning a proof-of-work compute that we'd then drop.
    const attachment = imageBlob
      ? await uploadImageAsAttachment(imageBlob, imageName, token)
      : null;
    const body = buildRequestBody(prompt, model, attachment);

    // Free-tier accounts gate the conversation endpoint behind a
    // chat-requirements handshake (proof-of-work + sentinel token).
    // Plus accounts may skip it (server returns 404) — we run the call
    // unconditionally and just add whichever headers the server hands
    // us. Pre-flighting also lets us surface unsolvable challenges
    // (arkose / turnstile) as a clean error before burning the PoW
    // compute.
    const sentinelHeaders = {};
    let requirements = null;
    try {
      requirements = await fetchChatRequirements(token);
    } catch (err) {
      // 5xx / network — fall through and try the conversation anyway;
      // worst case the conversation 403s and the caller sees the error.
      console.warn('[Flowboard] chat-requirements failed:', err?.message || err);
    }
    if (requirements) {
      if (requirements.token) {
        sentinelHeaders['openai-sentinel-chat-requirements-token'] = requirements.token;
      }
      if (requirements.arkose && requirements.arkose.required) {
        // Arkose Funcaptcha is human-verification — no programmatic way
        // to satisfy from MAIN world. Surface as clear error so the
        // user knows the score (rather than a generic 403).
        throw new Error('ARKOSE_REQUIRED');
      }
      if (requirements.turnstile && requirements.turnstile.required) {
        // Same story — Cloudflare Turnstile needs the page's widget,
        // which we can't trigger from a sibling fetch.
        throw new Error('TURNSTILE_REQUIRED');
      }
      const pow = requirements.proofofwork;
      if (pow && pow.required) {
        const proofToken = generateProofToken(
          true,
          pow.seed || '',
          pow.difficulty || '',
          navigator.userAgent || ''
        );
        if (proofToken) sentinelHeaders['openai-sentinel-proof-token'] = proofToken;
      }
    }

    const buildHeaders = (authToken) => ({
      'authorization': 'Bearer ' + authToken,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...sentinelHeaders,
    });

    let resp = await fetch(CONVERSATION_URL, {
      method: 'POST',
      credentials: 'include',
      headers: buildHeaders(token),
      body: JSON.stringify(body),
    });

    if (resp.status === 401) {
      // Session token rotated — refetch once and retry. Don't loop;
      // a second 401 means cookies are gone and the user must re-login.
      const fresh = await getAccessToken(true);
      resp = await fetch(CONVERSATION_URL, {
        method: 'POST',
        credentials: 'include',
        headers: buildHeaders(fresh),
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

  // Errors that mean HTTP-direct cannot proceed but the DOM fallback
  // (which uses the page's own JS to render Cloudflare's challenge
  // widgets) can still drive a successful generation. Keep this list
  // narrow — fallback to DOM is slower (10-30 s) and brittle to UI
  // changes, so we only swap modes when the HTTP path is fundamentally
  // gated rather than transiently failing.
  const FALLBACK_ERROR_CODES = new Set([
    'TURNSTILE_REQUIRED',
    'ARKOSE_REQUIRED',
    'NO_ACCESS_TOKEN',
  ]);
  const FALLBACK_ERROR_PREFIXES = [
    'CONVERSATION_HTTP_403',
    'CONVERSATION_HTTP_429',
    'CHAT_REQ_403',
    'CHAT_REQ_429',
    'PoW_FAILED',
  ];

  function isFallbackError(err) {
    const m = (err && err.message) || '';
    if (FALLBACK_ERROR_CODES.has(m)) return true;
    if (m.startsWith('NO_ACCESS_TOKEN')) return true;
    return FALLBACK_ERROR_PREFIXES.some((p) => m.startsWith(p));
  }

  async function runGenerationWithImages(prompt, model, imageBlob, imageName) {
    // HTTP-direct first — when it works it is faster (no DOM polling),
    // hits the proper conversation endpoint, and survives UI refreshes
    // unscathed. Only fall back when the failure mode is one the DOM
    // path can plausibly fix.
    try {
      return await runGenerationWithImagesHTTP(prompt, model, imageBlob, imageName);
    } catch (err) {
      if (!isFallbackError(err)) throw err;
      const dom = window.__FLOWBOARD_CHATGPT_DOM__;
      if (!dom || typeof dom.runGenerationDOM !== 'function') {
        // DOM helper missing → re-throw the original error so the
        // caller surfaces the actual block, not a misleading
        // "DOM mode unavailable" string.
        throw err;
      }
      console.warn(`[Flowboard] HTTP-direct blocked (${err.message}); falling back to DOM mode`);
      const result = await dom.runGenerationDOM(prompt, imageBlob, imageName);
      // Tag the result so the agent's activity log can show which path
      // produced the answer. Useful when triaging "why is this slow?"
      // reports.
      return { ...result, http_fallback_reason: err.message };
    }
  }

  async function runGenerationWithImagesHTTP(prompt, model, imageBlob, imageName) {
    const token = await getAccessToken();
    const parsed = await runGeneration(prompt, model, imageBlob, imageName);

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
    return { ...parsed, images, mode: 'http' };
  }

  /** Decode a base64 string into a Blob with the given MIME. The agent
   *  ships images as base64 over the WS channel; we round-trip through
   *  binary so the file-upload PUT receives raw bytes (Azure Blob rejects
   *  text/plain bodies). Chunked decoding mirrors arrayBufferToBase64. */
  function base64ToBlob(b64, mime) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  window.addEventListener('FLOWBOARD_CHATGPT_GEN', async (e) => {
    const { requestId, prompt, model, image_b64, image_mime, image_name } = e.detail || {};
    try {
      const imageBlob = image_b64
        ? base64ToBlob(image_b64, image_mime || 'image/png')
        : null;
      const result = await runGenerationWithImages(prompt, model, imageBlob, image_name);
      window.dispatchEvent(new CustomEvent('FLOWBOARD_CHATGPT_RESULT', {
        detail: {
          requestId,
          text: result.text,
          asset_pointers: result.asset_pointers,
          images: result.images,
          conversation_id: result.conversation_id,
          mode: result.mode || null,
          http_fallback_reason: result.http_fallback_reason || null,
          paragen: result.paragen || false,
          assistant_count: result.assistant_count || null,
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
