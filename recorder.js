// The recorder of debug builds: keeps what the sensor sends (radar echoes, level estimates with their confidence flags, the algorithm's
// internals, status, link, the device log) plus what the person at the tank enters (dipstick, litres added, the DG controller's reading,
// meter ohms, notes) as JSON lines, on the phone, until it is shared. No DOM. File format: webapp/RECORDING.md.
//
// One line per event, every line carries `pt` (the phone's clock, ms since 1970). The first line is `rec_start` (who, what, how the radar
// is set, the first status, the notes); the last is `rec_stop`. A lost link is written as `rec_event` and the recording goes on by itself
// when the app is connected again (the same sensor). For runs of many hours the waveforms are kept in `adaptive` mode by default: every
// frame while the sensor is unsure, the level is moving, a reading was just entered or the sensor just started (with 10 s before), else one a second.
import { Emitter, realClock, utf8 } from './util.js';

export const REC_FORMAT = 'mrm-fuel-recording';
export const REC_VERSION = 1;
export const FLUSH_MS = 10000;        // a crash or a closed tab loses at most this much
export const DEBUG_MS = 1000;         // the algorithm's internals (`debug`)
export const LOGS_MS = 3000;          // the device log, polled (the log topic is shared with the log page)
export const STATUS_MS = 5000;        // a status line at most this often, sooner when its words change
export const LINK_MS = 10000;
export const PART_BYTES = 12e6;       // one file to share is at most about this big (mail and chat apps take 20 to 25 MB)
export const SIZE_LIMIT_BYTES = 400e6;
export const REF_LIMIT = 50;
export const LOG_LIMIT = 600;
export const DATA_NOTE_MS = 30000;      // a line with the current values in the recording log on the screen (not in the file: the status and estimates are)

export const RAW_MODES = Object.freeze(['adaptive', 'all', 'slow']);
export const SLOW_EVERY = 10;         // `slow` and the quiet times of `adaptive`: one frame in this many
export const PREROLL = 100;           // frames kept back, to be written when something happens (10 s)
export const HOT_MS = Object.freeze({ start: 60000, unsure: 30000, motion: 30000, flag: 10000, ref: 60000, resume: 60000, restart: 180000 });
export const MOTION_MM = 1.5, MOTION_WINDOW_MS = 10000;

// What the person at the tank can enter. `value` kinds need a number.
export const REF_KINDS = Object.freeze([
  { id: 'poured_l', key: 'recRefPoured', unit: 'L', value: true, min: -5000, max: 5000 },
  { id: 'dipstick_mm', key: 'recRefDipstick', unit: 'mm', value: true, min: 0, max: 2000 },
  { id: 'dg_pct', key: 'recRefDgPct', unit: '%', value: true, min: 0, max: 100 },
  { id: 'dg_litres', key: 'recRefDgLitres', unit: 'L', value: true, min: 0, max: 5000 },
  { id: 'meter_ohm', key: 'recRefOhm', unit: 'ohm', value: true, min: 0, max: 1e6 },
  { id: 'note', key: 'recRefNote', unit: '', value: false },
]);

// '12,5' and '12.5' are the same; returns {ok, v} or {ok:false, err:'empty'|'number'|'range'}.
export function parseRefValue(text, kind) {
  const s = String(text === undefined || text === null ? '' : text).trim().replace(',', '.');
  if (s === '') return { ok: false, err: 'empty' };
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, err: 'number' };
  const v = Number(s);
  if (!Number.isFinite(v) || v < kind.min || v > kind.max) return { ok: false, err: 'range' };
  return { ok: true, v };
}

// A `status` reply as a `status` line (the reply carries the request's id and ok, and no ev).
const asStatus = (r) => { const { id, ok, ...rest } = r; return { ev: 'status', ...rest }; };

const p2 = (n) => String(n).padStart(2, '0');
// MRM-REC-<MAC>-<yyyymmdd-hhmmss local time>[-p01of03].txt: .txt because Chrome's share sheet only takes a few safe file types.
export function recFileName({ mac, startedPt, tzOffsetMin = 0, part = 1, parts = 1 }) {
  const d = new Date(startedPt - tzOffsetMin * 60000);
  const stamp = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  return `MRM-REC-${mac || 'sensor'}-${stamp}${parts > 1 ? `-p${p2(part)}of${p2(parts)}` : ''}.txt`;
}

