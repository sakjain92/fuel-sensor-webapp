// Firmware update over Bluetooth (PROTOCOL.md section 7), without any DOM.
//
//   ota_begin {size} -> chunk lines {"cmd":"ota","n":N,"d":"<Base64>"} (no id, no reply) -> ota_end
//
// The sensor answers with `ota` events (every 8 chunks and when all bytes are in) that name the next chunk it expects.
// At most 16 chunks are sent ahead of the last acknowledged one. A gap or a repeated chunk is answered with the same event,
// so an event that does not advance means "resend from n". Lost chunks, repeated chunks and lost events all recover.
import { Emitter, realClock, base64Encode } from './util.js';
import { t, STR, otaReason } from './core.js';
import { ProtocolError, DisconnectedError, TimeoutError } from './ble.js';

export const OTA_WRAPPER = 31;       // 26 bytes around the Base64 plus up to 5 digits of n
export const MAX_CHUNK = 744;        // PROTOCOL.md 7 "at most 744" (a 5-digit chunk line is then 1023 bytes). Not tied to the line limit of 2048: one write is at most 512 bytes, so 360 is the real maximum
export const FALLBACK_CHUNK = 96;    // used when the writes are too small for the formula (MTU 23): lines span several writes
export const WINDOW = 16;

// Raw bytes per chunk so that a whole chunk line fits one write: floor((write - 31) x 3 / 4), a multiple of 3, at most 744.
export function chunkRawBytes(writeSize) {
  let raw = Math.floor((writeSize - OTA_WRAPPER) * 3 / 4);
  raw -= raw % 3;
  if (raw > MAX_CHUNK) raw = MAX_CHUNK;
  return raw < 48 ? FALLBACK_CHUNK : raw;
}
export function chunkRawBytesForMtu(mtu) { return chunkRawBytes(mtu - 3); }
export function chunkCount(size, raw) { return Math.ceil(size / raw); }
// PROTOCOL.md 7 "Time": seconds = ceil(size / raw) x (4 x raw / 3 + 31) / R, R = line bytes per second the phone sustains.
export function estimateSeconds(size, raw, lineBytesPerSecond) {
  return chunkCount(size, raw) * (4 * raw / 3 + OTA_WRAPPER) / lineBytesPerSecond;
}

// Speed as a moving average over the last few seconds of acknowledged bytes. A stall makes the speed fall, so the time left grows.
export class RateMeter {
  constructor({ windowMs = 8000 } = {}) { this.windowMs = windowMs; this.s = []; }
  add(ms, bytes) {
    this.s.push({ ms, bytes });
    while (this.s.length > 2 && ms - this.s[1].ms >= this.windowMs) this.s.shift();
  }
  // bytes per second, or null until there is half a second of data
  rate(nowMs) {
    if (this.s.length < 1) return null;
    const first = this.s[0], last = this.s[this.s.length - 1];
    const span = (nowMs === undefined ? last.ms : Math.max(nowMs, last.ms)) - first.ms;
    if (span < 500) return null;
    return (last.bytes - first.bytes) / (span / 1000);
  }
}
export function etaSeconds(remainingBytes, rate) { return rate > 0 ? remainingBytes / rate : NaN; }

export class OtaError extends Error {
  // code: a sensor code (busy grant no_session big format link_mode chip variant older signature image hash write) or
  // cancelled | drop | stalled | send | no_transfer | internal
  constructor(code, msg, detail) { super(msg || code); this.name = 'OtaError'; this.code = code; this.detail = detail || ''; }
}
export function otaErrorText(e) {
  const c = e && e.code;
  if (c === 'cancelled') return STR.fwCancelled;
  if (c === 'drop') return STR.fwDrop;
  if (c === 'stalled' || c === 'send') return STR.fwStalled;
  if (c === 'busy') return STR.fwBusy;
  if (c === 'no_transfer') return STR.fwLost;
  return t('fwRefused', { e: otaReason(c) + (e && e.detail ? ' (' + e.detail + ')' : '') });
}

// Make sure the radio is not in long-range mode (the sensor refuses updates there): ask for "fast" and wait until it is done.
export async function ensureFastLink(client, clock = realClock, { timeoutMs = 15000, pollMs = 500 } = {}) {
  let r = await client.request('link');
  if (r.mode !== 'range') return r;
  r = await client.request('link', { mode: 'fast' });
  const t0 = clock.now();
  while (r.pending && clock.now() - t0 < timeoutMs) {
    await new Promise((res) => clock.setTimeout(res, pollMs));
    r = await client.request('link');
  }
  return r;
}

