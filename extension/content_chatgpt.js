/**
 * Content script for chatgpt.com — ISOLATED world bridge.
 *
 * Mirrors `content.js` (Flow bridge) but routes CHATGPT_GEN messages
 * from background.js into the MAIN world (`injected_chatgpt.js`)
 * where window.fetch lives in the page's auth context, and relays
 * results back to background.
 */
(function () {
  // Inject SHA3-512 first (defines window.sha3_512) — the chat-requirements
  // proof-of-work for free-tier ChatGPT depends on it. injected_chatgpt_dom.js
  // ships before injected_chatgpt.js so the latter's fallback ladder can
  // reach `window.__FLOWBOARD_CHATGPT_DOM__` at the moment of the first
  // request (rather than racing the load order on a slow Cloudflare edge).
  const root = document.head || document.documentElement;
  for (const file of ['sha3.js', 'injected_chatgpt_dom.js', 'injected_chatgpt.js']) {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL(file);
    s.onload = () => s.remove();
    root.appendChild(s);
  }
})();

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type !== 'CHATGPT_GEN') return;

  const { requestId, prompt, model, image_b64, image_mime, image_name } = msg;

  const handler = (e) => {
    if (e.detail?.requestId === requestId) {
      window.removeEventListener('FLOWBOARD_CHATGPT_RESULT', handler);
      clearTimeout(timer);
      reply(e.detail);
    }
  };

  // 120 s hard cap — ChatGPT text gen usually finishes in <30 s but
  // image gen on a busy queue can take up to a minute. Keep the worker
  // (`flow_client._send`) cap above this so the timeout wins here.
  const timer = setTimeout(() => {
    window.removeEventListener('FLOWBOARD_CHATGPT_RESULT', handler);
    reply({ requestId, error: 'CONTENT_TIMEOUT' });
  }, 120000);

  window.addEventListener('FLOWBOARD_CHATGPT_RESULT', handler);

  window.dispatchEvent(new CustomEvent('FLOWBOARD_CHATGPT_GEN', {
    detail: { requestId, prompt, model, image_b64, image_mime, image_name },
  }));

  return true; // keep channel open for async reply
});
