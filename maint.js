// Maintenance (PROTOCOL.md sections 4.2 and 5), without any DOM: the challenge-response login, the settings commands, the
// crash report, reset and restart. The login belongs to the Bluetooth connection: it ends when the link drops, after 15 minutes
// without a command that needs it, when its hours run out, and at a restart.
import { Emitter, realClock, base64Decode, concatBytes } from './util.js';
import {
  phoneClock, respCheck, respNorm, loginErrorKey, validateTank, validateSiteId, validLatLon, round6, resetPhraseOk, errText, clockInfo,
} from './core.js';
import { ProtocolError, DisconnectedError } from './ble.js';
import { loadFillLog } from './fill.js';

export const IDLE_MS = 15 * 60 * 1000;

export class Maintenance extends Emitter {
  constructor({ client, clock = realClock, tzOffsetMin = () => new Date().getTimezoneOffset() }) {
    super();
    Object.assign(this, { client, clock, tzOffsetMin });
    this.session = null;            // {kind, grant, hoursAt, expAt}
    this.state = null;              // latest maint_state reply
    client.on('disconnected', () => this.endSession('connection'));
  }

  get active() { return !!this.session; }
  get grant() { return (this.session && this.session.grant) || {}; }
  get kind() { return this.session ? this.session.kind : ''; }
  // ms until the login ends: its hours or 15 minutes without use, whichever comes first
  sessionLeftMs() { return this.session ? Math.max(0, this.session.expAt - this.clock.now()) : 0; }
  touch() {
    const s = this.session;
    if (s) s.expAt = Math.min(s.hoursAt, this.clock.now() + IDLE_MS);
  }
  endSession(reason) {
    if (!this.session) return;
    this.session = null;
    this.state = null;
    this.emit('ended', reason);
  }
  _clock() { return phoneClock(this.clock.now(), this.tzOffsetMin()); }

  // ---- login
  async getChallenge({ isNew = false } = {}) {
    const r = await this.client.request('auth_challenge', { t: this._clock().t, new: isNew ? true : undefined });
    return { challenge: r.challenge, lockoutS: r.lockout_s || 0, newWaitS: r.new_wait_s || 0, mac: r.mac, fw: r.fw };
  }
  // text: what the operator pasted. Resolves {ok: true, grant, kind, expiresS} or {ok: false, key, ...}.
  async login(text) {
    const c = respCheck(text);
    if (!String(text || '').trim()) return { ok: false, key: 'respEmpty' };
    try {
      const r = await this.client.request('auth_response', { response: respNorm(c.code), t: this._clock().t });
      const now = this.clock.now();
      const hours = r.grant && Number.isFinite(r.grant.hours) ? r.grant.hours : 1;
      this.session = { kind: r.kind, grant: r.grant || {}, hoursAt: now + hours * 3600e3, expAt: now + (Number.isFinite(r.expires_s) ? r.expires_s : 900) * 1000 };
      this.emit('login', this.session);
      return { ok: true, kind: r.kind, grant: this.session.grant, expiresS: r.expires_s };
    } catch (e) {
      if (!(e instanceof ProtocolError)) return { ok: false, key: 'errNet', text: errText(e) };
      const out = { ok: false, key: loginErrorKey(e.code), code: e.code };
      if (e.code === 'locked' || e.code === 'wrong') {
        try { out.lockS = (await this.getChallenge()).lockoutS; } catch (e2) { /* no countdown then */ }
      }
      return out;
    }
  }
  async logout() {
    if (this.session && this.client.connected) { try { await this.client.request('auth_logout', {}, { timeoutMs: 3000 }); } catch (e) { /* ends with the link anyway */ } }
    this.endSession('logout');
  }

  // ---- every command that needs a login goes through here
  async _call(cmd, fields, opts) {
    try {
      const r = await this.client.request(cmd, fields, opts);
      this.touch();
      return r;
    } catch (e) {
      if (e instanceof ProtocolError && e.code === 'no_session') this.endSession('device');
      throw e;
    }
  }
  async _act(fn) {
    try { return { ok: true, ...(await fn()) }; } catch (e) {
      if (e instanceof ProtocolError || e instanceof DisconnectedError || e.name === 'TimeoutError') return { ok: false, error: e, text: errText(e), ended: e instanceof ProtocolError && e.code === 'no_session' };
      throw e;
    }
  }

