// The field log of a simulated sensor (FIELDLOG.md): the encoders of the sensor's cells (sector header, MINUTE, EVENT, SNAPSHOT), a ring of
// sectors that answers flog_read like the firmware's, and a made-up log of four days for the demo. Used by fake_sensor.js (the demo and the
// tests); the app itself only reads logs (fieldlog.js). No DOM.
import { crc16, crc32, CELL, CELLS, EV, logIdText } from './fieldlog.js';

const clampInt = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round(x)));
const f32 = (x) => (x === null || x === undefined ? NaN : x);

// ---------------------------------------------------------------- encoders (physical units in; null = none)
export function encodeSectorHeader({ seq, boot = 0, uptime = 0, id = 0, sectors = 480, version = 1, cells = CELLS }) {
  const c = new Uint8Array(CELL).fill(0xff), v = new DataView(c.buffer);
  c.set([0x46, 0x4c, 0x47, 0x31], 0);
  v.setUint32(4, seq, true); v.setUint32(8, boot, true); v.setUint32(12, uptime, true);
  v.setUint16(16, version, true); v.setUint16(18, cells, true); v.setUint32(20, sectors, true); v.setUint32(24, id >>> 0, true);
  v.setUint32(28, crc32(c, 0, 28), true);
  return c;
}
function record(type, ncells, boot, uptime) {
  const b = new Uint8Array(ncells * CELL), v = new DataView(b.buffer);
  b[0] = 0xf1; b[1] = type; b[2] = ncells; b[3] = 1;
  v.setUint16(4, boot & 0xffff, true); v.setUint32(6, uptime, true);
  return { b, v };
}
const seal = (r) => { r.v.setUint16(30, crc16(r.b, 0, 30), true); return r.b; };

// o: {boot, uptime, level (mm), lmin, lmax (mm, absolute), hsurf, hfenv (mm), est, conf, up, down, state (0-4), src (0-3), fromEst, driven,
// doubt, bits (overrides the five before), pstd (degrees), temp (C), tiltx, tilty (degrees), vib (mg), out (percent; null = open), frames}
export function encodeMinute(o) {
  const r = record(1, 1, o.boot, o.uptime), v = r.v;
  const level = o.level === null || o.level === undefined ? null : o.level;
  v.setUint16(10, level === null ? 0xffff : clampInt(level * 100, 0, 0xfffe), true);
  const rel = (x) => (x === null || x === undefined || level === null ? -128 : clampInt((x - level) * 10, -127, 127));
  v.setInt8(12, rel(o.lmin)); v.setInt8(13, rel(o.lmax));
  const s16 = (x) => (x === null || x === undefined ? 0x7fff : clampInt(x * 100, -32767, 32766));
  v.setInt16(14, s16(o.hsurf), true); v.setInt16(16, s16(o.hfenv), true);
  r.b[18] = clampInt(o.est || 0, 0, 255); r.b[19] = clampInt(o.conf || 0, 0, 255);
  r.b[20] = (clampInt(o.up || 0, 0, 15) << 4) | clampInt(o.down || 0, 0, 15);
  r.b[21] = o.bits !== undefined ? o.bits : ((o.state === undefined ? 1 : o.state) & 7) | (((o.src === undefined ? 2 : o.src) & 3) << 3) | (o.fromEst === false ? 0 : 32) | (o.driven === false ? 0 : 64) | (o.doubt ? 128 : 0);
  r.b[22] = o.pstd === null || o.pstd === undefined ? 255 : clampInt(o.pstd * 4, 0, 254);
  v.setInt8(23, o.temp === null || o.temp === undefined ? -128 : clampInt(o.temp, -127, 127));
  v.setInt8(24, o.tiltx === null || o.tiltx === undefined ? -128 : clampInt(o.tiltx * 10, -127, 127));
  v.setInt8(25, o.tilty === null || o.tilty === undefined ? -128 : clampInt(o.tilty * 10, -127, 127));
  r.b[26] = o.vib === null || o.vib === undefined ? 255 : clampInt(o.vib, 0, 254);
  v.setUint16(27, o.out === null || o.out === undefined ? 0xffff : clampInt(o.out * 10, 0, 0xfffe), true);
  r.b[29] = clampInt((o.frames === undefined ? 600 : o.frames) / 4, 0, 255);
  return seal(r);
}
// o: {boot, uptime, code, a8, a16, x, y, z, w}
export function encodeEvent(o) {
  const r = record(2, 1, o.boot, o.uptime), v = r.v;
  r.b[10] = o.code; r.b[11] = o.a8 || 0; v.setInt16(12, o.a16 || 0, true);
  v.setFloat32(14, f32(o.x), true); v.setFloat32(18, f32(o.y), true); v.setFloat32(22, f32(o.z), true); v.setUint32(26, (o.w || 0) >>> 0, true);
  return seal(r);
}
// o: {boot, uptime, level, frames, reason, temp, bits, sEnv, bEnv, seq16, iq (Int16Array of 338), badData (corrupts the data after its CRC)}
export function encodeSnapshot(o) {
  const r = record(3, 23, o.boot, o.uptime), v = r.v;
  v.setUint16(10, o.level === null || o.level === undefined ? 0xffff : clampInt(o.level * 100, 0, 0xfffe), true);
  r.b[12] = o.frames === undefined ? 10 : o.frames; r.b[13] = o.reason === undefined ? 1 : o.reason; v.setInt8(14, o.temp === undefined ? 30 : o.temp); r.b[15] = o.bits === undefined ? 0x61 : o.bits;
  v.setFloat32(20, f32(o.sEnv), true); v.setFloat32(24, f32(o.bEnv), true); v.setUint16(28, (o.seq16 || 0) & 0xffff, true);
  const dv = new DataView(r.b.buffer, CELL, 22 * CELL);
  if (o.iq) for (let i = 0; i < o.iq.length && 2 * i + 1 < 352; i++) dv.setInt16(2 * i, o.iq[i], true);
  v.setUint32(16, crc32(r.b, CELL, 22 * CELL), true);
  if (o.badData) r.b[CELL + 5] ^= 0x55;
  return seal(r);
}

