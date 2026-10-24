// An in-memory fuel sensor that speaks PROTOCOL.md (firmware 2.0), for the tests and for the ?demo=1 mode.
//
//   FakeSensor            the sensor's brain: bytes in (receive), notification pieces out (onNotify), commands, state
//   FakeSensorTransport   a Transport (see ble.js) wired to one FakeSensor: the UI cannot tell it from Bluetooth
//   createDemo(fast)      a sensor with human-friendly timing and a fixed login code
//
// It enforces what the real sensor enforces: 2048-byte lines, flat JSON, no backslash, the access rules of section 5,
// pieces of at most MTU-3 bytes in both directions, one phone at a time, a login that ends with the connection.
// It is NOT a copy of the firmware: levels, signatures and timings are simulated.
import { realClock, utf8, utf8Decode, base64Decode, base64Encode } from './util.js';
import { ConnectError, DisconnectedError, MAX_LINE } from './ble.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const DEMO_RESPONSE = 'DEM0'.repeat(26);               // 104 symbols
const DEFAULT_GRANT = { settings: true, firmware: true, calibration: false, older: false, service: false, hours: 1 };
const SLOT_BYTES = 1966080;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// maint_time takes the phone's unix seconds from 2026-01-01 to 2099-12-31 (PROTOCOL.md 4.2); anything else is bad_input
export const CLOCK_MIN_S = Date.UTC(2026, 0, 1) / 1000;
export const CLOCK_MAX_S = Date.UTC(2100, 0, 1) / 1000 - 1;

