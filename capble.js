// The capacitive sensor (Escort TD-150-BLE) next to the radar sensor. It broadcasts its readings in Bluetooth advertisements (every 1 to 3 s,
// level 1 to 1023 / 4095, temperature), so no connection is needed and this does not use the radar sensor's link. The packets are logged as
// they are (`adv` lines: name, signal, manufacturer and service data as hex), plus the Escort fields decoded (`escort`). No DOM, no direct Web
// Bluetooth (the chooser comes in from ble.js). Needs Chrome's BluetoothDevice.watchAdvertisements().
import { Emitter, realClock } from './util.js';

const hex = (dv) => {
  const b = dv instanceof DataView ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength) : new Uint8Array(dv.buffer || dv);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};
const mapObj = (m, keyFmt) => { const o = {}; if (m && typeof m.forEach === 'function') m.forEach((v, k) => { o[keyFmt(k)] = hex(v); }); return o; };

// The Escort broadcast (manufacturer data of company 0x0F16, 12 bytes), worked out on the real sensor TW_133978 on 13 Nov 2026 (level about
// 89 mm, 22 broadcasts in 60 s): 08 | level u16 LE | 00 | temperature int8 C | ?? | CNT u16 LE | 00 00 00 | 80, e.g. 08 df04 00 25 d9 f05e
// 000000 80 = level 1247 (of 4095), 37 C, CNT 24304. Level and CNT moved together; the temperature is not yet checked against the Escort app;
// the other bytes did not change (their meaning is not known). Escort does not publish the layout: the raw hex stays in the line.
export const ESCORT_KEY = '0x0f16';
export function escortDecode(h) {
  if (typeof h !== 'string' || !/^08(?:[0-9a-f]{2}){7,}$/i.test(h)) return null;
  const b = h.match(/../g).map((x) => parseInt(x, 16));
  return { level: b[1] | (b[2] << 8), temp_c: b[4] > 127 ? b[4] - 256 : b[4], cnt: b[6] | (b[7] << 8) };
}

// One `advertisementreceived` event as a recording line.
export function advLine(ev) {
  const line = { ev: 'adv', name: (ev.device && ev.device.name) || ev.name || '', rssi: Number.isFinite(ev.rssi) ? ev.rssi : null, tx_power: Number.isFinite(ev.txPower) ? ev.txPower : null };
  const mfr = mapObj(ev.manufacturerData, (k) => '0x' + Number(k).toString(16).padStart(4, '0'));
  const svc = mapObj(ev.serviceData, (k) => String(k));
  if (Object.keys(mfr).length) line.mfr = mfr;
  const esc = escortDecode(mfr[ESCORT_KEY]);
  if (esc) line.escort = esc;
  if (Object.keys(svc).length) line.svc = svc;
  if (ev.uuids && ev.uuids.length) line.uuids = [...ev.uuids].map(String);
  return line;
}

export class CapAdvLogger extends Emitter {
  // choose({all}) -> Promise<device>: the browser's chooser (ble.js requestAdvertiser); supported: the browser has Web Bluetooth;
  // canWatch: false when the browser is known to have no watchAdvertisements() (Chrome and Edge have it only with the setting
  // "Experimental Web Platform features" switched on), null when that cannot be told before a device is chosen.
  constructor({ choose, supported = true, canWatch = null, clock = realClock } = {}) {
    super();
    Object.assign(this, { chooser: choose, isSupported: !!supported, canWatch, clock });
    this.state = 'idle';            // idle | watching
    this.device = null;
    this.name = '';
    this.packets = 0;
    this.last = null;               // the newest line
    this.lastAt = 0;
    this.error = null;              // {code, text}
    this._on = (ev) => this._adv(ev);
  }
  get supported() { return this.isSupported && typeof this.chooser === 'function'; }
  get watching() { return this.state === 'watching'; }