// ---------------------------------------------------------------- the ring
// A ring of sectors with the firmware's rules: sequence numbers from 1 (positions from 128), a record never crosses a sector end (the rest
// stays erased), the oldest sector goes when the ring is full, flog_read never reads past the end of a sector or the head.
export class SimLog {
  constructor({ sectors = 480, id = 0x1a2b3c4d } = {}) { this.sectors = sectors; this.idNum = id >>> 0; this.slots = new Map(); this.seq = 0; this.cell = CELLS; this.records = 0; }
  get id() { return logIdText(this.idNum); }
  get head() { return this.seq ? this.seq * CELLS + this.cell : 0; }
  get oldest() { return this.slots.size ? Math.min(...this.slots.keys()) * CELLS : 0; }
  _open(boot, uptime) {
    this.seq++;
    const s = new Uint8Array(CELLS * CELL).fill(0xff);
    s.set(encodeSectorHeader({ seq: this.seq, boot, uptime, id: this.idNum, sectors: this.sectors }), 0);
    this.slots.set(this.seq, s);
    this.slots.delete(this.seq - this.sectors);
    this.cell = 1;
  }
  // rec: the cells of one record. boot, uptime: for the header of a sector that has to be opened.
  append(rec, boot = 0, uptime = 0) {
    const n = rec.length / CELL;
    if (this.cell + n > CELLS) this._open(boot, uptime);
    this.slots.get(this.seq).set(rec, this.cell * CELL);
    this.cell += n;
    this.records++;
  }
  // flog_read: {pos, n, next, head, oldest, d (bytes)}
  read(pos, max = 42) {
    const head = this.head, oldest = this.oldest;
    if (!head || pos >= head) return { pos, n: 0, next: pos, head, oldest, d: new Uint8Array(0) };
    const p = Math.max(pos, oldest), seq = Math.floor(p / CELLS), c = p % CELLS;
    const n = Math.min(max, Math.min(head, (seq + 1) * CELLS) - p);
    return { pos: p, n, next: p + n, head, oldest, d: this.slots.get(seq).slice(c * CELL, (c + n) * CELL) };
  }
}