class Err extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; this.msg = msg || code; }
}
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isUint = (x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
const pad2 = (n) => (n < 10 ? '0' : '') + n;
// A paged reply carries as many items as fit in a line (PROTOCOL.md 3.5: "as many items as fit"); this is the room for the items,
// counted in bytes, after the envelope and a margin.
const FILL_LOG_ROOM = MAX_LINE - 24;
const LOGS_ROOM = MAX_LINE - 124;

function crockfordFrom(seedText, groups) {
  let h = 2166136261 >>> 0, out = '';
  for (let g = 0; g < groups; g++) {
    let grp = '';
    for (let i = 0; i < 5; i++) {
      for (const ch of seedText + g + ':' + i) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
      grp += CROCKFORD[h % 32];
    }
    out += (g ? '-' : '') + grp;
  }
  return out;
}
function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export class FakeSensor {
  constructor(o = {}) {
    this.clock = o.clock || realClock;
    this.mac = o.mac || 'A1B2C3D4E5F6';
    this.variant = o.variant || 'production';
    this.chip = o.chip || 'esp32c3';
    this.mtu = o.mtu || 247;                       // negotiated ATT MTU: pieces of mtu-3 bytes
    this.coded = o.coded !== false;                // the phone's radio can do Long Range
    this.grant = { ...DEFAULT_GRANT, ...(o.grant || {}) };
    this.loginCode = o.loginCode || DEMO_RESPONSE;
    this.statusMs = o.statusMs || 1000;
    this.settleMinS = o.settleMinS || 75;
    this.settleMaxS = o.settleMaxS || 300;
    this.pourLps = o.pourLps || 1.2;               // litres per second while the stage is "filling"
    this.burnLps = o.burnLps || 0;                 // litres per second drawn by the engine (demo)
    this.rebootMs = o.rebootMs === undefined ? 6000 : o.rebootMs;
    this.trialMs = o.trialMs === undefined ? 90000 : o.trialMs;
    this.linkSwitchMs = o.linkSwitchMs === undefined ? 1500 : o.linkSwitchMs;
    this.fillEnabled = o.fillEnabled !== false;
    this.slotBytes = o.slotBytes || SLOT_BYTES;            // the size of the update area (maint_state.ota.slot_bytes)
    this.strictPackage = !!o.strictPackage;        // check the .fwpkg header like the real sensor; demo accepts any file
    this.latencyMs = o.latencyMs || 0;
    this.otaFail = o.otaFail || null;              // {afterBytes, err, msg}: refuse the package with ota_err
    this.endFail = o.endFail || null;              // ota_end answers this error code
    this.rssi = o.rssi === undefined ? -58 : o.rssi;
    this.rtc = !!o.rtc;                            // a battery-backed clock chip is fitted: the sensor knows the time from the start
    this.s = {
      fw: o.fw || '2.0.0',
      boots: 12, powerInterruptions: 9, changes: 2,
      tank: { l_mm: 1755, w_mm: 790, h_mm: 190, custom: false, cap_l: 240 },
      level_mm: o.level_mm === undefined ? 123.45 : o.level_mm,
      site_id: o.site_id === undefined ? 'BLR-0042' : o.site_id,
      site_lat: o.site_lat === undefined ? 12.971599 : o.site_lat,
      site_lon: o.site_lon === undefined ? 77.594566 : o.site_lon,
      fuel: { filled_l: 1452.29, drained_l: 678.93, fills: 12, drains: 5, active: 'none', pending_l: 0 },
      coredump: o.coredump ? new Uint8Array(o.coredump).map((_, i) => (i * 7 + 3) & 255) : null,
      serial: o.serial === undefined ? 11 : o.serial, sinceReset: 2, reports: [],
      tokens: 6, tokenAt: 0,
      clockOffsetMs: o.rtc ? (o.rtcOffsetS || 0) * 1000 : null,     // sensor UTC = this clock + offset; null = the sensor does not know the time
      trialUntil: 0, rolledBack: false,
      link: { mode: 'auto', phy: '2M', pending: false },
      bootMs: this.clock.now(),
    };
    this.fill = { stage: 'idle' };
    this.online = true;
    this.out = null;                               // the transport that is connected right now
    this.notifying = false;
    this._timers = new Set();
    this._regsSeq = 100;
    this._logSeq = 1;
    this._logs = [];
    this._resetConn();
    this._challenge = this._newChallenge();
    this._newAt = -1e12;
    this.fails = 0;
    this.lockUntil = 0;
    this.sent = [];                                // every line sent to the phone (for tests); cleared with .sent.length = 0
    this.received = [];                            // every request line received
    this.strays = 0;
    this.stats = { otaChunksOk: 0, otaGaps: 0, otaDups: 0, maxLead: 0 };
    this.lastOta = null;
    this.tickTimer = null;
    this.hooks = {};                               // test hooks: {dropNotifications, swallow:[cmd], delayReply...}
  }

  // ------------------------------------------------------------------ connection plumbing
  _timer(kind, fn, ms) {
    const id = this.clock[kind](fn, ms);
    if (id && id.unref) id.unref();
    this._timers.add({ kind, id });
    return id;
  }
  _clearTimers() {
    for (const t of this._timers) this.clock[t.kind === 'setInterval' ? 'clearInterval' : 'clearTimeout'](t.id);
    this._timers.clear();
  }
  _resetConn() {
    this.subs = new Set();
    this.session = null;
    this.ota = null;
    this.asm = { parts: [], len: 0, skip: false };
    this.s.link = { ...this.s.link, mode: 'auto', pending: false };
    this.s.link.phy = '2M';
  }
  attach(transport) {
    if (!this.online) throw new Error('offline');
    if (this.out) throw new Error('busy');
    this.out = transport;
    this._resetConn();
  }
  detach(transport, reason) {
    if (this.out !== transport) return;
    this.out = null;
    this.notifying = false;
    if (this.tickTimer) { this.clock.clearInterval(this.tickTimer); this.tickTimer = null; }
    this._resetConn();
    if (transport.up) { transport.up = false; transport.onClose(reason || 'sensor'); }
  }
  enableNotifications() {
    this.notifying = true;
    this._send({ ev: 'hello', proto: 1, fw: this.s.fw, variant: this.variant, chip: this.chip, mac: this.mac, caps: this._caps(), min_app: 1 });
    if (this.tickTimer) this.clock.clearInterval(this.tickTimer);
    this.tickTimer = this._timer('setInterval', () => this._tick(), this.statusMs);
    this._ticks = 0;
  }
  stop() {
    this._clearTimers();
    if (this.tickTimer) { this.clock.clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.out) this.detach(this.out, 'stopped');
  }
  uptimeS() { return Math.max(0, Math.floor((this.clock.now() - this.s.bootMs) / 1000)); }

  _deliver(fn) {
    if (this.latencyMs > 0) this._timer('setTimeout', fn, this.latencyMs); else queueMicrotask(fn);
  }
  // One line to the phone, cut into pieces of MTU-3 bytes.
  _send(obj) {
    const bytes = utf8(JSON.stringify(obj) + '\n');
    if (bytes.length > MAX_LINE) throw new Error('fake sensor: line of ' + bytes.length + ' bytes (limit ' + MAX_LINE + '): ' + JSON.stringify(obj).slice(0, 80));
    this.sent.push(obj);
    if (this.sent.length > 3000) this.sent.splice(0, 1000);
    if (!this.notifying || !this.out) return;
    if (this.hooks.dropNotifications > 0 && obj.ev !== 'hello') { this.hooks.dropNotifications--; return; }
    if (obj.ev === 'ota' && this.hooks.dropOtaEvents > 0) { this.hooks.dropOtaEvents--; return; }
    const size = this.mtu - 3;
    for (let i = 0; i < bytes.length; i += size) {
      const piece = bytes.slice(i, i + size);
      const tr = this.out;
      this._deliver(() => { if (this.out === tr && tr.up) tr.onData(piece); });
    }
  }
  _reply(id, fields) { this._send({ id, ok: true, ...fields }); }
  _fail(id, code, msg) { this._send({ id, ok: false, err: code, msg: msg || code }); }

  // ------------------------------------------------------------------ incoming bytes
  receive(piece) {
    let start = 0;
    for (;;) {
      const nl = piece.indexOf(10, start);
      const end = nl < 0 ? piece.length : nl;
      const a = this.asm;
      if (!a.skip) {
        a.len += end - start;
        if (a.len + 1 > MAX_LINE) { a.skip = true; a.parts = []; }     // the newline counts: 2048 bytes in all
        else a.parts.push(piece.slice(start, end));
      }
      if (nl < 0) break;
      const done = this.asm;
      this.asm = { parts: [], len: 0, skip: false };
      if (done.skip) this._fail(null, 'line_too_long', 'line longer than ' + MAX_LINE + ' bytes');
      else {
        let n = 0;
        for (const p of done.parts) n += p.length;
        const buf = new Uint8Array(n);
        let o = 0;
        for (const p of done.parts) { buf.set(p, o); o += p.length; }
        let e2 = buf.length;
        if (e2 && buf[e2 - 1] === 13) e2--;
        if (e2) this._line(utf8Decode(buf.subarray(0, e2)));
      }
      start = nl + 1;
      if (start >= piece.length) break;
    }
  }
  _line(text) {
    this.received.push(text);
    let req;
    try { req = JSON.parse(text); } catch (e) { this._fail(null, 'bad_request', 'not JSON'); return; }
    if (!req || typeof req !== 'object' || Array.isArray(req)) { this._fail(null, 'bad_request', 'not an object'); return; }
    if (text.includes('\\')) { this._fail(isUint(req.id) ? req.id : null, 'bad_request', 'backslash in request'); return; }
    for (const [k, v] of Object.entries(req)) {
      if (v !== null && typeof v === 'object' && !(Array.isArray(v) && k === 'topics')) { this._fail(isUint(req.id) ? req.id : null, 'bad_request', 'requests are flat'); return; }
    }
    if (req.cmd === 'ota' && req.id === undefined) { this._otaChunk(req); return; }
    if (!isUint(req.id) || typeof req.cmd !== 'string' || !req.cmd) { this._fail(isUint(req.id) ? req.id : null, 'bad_request', 'id or cmd missing'); return; }
    if (this.hooks.swallow && this.hooks.swallow.includes(req.cmd)) return;       // never answers (timeout tests)
    const h = this['cmd_' + req.cmd];
    if (typeof h !== 'function' || (['debug', 'raw_start', 'raw_stop'].includes(req.cmd) && this.variant !== 'debug')) {
      this._fail(req.id, 'unknown_cmd', 'unknown command'); return;
    }
    const run = () => {
      try {
        const r = h.call(this, req);
        if (r !== undefined) this._reply(req.id, r);
      } catch (e) {
        if (e instanceof Err) this._fail(req.id, e.code, e.msg);
        else throw e;
      }
    };
    if (this.hooks.replyDelayMs) this._timer('setTimeout', run, this.hooks.replyDelayMs); else run();
  }

  // ------------------------------------------------------------------ access control (PROTOCOL.md section 5)
  _need(level) {
    const s = this.session;
    if (!s) throw new Err('no_session', 'login needed');
    const left = this._sessionLeftS();
    if (left <= 0) { this.session = null; throw new Err('no_session', 'login ended'); }
    if (level === 'any') { /* any login */ }
    else if (level === 'maintenance') { if (s.kind !== 'maintenance' || !(s.grant.settings || s.grant.firmware || s.grant.calibration)) throw new Err('grant', 'no maintenance grant'); }
    else if (level === 'settings') { if (s.kind !== 'maintenance' || !s.grant.settings) throw new Err('grant', 'no settings grant'); }
    else if (level === 'firmware') { if (s.kind !== 'maintenance' || !s.grant.firmware) throw new Err('grant', 'no firmware grant'); }
    else if (level === 'service') { if (s.kind !== 'service') throw new Err('grant', 'needs a service login'); }
    s.lastMs = this.clock.now();
    return s;
  }
  _sessionLeftS() {
    const s = this.session;
    if (!s) return 0;
    const now = this.clock.now();
    return Math.max(0, Math.min(s.startMs + s.grant.hours * 3600e3 - now, s.lastMs + 900e3 - now) / 1000);
  }

  // ------------------------------------------------------------------ views
  _lpmm() { return this.s.tank.l_mm * this.s.tank.w_mm / 1e6; }
  _litres() { return this.s.level_mm * this._lpmm(); }
  _capacity() { return this.s.tank.cap_l; }
  _pct() { return Math.max(0, Math.min(100, 100 * this._litres() / this._capacity())); }
  _statusWord() {
    if (this.s.fuel.active === 'fill' || this.s.fuel.active === 'drain') return 'moving';
    return 'steady';
  }
  _tank() {
    const t = this.s.tank;
    return { l_mm: r1(t.l_mm), w_mm: r1(t.w_mm), h_mm: r1(t.h_mm), lpmm: r5(this._lpmm()), custom: t.custom, cap_l: r1(t.cap_l) };
  }
  statusObject() {
    const s = this.s, lit = this._litres(), cap = this._capacity();
    const o = {
      fw: s.fw, variant: this.variant, chip: this.chip, mac: this.mac,
      level_mm: r2(s.level_mm), litres: r2(lit), capacity_l: r1(cap), fill_pct: r1(this._pct()),
      raw_adc: clamp(Math.round(lit * 4095 / cap), 0, 4095),
      source: 'estimate', status: this._statusWord(), age_s: 0.3, temp_c: 38,
      uptime_s: this.uptimeS(), boots: s.boots, power_interruptions: s.powerInterruptions, changes: s.changes,
      site_id: s.site_id, site_lat: s.site_lat, site_lon: s.site_lon,
      tank: this._tank(), radar: { link: 'ok' },
      fuel: { filled_l: r2(s.fuel.filled_l), drained_l: r2(s.fuel.drained_l), fills: s.fuel.fills, drains: s.fuel.drains, active: s.fuel.active, pending_l: r2(s.fuel.pending_l) },
      health: { safe_mode: false, trial: this.clock.now() < s.trialUntil, reset_reason: 'poweron', coredump: !!s.coredump },
    };
    if (this.variant === 'debug') Object.assign(o, { tracker: 'v6.11', calibration: '0x4242', state: 'confirmed', moving: this._statusWord() === 'moving' });
    return o;
  }
  linkObject() {
    const l = this.s.link;
    return { mode: l.mode, phy: l.phy, rssi: this.rssi, pending: l.pending, mtu: this.mtu };
  }
  regsWords() {
    const s = this.s, w = new Array(38).fill(0), lit = this._litres(), cap = this._capacity();
    const u32 = (i, v) => { v = Math.max(0, Math.min(0xfffffffe, Math.round(v))); w[i] = (v >>> 16) & 0xffff; w[i + 1] = v & 0xffff; };
    const s32 = (i, v) => { const x = v | 0; w[i] = (x >>> 16) & 0xffff; w[i + 1] = x & 0xffff; };
    w[0] = clamp(Math.round(lit * 4095 / cap), 0, 4095);
    w[1] = 38 & 0xffff;
    w[2] = clamp(Math.round(s.level_mm * 10), 0, 0xfffe);
    u32(3, lit * 100);
    for (let i = 0; i < 3; i++) w[5 + i] = parseInt(this.mac.substr(i * 4, 4), 16);
    const sid = s.site_id || '';
    for (let i = 0; i < 8; i++) w[8 + i] = ((sid.charCodeAt(2 * i) || 0) << 8) | (sid.charCodeAt(2 * i + 1) || 0);
    if (s.site_lat === null) s32(16, 0x7fffffff); else s32(16, Math.round(s.site_lat * 1e6));
    if (s.site_lon === null) s32(18, 0x7fffffff); else s32(18, Math.round(s.site_lon * 1e6));
    w[20] = Math.round(s.tank.l_mm); w[21] = Math.round(s.tank.w_mm); w[22] = Math.round(s.tank.h_mm);
    w[23] = Math.min(65535, s.changes);
    w[24] = ['steady', 'moving', 'checking', 'holding', 'starting', 'no_radar', 'safe_mode'].indexOf(this._statusWord());
    w[25] = 1 | 2 | 4 | (s.fuel.active === 'none' ? 0 : 16);
    u32(26, s.fuel.filled_l * 100); u32(28, s.fuel.drained_l * 100);
    w[30] = s.fuel.fills; w[31] = s.fuel.drains; w[32] = s.powerInterruptions;
    u32(33, this.uptimeS());
    const [ma, mi, pa] = s.fw.split('.').map(Number);
    w[35] = ma * 2048 + mi * 32 + pa;
    w[36] = 0;
    w[37] = Math.round(this._pct() * 10);
    return w;
  }
  regsEvent() { return { ev: 'regs', map: 1, seq: this._regsSeq++ & 0xffff, first: 40001, count: 38, words: this.regsWords() }; }

  // ------------------------------------------------------------------ the periodic work (one tick = statusMs)
  _tick() {
    if (!this.out) return;
    this._ticks++;
    const dt = this.statusMs / 1000, s = this.s;
    const lpmm = this._lpmm();
    if (this.fill.stage === 'filling') {
      const dL = this.pourLps * dt;
      s.level_mm += dL / lpmm;
      s.fuel.filled_l += dL;
      s.fuel.active = 'fill';
      s.fuel.pending_l = (s.level_mm - this.fill.levelBefore) * lpmm;
    } else if (this.burnLps > 0 && this.fill.stage === 'idle') {
      const dL = this.burnLps * dt;
      s.level_mm = Math.max(5, s.level_mm - dL / lpmm);
      s.fuel.drained_l += dL;
      s.fuel.active = 'slow_drain';
    } else {
      s.fuel.active = 'none';
      s.fuel.pending_l = 0;
    }
    if (this.fill.stage === 'filling') { /* pending stays */ }
    if (this.subs.has('status')) this._send({ ev: 'status', ...this.statusObject() });
    if (this.subs.has('regs')) this._send(this.regsEvent());
    if (this.subs.has('link') && this._ticks % 2 === 0) this._send({ ev: 'link', ...this.linkObject() });
    if (this.variant === 'debug') {
      this._addLog('I', 'level ' + r2(s.level_mm) + ' mm, state confirmed');
      if (this._ticks % 2 === 0) this._addLog('D', 'estimate ' + this._ticks + ' took 812 us');
    }
  }
  _addLog(l, m) {
    const line = { s: this._logSeq++, t: this.uptimeS() * 1000, l, m };
    this._logs.push(line);
    if (this._logs.length > 200) this._logs.shift();
    if (this.subs.has('log')) this._send({ ev: 'log', ...line });
  }

  // ------------------------------------------------------------------ commands: general and login
  cmd_hello() { return { proto: 1, fw: this.s.fw, variant: this.variant, chip: this.chip, mac: this.mac, caps: this._caps(), min_app: 1 }; }
  _caps() { return ['status', 'fill', 'maint', 'ota', 'link', 'regs', 'clock', 'capacity'].concat(this.chip === 'esp32c3' ? ['range'] : [], this.variant === 'debug' ? ['logs', 'raw'] : []); }
  cmd_ping() { return {}; }
  cmd_status() { return this.statusObject(); }
  cmd_subscribe(req) {
    const ok = ['status', 'log', 'link', 'regs'];
    if (!Array.isArray(req.topics) || req.topics.some((t) => !ok.includes(t))) throw new Err('bad_input', 'topics');
    if (req.topics.includes('log') && this.variant !== 'debug') this._need('service');
    req.topics.forEach((t) => this.subs.add(t));
    return { topics: [...this.subs] };
  }
  cmd_unsubscribe(req) {
    if (!Array.isArray(req.topics)) throw new Err('bad_input', 'topics');
    req.topics.forEach((t) => this.subs.delete(t));
    return { topics: [...this.subs] };
  }
  _newChallenge() { return 'FS-' + crockfordFrom(this.mac + ':' + (this._chalN = (this._chalN || 0) + 1), 8).replace(/-/g, '-').slice(0, 47); }
  cmd_auth_challenge(req) {
    const now = this.clock.now();
    if (req.new === true && now - this._newAt >= 600e3) { this._challenge = this._newChallenge(); this._newAt = now; }
    return {
      challenge: this._challenge, lockout_s: Math.max(0, Math.ceil((this.lockUntil - now) / 1000)),
      new_wait_s: Math.max(0, Math.ceil((this._newAt + 600e3 - now) / 1000)), mac: this.mac, fw: this.s.fw,
    };
  }
  cmd_auth_response(req) {
    const now = this.clock.now();
    if (!this._challenge) throw new Err('no_challenge', 'call auth_challenge first');
    const code = normalizeCode(req.response);
    if (code.length !== 104 || /[^0-9A-HJKMNP-TV-Z]/.test(code)) throw new Err('format', 'not a valid code');
    if (code !== normalizeCode(this.loginCode)) {                     // a correct response is always accepted, even when locked
      if (now < this.lockUntil) throw new Err('locked', 'locked out');
      if (++this.fails >= 5) this.lockUntil = now + 15 * 60e3;
      throw new Err('wrong', 'signature does not match');
    }
    this.fails = 0;
    this.session = { kind: 'maintenance', grant: { ...this.grant }, startMs: now, lastMs: now };
    this._challenge = this._newChallenge();
    return { kind: 'maintenance', grant: { ...this.grant }, expires_s: Math.round(this._sessionLeftS()) };
  }
  cmd_auth_logout() { this._need('any'); this.session = null; return {}; }

  // ------------------------------------------------------------------ maintenance
  _tankReply() { return { tank: this._tank() }; }
  cmd_maint_state() {
    this._need('maintenance');
    const s = this.s;
    return {
      build: { fw: s.fw, variant: this.variant, chip: this.chip, mac: this.mac },
      session: { expires_s: Math.round(this._sessionLeftS()), idle_s: 0 },
      grant: { ...this.session.grant },
      coredump: { present: !!s.coredump, size: s.coredump ? s.coredump.length : 0 },
      tank: this._tank(),
      ota: { trial: this.clock.now() < s.trialUntil, trial_remaining_s: Math.max(0, Math.round((s.trialUntil - this.clock.now()) / 1000)), rolled_back: s.rolledBack, rejected_version: '', slot_bytes: this.slotBytes },
    };
  }
  cmd_maint_tank(req) {
    this._need('settings');
    if (req.default === true) { this.s.tank = { l_mm: 1755, w_mm: 790, h_mm: 190, custom: false, cap_l: this.s.tank.cap_l }; this.s.changes++; return this._tankReply(); }
    const ok = (v) => typeof v === 'number' && v >= 10 && v <= 10000;
    const hasDim = ['l_mm', 'w_mm', 'h_mm'].some((k) => req[k] !== undefined), hasCap = req.cap_l !== undefined;
    if (hasDim || !hasCap) {
      if (!ok(req.l_mm) || !ok(req.w_mm) || !ok(req.h_mm)) throw new Err('bad_input', 'l_mm, w_mm, h_mm must be 10 to 10000');
      Object.assign(this.s.tank, { l_mm: req.l_mm, w_mm: req.w_mm, h_mm: req.h_mm, custom: true });
    }
    if (hasCap) {
      if (!(typeof req.cap_l === 'number' && req.cap_l >= 10 && req.cap_l <= 5000)) throw new Err('bad_input', 'cap_l must be 10 to 5000');
      this.s.tank.cap_l = Math.round(req.cap_l * 10) / 10;
    }
    this.s.changes++;
    return this._tankReply();
  }
  cmd_maint_site(req) {
    this._need('settings');
    // 1 to 16 characters, letters digits space and - _ . /, the first a letter or digit, the last not a space (core/site.cpp site_id_valid)
    if (typeof req.site_id !== 'string' || (req.site_id !== '' && !/^[A-Za-z0-9](?:[A-Za-z0-9 _.\/-]{0,14}[A-Za-z0-9_.\/-])?$/.test(req.site_id))) throw new Err('bad_input', 'site_id');
    this.s.site_id = req.site_id === '' ? null : req.site_id;
    this.s.changes++;
    return { site_id: this.s.site_id };
  }
  cmd_maint_location(req) {
    this._need('settings');
    const okNum = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
    if (!okNum(req.lat, 90) || !okNum(req.lon, 180)) throw new Err('bad_input', 'lat/lon');
    if (req.acc_m !== undefined && !okNum(req.acc_m, 1e7)) throw new Err('bad_input', 'acc_m');
    this.s.site_lat = r6(req.lat); this.s.site_lon = r6(req.lon);
    this.s.changes++;
    return { site_lat: this.s.site_lat, site_lon: this.s.site_lon };
  }
  // ---- the sensor clock (PROTOCOL.md 4.2 and 4.5)
  // Unix seconds UTC, or null while the sensor does not know the time. With a clock chip the time is there from the start and survives
  // a restart; without one a phone sets it with maint_time and a restart loses it.
  _utc() { const o = this.s.clockOffsetMs; return o === null ? null : Math.floor((this.clock.now() + o) / 1000); }
  _clockReply() {
    const utc = this._utc();
    // `valid`: the sensor knows the time (PROTOCOL.md 4.5; the envelope's own `ok` is always true here). hooks.clockNoValid leaves it out,
    // like a firmware from before the field.
    const r = { valid: utc !== null, utc, src: utc === null ? 'none' : this.rtc ? 'rtc' : 'phone', rtc: this.rtc };
    if (this.hooks.clockNoValid) delete r.valid;
    return r;
  }
  cmd_clock() { return this._clockReply(); }
  cmd_maint_time(req) {
    this._need('settings');
    if (!Number.isInteger(req.t) || req.t < CLOCK_MIN_S || req.t > CLOCK_MAX_S) throw new Err('bad_input', 't must be unix seconds from 2026-01-01 to 2099-12-31');
    this.s.clockOffsetMs = req.t * 1000 - this.clock.now();
    this.s.changes++;
    return this._clockReply();
  }
  cmd_maint_reset(req) {
    this._need('settings');
    if (req.confirm !== 'RESET') throw new Err('confirm', 'send "confirm":"RESET"');
    if (this.ota || this.clock.now() < this.s.trialUntil) throw new Err('busy', 'update in progress');
    this._timer('setTimeout', () => this._reboot({ reset: true }), 2000);
    return { items: 61, restart_in_s: 2 };
  }
  cmd_maint_restart() {
    this._need('maintenance');
    this._timer('setTimeout', () => this._reboot({}), 2000);
    return { restart_in_s: 2 };
  }
  cmd_coredump_read(req) {
    this._need('any');
    const d = this.s.coredump;
    if (!d) throw new Err('no_dump', 'no crash report');
    const off = req.off === undefined ? 0 : req.off, len = Math.min(512, req.len === undefined ? 512 : req.len);
    if (!isUint(off) || !isUint(len) || off > d.length) throw new Err('bad_input', 'off/len');
    const n = Math.min(len, d.length - off);
    return { size: d.length, off, len: n, d: base64Encode(d.subarray(off, off + n)) };
  }
  cmd_coredump_erase() { this._need('maintenance'); this.s.coredump = null; return {}; }

  _reboot({ reset = false, version = null }) {
    const s = this.s;
    if (!this.rtc) s.clockOffsetMs = null;                       // without a clock chip the time set by a phone is lost at a restart
    if (reset) {
      s.tank = { l_mm: 1755, w_mm: 790, h_mm: 190, custom: false, cap_l: 240 };
      s.fuel = { filled_l: 0, drained_l: 0, fills: 0, drains: 0, active: 'none', pending_l: 0 };
      s.reports = []; s.sinceReset = 0; s.changes++;
      s.site_id = null; s.site_lat = null; s.site_lon = null;               // the site ID and location are cleared too (items = 61)
      this.fill = { stage: 'idle' };
    }
    const prev = s.fw;
    if (version) { s.fw = version; s.changes++; }                // an installed firmware update counts as a settings change
    const tr = this.out;
    if (tr) this.detach(tr, 'reboot');
    this.online = false;
    this._timer('setTimeout', () => {
      this.online = true;
      s.boots++;
      s.bootMs = this.clock.now();
      if (version) {
        s.trialUntil = this.clock.now() + this.trialMs;
        if (this.hooks.rollback) {                    // the new firmware fails its own check and the old one comes back
          this._timer('setTimeout', () => { s.fw = prev; s.rolledBack = true; s.trialUntil = 0; this._reboot({}); }, Math.floor(this.trialMs / 2));
        }
      }
    }, this.rebootMs);
  }
  // Test helper: the sensor loses power for a moment.
  powerCycle() { this._reboot({}); }

  // ------------------------------------------------------------------ logs (debug builds; service login on production)
  cmd_logs(req) {
    if (this.variant !== 'debug') this._need('service');
    const since = req.since === undefined ? 0 : req.since;
    if (!isUint(since)) throw new Err('bad_input', 'since');
    const showDebug = req.debug === true;
    const first = this._logs.length ? this._logs[0].s : this._logSeq;
    const lost = Math.max(0, first - since);
    const lines = [];
    let size = 150, next = Math.max(since, first);
    for (const l of this._logs) {
      if (l.s < since) continue;
      if (l.l === 'D' && !showDebug) { next = l.s + 1; continue; }
      const sz = utf8(JSON.stringify(l)).length + 1;
      if (size + sz > LOGS_ROOM) break;
      lines.push(l); size += sz; next = l.s + 1;
    }
    return { first, lost: since === 0 ? 0 : lost, uptime_ms: this.uptimeS() * 1000, debug: showDebug, lines, next };
  }
  cmd_debug() { return { note: 'lab only' }; }
  cmd_raw_start() { return { radar: {}, tick_hz: 1000 }; }
  cmd_raw_stop() { return {}; }

  // ------------------------------------------------------------------ fill reports (section 6)
  _fillStage() {
    const f = this.fill;
    if (f.stage === 'measuring' && this.clock.now() - f.endMs >= this.settleMinS * 1000) f.stage = 'ready';
    return f.stage;
  }
  // fill_state, fill_start and fill_end (PROTOCOL.md 4.4): the stage and, always last, `last`: the newest report the sensor holds (public, no
  // login) or null. The history, fill_log, needs a login.
  _fillState() {
    if (!this.fillEnabled) return { enabled: false, stage: 'idle', last: null };
    const f = this.fill, stage = this._fillStage(), now = this.clock.now();
    const o = { enabled: true, stage };
    if (stage !== 'idle') {
      o.phone_start = f.phone_start; o.phone_end = f.phone_end || 0; o.tz_min = f.tz_min;
      o.since_start_s = Math.floor((now - f.startMs) / 1000); o.restarted = !!f.restarted;
      if (stage === 'measuring' || stage === 'ready') {
        o.since_end_s = Math.floor((now - f.endMs) / 1000); o.settle_min_s = this.settleMinS; o.settle_max_s = this.settleMaxS;
      }
    }
    o.last = this.s.reports.length ? this.s.reports[0] : null;
    return o;
  }
  _fillOn() { if (!this.fillEnabled) throw new Err('off', 'fill reports are not enabled'); }
  cmd_fill_state() { return this._fillState(); }
  cmd_fill_start(req) {
    this._fillOn();
    const now = this.clock.now();
    if (!isUint(req.t) || !Number.isInteger(req.tz_min) || req.tz_min < -840 || req.tz_min > 840) throw new Err('bad_input', 't/tz_min');
    const hasLat = req.lat !== undefined, hasLon = req.lon !== undefined;
    if (hasLat !== hasLon) throw new Err('bad_input', 'lat and lon come together');
    if (hasLat && (typeof req.lat !== 'number' || typeof req.lon !== 'number' || Math.abs(req.lat) > 90 || Math.abs(req.lon) > 180)) throw new Err('bad_input', 'lat/lon');
    if (this._fillStage() !== 'idle') throw new Err('busy', 'a fill report is already open');
    this._refillTokens();
    if (this.s.tokens < 1) throw new Err('rate_limited', 'too many fill reports');
    this.fill = { stage: 'filling', phone_start: req.t, tz_min: req.tz_min, startMs: now, levelBefore: this.s.level_mm,
      lat: hasLat ? r6(req.lat) : null, lon: hasLat ? r6(req.lon) : null, restarted: false, devStart: this._utc(),
      flowing: this.s.fuel.active === 'fill' || this.s.fuel.active === 'drain' };      // a fill or a drain was open at Start (flag bit 8)
    return this._fillState();
  }
  cmd_fill_end(req) {
    this._fillOn();
    if (!isUint(req.t)) throw new Err('bad_input', 't');
    if (this._fillStage() !== 'filling') throw new Err('not_open', 'no open fill report');
    Object.assign(this.fill, { stage: 'measuring', phone_end: req.t, endMs: this.clock.now(), devEnd: this._utc() });
    this.s.fuel.active = 'none';
    return this._fillState();
  }
  _refillTokens() {
    const now = this.clock.now();
    if (this.s.tokens < 6 && now - this.s.tokenAt >= 600e3) { this.s.tokens = Math.min(6, this.s.tokens + Math.floor((now - this.s.tokenAt) / 600e3)); this.s.tokenAt = now; }
  }
  cmd_fill_confirm(req) {
    this._fillOn();
    const st = this._fillStage();
    if (st === 'idle') throw new Err('not_open', 'no open fill report');
    if (st === 'filling') throw new Err('not_ready', 'end the fill first');
    if (st === 'measuring') throw new Err('measuring', 'still measuring');
    if (typeof req.litres !== 'number' || !(req.litres >= 0 && req.litres <= 100000)) throw new Err('bad_input', 'litres');
    if (req.moved_m !== undefined && !(Number.isInteger(req.moved_m) && req.moved_m >= 0)) throw new Err('bad_input', 'moved_m');
    const f = this.fill, s = this.s, lpmm = this._lpmm();
    const after = s.level_mm;
    const sensorL = Math.max(0, (after - f.levelBefore) * lpmm);
    s.serial++; s.sinceReset++;
    s.tokens = Math.max(0, s.tokens - 1); if (!s.tokenAt) s.tokenAt = this.clock.now();
    const tz = f.tz_min, loc = (u) => { const d = new Date((u + tz * 60) * 1000); return { day: d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()], hm: pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) }; };
    const a = f.phone_start > 0 ? loc(f.phone_start) : null, b = f.phone_end > 0 ? loc(f.phone_end) : null;
    const when = a ? a.day + ' ' + a.hm + (b ? '–' + b.hm : '') : 'time unknown';
    const moved = req.moved_m === undefined ? null : req.moved_m;
    const report = {
      serial: s.serial, since_reset: s.sinceReset,
      line: 'Fill report #' + s.serial + ' · PROCOM-SENSOR-' + this.mac + ' · ' + when + ' · operator ' + req.litres.toFixed(1) + ' L · sensor ' + sensorL.toFixed(1) + ' L',
      code: 'FR-' + crockfordFrom(this.mac + s.serial + ':' + req.litres, 24),
      operator_l: r2(req.litres), sensor_l: r2(sensorL), drained_l: 0,
      level_before_mm: r2(f.levelBefore), level_after_mm: r2(after), lpmm: r6(lpmm),
      phone_start: f.phone_start, phone_end: f.phone_end, tz_min: f.tz_min,
      duration_s: Math.floor((f.endMs - f.startMs) / 1000), lookback_s: 0, gen: 1, settings_changes: s.changes,
      flags: (f.restarted ? 1 : 0) | (moved !== null && moved > 100 ? 128 : 0) | (f.flowing ? 256 : 0),
      site_id: s.site_id, site_lat: s.site_lat, site_lon: s.site_lon,
      op_lat: f.lat, op_lon: f.lon, moved_m: moved,
      dev_utc_start: f.devStart === undefined ? null : f.devStart, dev_utc_end: f.devEnd === undefined ? null : f.devEnd,   // the sensor's own clock; null = it was not set
    };
    s.reports.unshift(report);
    if (s.reports.length > 50) s.reports.length = 50;
    s.fuel.fills++;
    this.fill = { stage: 'idle' };
    return { report };
  }
  // The history of the newest 50 reports (litres, times, the site, the operator's position): any login, maintenance or service. Without one
  // it answers no_session; the newest report alone is public (fill_state `last`).
  cmd_fill_log(req) {
    this._need('any');
    const from = req.from === undefined ? 0 : req.from;
    if (!isUint(from)) throw new Err('bad_input', 'from');
    const all = this.s.reports, reports = [];
    let size = 80;
    for (let i = from; i < all.length; i++) {
      const sz = utf8(JSON.stringify(all[i])).length + 1;
      if (reports.length && size + sz > FILL_LOG_ROOM) break;
      reports.push(all[i]); size += sz;
    }
    return { count: all.length, from, reports };
  }

  // ------------------------------------------------------------------ link and registers (section 4.5)
  cmd_link(req) {
    const l = this.s.link;
    if (req.mode !== undefined) {
      if (!['auto', 'fast', 'range'].includes(req.mode)) throw new Err('bad_input', 'mode');
      l.mode = req.mode;
      l.pending = true;
      this._timer('setTimeout', () => {
        l.pending = false;
        l.phy = req.mode === 'range' ? (this.coded ? 'coded' : '2M') : '2M';
        if (this.out && this.subs.has('link')) this._send({ ev: 'link', ...this.linkObject() });
      }, this.linkSwitchMs);
    }
    return this.linkObject();
  }
  cmd_regs() { const e = this.regsEvent(); delete e.ev; return e; }

  // ------------------------------------------------------------------ firmware update (section 7)
  cmd_ota_begin(req) {
    this._need('firmware');
    if (this.ota || this.clock.now() < this.s.trialUntil) throw new Err('busy', 'an update is in progress or in its trial');
    if (this.s.link.mode === 'range') throw new Err('link_mode', 'switch the link to fast first');
    if (!isUint(req.size)) throw new Err('bad_input', 'size');
    if (req.size > this.slotBytes) throw new Err('big', 'larger than the update area');
    if (req.size < 192 + 16) throw new Err('format', 'too small for a package');
    this.ota = { total: req.size, expected: 0, bytes: 0, head: new Uint8Array(192), failed: false, parts: [], lastEventN: 0, chunkLen: 0 };
    return {};
  }
  _rand() { this._seed = (Math.imul(this._seed || 12345, 1103515245) + 12345) >>> 0; return this._seed / 4294967296; }
  _otaChunk(req) {
    const o = this.ota, h = this.hooks;
    if (!o || !this.session) { this.strays++; return; }
    if (!Number.isInteger(req.n) || typeof req.d !== 'string') { this.strays++; return; }
    this.stats.maxLead = Math.max(this.stats.maxLead, req.n - (o.lastEventN || 0));
    // test hooks: lose or repeat a chunk on its way (first transmission only for the explicit sets)
    if (h.dropChunks && h.dropChunks.has(req.n)) { h.dropChunks.delete(req.n); return; }
    if (h.lossRate && this._rand() < h.lossRate) return;
    const again = (h.dupChunks && h.dupChunks.has(req.n)) || (h.dupRate && this._rand() < h.dupRate);
    if (h.dupChunks) h.dupChunks.delete(req.n);
    if (h.noTransferAt !== undefined && req.n === h.noTransferAt) {                      // the sensor lost the transfer (said once)
      h.noTransferAt = undefined;
      this._send({ ev: 'ota_err', err: 'no_transfer', msg: 'no transfer in progress', fatal: false, n: 0, bytes: 0, total: o.total });
      this.ota = null;
      return;
    }
    if (h.shortChunks && h.shortChunks.has(req.n) && req.n === o.expected && req.d.length > 40) {   // a write lost inside a line that spans several
      h.shortChunks.delete(req.n);                                                                // writes: the text is shorter, still valid Base64
      req = { ...req, d: req.d.slice(0, 8) + req.d.slice(28) };
    }
    if (h.softErrChunks && h.softErrChunks.has(req.n) && req.n === o.expected) {         // refused, but the transfer goes on
      h.softErrChunks.delete(req.n);
      this._send({ ev: 'ota_err', err: 'write', msg: 'chunk not stored', fatal: false, n: o.expected, bytes: o.bytes, total: o.total });
      return;
    }
    this._otaChunk1(req);
    if (again && this.ota) this._otaChunk1(req);
  }
  _otaEvent(o) { o.lastEventN = o.expected; this._send({ ev: 'ota', n: o.expected, bytes: o.bytes, total: o.total }); }
  _otaChunk1(req) {
    const o = this.ota;
    if (req.n !== o.expected) {                       // a gap or a repeat: tell the phone which chunk is next
      if (req.n > o.expected) this.stats.otaGaps++; else this.stats.otaDups++;
      this._otaEvent(o);
      return;
    }
    let raw;
    try { raw = base64Decode(req.d); } catch (e) { raw = null; }
    if (!raw || raw.length === 0) {                                              // not strict Base64: refused, the transfer goes on
      this._send({ ev: 'ota_err', err: 'bad_base64', msg: 'The chunk data is not valid base64.', n: o.expected, bytes: o.bytes, total: o.total, fatal: false });
      return;
    }
    // one chunk size for the whole file: a chunk that stops short of the end of the package must be as long as chunk 0
    if (o.expected > 0 && raw.length !== o.chunkLen && o.bytes + raw.length < o.total) {
      this._send({ ev: 'ota_err', err: 'bad_size', msg: 'The chunk is not as long as the first one. Send it again.', n: o.expected, bytes: o.bytes, total: o.total, fatal: false });
      return;
    }
    if (o.expected === 0) o.chunkLen = raw.length;
    for (let i = 0; i < raw.length && o.bytes + i < 192; i++) o.head[o.bytes + i] = raw[i];
    o.parts.push(raw);
    o.bytes += raw.length; o.expected++; this.stats.otaChunksOk++;
    if (o.bytes > o.total) { this._otaFatal('format', 'more data than announced'); return; }
    if (this.otaFail && !o.failed && o.bytes >= this.otaFail.afterBytes) { o.failed = true; this._otaFatal(this.otaFail.err, this.otaFail.msg || 'refused'); return; }
    if (this.strictPackage && o.bytes >= 192 && !o.checked) {
      o.checked = true;
      const magic = utf8Decode(o.head.subarray(0, 8));
      if (magic !== 'MRMFWPK1') { this._otaFatal('format', 'not a firmware package'); return; }
    }
    if (o.expected % 8 === 0 || o.bytes === o.total) this._otaEvent(o);
  }
  _otaFatal(err, msg) {
    const o = this.ota;
    this._send({ ev: 'ota_err', err, msg, fatal: true, n: o.expected, bytes: o.bytes, total: o.total });
    this.ota = null;
  }
  cmd_ota_end() {
    this._need('firmware');
    const o = this.ota;
    if (!o) throw new Err('format', 'no transfer');
    if (this.endFail) { this.ota = null; throw new Err(this.endFail, 'refused at the end'); }
    if (o.bytes !== o.total) throw new Err('format', 'incomplete: ' + o.bytes + ' of ' + o.total);
    let version;
    if (utf8Decode(o.head.subarray(0, 8)) === 'MRMFWPK1') {
      const u = (o.head[32] | o.head[33] << 8 | o.head[34] << 16 | o.head[35] << 24) >>> 0;
      version = (u >>> 16) + '.' + ((u >>> 8) & 255) + '.' + (u & 255);
    } else {
      const p = this.s.fw.split('.').map(Number); version = p[0] + '.' + p[1] + '.' + (p[2] + 1);
    }
    let all = new Uint8Array(o.bytes), at = 0;
    for (const p of o.parts) { all.set(p, at); at += p.length; }
    this.lastOta = all;
    this.ota = null;
    this._timer('setTimeout', () => this._reboot({ version }), 2000);
    return { version, restart_in_s: 2 };
  }
  cmd_ota_abort() { this._need('firmware'); this.ota = null; return {}; }
}

