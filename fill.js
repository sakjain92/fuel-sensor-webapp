// The fill-report flow (PROTOCOL.md section 6), without any DOM: Start with the operator's position, End, wait for the level to
// settle, the operator types the litres BLIND (the sensor's own litres are never shown before Confirm), Confirm.
// While a report is open the phone's position is watched and the largest distance from the Start fix is kept; it is sent as
// moved_m with Confirm. The open report lives in the sensor, so a reload or a reconnect resumes it (the Start fix is kept
// in session storage for that).
import { Emitter, realClock } from './util.js';
import { t, STR, parseLitres, phoneClock, haversineM, fillErrText, MOVED_WARN_M } from './core.js';
import { ProtocolError } from './ble.js';

export const WEAK_FIX_M = 100;           // a fix worse than this says little about a 100 m limit: ignored while watching, refused at Start
// The Start position goes into the signed report, so its accuracy must be known and good enough (100 m itself is still fine).
export const startFixOk = (acc) => Number.isFinite(acc) && acc <= WEAK_FIX_M;
const POLL_ACTIVE_MS = 3000;
const POLL_IDLE_MS = 15000;
const STORE_PREFIX = 'mrm.fill.';

export class FillFlow extends Emitter {
  constructor({ client, geo, storage, clock = realClock, mac = '', tzOffsetMin = () => new Date().getTimezoneOffset() }) {
    super();
    Object.assign(this, { client, geo, storage, clock, mac, tzOffsetMin });
    this.fs = null;                 // last fill_state reply
    this.fsAt = 0;
    this.stage = 'unknown';         // the device's stage once known: idle | filling | measuring | ready
    this.local = null;              // locating | nolocation | starting: steps before the device knows about the report
    this.busy = false;
    this.fix = null;                // the Start fix {lat, lon, acc}
    this.maxD = 0;                  // largest distance from the Start fix, metres (float)
    this.locWhy = '';
    this.message = null;            // {kind: 'bad' | 'ok' | 'warn', text}
    this.lastReport = null;
    this._stopWatch = null;
    this._token = 0;
    this._poll = null;
    this._running = false;
    this._paused = false;
  }

  // The sensor this flow talks to. A technician who connects to the next unit in the same page must not see the previous sensor's last
  // report (and share its code and file), its open-report state or its Start fix. The stored Start fix stays: it is kept per sensor.
  forSensor(mac) {
    if (this.mac && mac && this.mac !== mac) {
      if (this._stopWatch) { this._stopWatch(); this._stopWatch = null; }
      this.fix = null; this.maxD = 0;
      this.fs = null; this.fsAt = 0; this.stage = 'unknown'; this.local = null; this.busy = false; this.locWhy = ''; this.message = null;
      this.lastReport = null;
      this._token++;
    }
    this.mac = mac;
  }

  get enabled() { return !this.fs || this.fs.enabled !== false; }
  get view() {
    const fs = this.fs || {};
    return {
      known: !!this.fs, enabled: this.enabled, stage: this.local || (this.stage === 'unknown' ? 'idle' : this.stage), busy: this.busy,
      restarted: !!fs.restarted, phoneStart: fs.phone_start || 0, sinceEndS: fs.since_end_s || 0, fsAt: this.fsAt,
      settleMinS: fs.settle_min_s || 0, settleMaxS: fs.settle_max_s || 0,
      fix: this.fix ? { ...this.fix } : null, movedM: Math.round(this.maxD), movedWarn: !!this.fix && Math.round(this.maxD) > MOVED_WARN_M,
      locWhy: this.locWhy, message: this.message, lastReport: this.lastReport,
    };
  }
  _emit() { this.emit('change', this.view); }
  _say(kind, text) { this.message = text ? { kind, text } : null; }