  // Must be called straight from a tap (the browser's chooser). `all`: list every device, not only names starting with TD.
  async choose({ all = false } = {}) {
    this.error = null;
    if (!this.supported || this.canWatch === false) { this.error = { code: 'unsupported', text: '' }; this.emit('change'); return false; }   // (said before the chooser opens: no pointless choice)
    let device;
    try {
      device = await this.chooser({ all });
    } catch (e) {
      this.error = e && e.name === 'NotFoundError' ? { code: 'cancelled', text: '' } : { code: 'other', text: (e && e.message) || 'error' };
      this.emit('change');
      return false;
    }
    if (!device || typeof device.watchAdvertisements !== 'function') { this.error = { code: 'unsupported', text: '' }; this.emit('change'); return false; }
    this.stop();
    try {
      device.addEventListener('advertisementreceived', this._on);
      await device.watchAdvertisements();
    } catch (e) {
      device.removeEventListener('advertisementreceived', this._on);
      this.error = { code: 'other', text: (e && e.message) || 'error' };
      this.emit('change');
      return false;
    }
    this.device = device;
    this.name = device.name || '';
    this.packets = 0;
    this.restarts = 0;
    this.last = null;
    this.lastAt = this.clock.now();
    this.state = 'watching';
    this._startWatchdog();
    this.emit('change');
    return true;
  }
  // Chrome / Edge on Windows stop delivering the broadcasts after a minute or two while watchAdvertisements() still counts as on (14 Nov 2026
  // recording: 13 packets in the first 126 s, then none for 15 min; 13 Nov: 0 packets in 57 min). When nothing came for STALL_MS the watch is
  // stopped and started again on the same device (no chooser needed); `restart` is emitted so the recording shows it.
  _startWatchdog() {
    this._stopWatchdog();
    this._wd = this.clock.setInterval(() => this._check(), CapAdvLogger.CHECK_MS);
  }
  _stopWatchdog() { if (this._wd) { this.clock.clearInterval(this._wd); this._wd = null; } }
  async _check() {
    const d = this.device;
    if (!d || this._busy || this.clock.now() - this.lastAt < CapAdvLogger.STALL_MS) return;
    this._busy = true;
    const quietS = Math.round((this.clock.now() - this.lastAt) / 1000);
    try { if (typeof d.unwatchAdvertisements === 'function') d.unwatchAdvertisements(); } catch (e) { /* already stopped */ }
    let ok = true, text = '';
    try { await d.watchAdvertisements(); } catch (e) { ok = false; text = (e && e.message) || 'error'; }
    this._busy = false;
    if (this.device !== d) return;                               // stopped meanwhile
    this.restarts++;
    this.lastAt = this.clock.now();                              // the next try comes STALL_MS later
    this.emit('restart', { n: this.restarts, quiet_s: quietS, ok, error: text });
    this.emit('change');
  }
  stop() {
    this._stopWatchdog();
    const d = this.device;
    this.device = null;
    if (d) {
      d.removeEventListener('advertisementreceived', this._on);
      try { if (typeof d.unwatchAdvertisements === 'function') d.unwatchAdvertisements(); } catch (e) { /* already stopped */ }
    }
    if (this.state !== 'idle') { this.state = 'idle'; this.emit('change'); }
  }
  _adv(ev) {
    const line = advLine(ev);
    this.packets++;
    this.last = line;
    this.lastAt = this.clock.now();
    this.emit('adv', line);
  }
  get agoS() { return this.last ? Math.max(0, Math.round((this.clock.now() - this.lastAt) / 1000)) : null; }
  get escort() { return (this.last && this.last.escort) || null; }
  static STALL_MS = 20000;   // the Escort sends every 3 s: 20 s with nothing = the browser stopped delivering
  static CHECK_MS = 5000;
  get hex() {
    const l = this.last;
    if (!l) return '';
    return Object.entries(l.mfr || {}).map(([k, v]) => `${k}:${v}`).concat(Object.entries(l.svc || {}).map(([k, v]) => `${k}:${v}`)).join(' ');
  }
}

// ---- Reading the capacitive sensor over a CONNECTION (16 Nov 2026). Listening to its broadcasts needs a browser setting and, worse, Chrome
// silently stops delivering them (14 Nov: 16 % of the broadcasts arrived; 16 Nov on a laptop: 0 in 8 min while a direct listener heard
// them). A connection works in every Chrome / Edge with Web Bluetooth, no setting. Protocol worked out from the Escort phone app's Bluetooth
// log (16 Nov 2026, TW_133978): plain text lines ending in CR, no password. Write "GA\r" (get all) to ESC_RX; the reply comes as
// notifications on ESC_TX, split over several packets: "AGA,UT:1:26,UL:1:1453,UF:1:1753,...,SE:1:133978,...\r", fields key:type:value.
// UL = level (1..4095, as the Escort app shows it), UT = temperature in C, SE = serial; the other fields are kept as text in the line.
// The sensor takes ONE connection at a time: the Escort phone app must be disconnected.
export const ESC_SVC = '6e400001-b5a3-f393-e0a9-ffeeddc00000';
export const ESC_RX = '6e400002-b5a3-f393-e0a9-ffeeddc00000';
export const ESC_TX = '6e400003-b5a3-f393-e0a9-ffeeddc00000';

