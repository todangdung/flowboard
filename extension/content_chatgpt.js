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
  // proof-of-work for free-tier ChatGPT depends on it. injected_chatgpt.js
  // is appended second so it can reference the helper at module init.
  const root = document.head || document.documentElement;
  for (const file of ['sha3.js', 'injected_chatgpt.js']) {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL(file);
    s.onload = () => s.remove();
    root.appendChild(s);
  }
})();

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type !== 'CHATGPT_GEN') return;

  const { requestId, prompt, model } = msg;

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
    detail: { requestId, prompt, model },
  }));

  return true; // keep channel open for async reply
});