// ---------------------------------------------------------------- the demo log
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const LPMM = 1.38645, CAP_L = 240;

// The echo of a snapshot, made up like the demo's live radar frame (fake_sensor.js _rawFrame): the chip's own leakage, the floor, the surface.
function fakeEcho(level, rnd) {
  const iq = new Int16Array(2 * 169);
  const floor = 232.77 + 0.462 * level, surface = 232.77 - level;
  for (let i = 0; i < 169; i++) {
    const d = -20.018192 + 2.502274 * i;
    let a = d >= -12.5 ? 22000 * Math.exp(-(d + 12.5) / 12) : 22000 * Math.exp((d + 12.5) / 6);
    a += 5700 * Math.exp(-0.5 * ((d - floor) / 17) ** 2);
    if (level > 12) a += 420 * Math.exp(-0.5 * ((d - surface) / 10) ** 2);
    const ph = (4 * Math.PI * d) / 4.96;
    iq[2 * i] = clampInt(a * Math.cos(ph) + (rnd() - 0.5) * 30, -32768, 32767);
    iq[2 * i + 1] = clampInt(a * Math.sin(ph) + (rnd() - 0.5) * 30, -32768, 32767);
  }
  return iq;
}

// What the sensor holds: `demo` (default) fills it with four days of a made-up tank: three starts (the first two without a SYNC: the
// sensor did not know the time then; the SYNC of the last start is the previous visit, 34 hours ago), a fill and a drain, one level step of
// 5.4 mm, hourly snapshots, the wire open for two minutes after a start. opts.demo false: an empty log the test fills (append, minute, event).
export class FakeFieldLog {
  constructor({ clock, demo = true, sectors = 480, id = 0x5eed1e55, seed = 7, boot = 41 } = {}) {
    this.clock = clock;
    this.ring = new SimLog({ sectors, id });
    this.boot = boot;
    this.lastUptime = 0;
    this.dropped = 0;
    this.rnd = lcg(seed);
    this.anchorMs = clock.now();
    this.anchorUptime = 0;
    this.syncs = 0;
    if (demo) this._demo();
  }
  // the uptime of the current boot now (the demo log's last start went on running)
  nowUptime() { return Math.max(this.lastUptime, this.anchorUptime + Math.floor((this.clock.now() - this.anchorMs) / 1000)); }
  put(rec, uptime) { this.ring.append(rec, this.boot, uptime); this.lastUptime = Math.max(this.lastUptime, uptime); }
  minute(o) { this.put(encodeMinute({ boot: this.boot, ...o }), o.uptime); }
  event(o) { this.put(encodeEvent({ boot: this.boot, ...o }), o.uptime); }
  snapshot(o) { this.put(encodeSnapshot({ boot: this.boot, ...o }), o.uptime); }
  info() {
    const r = this.ring, empty = !r.head;
    return { on: true, log_id: r.id, sectors: r.sectors, cells: CELLS, oldest: empty ? 0 : r.oldest, head: r.head, boot: this.boot, uptime_s: this.nowUptime(), ver: 1, records: r.records, dropped: this.dropped };
  }
  // flog_sync / flog_note: an event at once, at the uptime of now
  sync(t, tz) { this.syncs++; this.event({ uptime: this.nowUptime(), code: EV.SYNC, a16: tz, w: t }); }
  note(kind, mm, litres, t) { this.event({ uptime: this.nowUptime(), code: EV.NOTE, a8: kind, x: kind === 1 ? mm : NaN, y: kind === 2 ? litres : NaN, w: t }); }