// The files of one recording: chunks packed into parts of at most `maxBytes`; every part starts with its own copy of the
// header line, so each file can be analysed alone. Returns [{name, text, bytes, lines, frames}].
export function buildParts(rec, chunks, { maxBytes = PART_BYTES } = {}) {
  const groups = [];
  let cur = null;
  for (const c of chunks) {
    if (!cur || (cur.bytes + c.bytes > maxBytes && cur.items.length)) { cur = { items: [], bytes: 0 }; groups.push(cur); }
    cur.items.push(c);
    cur.bytes += c.bytes;
  }
  if (!groups.length) groups.push({ items: [], bytes: 0 });
  return groups.map((g, i) => {
    const head = JSON.stringify({ ...rec.header, part: i + 1, parts: groups.length }) + '\n';
    const text = head + g.items.map((c) => c.text).join('');
    return {
      name: recFileName({ mac: rec.mac, startedPt: rec.startedPt, tzOffsetMin: rec.tzOffsetMin || 0, part: i + 1, parts: groups.length }),
      text, bytes: utf8(text).length, lines: g.items.reduce((a, c) => a + c.lines, 0) + 1, frames: g.items.reduce((a, c) => a + c.frames, 0),
    };
  });
}

export class Recorder extends Emitter {
  constructor({ client, feed, store, clock = realClock, app = {} }) {
    super();
    Object.assign(this, { client, feed, store, clock, app });
    this.state = 'idle';           // idle | starting | recording | waiting (the link is lost; it resumes by itself)
    this.error = null;             // {code, text} after a failed start or an early end
    this.rec = null;
    this._offs = [];
    this._timer = null;
    this._io = Promise.resolve();  // writes to the store, in order
    this._held = false;
    this._resuming = false;
    this._retry = null;
    this._reset();
  }
  _reset() {
    this._buf = [];
    this._bufBytes = 0;
    this._chunk = { n: 0, lines: 0, frames: 0 };
    this.lines = 0;
    this.frames = 0;               // raw frames written
    this.rawSeen = 0;              // raw frames that arrived (before the mode's rule)
    this.lost = 0;                 // frames missing from the sequence
    this.bytes = 0;                // stored
    this.rawMode = 'adaptive';
    this.estimate = null;
    this.refs = [];                // the readings entered in this recording (newest last)
    this.log = [];                 // what the recording page shows: {pt, kind, ...}
    this.debugErrors = 0;
    this._status = null;
    this._lastSeq = null;
    this._logNext = 0;
    this._busy = { debug: false, logs: false };
    this._at = { debug: 0, logs: 0, flush: 0, status: 0, link: 0, data: 0 };
    this._statusWord = '';
    this._ring = [];
    this._hotUntil = 0;
    this._outHist = [];
    this._lastState = '';
  }
  get active() { return this.state === 'recording' || this.state === 'waiting'; }
  get hot() { return this.rawMode === 'all' || (this.rawMode === 'adaptive' && this.clock.now() < this._hotUntil); }
  get elapsedS() { return this.rec ? Math.max(0, Math.round((this.clock.now() - this.rec.startedPt) / 1000)) : 0; }

  _note(kind, extra = {}) {
    this.log.push({ pt: this.clock.now(), kind, ...extra });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.emit('log');
  }

