// The field log of firmware 3.0.3 (FIELDLOG.md is the contract): the decoder of the sensor's cells, the time of every record, the numbers
// and series the Field log page shows, the saved file, and the download over the JSON-lines protocol. No DOM, no Web Bluetooth.
//
//   decodeLog(pages)         cells -> records (MINUTE, EVENT, SNAPSHOT), counts of erased, damaged and unreadable cells
//   layoutTime(records)      the time of each record: dated through a SYNC event of its boot, else placed between its neighbours
//   buildSeries / summarize  what the plots and the tiles use
//   buildFieldLogFile        the .jsonl file (FIELDLOG.md 10)
//   FieldLog                 the download (flog_sync, flog_info, flog_read ...), the store, the notes, the check before a firmware update
import { Emitter, base64Decode, base64Encode, realClock, utf8 } from './util.js';
import { ProtocolError, TimeoutError, DisconnectedError } from './ble.js';
import { phoneClock } from './core.js';
import { parseRefValue } from './recorder.js';

// ---------------------------------------------------------------- layout constants (FIELDLOG.md 2-5)
export const CELL = 32, CELLS = 128, PAGE_CELLS = 42;
export const FORMAT_VERSION = 1;
export const SNAP_CELLS = 23, SNAP_POINTS = 169, SNAP_START_MM = -20.018192, SNAP_STEP_MM = 2.502274;
export const T_MINUTE = 1, T_EVENT = 2, T_SNAPSHOT = 3;
export const EV = Object.freeze({ BOOT: 1, LOG_ON: 2, FIRST_CONFIRM: 3, STEP: 4, STATE: 5, WIRE: 6, EVLOG: 7, SYNC: 8, NOTE: 9 });
const EV_NAMES = Object.freeze({ 1: 'boot', 2: 'log_on', 3: 'first_confirm', 4: 'step', 5: 'state', 6: 'wire', 7: 'evlog', 8: 'sync', 9: 'note' });
export const NOTE_KINDS = Object.freeze({ DIPSTICK: 1, FUEL: 2, OTHER: 3 });
export const STATE_NAMES = Object.freeze(['none', 'confirmed', 'uncertain', 'holding', 'fault']);
export const MIN_SYNC_UNIX = 1700000000;                  // a SYNC with an earlier time (a phone whose clock was never set) dates nothing
export const CELLS_PER_DAY = 2048;                        // about (FIELDLOG.md 8: 65 KB a day): turns a count of cells into a rough time
export const UNREAD_CELLS = 64;                           // less than this on the sensor and not on the phone is not worth a warning before an update

