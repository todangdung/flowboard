/**
 * Pure-JS unit test for the SSE parser inside `injected_chatgpt.js`.
 *
 * We can't import the file directly because it's an IIFE that exposes
 * the parser on `window.__FLOWBOARD_CHATGPT_PARSE__`. Instead we use
 * Node's vm module to evaluate it inside a fake `window`-shaped sandbox.
 *
 * Run with `node tests/parser.test.js` from inside `extension/`.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');
// Cross-realm-safe deep-equality. Parser returns arrays/objects whose
// prototype chains live in the vm sandbox; strict equality compares
// [[Prototype]] which trips a false positive across realms. JSON
// round-trip flattens to host values for the comparison only.
function deepEqualJSON(actual, expected) {
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(actual)),
    JSON.parse(JSON.stringify(expected)),
  );
}

const EXT_DIR = path.resolve(__dirname, '..');

function loadParser() {
  const src = fs.readFileSync(path.join(EXT_DIR, 'injected_chatgpt.js'), 'utf8');
  // Don't pass Array/Object/JSON into the sandbox — vm.createContext
  // provides them as part of the host realm. Passing them in creates a
  // realm boundary that makes assert.deepEqual fail on prototype mismatch
  // even when structures are identical.
  const sandbox = {
    window: {
      // Stub addEventListener — the IIFE registers an event listener
      // when loaded. Parser tests don't exercise the event path; we just
      // need the bind to succeed so the parser-export line further down
      // runs.
      addEventListener: () => {},
    },
    fetch: async () => { throw new Error('fetch not used in parser tests'); },
    crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000000' },
    TextDecoder,
    setTimeout,
    clearTimeout,
    console,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (typeof sandbox.window.__FLOWBOARD_CHATGPT_PARSE__ !== 'function') {
    throw new Error('parser was not exposed on window.__FLOWBOARD_CHATGPT_PARSE__');
  }
  return sandbox.window.__FLOWBOARD_CHATGPT_PARSE__;
}

function asyncIterFromString(content, chunkSize = 64) {
  // Mimic what the real fetch reader emits: a stream of decoded string
  // chunks. We slice into small chunks to exercise the parser's buffer
  // join logic across event boundaries.
  return {
    [Symbol.asyncIterator]() {
      let pos = 0;
      return {
        async next() {
          if (pos >= content.length) return { value: undefined, done: true };
          const value = content.slice(pos, pos + chunkSize);
          pos += chunkSize;
          return { value, done: false };
        },
      };
    },
  };
}

async function runTests() {
  const parseSSEStream = loadParser();
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed += 1;
    } catch (e) {
      console.error(`✗ ${name}: ${e.message}`);
      if (e.stack) console.error(e.stack);
      failed += 1;
    }
  }

  await test('text-only stream — final text matches longest delta', async () => {
    const fixture = fs.readFileSync(path.join(EXT_DIR, 'tests/fixtures/chatgpt_sse_text_only.txt'), 'utf8');
    const result = await parseSSEStream(asyncIterFromString(fixture));
    assert.equal(result.text, 'Một con mèo dễ thương đang ngồi trên thảm xanh.');
    deepEqualJSON(result.asset_pointers, []);
    assert.equal(result.conversation_id, 'conv-text-only-001');
  });

  await test('text-only stream — handles tiny chunk sizes (split across events)', async () => {
    const fixture = fs.readFileSync(path.join(EXT_DIR, 'tests/fixtures/chatgpt_sse_text_only.txt'), 'utf8');
    // 7 bytes per chunk → splits mid-JSON. Parser must buffer correctly.
    const result = await parseSSEStream(asyncIterFromString(fixture, 7));
    assert.equal(result.text, 'Một con mèo dễ thương đang ngồi trên thảm xanh.');
  });

  await test('image stream — extracts asset_pointers in order', async () => {
    const fixture = fs.readFileSync(path.join(EXT_DIR, 'tests/fixtures/chatgpt_sse_with_image.txt'), 'utf8');
    const result = await parseSSEStream(asyncIterFromString(fixture));
    assert.equal(result.text, 'Đây là ảnh con mèo:');
    deepEqualJSON(result.asset_pointers, [
      'file-service://file-AAAABBBB',
      'file-service://file-CCCCDDDD',
    ]);
    assert.equal(result.conversation_id, 'conv-img-001');
  });

  await test('image stream — deduplicates repeated pointers', async () => {
    // Same asset_pointer in two deltas (ChatGPT does this as it streams
    // multimodal_text). Parser must keep each unique pointer once.
    const fixture = [
      'data: {"conversation_id": "c1", "message": {"id": "m", "author": {"role": "assistant"}, "content": {"content_type": "multimodal_text", "parts": [{"content_type": "image_asset_pointer", "asset_pointer": "file-service://file-X"}]}}}',
      '',
      'data: {"conversation_id": "c1", "message": {"id": "m", "author": {"role": "assistant"}, "content": {"content_type": "multimodal_text", "parts": [{"content_type": "image_asset_pointer", "asset_pointer": "file-service://file-X"}]}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const result = await parseSSEStream(asyncIterFromString(fixture));
    deepEqualJSON(result.asset_pointers, ['file-service://file-X']);
  });

  await test('malformed JSON line is skipped without throwing', async () => {
    const fixture = [
      'data: {"conversation_id": "c1", "message": {"id": "m", "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["before"]}}}',
      '',
      'data: {malformed json',
      '',
      'data: {"conversation_id": "c1", "message": {"id": "m", "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["after malformed"]}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const result = await parseSSEStream(asyncIterFromString(fixture));
    assert.equal(result.text, 'after malformed');
  });

  await test('stream without [DONE] still flushes final accumulated state', async () => {
    // Real fetch readers always close; we test that even if [DONE]
    // never arrives, the parser yields what it has when the iterator
    // ends rather than hanging.
    const fixture = [
      'data: {"conversation_id": "c1", "message": {"id": "m", "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["partial"]}}}',
      '',
    ].join('\n');
    const result = await parseSSEStream(asyncIterFromString(fixture));
    assert.equal(result.text, 'partial');
    assert.equal(result.conversation_id, 'c1');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