  // ---------------------------------------------------------------- start / stop
  async start({ notes = '', rawMode = 'adaptive' } = {}) {
    if (this.state !== 'idle') return false;
    await this._io;
    this.error = null;
    if (!this.client.connected) { this.error = { code: 'not_connected', text: '' }; this.emit('change'); return false; }
    this.state = 'starting';
    this.emit('change');
    this._reset();
    this.rawMode = RAW_MODES.includes(rawMode) ? rawMode : 'adaptive';
    try {
      const hello = this.client.hello || {};
      await this.client.subscribe(['status', 'link']).catch(() => {});      // (the app does it too; the recorder does not rely on that)
      await this.feed.acquire();
      this._held = true;
      let status0 = null;
      try { status0 = await this.client.request('status'); } catch (e) { /* the header goes without it */ }
      const t0 = this.clock.now();
      const header = {
        ev: 'rec_start', format: REC_FORMAT, version: REC_VERSION, started_pt: t0, started_iso: new Date(t0).toISOString(),
        tz_offset_min: this.app.tzOffsetMin || 0, app: { build: this.app.build || '', ua: this.app.ua || '' },
        sensor: { mac: hello.mac || '', name: hello.name || '', fw: hello.fw || '', variant: hello.variant || '', chip: hello.chip || '', caps: hello.caps || [] },
        radar: this.feed.radar || null, status0: status0 ? asStatus(status0) : null, raw_mode: this.rawMode, slow_every: SLOW_EVERY, notes: String(notes || '').slice(0, 1000), pt: t0,
      };
      this._status = status0;
      this.rec = await this.store.create({
        id: String(t0), mac: hello.mac || '', fw: hello.fw || '', startedPt: t0, endedPt: null, state: 'recording', tzOffsetMin: header.tz_offset_min,
        frames: 0, lines: 0, bytes: 0, chunks: 0, header, notes: header.notes, rawMode: this.rawMode,
      });                                                // (the header line is added at the top of every file by buildParts)
      this._hook();
      this._at = { debug: t0, logs: t0, flush: t0, status: t0, link: 0, data: t0 };
      this._timer = this.clock.setInterval(() => this._pump(), 1000);
      this.state = 'recording';
      this._note('started', { mode: this.rawMode });
      this._trigger('start', HOT_MS.start);
      this.emit('change');
      await this._pollLogs(true).catch(() => {});
      return true;
    } catch (e) {
      this._unhook();
      this._clearTimer();
      if (this._held) { this._held = false; await this.feed.release(); }
      this.state = 'idle';
      this.error = { code: (e && e.code) || 'error', text: (e && (e.msg || e.message)) || 'error' };
      this.emit('change');
      return false;
    }
  }

  async stop(reason = 'user') {
    if (this.state === 'idle' || this.state === 'starting') return;
    this._clearTimer();
    if (this._retry !== null) { this.clock.clearTimeout(this._retry); this._retry = null; }
    this._unhook();
    this._note('stopped', { reason });
    this._write({ ev: 'rec_stop', reason, frames: this.frames, raw_seen: this.rawSeen, lost: this.lost, lines: this.lines + 1 });
    this.state = 'idle';
    this.emit('change');
    await this._flush();
    const rec = this.rec;
    await this._queue(() => this.store.update(rec.id, { state: 'done', endedPt: this.clock.now(), frames: this.frames, lines: this.lines, bytes: this.bytes, chunks: this._chunk.n, stopReason: reason })).catch(() => {});
    if (this._held) { this._held = false; await this.feed.release(); }
    this.emit('change');
    this.emit('stopped', rec);
  }

  // After a reconnect (the app calls this from its onConnected): the same sensor goes on, another one ends this recording. A link that
  // is lost again meanwhile, or a radar that is not up yet, only means "try again": the recording is never ended by a power cycle.
  async resume() {
    if (this.state !== 'waiting' || this._resuming) return;
    this._resuming = true;
    try {
      const hello = this.client.hello || {};
      if ((hello.mac || '') !== (this.rec.mac || '')) { this.error = { code: 'other_sensor', text: '' }; await this.stop('other_sensor'); return; }
      let st = null;
      try {
        await this.client.subscribe(['status', 'link']).catch(() => {});
        await this.feed.resume();
        st = await this.client.request('status').catch(() => null);
      } catch (e) {
        if (this.client.connected) this._retryResume(e);
        return;
      }
      if (!this.client.connected || this.state !== 'waiting') return;
      const before = this._status;
      const changed = (k) => st && before && st[k] !== undefined && before[k] !== undefined && st[k] !== before[k];
      const restarted = !!(st && before && (changed('boots') || changed('power_interruptions') || (Number.isFinite(st.uptime_s) && Number.isFinite(before.uptime_s) && st.uptime_s < before.uptime_s)));
      this._write({ ev: 'rec_event', what: 'link_resumed', restarted });
      this._write({ ev: 'hello', ...hello });
      if (st) { this._status = st; this._write(asStatus(st)); }
      this._note('link_resumed', { restarted });
      if (restarted) {
        this._logNext = 0;
        this._lastSeq = null;
        this._outHist = [];
        this._write({ ev: 'rec_event', what: 'sensor_restarted' });
        this._note('restarted');
      }
      const now = this.clock.now();
      this._at = { debug: now, logs: now, flush: now, status: now, link: 0, data: now };
      this._clearTimer();
      this._timer = this.clock.setInterval(() => this._pump(), 1000);
      this.state = 'recording';
      this._trigger(restarted ? 'restart' : 'resume', restarted ? HOT_MS.restart : HOT_MS.resume);
      this.emit('change');
      await this._pollLogs(restarted).catch(() => {});
    } finally { this._resuming = false; }
  }
  _retryResume(e) {
    this._note('resume_retry', { code: (e && e.code) || '' });
    if (this._retry !== null) return;
    this._retry = this.clock.setTimeout(() => { this._retry = null; this.resume(); }, 5000);
  }