// One "AGA,..." reply as {fields}; null for anything else.
export function gaParse(s) {
  if (typeof s !== 'string' || !s.startsWith('AGA,')) return null;
  const f = {};
  for (const part of s.slice(4).split(',')) {
    const m = /^([A-Z]+):\d+:(.*)$/.exec(part);
    if (m && !(m[1] in f)) f[m[1]] = m[2];
  }
  return f;
}
const num = (x) => (x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);

// The capacitive level in mm, shown on the Recording page only (user 19 Nov 2026: compare the dipstick with the capacitive sensor at the one
// test site; nothing about it on the dashboard or anywhere a customer sees). The Escort gives only 1..4095 over its probe (7000 / 6500 are
// error codes), so this line was fitted on that site's probe TW_133978 against the radar level at still fuel: mm = 0.07112 x level + 2.93
// (14, 16, 17 Nov recordings; on 18 Nov it was +0.28 mm off, scatter 0.74 mm; each day within -0.9..+1.4 mm). Another probe, tank or
// mounting needs its own line. The recording keeps the raw level, so a better line can be applied later.
export const ESCORT_MM_PER_LEVEL = 0.07112, ESCORT_MM_AT_0 = 2.93;
export const escortMm = (level) => (Number.isFinite(level) && level >= 1 && level <= 4095 ? ESCORT_MM_PER_LEVEL * level + ESCORT_MM_AT_0 : null);

// One reply as a recording line: same `adv` kind as the broadcasts (so the readers keep working), marked src "gatt", the reply text kept.
export function gaLine(name, s) {
  const f = gaParse(s);
  const line = { ev: 'adv', src: 'gatt', name: name || '', rssi: null, tx_power: null, ga: s };
  if (f && num(f.UL) !== null) line.escort = { level: num(f.UL), temp_c: num(f.UT), cnt: null };
  return line;
}

export class CapGattLogger extends Emitter {
  // choose({all}) -> Promise<device> (ble.js requestEscort: asks for ESC_SVC); open(device, onBytes) -> Promise<{write, close}> and
  // close(device) (ble.js escortOpen / escortClose: only ble.js talks to Web Bluetooth); supported: the browser has Web Bluetooth.
  constructor({ choose, open, close, supported = true, clock = realClock } = {}) {
    super();
    Object.assign(this, { chooser: choose, opener: open, closer: close, isSupported: !!supported, clock });
    this.state = 'idle';            // idle | watching (connected or reconnecting)
    this.device = null;
    this.name = '';
    this.packets = 0;               // readings
    this.restarts = 0;              // reconnections
    this.last = null;
    this.lastAt = 0;                // the last reading, or the last reconnection try (the stall timer counts from it)
    this.readAt = null;             // the last reading only
    this.error = null;
    this._rx = null;                // the open link {write, close}
    this._buf = '';
    this._busy = false;
    this._failed = false;
    this._onGone = () => { this._rx = null; };
  }
  get supported() { return this.isSupported && typeof this.chooser === 'function' && typeof this.opener === 'function'; }
  get watching() { return this.state === 'watching'; }
  get connected() { return !!this._rx; }

