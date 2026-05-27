/**
 * SHA3-512 — standalone implementation for ChatGPT free-tier PoW.
 *
 * The SHA-3 algorithm (FIPS PUB 202) is in the public domain. This
 * file is a clean-room JS port using 32-bit pair encoding for 64-bit
 * lanes; structure cross-referenced against emn178/js-sha3 (MIT). No
 * external dependencies — small enough to inline in a Chrome MV3
 * extension without bundling.
 *
 * Why we need it: ChatGPT free accounts gate `/backend-api/conversation`
 * behind a proof-of-work over a server-issued seed + difficulty. The
 * proof is `gAAAAAB + base64(json([screen, time, ..., counter, ...]))`
 * where SHA3-512(seed + base) starts with a hex prefix ≤ difficulty.
 * WebCrypto doesn't expose SHA-3 (only SHA-2 family), so we ship our
 * own. ~150 lines, runs ~10k iterations/sec in unoptimised V8 — fast
 * enough for the difficulty levels OpenAI currently issues (5–7 hex
 * chars; usually solved in <2k iters).
 *
 * Exports:
 *   window.sha3_512(input: Uint8Array | string) -> hex string (lowercase)
 *
 * License: MIT for this file.
 */
(function () {
  'use strict';

  // 24 round constants for Keccak-f[1600]. Each is a 64-bit value
  // expressed as [hi32, lo32] so JS bitwise ops stay 32-bit safe.
  const RC = [
    [0x00000000, 0x00000001], [0x00000000, 0x00008082],
    [0x80000000, 0x0000808a], [0x80000000, 0x80008000],
    [0x00000000, 0x0000808b], [0x00000000, 0x80000001],
    [0x80000000, 0x80008081], [0x80000000, 0x00008009],
    [0x00000000, 0x0000008a], [0x00000000, 0x00000088],
    [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
    [0x00000000, 0x8000808b], [0x80000000, 0x0000008b],
    [0x80000000, 0x00008089], [0x80000000, 0x00008003],
    [0x80000000, 0x00008002], [0x80000000, 0x00000080],
    [0x00000000, 0x0000800a], [0x80000000, 0x8000000a],
    [0x80000000, 0x80008081], [0x80000000, 0x00008080],
    [0x00000000, 0x80000001], [0x80000000, 0x80008008],
  ];

  // Rotation offsets r[x][y] for the ρ step.
  const R = [
    [ 0, 36,  3, 41, 18],
    [ 1, 44, 10, 45,  2],
    [62,  6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39,  8, 14],
  ];

  /** 64-bit rotate left, writing the result back into `out[0], out[1]`.
   *  We pre-allocate `out` and reuse it to avoid GC pressure inside the
   *  PoW hot loop. */
  function rotl(hi, lo, n, out) {
    if (n === 0) { out[0] = hi; out[1] = lo; return; }
    if (n === 32) { out[0] = lo; out[1] = hi; return; }
    if (n < 32) {
      const m = 32 - n;
      out[0] = (hi << n) | (lo >>> m);
      out[1] = (lo << n) | (hi >>> m);
    } else {
      const k = n - 32;
      const m = 32 - k;
      out[0] = (lo << k) | (hi >>> m);
      out[1] = (hi << k) | (lo >>> m);
    }
  }

  // Scratch buffers reused across rounds.
  const cHi = new Int32Array(5), cLo = new Int32Array(5);
  const dHi = new Int32Array(5), dLo = new Int32Array(5);
  const bHi = new Int32Array(25), bLo = new Int32Array(25);
  const tmp = new Int32Array(2);

  /** One pass of Keccak-f[1600] — 24 rounds of θ ρ π χ ι.
   *  `s` is a length-50 Int32Array: lane (x,y) sits at index 2*(5*y + x). */
  function keccakF(s) {
    for (let round = 0; round < 24; round++) {
      // θ — column parity
      for (let x = 0; x < 5; x++) {
        let h = 0, l = 0;
        for (let y = 0; y < 5; y++) {
          const i = 2 * (5 * y + x);
          h ^= s[i];
          l ^= s[i + 1];
        }
        cHi[x] = h;
        cLo[x] = l;
      }
      for (let x = 0; x < 5; x++) {
        rotl(cHi[(x + 1) % 5], cLo[(x + 1) % 5], 1, tmp);
        dHi[x] = cHi[(x + 4) % 5] ^ tmp[0];
        dLo[x] = cLo[(x + 4) % 5] ^ tmp[1];
      }
      for (let x = 0; x < 5; x++) {
        const dxH = dHi[x], dxL = dLo[x];
        for (let y = 0; y < 5; y++) {
          const i = 2 * (5 * y + x);
          s[i]     ^= dxH;
          s[i + 1] ^= dxL;
        }
      }

      // ρ + π — rotate each lane, permute to B
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const i = 2 * (5 * y + x);
          rotl(s[i], s[i + 1], R[x][y], tmp);
          const newPos = 5 * ((2 * x + 3 * y) % 5) + y;
          bHi[newPos] = tmp[0];
          bLo[newPos] = tmp[1];
        }
      }

      // χ — non-linear mixing
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
          const a = 5 * y + x;
          const b = 5 * y + ((x + 1) % 5);
          const c = 5 * y + ((x + 2) % 5);
          s[2 * a]     = bHi[a] ^ ((~bHi[b]) & bHi[c]);
          s[2 * a + 1] = bLo[a] ^ ((~bLo[b]) & bLo[c]);
        }
      }

      // ι — XOR round constant into lane (0,0)
      s[0] ^= RC[round][0];
      s[1] ^= RC[round][1];
    }
  }

  // Absorb `length` bytes from `data` starting at `offset` into the
  // state via XOR. Bytes are interpreted little-endian within each 8-byte
  // lane: byte 0 → lowest bits of lo, byte 7 → highest bits of hi.
  function absorbBlock(state, data, offset, length) {
    for (let i = 0; i < length; i++) {
      const byteVal = data[offset + i];
      if (byteVal === 0) continue;
      const laneIdx = i >>> 3;
      const byteInLane = i & 7;
      if (byteInLane < 4) {
        state[2 * laneIdx + 1] ^= byteVal << (8 * byteInLane);
      } else {
        state[2 * laneIdx + 0] ^= byteVal << (8 * (byteInLane - 4));
      }
    }
  }

  const HEX = '0123456789abcdef';

  function sha3_512(input) {
    let data;
    if (typeof input === 'string') {
      data = new TextEncoder().encode(input);
    } else if (input instanceof Uint8Array) {
      data = input;
    } else {
      data = new Uint8Array(input);
    }

    const rateBytes = 72; // SHA3-512: rate = 1600 - 1024 = 576 bits
    const state = new Int32Array(50);

    // Absorb full blocks
    const len = data.length;
    let offset = 0;
    while (offset + rateBytes <= len) {
      absorbBlock(state, data, offset, rateBytes);
      keccakF(state);
      offset += rateBytes;
    }

    // Final block with multi-rate padding (0x06 ... 0x80)
    const padBlock = new Uint8Array(rateBytes);
    const remaining = len - offset;
    if (remaining > 0) padBlock.set(data.subarray(offset, len), 0);
    padBlock[remaining] = 0x06;        // SHA-3 domain separator
    padBlock[rateBytes - 1] |= 0x80;   // final-block marker
    absorbBlock(state, padBlock, 0, rateBytes);
    keccakF(state);

    // Squeeze 64 bytes (= 8 lanes) as hex
    let hex = '';
    for (let i = 0; i < 8; i++) {
      const hi = state[2 * i];
      const lo = state[2 * i + 1];
      // Little-endian: lo bytes first (low to high), then hi
      const bytes = [
        lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, (lo >>> 24) & 0xff,
        hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, (hi >>> 24) & 0xff,
      ];
      for (let j = 0; j < 8; j++) {
        const b = bytes[j];
        hex += HEX[b >>> 4] + HEX[b & 0xf];
      }
    }
    return hex;
  }

  // Expose for both MAIN-world (window) and the Node test sandbox.
  if (typeof window !== 'undefined') window.sha3_512 = sha3_512;
  if (typeof globalThis !== 'undefined') globalThis.sha3_512 = sha3_512;
})();