  // The page was closed or crashed (or the phone's browser was killed) and this recording was left behind: open it again and go on
  // writing into the same file. The sensor must be the same one. The gap is the time between the last stored line and now.
  async continueRec(id) {
    if (this.state !== 'idle') return false;
    await this._io;
    this.error = null;
    const rec = (await this.store.list()).find((r) => r.id === id);
    const hello = this.client.hello || {};
    if (!rec) { this.error = { code: 'no_recording', text: '' }; this.emit('change'); return false; }
    if (!this.client.connected) { this.error = { code: 'not_connected', text: '' }; this.emit('change'); return false; }
    if ((hello.mac || '') !== (rec.mac || '')) { this.error = { code: 'other_sensor', text: '' }; this.emit('change'); return false; }
    this.state = 'starting';
    this.emit('change');
    this._reset();
    this.rawMode = RAW_MODES.includes(rec.rawMode) ? rec.rawMode : 'adaptive';
    try {
      await this.client.subscribe(['status', 'link']).catch(() => {});
      await this.feed.acquire();
      this._held = true;
      const status0 = await this.client.request('status').catch(() => null);
      const chunks = await this.store.chunks(id);
      this._chunk.n = chunks.length ? Math.max(...chunks.map((c) => c.n)) + 1 : 0;
      this.lines = rec.lines || 0;
      this.frames = rec.frames || 0;
      this.bytes = rec.bytes || 0;
      this._status = status0;
      this.rec = await this.store.update(id, { state: 'recording', endedPt: null });
      this._hook();
      const t0 = this.clock.now();
      this._at = { debug: t0, logs: t0, flush: t0, status: t0, link: 0, data: t0 };
      this._write({ ev: 'rec_event', what: 'app_resumed' });
      this._write({ ev: 'hello', ...hello });
      if (status0) this._write(asStatus(status0));
      this._timer = this.clock.setInterval(() => this._pump(), 1000);
      this.state = 'recording';
      this._note('app_resumed');
      this._trigger('restart', HOT_MS.restart);
      this.emit('change');
      await this._pollLogs(true).catch(() => {});
      return true;
    } catch (e) {
      this._unhook();
      this._clearTimer();
      if (this._held) { this._held = false; await this.feed.release(); }
      this.state = 'idle';
      this.error = { code: (e && e.code) || 'error', text: (e && (e.msg || e.message)) || 'error' };
      this.emit('change');
      return false;
    }
  }

  // ---------------------------------------------------------------- what the person at the tank enters
  addRef(kindId, valueText = '', text = '') {
    if (!this.active) return { ok: false, err: 'idle' };
    const kind = REF_KINDS.find((k) => k.id === kindId);
    if (!kind) return { ok: false, err: 'kind' };
    let value = null;
    const note = String(text || '').trim().slice(0, 200);
    if (kind.value) {
      const p = parseRefValue(valueText, kind);
      if (!p.ok) return p;
      value = p.v;
    } else if (!note) return { ok: false, err: 'empty' };
    const st = this._status || {}, est = this.estimate;
    const line = {
      ev: 'ref', kind: kindId, value, unit: kind.unit, text: note,
      shown_level_mm: Number.isFinite(st.level_mm) ? st.level_mm : null, shown_litres: Number.isFinite(st.litres) ? st.litres : null,
      shown_pct: Number.isFinite(st.fill_pct) ? st.fill_pct : null, est_h: est && Number.isFinite(est.h) ? est.h : null,
    };
    this._write(line);
    const r = { pt: line.pt, kind: kindId, value, unit: kind.unit, text: note };
    this.refs.push(r);
    if (this.refs.length > REF_LIMIT) this.refs.shift();
    this._note('ref', { refKind: kindId, value, unit: kind.unit, text: note });          // (not `kind`: that is the log entry's own)
    this._trigger('ref', HOT_MS.ref);
    this.emit('change');
    return { ok: true };
  }

