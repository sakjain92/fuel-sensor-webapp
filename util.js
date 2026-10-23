// Small helpers shared by every module: clock, event emitter, bytes, Base64, hex. No DOM, no Web Bluetooth.

// A clock object so that time-dependent code can be driven by a manual clock in tests.
export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

export class Emitter {
  constructor() { this._h = new Map(); }
  // Returns a function that removes the listener.
  on(name, fn) {
    let set = this._h.get(name);
    if (!set) this._h.set(name, (set = new Set()));
    set.add(fn);
    return () => this.off(name, fn);
  }
  off(name, fn) { const set = this._h.get(name); if (set) set.delete(fn); }
  emit(name, ...args) {
    const set = this._h.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { console.error('handler for "' + name + '" failed:', e); }
    }
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s) => enc.encode(s);
export const utf8Decode = (b) => dec.decode(b);

export function concatBytes(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function toHex(bytes, sep = '') {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (i && sep ? sep : '') + (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

export function fromHex(hex) {
  const h = String(hex).replace(/[^0-9a-fA-F]/g, '');
  if (h.length % 2) throw new Error('odd number of hex digits');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = (() => { const m = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; return m; })();

// Standard Base64 (RFC 4648) with padding, no line breaks.
export function base64Encode(b) {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = b.length - i;
  if (rem === 1) {
    const n = b[i] << 16;
    out += B64[n >> 18] + B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

// Throws on characters outside the alphabet; accepts missing padding.
export function base64Decode(s) {
  s = String(s).replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_REV[c] : -1;
    if (v < 0) throw new Error('invalid Base64 character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; }
  }
  return out.subarray(0, o);
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
