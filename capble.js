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