  // ---------------------------------------------------------------- the writer
  _write(obj) {
    if (obj.pt === undefined) obj.pt = this.clock.now();
    const s = JSON.stringify(obj);
    this._buf.push(s);
    this._bufBytes += s.length + 1;
    this._chunk.lines++;
    this.lines++;
    if (obj.ev === 'raw') { this._chunk.frames++; this.frames++; }
    if (this._bufBytes > 400000) this._flush();
  }
  _queue(fn) { const r = this._io.then(fn); this._io = r.catch(() => {}); return r; }
  _flush() {
    if (!this._buf.length || !this.rec) return this._io;
    const text = this._buf.join('\n') + '\n';
    const info = { text, lines: this._chunk.lines, frames: this._chunk.frames, bytes: utf8(text).length };
    const n = this._chunk.n++;
    this._buf = [];
    this._bufBytes = 0;
    this._chunk.lines = 0;
    this._chunk.frames = 0;
    const id = this.rec.id;
    return this._queue(async () => {
      await this.store.addChunk(id, n, info);
      this.bytes += info.bytes;
      await this.store.update(id, { frames: this.frames, lines: this.lines, bytes: this.bytes, chunks: n + 1 });
      if (this.bytes > SIZE_LIMIT_BYTES && this.active) { this.error = { code: 'size_limit', text: '' }; this.stop('size_limit'); }
    }).catch((e) => {
      this.error = { code: 'storage', text: (e && e.message) || 'storage' };
      if (this.active) this.stop('storage_error');
    });
  }
  flushNow() { return this._flush(); }                 // the page is going away
  // Lines from another source on the phone (the capacitive sensor's Bluetooth broadcast, capble.js): written while a recording runs.
  writeExternal(obj) {
    if (!this.active || !obj || typeof obj.ev !== 'string') return false;
    this._write({ ...obj });
    return true;
  }

  // ---------------------------------------------------------------- the feeds
  _hook() {
    const c = this.client;
    this._offs = [
      c.on('raw', (e) => this._raw(e)),
      c.on('estimate', (e) => this._estimate(e)),
      c.on('status', (e) => this._statusEv(e)),
      c.on('link', (e) => { const n = this.clock.now(); if (n - this._at.link >= LINK_MS) { this._at.link = n; this._write({ ...e }); } }),
      c.on('disconnected', () => this._lost()),
    ];
  }
  _unhook() { for (const off of this._offs) off(); this._offs = []; }
  _clearTimer() { if (this._timer !== null) { this.clock.clearInterval(this._timer); this._timer = null; } }

  // Work that is due: the debug poll, the log poll, the flush. Called by the one-second timer and by every incoming estimate and status,
  // so a browser that slows timers of a page in the background does not stop the recording.
  _pump() {
    if (this.state !== 'recording') return;
    const now = this.clock.now();
    if (now - this._at.debug >= DEBUG_MS) { this._at.debug = now; this._pollDebug(); }
    if (now - this._at.logs >= LOGS_MS) { this._at.logs = now; this._pollLogs(false); }
    if (now - this._at.flush >= FLUSH_MS) { this._at.flush = now; this._flush(); }
    if (now - this._at.data >= DATA_NOTE_MS) { this._at.data = now; this._noteData(); }
  }
  _noteData() {
    const st = this._status || {}, est = this.estimate || {};
    const num = (x) => (Number.isFinite(x) ? x : null);
    this._note('data', { level_mm: num(st.level_mm), litres: num(st.litres), fill_pct: num(st.fill_pct), status: st.status || '', state: est.state || '', out: num(est.out), temp_c: num(st.temp_c) });
  }

  // Full-rate waveforms for a while (adaptive mode): the frames kept back until now are written first.
  _trigger(why, holdMs) {
    if (this.rawMode !== 'adaptive') return;
    const now = this.clock.now();
    const was = now < this._hotUntil;
    this._hotUntil = Math.max(this._hotUntil, now + holdMs);
    if (was) return;
    for (const f of this._ring) this._write(f);
    this._ring = [];
    this._write({ ev: 'rec_event', what: 'full_rate', why });
    this._note('full_rate', { why });
  }

