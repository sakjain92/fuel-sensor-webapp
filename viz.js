// The live radar echo of debug builds (PROTOCOL.md 9: `raw_start`, `raw` and `estimate` events). No DOM.
// A `raw` event carries one radar frame: num_points x (int16 I, int16 Q). The amplitude of a point is sqrt(I^2 + Q^2); its distance from
// the sensor chip is (start_point + i x step_length) x base_step_length_m.
import { Emitter, base64Decode, realClock } from './util.js';
import { ProtocolError } from './ble.js';
import { RawFeed } from './rawfeed.js';

// What the firmware sends today (core/rawlines.cpp); used when the reply carries no usable radar block.
export const RADAR_DEFAULT = Object.freeze({ start_point: -8, num_points: 169, step_length: 1, base_step_length_m: 0.002502274001017213 });

const FLAG_SATURATED = 1, FLAG_DELAYED = 2, FLAG_CAL = 4, FLAG_LOST = 8;
export const FLAGS = Object.freeze({ saturated: FLAG_SATURATED, delayed: FLAG_DELAYED, calibration: FLAG_CAL, lost: FLAG_LOST });

const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;

// The distance axis of a frame, from raw_start's `radar` block: {n, x0, dx, mm(i)} in millimetres.
export function vizAxis(radar) {
  const r = radar && typeof radar === 'object' ? radar : {};
  const ok = isInt(r.num_points, 2, 1024) && isInt(r.start_point, -4096, 4096) && isInt(r.step_length, 1, 1024)
    && Number.isFinite(r.base_step_length_m) && r.base_step_length_m > 0 && r.base_step_length_m < 0.1;
  const a = ok ? r : RADAR_DEFAULT;
  const dx = a.step_length * a.base_step_length_m * 1000;
  const x0 = a.start_point * a.base_step_length_m * 1000;
  const n = a.num_points;
  return { n, x0, dx, x1: x0 + (n - 1) * dx, mm: (i) => x0 + i * dx };
}

// One frame's amplitudes from the Base64 `iq` field, or null if the field is not n points of (int16 I, int16 Q).
export function decodeRawIq(b64, n) {
  if (typeof b64 !== 'string') return null;
  let b;
  try { b = base64Decode(b64); } catch (e) { return null; }
  if (b.length !== 4 * n) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const amp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const re = v.getInt16(4 * i, true), im = v.getInt16(4 * i + 2, true);
    amp[i] = Math.hypot(re, im);
  }
  return amp;
}

// The smallest 1, 2, 5 x 10^k that is at least v (at least `min`).
export function niceCeil(v, min = 100) {
  if (!(v > min)) return min;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Round tick values for an axis from lo to hi, about `count` of them.
export function niceTicks(lo, hi, count = 6) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
  const out = [];
  for (let x = Math.ceil(lo / step) * step; x <= hi + step * 1e-9; x += step) out.push(Math.round(x / step) * step || 0);          // (never -0)
  return out;
}

// Distance ranges and amplitude scales the page offers (hi null = to the end of the frame; max null = automatic).
export const RANGES = Object.freeze([
  { id: 'full', key: 'vizRangeFull', lo: null, hi: null },
  { id: '0-100', key: 'vizRange0100', lo: 0, hi: 100 },
  { id: '0-200', key: 'vizRange0200', lo: 0, hi: 200 },
  { id: '100-300', key: 'vizRange100300', lo: 100, hi: 300 },
]);
export const SCALES = Object.freeze([null, 500, 1000, 2000, 5000, 10000, 25000]);

// The frames of one raw_start session. `start()` asks for the stream, `stop()` ends it; 'frame', 'estimate' and 'change' events tell the page.
export class SensorViz extends Emitter {
  constructor({ client, clock = realClock, feed = null }) {
    super();
    Object.assign(this, { client, clock });
    this.feed = feed || new RawFeed({ client });         // shared with the recorder when the app passes its own
    this._held = false;                                   // we hold a share of the raw stream
    this.state = 'idle';            // idle | starting | running | error
    this.error = null;              // {code, text} after a failed start
    this.paused = false;
    this.peakHold = false;
    this._offs = [];
    this._reset();
  }
  _reset() {
    this.axis = vizAxis(null);
    this.amp = null;                // the newest frame shown (Float32Array)
    this.peak = null;               // per point maximum since the last reset (peak hold)
    this.seq = null;
    this.flags = 0;
    this.temp = null;
    this.frames = 0;                // frames shown since the start
    this.lost = 0;                  // frames missing from the sequence
    this.bad = 0;                   // frames that could not be read
    this.estimate = null;           // the newest `estimate` event
    this._times = [];               // arrival times of the last frames (for the frame rate)
    this._last = null;              // seq of the previous frame, shown or not
  }
  get running() { return this.state === 'running'; }
  // Frames per second over the last two seconds.
  get fps() {
    const now = this.clock.now();
    this._times = this._times.filter((t) => now - t <= 2000);
    return this._times.length ? this._times.length / 2 : 0;
  }