  // Must be called straight from a tap (the browser's chooser).
  async choose({ all = false } = {}) {
    this.error = null;
    if (!this.supported) { this.error = { code: 'unsupported', text: '' }; this.emit('change'); return false; }
    let device;
    try {
      device = await this.chooser({ all });
    } catch (e) {
      this.error = e && e.name === 'NotFoundError' ? { code: 'cancelled', text: '' } : { code: 'other', text: (e && e.message) || 'error' };
      this.emit('change');
      return false;
    }
    this.stop();
    this.device = device;                                    // (the notifications check it)
    try {
      await this._connect(device);
    } catch (e) {
      this.device = null;
      this._drop(device);
      this.error = { code: 'other', text: (e && e.message) || 'error' };
      this.emit('change');
      return false;
    }
    Object.assign(this, { name: device.name || '', packets: 0, restarts: 0, last: null, lastAt: this.clock.now(), readAt: null, state: 'watching', _failed: false });
    if (typeof device.addEventListener === 'function') device.addEventListener('gattserverdisconnected', this._onGone);
    this._wd = this.clock.setInterval(() => this._tick(), CapGattLogger.POLL_MS);
    this._ask();
    this.emit('change');
    return true;
  }
  async _connect(device) {
    this._buf = '';
    this._rx = await this.opener(device, (b) => { if (this.device === device) this._bytes(b); });
  }
  _drop(device) {
    const l = this._rx;
    this._rx = null;
    if (l) { try { l.close(); } catch (e) { /* gone already */ } } else if (typeof this.closer === 'function') this.closer(device);
  }
  async _ask() {
    const rx = this._rx;
    if (!rx) return;
    try { await rx.write(new Uint8Array([0x47, 0x41, 0x0d])); } catch (e) { /* "GA\r"; the next tick finds out */ }
  }
  // Every POLL_MS: ask for a reading; with nothing for STALL_MS (or the link gone) reconnect to the same device (no chooser needed).
  async _tick() {
    const d = this.device;
    if (!d || this._busy) return;
    if (this._rx && this.clock.now() - this.lastAt < CapGattLogger.STALL_MS) { this._ask(); return; }
    if (!this._rx && this._failed && this.clock.now() - this.lastAt < CapGattLogger.STALL_MS) return;   // after a failed try: wait STALL_MS
    this._busy = true;
    const quietS = Math.round((this.clock.now() - this.lastAt) / 1000);
    this._drop(d);
    let ok = true, text = '';
    try { await this._connect(d); } catch (e) { ok = false; text = (e && e.message) || 'error'; this._rx = null; }
    this._busy = false;
    if (this.device !== d) { this._drop(d); return; }       // stopped meanwhile
    this.restarts++;
    this._failed = !ok;
    this.lastAt = this.clock.now();                          // the next try comes STALL_MS later
    this.emit('restart', { n: this.restarts, quiet_s: quietS, ok, error: text });
    this.emit('change');
    if (ok) this._ask();
  }
  stop() {
    if (this._wd) { this.clock.clearInterval(this._wd); this._wd = null; }
    const d = this.device;
    this.device = null;
    if (d) { if (typeof d.removeEventListener === 'function') d.removeEventListener('gattserverdisconnected', this._onGone); this._drop(d); }
    if (this.state !== 'idle') { this.state = 'idle'; this.emit('change'); }
  }
  _bytes(b) {
    for (const x of b) this._buf += String.fromCharCode(x);
    if (this._buf.length > 4096) this._buf = this._buf.slice(-4096);
    let i;
    while ((i = this._buf.indexOf('\r')) >= 0) {
      const s = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 1);
      if (!s.startsWith('AGA,')) continue;                 // "WRN" and the like
      const line = gaLine(this.name, s);
      this.packets++;
      this.last = line;
      this.lastAt = this.readAt = this.clock.now();
      this.emit('adv', line);
    }
  }
  // (from the last reading, not from a reconnection: an old reading must not look new)
  get agoS() { return this.last && this.readAt !== null ? Math.max(0, Math.round((this.clock.now() - this.readAt) / 1000)) : null; }
  get escort() { return (this.last && this.last.escort) || null; }
  get hex() { return this.last ? this.last.ga.slice(0, 60) : ''; }
  // The level in mm (escortMm) from a reading at most FRESH_MS old; null with none (not reading, no reading yet, a gap, no level in it).
  // (Also shown after a free-text note: the colleague types dipstick readings as notes, 18 Nov 2026.)
  get levelMm() {
    const e = this.escort;
    if (!this.watching || !e || this.readAt === null || this.clock.now() - this.readAt > CapGattLogger.FRESH_MS) return null;
    return escortMm(e.level);
  }
  static POLL_MS = 3000;     // one reading every 3 s (the Escort app asks every ~4 s)
  static STALL_MS = 15000;   // no reply for 15 s: reconnect
  static FRESH_MS = 10000;   // an older reading (2 missed replies) is not shown as the capacitive level in the recording log: in a fill it would be mm off
}