// ---------------------------------------------------------------- checksums
let T16 = null, T32 = null;
// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, not reflected, no final xor.
export function crc16(b, o = 0, n = b.length - o) {
  if (!T16) { T16 = new Uint16Array(256); for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; T16[i] = c; } }
  let c = 0xffff;
  for (let i = 0; i < n; i++) c = ((c << 8) & 0xffff) ^ T16[((c >> 8) ^ b[o + i]) & 0xff];
  return c;
}
// CRC-32 (IEEE 802.3, the zlib crc32).
export function crc32(b, o = 0, n = b.length - o) {
  if (!T32) { T32 = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; T32[i] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < n; i++) c = (c >>> 8) ^ T32[(c ^ b[o + i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- cells
const view = (c) => new DataView(c.buffer, c.byteOffset, c.byteLength);
export function isErased(c) { for (let i = 0; i < c.length; i++) if (c[i] !== 0xff) return false; return true; }
const fin = (x) => (Number.isFinite(x) ? x : null);

// The log id in a flog_info reply: 8 hex digits, or "" before a log is mounted. FIELDLOG.md 7 calls the key `id`, but a reply already has an
// `id` (the request's), so the sensor must send it under another name: `log_id` is read first, a text `id` is taken as a fallback.
export function infoLogId(info) {
  const v = info && info.log_id !== undefined ? info.log_id : info && typeof info.id === 'string' ? info.id : '';
  return typeof v === 'string' ? v.toLowerCase() : '';
}
// The log id as the sensor tells it in flog_info: 8 hex digits.
export const logIdText = (u) => (u >>> 0).toString(16).padStart(8, '0');
// The sector header (cell 0): {ok, seq, boot, uptime, version, cells, sectors, logId}, or {ok: false, erased} (erased cell) or {ok: false, reason}.
export function parseSectorHeader(c) {
  if (isErased(c)) return { ok: false, erased: true };
  if (c[0] !== 0x46 || c[1] !== 0x4c || c[2] !== 0x47 || c[3] !== 0x31) return { ok: false, erased: false, reason: 'magic' };
  const v = view(c);
  if (crc32(c, 0, 28) !== v.getUint32(28, true)) return { ok: false, erased: false, reason: 'crc' };
  return { ok: true, seq: v.getUint32(4, true), boot: v.getUint32(8, true), uptime: v.getUint32(12, true), version: v.getUint16(16, true), cells: v.getUint16(18, true), sectors: v.getUint32(20, true), logId: logIdText(v.getUint32(24, true)) };
}

// The first cell of a record, or null when byte 0 is not 0xF1 or the CRC-16 of bytes 0-29 fails.
export function parseRecordHead(c) {
  if (c[0] !== 0xf1) return null;
  const v = view(c);
  if (crc16(c, 0, 30) !== v.getUint16(30, true)) return null;
  return { type: c[1], ncells: c[2], ver: c[3], boot: v.getUint16(4, true), uptime: v.getUint32(6, true) };
}

function parseMinute(c) {
  const v = view(c);
  const lv = v.getUint16(10, true), none = (x) => x === 0x7fff;
  const level = lv === 0xffff ? null : lv / 100;
  const rel = (b) => (level === null || b === -128 ? null : level + b / 10);
  const hs = v.getInt16(14, true), hf = v.getInt16(16, true), bits = c[21], steps = c[20];
  const tilt = (b) => (b === -128 ? null : b / 10);
  const out = v.getUint16(27, true);
  return {
    level, lmin: rel(v.getInt8(12)), lmax: rel(v.getInt8(13)), hsurf: none(hs) ? null : hs / 100, hfenv: none(hf) ? null : hf / 100,
    est: c[18], conf: c[19], up: steps >> 4, down: steps & 15,
    bits, state: bits & 7, src: (bits >> 3) & 3, fromEst: !!(bits & 32), driven: !!(bits & 64), doubt: !!(bits & 128),
    pstd: c[22] === 255 ? null : c[22] / 4, temp: v.getInt8(23) === -128 ? null : v.getInt8(23),
    tiltx: tilt(v.getInt8(24)), tilty: tilt(v.getInt8(25)), vib: c[26] === 255 ? null : c[26],
    out: out === 0xffff ? null : out / 10, open: out === 0xffff, frames: c[29] * 4,
  };
}

function parseEvent(c) {
  const v = view(c);
  const e = { code: c[10], name: EV_NAMES[c[10]] || 'unknown', a8: c[11], a16: v.getInt16(12, true), x: fin(v.getFloat32(14, true)), y: fin(v.getFloat32(18, true)), z: fin(v.getFloat32(22, true)), w: v.getUint32(26, true) };
  switch (e.code) {
    case EV.BOOT: e.reason = e.a8; e.stored = e.x; e.bootFull = e.w; break;
    case EV.LOG_ON: e.formatted = e.a8 === 1; e.sectors = e.w; e.trialEndUptime = e.x; break;
    case EV.FIRST_CONFIRM: e.level = e.x; e.stored = e.y; e.afterS = e.z; e.buckets = e.a16; break;
    case EV.STEP: e.buckets = e.a16; e.state = e.a8; e.from = e.x; e.to = e.y; e.surf = e.z; e.src = e.w; break;
    case EV.STATE: e.state = e.a8; e.was = e.a16; e.level = e.x; e.inOldS = e.z; e.missed = e.w; break;
    case EV.WIRE: e.driven = e.a8 === 1; e.why = e.a16; e.used = e.x; e.pct = e.y; break;
    case EV.SYNC: e.unix = e.w; e.tz = e.a16; break;
    case EV.NOTE: e.noteKind = e.a8; e.mm = e.x; e.litres = e.y; e.unix = e.w; break;
    default: break;
  }
  return e;
}

// A snapshot: the first cell and the 22 cells of echo that follow. ok = the CRC-32 of the 704 data bytes holds.
function parseSnapshot(cells) {
  const c = cells[0], v = view(c);
  const data = new Uint8Array(22 * CELL);
  for (let i = 0; i < 22; i++) data.set(cells[1 + i], i * CELL);
  const ok = crc32(data) === v.getUint32(16, true);
  const s = { ok, level: v.getUint16(10, true) === 0xffff ? null : v.getUint16(10, true) / 100, frames: c[12], reason: c[13], temp: v.getInt8(14), bits: c[15], sEnv: fin(v.getFloat32(20, true)), bEnv: fin(v.getFloat32(24, true)), seq16: v.getUint16(28, true), iq: null };
  if (ok) {
    const dv = view(data), iq = new Int16Array(2 * SNAP_POINTS);
    for (let i = 0; i < iq.length; i++) iq[i] = dv.getInt16(2 * i, true);
    s.iq = iq;
  }
  return s;
}

// The fields of a record's first cell as they are written (FIELDLOG.md 3-5, raw record units; NaN stays NaN): for tests and tools.
export function rawFields(c) {
  const v = view(c), type = c[1], o = { type, ncells: c[2], boot: v.getUint16(4, true), uptime: v.getUint32(6, true) };
  if (type === T_MINUTE) Object.assign(o, { level: v.getUint16(10, true), lmin: v.getInt8(12), lmax: v.getInt8(13), hsurf: v.getInt16(14, true), hfenv: v.getInt16(16, true), est: c[18], conf: c[19], steps: c[20], bits: c[21], pstd: c[22], temp: v.getInt8(23), tiltx: v.getInt8(24), tilty: v.getInt8(25), vib: c[26], out: v.getUint16(27, true), frames: c[29] });
  else if (type === T_EVENT) Object.assign(o, { code: c[10], a8: c[11], a16: v.getInt16(12, true), x: v.getFloat32(14, true), y: v.getFloat32(18, true), z: v.getFloat32(22, true), w: v.getUint32(26, true) });
  else if (type === T_SNAPSHOT) Object.assign(o, { level: v.getUint16(10, true), frames: c[12], reason: c[13], temp: v.getInt8(14), bits: c[15], crc: v.getUint32(16, true), sEnv: v.getFloat32(20, true), bEnv: v.getFloat32(24, true), seq16: v.getUint16(28, true) });
  return o;
}

// ---------------------------------------------------------------- the decoder
// pages: [{pos, n, d}] (d = n x 32 bytes), in any order, overlapping or not (the same cell twice must be the same bytes). logId: the id of
// the log (8 hex digits): a sector of another id is not part of it (FIELDLOG.md 2); null takes every id.
// Returns {records (by position), sectors, stats}. A sector whose header is erased or fails its CRC holds nothing. In the others,
// an erased cell is skipped, and a cell that does not start a record counts as damaged (FIELDLOG.md 2). A record whose cells are not all
// here (the download is not finished) is counted as incomplete, not as damaged.
export function decodeLog(pages, { logId = null } = {}) {
  const cells = new Map();
  for (const p of pages) for (let i = 0; i < p.n; i++) cells.set(p.pos + i, p.d.subarray(i * CELL, i * CELL + CELL));
  const seqs = [...new Set([...cells.keys()].map((p) => Math.floor(p / CELLS)))].sort((a, b) => a - b);
  const records = [], sectors = [];
  const stats = { cells: cells.size, erased: 0, damaged: 0, badSectors: 0, foreignSectors: 0, unsupportedSectors: 0, incomplete: 0, minutes: 0, events: 0, snapshots: 0, badSnapshots: 0, unknown: 0 };
  for (const seq of seqs) {
    const base = seq * CELLS, hc = cells.get(base);
    let hdr = null;
    if (hc) {
      hdr = parseSectorHeader(hc);
      if (!hdr.ok) {                                          // holds nothing: what is written there cannot be used
        if (!hdr.erased) stats.badSectors++;
        for (let c = 0; c < CELLS; c++) { const x = cells.get(base + c); if (x && !isErased(x)) stats.damaged++; }
        sectors.push({ seq, ok: false, reason: hdr.erased ? 'erased' : hdr.reason });
        continue;
      }
      if (hdr.seq !== seq) {
        stats.badSectors++;
        for (let c = 0; c < CELLS; c++) { const x = cells.get(base + c); if (x && !isErased(x)) stats.damaged++; }
        sectors.push({ seq, ok: false, reason: 'seq' });
        continue;
      }
      if (logId !== null && hdr.logId !== String(logId).toLowerCase()) { stats.foreignSectors++; sectors.push({ seq, ok: false, reason: 'id' }); continue; }
      if (hdr.version !== FORMAT_VERSION || hdr.cells !== CELLS) { stats.unsupportedSectors++; sectors.push({ seq, ok: false, reason: 'version' }); continue; }
    }
    sectors.push({ seq, ok: true, header: !!hdr, boot: hdr ? hdr.boot : null, uptime: hdr ? hdr.uptime : null, logId: hdr ? hdr.logId : null });
    for (let c = 1; c < CELLS;) {
      const cell = cells.get(base + c);
      if (!cell) { c++; continue; }
      if (isErased(cell)) { stats.erased++; c++; continue; }
      const h = parseRecordHead(cell);
      if (!h || h.ncells < 1 || c + h.ncells > CELLS) { stats.damaged++; c++; continue; }
      const parts = [cell];
      for (let k = 1; k < h.ncells; k++) { const x = cells.get(base + c + k); if (!x) break; parts.push(x); }
      const rec = { pos: base + c, seq, cell: c, boot: h.boot, uptime: h.uptime, ncells: h.ncells, bytes: cell };
      if (parts.length < h.ncells) { stats.incomplete++; c += h.ncells; continue; }
      if (h.ver !== 1 || ![T_MINUTE, T_EVENT, T_SNAPSHOT].includes(h.type)) { rec.kind = 'other'; rec.type = h.type; stats.unknown++; }
      else if (h.type === T_MINUTE) { rec.kind = 'minute'; Object.assign(rec, parseMinute(cell)); stats.minutes++; }
      else if (h.type === T_EVENT) { rec.kind = 'event'; Object.assign(rec, parseEvent(cell)); stats.events++; }
      else if (h.ncells !== SNAP_CELLS) { rec.kind = 'snapshot'; rec.ok = false; rec.iq = null; stats.snapshots++; stats.badSnapshots++; }
      else { rec.kind = 'snapshot'; Object.assign(rec, parseSnapshot(parts)); stats.snapshots++; if (!rec.ok) stats.badSnapshots++; }
      records.push(rec);
      c += h.ncells;
    }
  }
  return { records, sectors, stats };
}

// ---------------------------------------------------------------- time (FIELDLOG.md 6)
// Boots are the runs of records with the same boot number, in the order of the positions. A boot with a SYNC event is dated: every
// record has `t` (unix seconds) = sync.w + (uptime - sync.uptime), from the SYNC nearest in uptime. A boot with none is not: it lies after
// the boot before and before the boot after, the time the sensor was off unknown. For the plots every record also gets `tl`, a time on one
// axis: the real time for dated boots; for the others a place after the end of the boot before (or, before the first dated boot, ahead of
// it), so that their order is kept. {boots, anyDated, tMin, tMax, datedFrom, datedTo, datedS, undatedS}
export function layoutTime(records) {
  const boots = [];
  let cur = null;
  for (const r of records) {
    if (!cur || cur.boot !== r.boot) { cur = { index: boots.length, boot: r.boot, first: r.uptime, last: r.uptime, n: 0, syncs: [], dated: false, lStart: 0, lEnd: 0, overlap: false }; boots.push(cur); }
    cur.n++;
    if (r.uptime < cur.first) cur.first = r.uptime;
    if (r.uptime > cur.last) cur.last = r.uptime;
    if (r.kind === 'event' && r.code === EV.SYNC && r.unix >= MIN_SYNC_UNIX) cur.syncs.push({ uptime: r.uptime, unix: r.unix, tz: r.tz });
    r.bootIndex = cur.index;
  }
  for (const b of boots) b.dated = b.syncs.length > 0;
  const at = (b, u) => {                                       // the SYNC nearest in uptime (the earlier one on a tie)
    let s = b.syncs[0];
    for (const x of b.syncs) if (Math.abs(x.uptime - u) < Math.abs(s.uptime - u)) s = x;
    return s.unix + (u - s.uptime);
  };
  for (const b of boots) if (b.dated) { b.lStart = at(b, b.first); b.lEnd = at(b, b.last); }
  const firstDated = boots.findIndex((b) => b.dated);
  if (firstDated < 0) {
    let x = 0;
    for (const b of boots) { b.lStart = x; b.lEnd = x + (b.last - b.first); x = b.lEnd; }
  } else {
    for (let j = firstDated - 1; j >= 0; j--) { const b = boots[j]; b.lEnd = boots[j + 1].lStart; b.lStart = b.lEnd - (b.last - b.first); }
    let prevEnd = boots[firstDated].lEnd;
    for (let j = firstDated + 1; j < boots.length; j++) {
      const b = boots[j];
      if (!b.dated) { b.lStart = prevEnd; b.lEnd = prevEnd + (b.last - b.first); }
      prevEnd = b.lEnd;
    }
    for (let j = 0; j + 1 < boots.length; j++) if (!boots[j].dated && boots[j].lEnd > boots[j + 1].lStart + 1) boots[j].overlap = true;
  }
  for (const r of records) {
    const b = boots[r.bootIndex];
    if (b.dated) { r.t = at(b, r.uptime); r.tl = r.t; } else { r.t = null; r.tl = b.lStart + (r.uptime - b.first); }
  }
  const dated = boots.filter((b) => b.dated);
  const out = {
    boots, anyDated: dated.length > 0,
    tMin: boots.length ? Math.min(...boots.map((b) => b.lStart)) : 0, tMax: boots.length ? Math.max(...boots.map((b) => b.lEnd)) : 0,
    datedFrom: dated.length ? Math.min(...dated.map((b) => b.lStart)) : null, datedTo: dated.length ? Math.max(...dated.map((b) => b.lEnd)) : null,
    datedS: dated.reduce((s, b) => s + (b.lEnd - b.lStart), 0), undatedS: boots.filter((b) => !b.dated).reduce((s, b) => s + (b.last - b.first), 0),
  };
  return out;
}

// ---------------------------------------------------------------- series, ranges, ticks
// The MINUTE records as columns (NaN where the record has no value), and the markers. Records in the order of the positions.
export function buildSeries(records) {
  const m = records.filter((r) => r.kind === 'minute');
  const n = m.length, col = () => new Float64Array(n);
  const s = { n, tl: col(), t: col(), level: col(), lmin: col(), lmax: col(), hsurf: col(), hfenv: col(), temp: col(), vib: col(), tiltx: col(), tilty: col(), est: col(), conf: col(), open: new Uint8Array(n), boot: new Int32Array(n), uptime: col(), sorted: true };
  const nan = (x) => (x === null || x === undefined ? NaN : x);
  m.forEach((r, i) => {
    s.tl[i] = r.tl; s.t[i] = r.t === null ? NaN : r.t; s.level[i] = nan(r.level); s.lmin[i] = nan(r.lmin); s.lmax[i] = nan(r.lmax); s.hsurf[i] = nan(r.hsurf); s.hfenv[i] = nan(r.hfenv);
    s.temp[i] = nan(r.temp); s.vib[i] = nan(r.vib); s.tiltx[i] = nan(r.tiltx); s.tilty[i] = nan(r.tilty); s.est[i] = r.est; s.conf[i] = r.conf; s.open[i] = r.open ? 1 : 0; s.boot[i] = r.bootIndex; s.uptime[i] = r.uptime;
    if (i && s.tl[i] < s.tl[i - 1]) s.sorted = false;
  });
  s.markers = records.filter((r) => r.kind === 'event' && (r.code === EV.BOOT || r.code === EV.STEP)).map((r) => ({ kind: r.code === EV.BOOT ? 'boot' : 'step', tl: r.tl, boot: r.bootIndex, buckets: r.buckets || 0, level: r.code === EV.STEP ? r.to : null, reason: r.reason }));
  return s;
}

export const RANGES = Object.freeze([{ id: '24h', key: 'flRange_24h', s: 86400 }, { id: '4d', key: 'flRange_4d', s: 4 * 86400 }, { id: 'all', key: 'flRange_all', s: null }]);
// The window of the plots: the last `s` seconds up to the newest record, or everything.
export function rangeWindow(timeline, id) {
  const r = RANGES.find((x) => x.id === id) || RANGES[RANGES.length - 1];
  const hi = timeline.tMax;
  return { lo: r.s === null ? timeline.tMin : Math.max(timeline.tMin, hi - r.s), hi: hi > timeline.tMin ? hi : timeline.tMin + 60 };
}
// Runs of minutes with the wire open, as [t0, t1] (a minute covers the 60 s before its time), never across a start.
export function openRuns(s) {
  const runs = [];
  let run = null;
  for (let i = 0; i < s.n; i++) {
    if (s.open[i] && run && run.boot === s.boot[i] && s.tl[i] - run.t1 <= 61) run.t1 = s.tl[i];
    else if (s.open[i]) { run = { boot: s.boot[i], t0: s.tl[i] - 60, t1: s.tl[i] }; runs.push(run); } else run = null;
  }
  return runs.map((r) => [r.t0, r.t1]);
}
// Confirmed estimates per hour of the axis: [{t (start of the hour), est, conf, pct}] inside [lo, hi].
export function confirmedPerHour(s, lo, hi) {
  const m = new Map();
  for (let i = 0; i < s.n; i++) {
    if (s.tl[i] < lo || s.tl[i] > hi || !(s.est[i] > 0)) continue;
    const h = Math.floor(s.tl[i] / 3600);
    const e = m.get(h) || { t: h * 3600, est: 0, conf: 0 };
    e.est += s.est[i]; e.conf += s.conf[i];
    m.set(h, e);
  }
  return [...m.values()].sort((a, b) => a.t - b.t).map((e) => ({ ...e, pct: (100 * e.conf) / e.est }));
}
// The index of the minute nearest to time t (-1 when there are none).
export function nearestIndex(s, t) {
  if (!s.n) return -1;
  if (!s.sorted) { let b = 0; for (let i = 1; i < s.n; i++) if (Math.abs(s.tl[i] - t) < Math.abs(s.tl[b] - t)) b = i; return b; }
  let lo = 0, hi = s.n - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s.tl[mid] < t) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(s.tl[lo - 1] - t) <= Math.abs(s.tl[lo] - t) ? lo - 1 : lo;
}
// Time-axis ticks between lo and hi (unix seconds, or seconds of the layout when nothing is dated): about `count` of them at round
// hours or days of the phone's time zone (tzMin minutes east of UTC). [{t, label (HH:MM, or 'D Mon' at a day), day (a date tick)}].
const STEPS = [600, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 432000, 864000];
export function timeTicks(lo, hi, count, tzMin, months) {
  if (!(hi > lo)) return [];
  const want = (hi - lo) / Math.max(1, count);
  const step = STEPS.find((s) => s >= want) || STEPS[STEPS.length - 1];
  const off = tzMin * 60, out = [];
  const p2 = (n) => String(n).padStart(2, '0');
  for (let t = Math.ceil((lo + off) / step) * step - off; t <= hi + 1e-6; t += step) {
    const d = new Date((t + off) * 1000);
    const day = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
    out.push({ t, day: day || step >= 86400, label: day || step >= 86400 ? d.getUTCDate() + ' ' + months[d.getUTCMonth()] : p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) });
  }
  return out;
}
// The same for an axis in hours since the first record (nothing is dated): [{t, label '12 h'}].
export function elapsedTicks(lo, hi, count) {
  if (!(hi > lo)) return [];
  const want = (hi - lo) / Math.max(1, count);
  const step = STEPS.find((s) => s >= want && s >= 3600) || STEPS[STEPS.length - 1];
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-6; t += step) out.push({ t, day: false, label: Math.round(t / 3600) + ' h' });
  return out;
}

// ---------------------------------------------------------------- the numbers of the page
// Reset reasons of ESP-IDF (esp_reset_reason_t): power (power-on 1, brownout 9), restart (software 3, external 2, deep sleep 8), fault (the rest).
export function resetGroup(reason) { return reason === 1 || reason === 9 ? 'power' : reason === 3 || reason === 2 || reason === 8 ? 'restart' : 'fault'; }
export function summarize(decoded, timeline, series) {
  const r = decoded.records, st = decoded.stats;
  const boots = r.filter((x) => x.kind === 'event' && x.code === EV.BOOT);
  const steps = r.filter((x) => x.kind === 'event' && x.code === EV.STEP);
  let est = 0, conf = 0, open = 0;
  for (let i = 0; i < series.n; i++) { est += series.est[i]; conf += series.conf[i]; open += series.open[i]; }
  const groups = { power: 0, restart: 0, fault: 0 };
  for (const b of boots) groups[resetGroup(b.reason)]++;
  return {
    datedDays: timeline.datedFrom === null ? 0 : (timeline.datedTo - timeline.datedFrom) / 86400, datedFrom: timeline.datedFrom, datedTo: timeline.datedTo,
    undatedHours: timeline.undatedS / 3600, bootsTotal: timeline.boots.length, undatedBoots: timeline.boots.filter((b) => !b.dated).length,
    minutes: series.n, starts: boots.length, startGroups: groups,
    steps: steps.length, stepsUp: steps.filter((x) => x.buckets > 0).length, stepsDown: steps.filter((x) => x.buckets < 0).length,
    confPct: est > 0 ? (100 * conf) / est : null, wireOpenMin: open,
    damaged: st.damaged, snapshots: st.snapshots, badSnapshots: st.badSnapshots, events: st.events, badSectors: st.badSectors, incomplete: st.incomplete,
  };
}

// ---------------------------------------------------------------- the saved file (FIELDLOG.md 10)
const p2 = (n) => String(n).padStart(2, '0');
export function flogFileName(mac, key, nowMs, tzMin) {
  const d = new Date(nowMs + tzMin * 60000);
  return 'MRM-FLOG-' + mac + '-' + key + '-' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + '-' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + '.jsonl';
}
// pages: [{pos, n, d}] (any order); the file holds each cell once, the pages cut where they overlap. visits: the visit lines, oldest first.
export function buildFieldLogFile({ mac, logId, key = '', name = '', build = '', nowMs = Date.now(), tzMin = 0, tank = null, visits = [], pages = [] }) {
  const header = { format: 'mrm-field-log', version: 1, mac, log_id: logId, name: name || 'PROCOM-SENSOR-' + mac, saved_iso: new Date(nowMs).toISOString(), app_build: build };
  if (tank) {
    const t = {};
    for (const [k, v] of [['cap_l', tank.cap_l], ['l_mm', tank.l_mm], ['w_mm', tank.w_mm], ['h_mm', tank.h_mm], ['lpmm', tank.lpmm]]) if (Number.isFinite(v)) t[k] = v;
    header.tank = t;
  }
  const lines = [JSON.stringify(header)];
  for (const v of visits) lines.push(JSON.stringify(v));
  let end = -1;
  for (const p of [...pages].sort((a, b) => a.pos - b.pos)) {
    if (p.pos + p.n <= end) continue;
    let pos = p.pos, n = p.n, d = p.d;
    if (pos < end) { const cut = end - pos; pos = end; n -= cut; d = d.subarray(cut * CELL); }
    lines.push(JSON.stringify({ ev: 'pg', pos, n, d: base64Encode(d.subarray(0, n * CELL)) }));
    end = pos + n;
  }
  const text = lines.join('\n') + '\n';
  return { name: flogFileName(mac, key || logId, nowMs, tzMin), text, bytes: utf8(text), lines: lines.length, mime: 'text/plain' };
}
// A saved file back to {header, visits, pages} (the laptop's decoder does the same in Python; the tests use this one).
export function parseFieldLogFile(text) {
  const out = { header: null, visits: [], pages: [] };
  for (const l of text.split('\n')) {
    if (!l) continue;
    const o = JSON.parse(l);
    if (o.format === 'mrm-field-log') out.header = o;
    else if (o.ev === 'visit') out.visits.push(o);
    else if (o.ev === 'pg') out.pages.push({ pos: o.pos, n: o.n, d: base64Decode(o.d) });
  }
  return out;
}

// ---------------------------------------------------------------- the notes of the person at the tank
// What a NOTE needs: kind 1 a dipstick reading (0-400 mm), kind 2 litres of fuel added (minus: taken out, not 0), kind 3 nothing.
// Returns {ok, kind, mm, litres} or {ok: false, err: 'empty' | 'number' | 'range' | 'zero'}.
export function parseNote(kind, text) {
  kind = Number(kind);
  if (kind === NOTE_KINDS.OTHER) return { ok: true, kind, mm: 0, litres: 0 };
  if (kind === NOTE_KINDS.DIPSTICK) { const p = parseRefValue(text, { min: 0, max: 400 }); return p.ok ? { ok: true, kind, mm: p.v, litres: 0 } : p; }
  if (kind === NOTE_KINDS.FUEL) {
    const p = parseRefValue(text, { min: -5000, max: 5000 });
    if (!p.ok) return p;
    return p.v === 0 ? { ok: false, err: 'zero' } : { ok: true, kind, mm: 0, litres: p.v };
  }
  return { ok: false, err: 'kind' };
}

// ---------------------------------------------------------------- the download
const RETRIES = 3;
const isLinkError = (e) => e instanceof DisconnectedError || (e && e.name === 'DisconnectedError');
const isTimeout = (e) => e instanceof TimeoutError || (e && e.name === 'TimeoutError');
class Stop extends Error { constructor(reason, text) { super(text || reason); this.reason = reason; } }

export class FieldLog extends Emitter {
  // store: flogstore.js. app: {build}. tzOffsetMin(): minutes WEST of UTC, like Date.getTimezoneOffset().
  constructor({ client, store, clock = realClock, app = {}, tzOffsetMin = () => new Date().getTimezoneOffset() }) {
    super();
    Object.assign(this, { client, store, clock, app, tzOffsetMin });
    this._run = null;
  }
  get busy() { return this._run !== null; }
  get mac() { const h = this.client.hello; return h && h.mac ? String(h.mac).toUpperCase() : ''; }
  abort() { if (this._run) this._run.aborted = true; }

  async _ask(cmd, fields = {}, opts = {}) {
    for (let k = 1; ; k++) {
      if (this._run && this._run.aborted) throw new Stop('cancelled');
      try { return await this.client.request(cmd, fields, opts); } catch (e) {
        if (isTimeout(e) && k < RETRIES) continue;                          // the sensor was busy: ask again
        throw e;
      }
    }
  }
  async info() { return this._ask('flog_info'); }

  // One flog_read, checked: {pos, n, next, head, oldest, d (bytes)}.
  async _read(pos) {
    for (let k = 1; ; k++) {
      const r = await this._ask('flog_read', { pos });
      let d = null;
      if (Number.isInteger(r.pos) && Number.isInteger(r.n) && r.n >= 0 && r.n <= 64 && typeof r.d === 'string') { try { d = base64Decode(r.d); } catch (e) { d = null; } }
      if (d && d.length === r.n * CELL && r.pos >= pos) return { pos: r.pos, n: r.n, next: Number.isInteger(r.next) && r.next >= r.pos + r.n ? r.next : r.pos + r.n, head: Number.isInteger(r.head) ? r.head : null, oldest: Number.isInteger(r.oldest) ? r.oldest : null, d };
      if (k >= RETRIES) throw new Stop('bad_reply', 'the sensor sent a page that does not fit');
    }
  }

  // Is the log on the sensor the one the phone has under this key? Same id, and the sector of the last cell the phone holds reads the same
  // there (a firmware written again into the same slot has the same id and starts at 128 again). Reads that sector's start and compares it, and
  // the cells after it, with what is stored. true / false / null (cannot tell: that sector is gone from the sensor, or nothing stored there).
  async _sameLog(mac, key, last) {
    const lastCell = last.pos + last.n - 1, sector = Math.floor(lastCell / CELLS) * CELLS;
    const r = await this._read(sector);
    if (r.pos !== sector || r.n === 0) return null;
    const c = await this.store.compare(mac, key, { pos: r.pos, n: r.n, d: r.d });
    if (c.conflict > 0) return false;
    return c.same > 0 ? true : null;
  }
  // The newest stored log of this id: its doc, or null.
  async _logOf(mac, id) {
    const all = (await this.store.gens(mac)).filter((g) => g.id === id);
    return all.length ? all[all.length - 1] : null;
  }

  // The newest data to the phone. Resolves {ok, complete, reason, ...}; never throws for a link or sensor problem (the pages that came
  // are stored as they arrive: starting again carries on from the last one).
  async download({ onProgress } = {}) {
    if (this._run) throw new Error('a download is running');
    const mac = this.mac;
    if (!mac) throw new Error('not connected');
    const run = this._run = { aborted: false };
    const res = { ok: false, complete: false, reason: '', error: '', from: null, to: null, head: null, oldest: null, cells: 0, bytes: 0, pages: 0, lost: [], newLog: false, key: '', id: '', synced: false, info: null, empty: false, why: '' };
    const prog = (phase, extra = {}) => { if (onProgress) try { onProgress({ phase, cells: res.cells, bytes: res.bytes, pages: res.pages, from: res.from, to: res.to, head: res.head, ...extra }); } catch (e) { /* the page is gone */ } };
    let status = null, pos = null;
    const startedMs = this.clock.now();
    try {
      prog('sync');
      const pc = phoneClock(startedMs, this.tzOffsetMin());
      try { await this._ask('flog_sync', { t: pc.t, tz: pc.tz_min }); res.synced = true; } catch (e) {
        if (isLinkError(e) || e instanceof Stop) throw e;                   // (no clock written: the records of this boot stay undated; the rest goes on)
        res.syncError = (e && e.code) || (e && e.message) || 'error';
      }
      const info = res.info = await this._ask('flog_info');
      if (info.ver !== undefined && info.ver !== FORMAT_VERSION) throw new Stop('unsupported', 'log format ' + info.ver);
      if (info.cells !== undefined && info.cells !== CELLS) throw new Stop('unsupported', 'cells per sector ' + info.cells);
      res.why = info.why || '';
      const id = res.id = infoLogId(info);
      if (!id) { res.empty = true; res.complete = true; res.ok = true; prog('end'); return res; }          // no log mounted (a trial, an update going on, no slot)
      if (!Number.isInteger(info.oldest) || !Number.isInteger(info.head)) throw new Stop('bad_reply', 'flog_info without positions');
      res.head = info.head; res.oldest = info.oldest;
      try { const st = await this._ask('status'); const { id: i, ok, ...rest } = st; status = rest; } catch (e) { if (isLinkError(e) || e instanceof Stop) throw e; }
      prog('info');

      // which stored log is this one, and where does the next page start
      let doc = await this._logOf(mac, id), from = info.oldest;
      if (doc) {
        const last = await this.store.last(mac, doc.key);
        if (last) {
          if (info.head < last.next) doc = null;                            // positions only grow: this log was started again
          else if (await this._sameLog(mac, doc.key, last) === false) doc = null;
          else from = last.next;
        }
      }
      if (!doc) { res.newLog = !!(await this._logOf(mac, id)) || !!(await this.store.device(mac)); doc = await this.store.newLog(mac, id, startedMs); from = info.oldest; }
      let key = res.key = doc.key;
      res.from = pos = from; res.to = from;
      prog('read');

      let head = info.head, restarts = 0;
      for (let guard = 0; guard < 20000; guard++) {
        if (pos >= head) break;
        const r = await this._read(pos);
        if (r.head !== null) head = r.head;
        res.head = head;
        if (r.oldest !== null) res.oldest = r.oldest;
        if (r.pos > pos) res.lost.push({ from: pos, to: r.pos, cells: r.pos - pos });        // overwritten on the sensor before it was read
        if (r.n === 0) break;
        const add = await this.store.addPage(mac, key, { pos: r.pos, n: r.n, d: r.d, next: r.next });
        if (add.conflict > 0) {                                             // the cells here are not the cells the phone holds: another log
          if (++restarts > 1) throw new Stop('log_changed', 'the log on the sensor keeps changing');
          doc = await this.store.newLog(mac, id, this.clock.now());
          key = res.key = doc.key;
          res.newLog = true; res.cells = 0; res.bytes = 0; res.pages = 0; res.lost = [];
          res.from = pos = info.oldest; res.to = pos;
          continue;
        }
        res.cells += r.n; res.bytes += r.n * CELL; res.pages++;
        pos = r.next; res.to = pos;
        prog('read');
      }
      res.complete = true; res.ok = true;
    } catch (e) {
      if (e instanceof Stop) { res.reason = e.reason; res.error = e.message; } else if (isLinkError(e)) res.reason = 'link_lost';
      else if (isTimeout(e)) res.reason = 'timeout';
      else if (e instanceof ProtocolError) { res.reason = 'protocol'; res.error = e.code + (e.msg ? ': ' + e.msg : ''); } else { res.reason = 'error'; res.error = (e && e.message) || String(e); }
    } finally {
      this._run = null;
    }
    // the visit line and what the page needs next time (also after a stop: the pages that came are kept)
    if (res.info && res.key && (res.complete || res.cells > 0)) {
      try {
        const info = res.info, h = this.client.hello || {};
        const t = status && status.tank ? status.tank : null;
        const pc = phoneClock(startedMs, this.tzOffsetMin());
        const visit = {
          ev: 'visit', id: res.id, phone_ms: startedMs, tz_min: pc.tz_min, fw: (status && status.fw) || h.fw || '', calibration: status && status.calibration !== undefined ? status.calibration : null, variant: (status && status.variant) || h.variant || '',
          boot: info.boot === undefined ? null : info.boot, uptime_s: info.uptime_s === undefined ? null : info.uptime_s, oldest: info.oldest, head: info.head, from: res.from, to: res.to, status: status || {},
        };
        if (res.lost.length) visit.lost = res.lost.map((l) => [l.from, l.to]);
        await this.store.addVisit(mac, res.key, visit);
        const cur = (await this.store.device(mac)) || { mac };
        await this.store.putDevice({ ...cur, mac, name: 'PROCOM-SENSOR-' + mac, cur: res.key, tank: t ? { cap_l: t.cap_l, l_mm: t.l_mm, w_mm: t.w_mm, h_mm: t.h_mm, lpmm: t.lpmm } : cur.tank || null, updated: this.clock.now() });
      } catch (e) {
        if (res.ok) { res.ok = false; res.complete = false; res.reason = 'storage'; res.error = (e && e.message) || 'storage'; }
      }
    }
    prog('end');
    return res;
  }

  // Everything the phone holds of one log of this sensor (the newest downloaded unless `key`): {mac, key, id, dev, visits, pages, kind (the
  // store), older: the keys of the other logs}.
  async load(key = '') {
    const mac = this.mac;
    const dev = mac ? await this.store.device(mac) : null;
    const k = key || (dev && dev.cur);
    const g = k ? await this.store.gen(mac, k) : null;
    if (!g) return { mac, key: '', id: '', dev, visits: [], pages: [], kind: this.store.kind, older: [] };
    const gens = await this.store.gens(mac);
    return { mac, key: g.key, id: g.id, dev, visits: g.visits, pages: await this.store.pages(mac, g.key), kind: this.store.kind, older: gens.filter((x) => x.key !== g.key).map((x) => x.key) };
  }
  // The file of what load() returned (at once: a share sheet needs the tap that asked for it still to be fresh), or null when nothing is stored.
  fileOf(l) {
    if (!l || !l.key || !l.pages.length) return null;
    return buildFieldLogFile({ mac: l.mac, logId: l.id, key: l.key, name: l.dev && l.dev.name, build: this.app.build || '', nowMs: this.clock.now(), tzMin: -this.tzOffsetMin(), tank: l.dev && l.dev.tank, visits: l.visits, pages: l.pages });
  }
  async file(key = '') { return this.fileOf(await this.load(key)); }

  // flog_note (the phone's time in the request). n: parseNote()'s answer.
  async note(n) {
    return this.client.request('flog_note', { kind: n.kind, mm: n.mm, litres: n.litres, t: Math.floor(this.clock.now() / 1000) });
  }

  // Before a firmware update (it erases the log): is there log on the sensor that this phone does not hold? {known, unread, never, cells, info}.
  async unread() {
    const mac = this.mac;
    let info;
    try { info = await this.client.request('flog_info'); } catch (e) { return { known: false, unread: true, never: false, cells: 0, info: null }; }
    if (!infoLogId(info)) return { known: true, unread: false, never: false, cells: 0, info };          // no log mounted: nothing to lose
    if (!Number.isInteger(info.head) || !Number.isInteger(info.oldest)) return { known: false, unread: true, never: false, cells: 0, info };
    let doc = null, have = null;
    try { doc = await this._logOf(mac, infoLogId(info)); have = doc ? await this.store.last(mac, doc.key) : null; } catch (e) { return { known: false, unread: true, never: false, cells: 0, info }; }
    if (!have) { const cells = info.head - info.oldest; return { known: true, unread: cells > UNREAD_CELLS, never: true, cells, info }; }
    const cells = info.head < have.next ? info.head - info.oldest : info.head - have.next;
    return { known: true, unread: cells > UNREAD_CELLS, never: false, cells, info };
  }
}