export class OtaUploader extends Emitter {
  constructor({ client, bytes, clock = realClock, windowSize = WINDOW, stallMs = 4000, guardMs = 1000, failAfterMs = 30000, beginTimeoutMs = 30000, endTimeoutMs = 40000, chunkRetries = 3, echoMs = 1000 }) {
    super();
    Object.assign(this, { client, bytes, clock, windowSize, stallMs, guardMs, failAfterMs, beginTimeoutMs, endTimeoutMs, chunkRetries, echoMs });
    this.total = bytes.length;
    this.state = 'idle';           // idle | switching | begin | sending | finishing | done | failed | cancelled
    this.raw = 0;
    this.totalChunks = 0;
    this.next = 0;                 // next chunk number to send
    this.acked = 0;                // next chunk number the sensor expects (as last told)
    this.bytesAcked = 0;
    this.meter = new RateMeter();
    this.stats = { sent: 0, rewinds: 0, stalls: 0, maxAhead: 0 };
    this._rewoundTo = -1;
    this._rewindAt = 0;
    this._gapEchoes = 0;           // answers still to come from chunks that were on their way when an event made us rewind
    this._dupEchoes = 0;           // answers still to come to the repeats of a stall rewind (they may repeat chunks that were only delayed)
    this._dupLimit = 0;            // the highest chunk number sent before that rewind: once the sensor is beyond it, no such answer follows
    this._dupFrom = 0;             // when the first event after that rewind arrived
    this._recheckTimer = null;
    this._recheckFor = -1;         // the chunk the recheck is about
    this._softErrs = 0;             // non-fatal errors since the sensor last moved on
    this._wake = null;
    this._waitTimer = null;
    this._stopped = false;
    this._streamFail = null;
    this._offs = [];
    this._cancelled = new Promise((_, reject) => { this._cancelNow = reject; });     // rejects when cancel() is called
    this._cancelled.catch(() => {});
  }

  get progress() {
    const now = this.clock.now();
    const rate = this.meter.rate(now);
    const remaining = this.total - this.bytesAcked;
    return {
      state: this.state, bytes: this.bytesAcked, total: this.total,
      percent: this.total ? Math.min(100, Math.floor(100 * this.bytesAcked / this.total)) : 0,
      rate, etaS: this.state === 'sending' ? etaSeconds(remaining, rate) : NaN, at: now,
      chunk: this.raw, acked: this.acked, totalChunks: this.totalChunks,
    };
  }
  _state(s) { this.state = s; this.emit('progress', this.progress); }

  async run() {
    if (this.state !== 'idle') throw new OtaError('internal', 'already started');
    try {
      this._state('switching');
      await this._until(this._prepareLink());
      this._check();
      this._state('begin');
      this.raw = chunkRawBytes(this.client.writeSize);
      this.totalChunks = chunkCount(this.total, this.raw);
      await this._until(this._begin());
      this._check();
      this._state('sending');
      await this._stream();
      this._check();
      this._state('finishing');
      const r = await this._finish();
      this._state('done');
      return r;
    } catch (e) {
      this._stopped = true;
      if (this.state !== 'cancelled') this._state('failed');
      throw this._wrap(e);
    } finally {
      this._cleanup();
    }
  }
  _check() { if (this._stopped) throw new OtaError('cancelled'); }
  // A step that may take long (switching the radio, ota_begin: up to 30 s) ends at once when the operator cancels; the request itself
  // is left to finish, and ota_abort follows it.
  _until(p) { p.catch(() => {}); return Promise.race([p, this._cancelled]); }
  _wrap(e) {
    if (e instanceof OtaError) return e;
    if (e instanceof ProtocolError) return new OtaError(e.code, e.msg, e.msg);
    if (e instanceof DisconnectedError) return new OtaError('drop');
    if (e instanceof TimeoutError) return new OtaError('stalled', 'no answer to ' + e.cmd);
    return new OtaError('internal', e && e.message);
  }

  async _prepareLink() { await ensureFastLink(this.client, this.clock); }
  async _begin() {
    try {
      await this.client.request('ota_begin', { size: this.total }, { timeoutMs: this.beginTimeoutMs });
    } catch (e) {
      if (e instanceof ProtocolError && e.code === 'link_mode') {          // the radio went back to long range: switch once more
        await ensureFastLink(this.client, this.clock);
        await this.client.request('ota_begin', { size: this.total }, { timeoutMs: this.beginTimeoutMs });
      } else throw e;
    }
  }

  async cancel() {
    if (this._stopped || this.state === 'finishing' || this.state === 'done' || this.state === 'failed') return false;
    const wasBegun = this.state === 'sending' || this.state === 'begin';
    this._stopped = true;
    this.state = 'cancelled';
    this.emit('progress', this.progress);
    this._cancelNow(new OtaError('cancelled'));
    this._signal();
    if (this._streamFail) this._streamFail(new OtaError('cancelled'));
    if (wasBegun && this.client.connected) { try { await this.client.request('ota_abort', {}, { timeoutMs: 4000 }); } catch (e) { /* the transfer is dropped on the sensor anyway */ } }
    return true;
  }