  // ---- polling and state
  start() { this._running = true; this.clock.clearTimeout(this._poll); return this.refresh(); }
  dispose() {
    this._running = false;
    this.clock.clearTimeout(this._poll);
    this._poll = null;
    if (this._stopWatch) { this._stopWatch(); this._stopWatch = null; }
  }
  // No polling while the link is needed for something bulky (a firmware transfer).
  pause() { this._paused = true; this.clock.clearTimeout(this._poll); this._poll = null; }
  resume() { if (this._paused) { this._paused = false; this._schedule(); } }
  _schedule() {
    this.clock.clearTimeout(this._poll);
    this._poll = null;
    if (!this._running || this._paused || !this.client.connected) return;
    const open = this.stage === 'filling' || this.stage === 'measuring' || this.stage === 'ready';
    this._poll = this.clock.setTimeout(() => this.refresh(), open || this.local ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }
  async refresh() {
    try { this._apply(await this.client.request('fill_state')); } catch (e) { /* a missed poll is not worth a message */ }
    this._schedule();
    this._emit();
  }
  _apply(fs) {
    this.fs = fs;
    this.fsAt = this.clock.now();
    if (fs.last !== undefined) this._setLast(fs.last);           // fill_state, fill_start and fill_end all carry the newest report
    const open = fs.enabled !== false && fs.stage !== 'idle';
    if (open) {
      this.local = null;
      if (!this.fix) this._resume(fs.phone_start);
      this.stage = fs.stage;
      this._ensureWatch();
    } else if (!this.local) {
      if (this.fix || this._stopWatch) this._clearTracking();       // closed by the sensor, or confirmed elsewhere
      this.stage = 'idle';
    }
  }

  // The newest signed report the sensor holds comes with every fill_state, fill_start and fill_end reply (`last`, PROTOCOL.md 4.4; null
  // while it holds none) and needs no login: it is the "last fill report" card after a connect or a reload. The history, fill_log, needs
  // a login and is read in Maintenance only. A reply from a firmware without `last` leaves the card as it is.
  _setLast(last) {
    const ok = last && typeof last === 'object' && Number.isFinite(last.serial) && typeof last.line === 'string' && typeof last.code === 'string';
    const next = ok ? last : null;
    const cur = this.lastReport;
    if (next === null ? cur === null : (cur && cur.serial === next.serial && cur.code === next.code)) return;       // unchanged: keep the object
    this.lastReport = next;
  }

  // ---- operator steps
  async pressStart() {
    if (this.busy || !this.enabled || this.stage === 'filling' || this.stage === 'measuring' || this.stage === 'ready' || this.local === 'locating' || this.local === 'starting') return;
    this._say('', '');
    this.local = 'locating';
    this.locWhy = '';
    this._emit();
    const token = ++this._token;
    let fix = null, why = '';
    try { fix = await this.geo.getPosition({ timeoutMs: 20000 }); } catch (e) { why = e && e.code ? e.code : 'unavailable'; }
    if (token !== this._token) return;                              // "continue without location" or "cancel" came first
    if (!fix) { this.local = 'nolocation'; this.locWhy = why; this._emit(); return; }
    // A Start position that is only good to a kilometre (Android's "approximate location", a cold GPS) or of unknown accuracy would go
    // into the signed report as the operator's place and make the 100 m check meaningless: it is not used. The operator turns precise
    // location on and tries again, or continues without a position (the report then has none, and says so).
    if (!startFixOk(fix.acc)) { this.local = 'nolocation'; this.locWhy = 'weak'; this._emit(); return; }
    await this._startDevice(fix);
  }
  async retryLocation() { if (this.local === 'nolocation') { this.local = null; await this.pressStart(); } }
  async continueWithoutLocation() {
    if (this.local !== 'locating' && this.local !== 'nolocation') return;
    this._token++;                                                  // a position that arrives later is ignored
    await this._startDevice(null);
  }
  cancelStart() { if (this.local === 'locating' || this.local === 'nolocation') { this._token++; this.local = null; this._emit(); } }

  async _startDevice(fix) {
    this.local = 'starting';
    this.busy = true;
    this._emit();
    const c = phoneClock(this.clock.now(), this.tzOffsetMin());
    try {
      const fs = await this.client.request('fill_start', { t: c.t, tz_min: c.tz_min, lat: fix ? fix.lat : undefined, lon: fix ? fix.lon : undefined }, { timeoutMs: 15000 });
      this.local = null;
      this.fix = fix ? { ...fix } : null;
      this.maxD = 0;
      this._persist(fs.phone_start === undefined ? c.t : fs.phone_start);
      this._apply(fs);
    } catch (e) {
      this.local = null;
      this._say('bad', fillErrText(e));
      if (e instanceof ProtocolError && e.code === 'busy') await this.refresh();
    } finally {
      this.busy = false;
      this._schedule();
      this._emit();
    }
  }
  async pressEnd() {
    if (this.busy || this.stage !== 'filling') return;
    this.busy = true;
    this._say('', '');
    this._emit();
    const c = phoneClock(this.clock.now(), this.tzOffsetMin());
    try { this._apply(await this.client.request('fill_end', { t: c.t }, { timeoutMs: 15000 })); } catch (e) {
      this._say('bad', fillErrText(e));
      if (e instanceof ProtocolError) await this.refresh();
    } finally { this.busy = false; this._schedule(); this._emit(); }
  }
  // text: what the operator typed. Resolves {ok, report} or {ok: false, ...}.
  async confirmReport(text) {
    if (this.busy || this.stage !== 'ready') return { ok: false, reason: 'stage' };
    const p = parseLitres(text);
    if (!p.ok) { this._say('bad', STR.frBadL); this._emit(); return { ok: false, reason: 'input' }; }
    this.busy = true;
    this._say('', '');
    this._emit();
    try {
      const r = await this.client.request('fill_confirm', { litres: p.v, moved_m: this.fix ? Math.round(this.maxD) : undefined }, { timeoutMs: 15000 });
      this._clearTracking();
      this.lastReport = r.report;
      this.stage = 'idle';
      this.fs = { enabled: true, stage: 'idle' };
      this._say('ok', t('frDoneMsg', { n: r.report.serial }));
      this.emit('report', r.report);
      return { ok: true, report: r.report };
    } catch (e) {
      this._say('bad', fillErrText(e));
      if (e instanceof ProtocolError) await this.refresh();
      return { ok: false, reason: 'device', error: e };
    } finally { this.busy = false; this._schedule(); this._emit(); }
  }

  // ---- the Start fix and the distance moved
  _key() { return STORE_PREFIX + this.mac; }
  _persist(phoneStart) {
    if (!this.fix) { this.storage.del(this._key()); return; }
    this.storage.set(this._key(), JSON.stringify({ phone_start: phoneStart, lat: this.fix.lat, lon: this.fix.lon, acc: this.fix.acc, maxD: this.maxD }));
  }
  _resume(phoneStart) {
    let o = null;
    try { o = JSON.parse(this.storage.get(this._key()) || 'null'); } catch (e) { o = null; }
    if (o && o.phone_start === phoneStart && Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
      this.fix = { lat: o.lat, lon: o.lon, acc: Number.isFinite(o.acc) ? o.acc : null };
      this.maxD = Number.isFinite(o.maxD) ? o.maxD : 0;
    } else if (o) this.storage.del(this._key());                   // belongs to an older report
  }
  _ensureWatch() {
    if (!this.fix || this._stopWatch) return;
    this._stopWatch = this.geo.watch((f) => this._onFix(f), () => { /* no fix for now: keep the largest distance so far */ });
  }
  _onFix(f) {
    if (!this.fix || !f) return;
    if (f.acc !== null && f.acc !== undefined && f.acc > WEAK_FIX_M) return;
    const d = haversineM(this.fix.lat, this.fix.lon, f.lat, f.lon);
    if (d > this.maxD) {
      this.maxD = d;
      const phoneStart = this.fs && this.fs.phone_start;
      this._persist(phoneStart === undefined ? 0 : phoneStart);
      this._emit();
    }
  }
  _clearTracking() {
    if (this._stopWatch) { this._stopWatch(); this._stopWatch = null; }
    this.fix = null;
    this.maxD = 0;
    this.storage.del(this._key());
  }
}

// All reports the sensor holds (the newest 50), newest first. fill_log needs a login of any kind (without one it answers no_session):
// Maintenance reads it with `Maintenance.readFillLog`, behind its login. Replies are paged.
export async function loadFillLog(client, { max = 50 } = {}) {
  const reports = [];
  let from = 0, count = Infinity;
  while (from < count && reports.length < max) {
    const r = await client.request('fill_log', { from });
    count = r.count;
    if (!Array.isArray(r.reports) || !r.reports.length) break;
    reports.push(...r.reports);
    from += r.reports.length;
  }
  return { reports: reports.slice(0, max), count: Number.isFinite(count) ? count : reports.length };
}