  async start() {
    if (this.state === 'starting' || this.state === 'running') return;
    this._reset();
    this.error = null;
    this.state = 'starting';
    this.emit('change');
    this._offs = [this.client.on('raw', (e) => this._raw(e)), this.client.on('estimate', (e) => this._estimate(e)),
      this.client.on('disconnected', () => this._ended())];
    try {
      const radar = await this.feed.acquire();
      this._held = true;
      if (this.state !== 'starting') { this._held = false; await this.feed.release(); return; }     // stopped while the sensor was answering
      this.axis = vizAxis(radar);
      this.state = 'running';
    } catch (e) {
      if (this.state !== 'starting') return;
      this._unhook();
      this.state = 'error';
      this.error = e instanceof ProtocolError ? { code: e.code, text: e.msg || e.code } : { code: 'error', text: (e && e.message) || 'error' };
    }
    this.emit('change');
  }
  async stop() {
    const was = this.state;
    this._unhook();
    this.state = 'idle';
    this.emit('change');
    if (this._held) { this._held = false; await this.feed.release(); }
  }
  _ended() {
    this._unhook();
    if (this._held) { this._held = false; this.feed.release(); }
    if (this.state === 'running' || this.state === 'starting') { this.state = 'idle'; this.emit('change'); }
  }
  _unhook() { for (const off of this._offs) off(); this._offs = []; }

  pause() { this.paused = true; this.emit('change'); }
  resume() { this.paused = false; this.emit('change'); }
  setPeakHold(on) {
    this.peakHold = !!on;
    this.peak = this.peakHold && this.amp ? Float32Array.from(this.amp) : null;
    this.emit('change');
  }
  resetPeak() { this.peak = this.peakHold && this.amp ? Float32Array.from(this.amp) : null; this.emit('change'); }

  _raw(e) {
    if (this.state !== 'running') return;
    const seq = Number.isFinite(e.seq) ? e.seq : null;            // the sequence first: a frame we cannot read did arrive, it is not lost
    if (seq !== null && this._last !== null && seq > this._last + 1 && seq - this._last < 1e6) this.lost += seq - this._last - 1;
    if (seq !== null) this._last = seq;
    const amp = decodeRawIq(e.iq, this.axis.n);
    if (!amp) { this.bad++; return; }
    this._times.push(this.clock.now());
    if (this.paused) return;                                // the stream goes on; the picture stands still
    this.amp = amp;
    this.seq = seq;
    this.flags = Number.isFinite(e.flags) ? e.flags : 0;
    this.temp = Number.isFinite(e.temp) ? e.temp : null;
    this.frames++;
    if (this.peakHold) {
      if (!this.peak) this.peak = Float32Array.from(amp);
      else for (let i = 0; i < amp.length; i++) if (amp[i] > this.peak[i]) this.peak[i] = amp[i];
    }
    this.emit('frame');
  }
  _estimate(e) {
    if (this.state !== 'running') return;
    this.estimate = { seq: e.seq, h: Number.isFinite(e.h) ? e.h : null, out: Number.isFinite(e.out) ? e.out : null, state: String(e.state || '') };
    this.emit('estimate');
  }

  // The strongest point in [lo, hi] mm of the newest frame, or null.
  strongest(lo, hi) {
    if (!this.amp) return null;
    let best = -1, bi = -1;
    for (let i = 0; i < this.amp.length; i++) {
      const d = this.axis.mm(i);
      if (d < lo || d > hi) continue;
      if (this.amp[i] > best) { best = this.amp[i]; bi = i; }
    }
    return bi < 0 ? null : { i: bi, mm: this.axis.mm(bi), amp: best };
  }
}