  _raw(e) {
    this.rawSeen++;
    const seq = Number.isFinite(e.seq) ? e.seq : null;
    if (seq !== null && this._lastSeq !== null && seq > this._lastSeq + 1 && seq - this._lastSeq < 1e6) this.lost += seq - this._lastSeq - 1;
    if (seq !== null) this._lastSeq = seq;
    if (this.rawMode === 'adaptive' && Number.isFinite(e.flags) && e.flags !== 0) this._trigger('flag', HOT_MS.flag);   // saturated, delayed, calibration, frames lost
    const base = seq === null || seq % SLOW_EVERY === 0;
    if (this.rawMode === 'all' || (this.rawMode === 'adaptive' && this.clock.now() < this._hotUntil) || base) { this._write({ ...e }); return; }
    if (this.rawMode === 'adaptive') {                    // kept back: written when something happens within the next 10 s
      this._ring.push({ ...e, pt: this.clock.now() });          // (with the time it arrived, not the time it is written)
      if (this._ring.length > PREROLL) this._ring.shift();
    }
  }
  _estimate(e) {
    const h = Number.isFinite(e.h) ? e.h : null, out = Number.isFinite(e.out) ? e.out : null, state = String(e.state || '');
    this.estimate = { h, out, state };
    if (state !== this._lastState) { if (this._lastState) this._note('state', { from: this._lastState, to: state }); this._lastState = state; }
    if (state !== 'confirmed' || (Array.isArray(e.flags) && e.flags.length) || (e.src && e.src !== 'estimate')) this._trigger('unsure', HOT_MS.unsure);
    if (out !== null) {                                   // the level is moving (a pour, a drain): the waveforms matter
      const now = this.clock.now();
      this._outHist.push({ pt: now, out });
      while (this._outHist.length && now - this._outHist[0].pt > MOTION_WINDOW_MS) this._outHist.shift();
      if (this._outHist.length > 1 && Math.abs(out - this._outHist[0].out) > MOTION_MM) this._trigger('motion', HOT_MS.motion);
    }
    this._write({ ...e });
    this._pump();
  }
  _statusEv(e) {
    this._status = e;
    const word = `${e.status}|${e.source}`, now = this.clock.now();
    if (now - this._at.status >= STATUS_MS || word !== this._statusWord) { this._at.status = now; this._statusWord = word; this._write({ ...e }); }
    this._pump();
  }
  _lost() {
    if (this.state !== 'recording') return;
    this._clearTimer();
    this.state = 'waiting';
    this._write({ ev: 'rec_event', what: 'link_lost' });
    this._note('link_lost');
    this._flush();
    this.emit('change');
  }
  async _pollDebug() {
    if (this._busy.debug || this.state !== 'recording') return;
    this._busy.debug = true;
    try {
      const r = await this.client.request('debug');
      const { id, ok, ...rest } = r;
      if (this.state === 'recording') this._write({ ev: 'debug', ...rest });
    } catch (e) { this.debugErrors++; } finally { this._busy.debug = false; }
  }
  // The device log from `_logNext` on; `backlog` marks the lines that were there before the recording started (the boot lines).
  async _pollLogs(backlog) {
    if (this._busy.logs || this.state !== 'recording') return;
    this._busy.logs = true;
    try {
      for (let page = 0; page < 60; page++) {
        const r = await this.client.request('logs', { since: this._logNext, debug: true });
        if (this.state !== 'recording') return;
        if (page === 0 && backlog && r.lost) this._write({ ev: 'rec_event', what: 'log_lost', n: r.lost });
        for (const l of r.lines || []) {
          this._write(backlog ? { ev: 'log', s: l.s, t: l.t, l: l.l, m: l.m, backlog: true } : { ev: 'log', s: l.s, t: l.t, l: l.l, m: l.m });
          this._logNext = Math.max(this._logNext, l.s + 1);
        }
        if (!r.lines || !r.lines.length || !(r.next > this._logNext - 1)) break;
        this._logNext = Math.max(this._logNext, r.next);
      }
    } catch (e) { /* the next poll tries again */ } finally { this._busy.logs = false; }
  }

  // ---------------------------------------------------------------- what is stored
  async recordings() { return this.store.list(); }
  async files(id) {
    if (this.rec && this.rec.id === id && this.active) await this._flush();
    const rec = (await this.store.list()).find((r) => r.id === id);
    if (!rec) return [];
    return buildParts(rec, await this.store.chunks(id));
  }
  async remove(id) { if (this.rec && this.rec.id === id && this.active) return false; await this.store.remove(id); this.emit('change'); return true; }
  // A recording left 'recording' by a page that was closed or crashed: mark it so the list tells the truth.
  async recoverInterrupted() {
    for (const r of await this.store.list()) {
      if (r.state === 'recording' && !(this.rec && this.rec.id === r.id && this.active)) await this.store.update(r.id, { state: 'interrupted' });
    }
  }
}