  // ---- streaming
  _stream() {
    return new Promise((resolve, reject) => {
      const t0 = this.clock.now();
      this.lastProgressAt = t0;
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; this._stopped = this._stopped || fn === reject; this._signal(); fn(v); };
      this._streamFail = (err) => done(reject, err);
      this._streamOk = () => done(resolve);
      this._offs.push(this.client.on('ota', (ev) => this._onOta(ev)));
      this._offs.push(this.client.on('ota_err', (ev) => this._onErr(ev)));
      this._offs.push(this.client.on('disconnected', () => done(reject, new OtaError('drop'))));
      this._sendLoop().catch((e) => done(reject, this._wrap(e)));
    });
  }
  async _sendLoop() {
    while (!this._stopped) {
      if (this.acked >= this.totalChunks && this.bytesAcked >= this.total) return;
      if (this.next >= this.totalChunks || this.next - this.acked >= this.windowSize) {
        await this._wait();
        continue;
      }
      const n = this.next++;
      this.stats.maxAhead = Math.max(this.stats.maxAhead, n - this.acked + 1);
      await this._sendChunk(n);
    }
  }
  async _sendChunk(n) {
    const from = n * this.raw;
    const line = { cmd: 'ota', n, d: base64Encode(this.bytes.subarray(from, Math.min(this.total, from + this.raw))) };
    for (let attempt = 0; ; attempt++) {
      if (this._stopped) throw new OtaError('cancelled');       // cancelled or failed while this chunk waited to be tried again: nothing may follow ota_abort
      try { await this.client.sendLine(line, { noResponse: true }); this.stats.sent++; return; } catch (e) {
        if (e instanceof DisconnectedError || attempt >= this.chunkRetries) throw (e instanceof DisconnectedError ? e : new OtaError('send', 'write failed: ' + (e && e.message)));
        await new Promise((r) => this.clock.setTimeout(r, 60 * (attempt + 1)));
      }
    }
  }
  // Wait for an event, a rewind or a stop; after stallMs of silence assume the events (or the chunks) were lost and resend.
  _wait() {
    return new Promise((res) => {
      this._waitTimer = this.clock.setTimeout(() => { this._wake = null; this._waitTimer = null; this._onStall(); res(); }, this.stallMs);
      this._wake = () => { this.clock.clearTimeout(this._waitTimer); this._waitTimer = null; res(); };
    });
  }
  _signal() { const w = this._wake; this._wake = null; if (w) w(); }
  _onStall() {
    const now = this.clock.now();
    if (this._stopped) return;
    if (now - this.lastProgressAt > this.failAfterMs) { this._streamFail(new OtaError('stalled')); return; }
    this.stats.stalls++;
    this._rewind(this.acked, now, 'stall');     // resend from the first unacknowledged chunk: repeats are answered with the current event
  }
  // kind 'gap': the sensor said it still wants chunk n although we sent beyond it; 'stall': nothing was heard for a while.
  _rewind(n, now, kind) {
    // Answers that say nothing new are counted, so that they do not start the next rewind (a chain of rewinds that lasts for the rest of
    // the transfer). Two kinds, told apart because they end differently:
    //  - gap: the chunks sent after the lost one are refused one by one, each answered "chunk n next". They were on their way before
    //    the rewind, so all these answers come before the first progress event after it. A loss after that is a new loss.
    //  - stall: the chunks we send again may repeat chunks that were only delayed (the link froze). The sensor answers every repeat with
    //    where it is, after the progress events of the originals. Once it is beyond what we had sent, none can follow.
    const sent = Math.max(0, this.next - n);
    if (kind === 'stall') {
      this._dupEchoes = Math.min(8 * this.windowSize, this._dupEchoes + sent);
      this._dupLimit = Math.max(this._dupLimit, this.next);
      this._dupFrom = 0;
    } else this._gapEchoes = Math.min(2 * this.windowSize, this._gapEchoes + Math.max(0, sent - 1));
    this.next = n;
    this._rewoundTo = n;
    this._rewindAt = now;
    this.stats.rewinds++;
  }
  _onOta(ev) {
    if (this.state !== 'sending' || this._stopped) return;
    const now = this.clock.now();
    const n = Math.max(0, Math.min(this.totalChunks, Number(ev.n)));
    if (!Number.isFinite(n)) return;
    if (this._dupEchoes > 0 && !this._dupFrom) this._dupFrom = now;
    if (n < this.acked) return;                                  // an old answer that came late: the sensor is further on than that
    if (n > this.acked) {                                        // progress
      this._gapEchoes = 0;                                       // the answers to chunks sent before a rewind all came before this
      if (n > this._dupLimit) this._dupEchoes = 0;
      this._softErrs = 0;
      this.acked = n;
      this.bytesAcked = Math.min(this.total, Number.isFinite(ev.bytes) ? ev.bytes : n * this.raw);
      this.lastProgressAt = now;
      this._rewoundTo = -1;
      if (this.next < n) this.next = n;
      this.meter.add(now, this.bytesAcked);
      this.emit('progress', this.progress);
      if (this.acked >= this.totalChunks && this.bytesAcked >= this.total) this._streamOk();
    } else {                                                     // the sensor still wants chunk n: a gap or a repeat
      if (now - this.lastProgressAt > this.failAfterMs) { this._streamFail(new OtaError('stalled')); return; }
      const guarded = this._rewoundTo === n && now - this._rewindAt < this.guardMs;   // already resending from n: stale echo
      const gapEcho = this._gapEchoes > 0 && n === this._rewoundTo;
      const dupEcho = !gapEcho && this._dupEchoes > 0 && now - this._dupFrom < this.echoMs;
      if (gapEcho) this._gapEchoes--; else if (dupEcho) this._dupEchoes--;
      if (!guarded && !gapEcho && !dupEcho && this.next > n) {
        this.acked = n;
        if (Number.isFinite(ev.bytes)) this.bytesAcked = ev.bytes;
        this._rewind(n, now, 'gap');
      } else if (this.next > n) this._recheck();
    }
    this._signal();
  }
  // An answer was taken for an echo. If the sensor still asks for the same chunk a whole guard time later, nothing moved: the chunk is lost.
  _recheck() {
    const at = this.acked;
    if (this._recheckTimer !== null) {
      if (this._recheckFor === at) return;                       // already waiting to see whether this chunk moves
      this.clock.clearTimeout(this._recheckTimer);               // the sensor moved on since: wait for the new chunk instead
    }
    this._recheckFor = at;
    this._recheckTimer = this.clock.setTimeout(() => {
      this._recheckTimer = null;
      if (this._stopped || this.state !== 'sending' || this.acked !== at || this.next <= at) return;
      this._rewind(at, this.clock.now(), 'gap');
      this._signal();
    }, this.guardMs);
  }
  // ota_err: fatal (the default) means the sensor dropped the transfer: stop and say why. A non-fatal one (bad_base64, bad_size, or any
  // other with "fatal":false) names the chunk it wants next (n), like a gap: resend from there. 200 of them without the sensor moving on
  // end the transfer.
  _onErr(ev) {
    if (this.state !== 'sending' && this.state !== 'begin') return;
    // "no_transfer" is non-fatal for the sensor (it says it once) but for us the transfer is over: it lost it
    if (ev.err === 'no_transfer') { this._streamFail && this._streamFail(new OtaError('no_transfer', ev.msg || '', ev.msg || '')); return; }
    // The codes say what the sensor does with the transfer (PROTOCOL.md 7). A line that lost a piece on the way may lack "fatal" or "n":
    // the code decides, and without n the chunk to continue with is the one the sensor last asked for.
    const soft = ev.fatal === false || ((ev.err === 'bad_base64' || ev.err === 'bad_size') && ev.fatal !== true);
    if (soft) {
      if (++this._softErrs > 200) { this._streamFail && this._streamFail(new OtaError(ev.err || 'write', ev.msg || '', ev.msg || '')); return; }
      this._onOta({ ev: 'ota', n: Number.isFinite(ev.n) ? ev.n : this.acked, bytes: ev.bytes });
      return;
    }
    this._streamFail && this._streamFail(new OtaError(ev.err || 'format', ev.msg || '', ev.msg || ''));
  }

  async _finish() {
    let dropped = false;
    const off = this.client.on('disconnected', () => { dropped = true; });
    this._offs.push(off);
    try {
      const r = await this.client.request('ota_end', {}, { timeoutMs: this.endTimeoutMs });
      this.client.expectClose();
      return { version: r.version, restartInS: r.restart_in_s, uncertain: false };
    } catch (e) {
      // The link dropped while the sensor was verifying: it may have installed and restarted. The caller finds out by reconnecting.
      if (dropped || e instanceof DisconnectedError) return { version: null, restartInS: 2, uncertain: true };
      throw e;
    }
  }
  _cleanup() {
    if (this._recheckTimer !== null) this.clock.clearTimeout(this._recheckTimer);
    this._recheckTimer = null;
    for (const off of this._offs) off();
    this._offs = [];
    if (this._waitTimer) this.clock.clearTimeout(this._waitTimer);
    this._waitTimer = null;
    this._wake = null;
  }
}