  _demo() {
    const rnd = this.rnd, nowS = Math.floor(this.clock.now() / 1000);
    const plan = [{ boot: 41, minutes: 2000 }, { boot: 42, minutes: 1400 }, { boot: 43, minutes: 2360 }];
    let level = 96.0, absMin = 0;
    plan.forEach((b, bi) => {
      this.boot = b.boot;
      const items = [];                                   // [uptime, order, fn]
      const at = (u, order, fn) => items.push([u, order, fn]);
      const stored = level;
      if (bi === 0) at(1, 0, () => this.event({ uptime: 1, code: EV.LOG_ON, a8: 1, w: 480 }));
      at(2, 1, () => this.event({ uptime: 2, code: EV.BOOT, a8: 1, x: bi === 0 ? NaN : stored, w: b.boot }));
      at(6, 1, () => this.event({ uptime: 6, code: EV.WIRE, a8: 1, a16: bi === 0 ? 1 : 2, x: stored, y: (stored * LPMM) / CAP_L * 100 }));
      at(12, 1, () => this.event({ uptime: 12, code: EV.FIRST_CONFIRM, x: stored, y: bi === 0 ? NaN : stored, z: 12 }));
      at(61, 2, () => this.snapshot({ uptime: 61, level: stored, reason: 2, temp: 30, sEnv: 232.77 - stored, bEnv: 232.77 + 0.462 * stored, iq: fakeEcho(stored, rnd) }));
      for (let h = 1; h * 3600 <= b.minutes * 60; h++) at(h * 3600 + 1, 2, () => this.snapshot({ uptime: h * 3600 + 1, level, reason: 1, temp: 30, sEnv: 232.77 - level, bEnv: 232.77 + 0.462 * level, iq: fakeEcho(level, rnd) }));
      if (bi === 2) {
        const u = 1200 * 60 + 5, t = nowS - (60 * b.minutes + 30 - u);               // the visit before: its SYNC dates this whole boot
        at(u, 1, () => this.event({ uptime: u, code: EV.SYNC, a16: 330, w: t }));
      }
      for (let m = 1; m <= b.minutes; m++) {
        const u = 60 * m, fill = bi === 0 && m >= 600 && m < 606, drain = bi === 1 && m >= 300 && m < 660, step = bi === 2 && m === 1500;
        at(u, 3, () => {
          absMin++;
          if (fill) level += 9.5; else if (drain) level -= 0.05; else level -= 0.004;
          const stepNow = step ? 5.4 : 0;
          const before = level;
          level += stepNow;
          const lv = level + (rnd() - 0.5) * 0.1, young = m <= 3, open = bi === 1 && m <= 2;
          if (step) {
            this.event({ uptime: u - 20, code: EV.STEP, a8: 1, a16: 1, x: before, y: level, z: before + 0.4, w: 2 });
            this.snapshot({ uptime: u - 19, level, reason: 3, temp: 31, sEnv: 232.77 - level, bEnv: 232.77 + 0.462 * level, iq: fakeEcho(level, rnd) });
          }
          this.minute({
            uptime: u, level: lv, lmin: lv - 0.1 - (fill ? 8 : 0), lmax: lv + 0.1, hsurf: young ? null : lv + (rnd() - 0.5) * 0.6, hfenv: young ? null : lv * 0.982 + (rnd() - 0.5) * 0.8,
            est: fill ? 200 : 240, conf: young ? [0, 60, 180][m - 1] : fill ? 120 : 240, up: step ? 1 : 0, down: 0,
            state: young || fill ? 2 : 1, src: young ? 0 : 2, fromEst: !young, driven: !open, doubt: fill,
            pstd: 2.5 + rnd(), temp: Math.round(30 + 6 * Math.sin((2 * Math.PI * absMin) / 1440)), tiltx: -0.3 + (rnd() - 0.5) * 0.1, tilty: 0.7 + (rnd() - 0.5) * 0.1,
            vib: fill ? 40 : 3 + (rnd() < 0.1 ? 2 : 0), out: open ? null : (lv * LPMM) / CAP_L * 100, frames: 600,
          });
        });
      }
      items.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      for (const it of items) it[2]();
    });
    this.anchorUptime = 60 * plan[2].minutes + 30;
    this.anchorMs = this.clock.now();
  }
}