// ---------------------------------------------------------------------- the transport
export class FakeSensorTransport {
  // maxWrite: what the "browser" reports as maxWriteWithoutResponseSize (null: it has none)
  constructor(sensor, { maxWrite = null, otaBytesPerS = 0, clock } = {}) {
    this.sensor = sensor;
    this.maxWrite = maxWrite;
    this.otaBytesPerS = otaBytesPerS;
    this.clock = clock || sensor.clock;
    this.up = false;
    this.picked = false;
    this.writes = [];                 // sizes of the writes, for tests
    this.onData = () => {};
    this.onClose = () => {};
    this.failNextConnects = 0;
  }
  async pick() { this.picked = true; return { name: 'PROCOM-SENSOR-' + this.sensor.mac }; }
  async connect() {
    if (this.failNextConnects > 0) { this.failNextConnects--; throw new ConnectError('ce_failed'); }
    if (!this.sensor.online) throw new ConnectError('ce_notfound');
    try { this.sensor.attach(this); } catch (e) { throw new ConnectError(e.message === 'busy' ? 'ce_notfound' : 'ce_failed'); }
    this.up = true;
    await Promise.resolve();
    this.sensor.enableNotifications();
  }
  async write(bytes, { noResponse = false } = {}) {
    if (!this.up) throw new DisconnectedError();
    if (bytes.length > this.sensor.mtu - 3) throw new Error('fake transport: a write of ' + bytes.length + ' bytes exceeds MTU-3 = ' + (this.sensor.mtu - 3));
    if (this.maxWrite && bytes.length > this.maxWrite) throw new Error('fake transport: write above maxWrite');
    this.writes.push(bytes.length);
    if (noResponse && this.otaBytesPerS > 0) {
      await new Promise((r) => this.clock.setTimeout(r, bytes.length * 1000 / this.otaBytesPerS));
      if (!this.up) throw new DisconnectedError();
    }
    this.sensor.receive(bytes.slice());
  }
  disconnect() {
    if (this.up) { this.up = false; this.sensor.detach(this, 'user'); }
  }
}

// A sensor with demo timing. fast: everything about ten times quicker, for tests and impatient people.
// rtc: the demo sensor has a clock chip that runs 23 s behind the phone (so the Sensor clock card has something to say); without it the
// sensor does not know the time until a phone sets it.
export function createDemo({ fast = false, mac = 'A1B2C3D4E5F6', clock, variant = 'production', rtc = false } = {}) {
  const k = fast ? 10 : 1;
  const sensor = new FakeSensor({
    clock, mac, variant, rtc, rtcOffsetS: -23, level_mm: 123.45, burnLps: 0.02 * k, pourLps: 1.5 * k,
    settleMinS: fast ? 2 : 8, settleMaxS: fast ? 6 : 20, rebootMs: fast ? 1500 : 4000, trialMs: fast ? 1500 : 8000,
    linkSwitchMs: fast ? 300 : 1200, coredump: 1500,
  });
  const transport = new FakeSensorTransport(sensor, { maxWrite: 244, otaBytesPerS: fast ? 400000 : 12000, clock });
  return { sensor, transport, loginCode: DEMO_RESPONSE };
}