  // maint_state: grant, tank, crash report, trial state. Its `expires_s` is the sensor's own count, so it replaces ours.
  async loadState() {
    const res = await this._act(async () => {
      const r = await this.client.request('maint_state');
      this.state = r;
      if (this.session) {
        if (r.grant) this.session.grant = r.grant;
        if (r.session && Number.isFinite(r.session.expires_s)) this.session.expAt = this.clock.now() + r.session.expires_s * 1000;
      }
      this.emit('state', r);
      return { state: r };
    });
    if (!res.ok && res.ended) this.endSession('device');
    return res;
  }

  async saveTank(l, w, h) {
    const v = validateTank(l, w, h);
    if (!v.ok) return { ok: false, err: 'input', v };
    return this._act(async () => ({ tank: (await this._call('maint_tank', { l_mm: v.l.v, w_mm: v.w.v, h_mm: v.h.v })).tank }));
  }
  async useDefaultTank() { return this._act(async () => ({ tank: (await this._call('maint_tank', { default: true })).tank })); }

  async saveSite(text) {
    const v = validateSiteId(text);
    if (!v.ok) return { ok: false, err: 'input', v };
    if (v.empty) return { ok: false, err: 'empty' };                 // clearing is a separate, deliberate button
    return this._act(async () => ({ site_id: (await this._call('maint_site', { site_id: v.value })).site_id }));
  }
  async clearSite() { return this._act(async () => ({ site_id: (await this._call('maint_site', { site_id: '' })).site_id })); }

  async saveLocation({ lat, lon, acc }) {
    if (!validLatLon(lat, lon)) return { ok: false, err: 'input' };
    const acc_m = Number.isFinite(acc) && acc >= 0 ? Math.min(100000, Math.round(acc)) : undefined;
    return this._act(async () => {
      const r = await this._call('maint_location', { lat: round6(lat), lon: round6(lon), acc_m });
      return { site_lat: r.site_lat, site_lon: r.site_lon };
    });
  }

  // The history of the newest 50 fill reports -> {ok, log: {reports, count}}. fill_log needs a login of any kind (PROTOCOL.md 4.4, 5): it goes
  // through the session like the settings commands, so that a login the sensor has ended is noticed (no_session ends it here too).
  async readFillLog(opts) {
    return this._act(async () => ({ log: await loadFillLog({ request: (cmd, fields, o) => this._call(cmd, fields, o) }, opts) }));
  }

  // The sensor's clock (PROTOCOL.md 4.5: `clock` needs no login) compared with this phone's -> {ok, clock: {set, utc, src, rtc, diffS}}
  async readClock() {
    return this._act(async () => {
      const t0 = this.clock.now();
      const r = await this.client.request('clock');
      return { clock: clockInfo(r, (t0 + this.clock.now()) / 2) };
    });
  }
  // maint_time: the sensor takes this phone's unix seconds (settings grant; counts as a settings change). The reply is the clock reply.
  async setClockFromPhone() {
    return this._act(async () => {
      const r = await this._call('maint_time', { t: Math.floor(this.clock.now() / 1000) });
      return { clock: clockInfo(r, this.clock.now()) };
    });
  }

  // typed: what the operator typed into the confirmation box (it must read RESET)
  async resetDefaults(typed) {
    if (!resetPhraseOk(typed)) return { ok: false, err: 'phrase' };
    return this._act(async () => {
      const r = await this._call('maint_reset', { confirm: 'RESET' });
      this.client.expectClose();
      this.endSession('reset');
      return { restartInS: r.restart_in_s, items: r.items };
    });
  }
  async restart() {
    return this._act(async () => {
      const r = await this._call('maint_restart');
      this.client.expectClose();
      this.endSession('restart');
      return { restartInS: r.restart_in_s };
    });
  }

  // The crash report in pages of up to 512 bytes. onProgress(0..1); shouldCancel() -> true stops.
  async readCoredump({ onProgress, shouldCancel } = {}) {
    return this._act(async () => {
      const parts = [];
      let off = 0, size = Infinity, pages = 0;
      while (off < size) {
        if (shouldCancel && shouldCancel()) return { cancelled: true };
        if (++pages > 8192) throw new ProtocolError('too_big', 'crash report is too large');
        const r = await this._call('coredump_read', { off, len: 512 });
        const part = base64Decode(r.d || '');
        if (r.off !== off || part.length !== r.len || (part.length === 0 && off < r.size)) throw new ProtocolError('bad_request', 'unexpected crash report page');
        size = r.size;
        parts.push(part);
        off += part.length;
        if (onProgress) onProgress(size ? Math.min(1, off / size) : 1);
      }
      return { bytes: concatBytes(...parts), size };
    });
  }
  async eraseCoredump() { return this._act(async () => { await this._call('coredump_erase'); return {}; }); }
}
