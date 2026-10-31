// The capacitive sensor (Escort TD-BLE) next to the radar sensor. It broadcasts its readings in Bluetooth advertisements (every 1 to 3 s, level 1
// to 1023 / 4095, temperature, battery), so no connection is needed and this does not use the radar sensor's link. Escort does not publish the
// packet layout ("Escort BLE protocol"): the packets are logged as they are (`adv` lines: name, signal, manufacturer and service data as hex)
// and decoded afterwards against the dipstick and the radar. No DOM, no direct Web Bluetooth (the chooser comes in from ble.js). Needs Chrome's
// BluetoothDevice.watchAdvertisements().
import { Emitter, realClock } from './util.js';

const hex = (dv) => {
  const b = dv instanceof DataView ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength) : new Uint8Array(dv.buffer || dv);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};
const mapObj = (m, keyFmt) => { const o = {}; if (m && typeof m.forEach === 'function') m.forEach((v, k) => { o[keyFmt(k)] = hex(v); }); return o; };

// One `advertisementreceived` event as a recording line.
export function advLine(ev) {
  const line = { ev: 'adv', name: (ev.device && ev.device.name) || ev.name || '', rssi: Number.isFinite(ev.rssi) ? ev.rssi : null, tx_power: Number.isFinite(ev.txPower) ? ev.txPower : null };
  const mfr = mapObj(ev.manufacturerData, (k) => '0x' + Number(k).toString(16).padStart(4, '0'));
  const svc = mapObj(ev.serviceData, (k) => String(k));
  if (Object.keys(mfr).length) line.mfr = mfr;
  if (Object.keys(svc).length) line.svc = svc;
  if (ev.uuids && ev.uuids.length) line.uuids = [...ev.uuids].map(String);
  return line;
}

export class CapAdvLogger extends Emitter {
  // choose({all}) -> Promise<device>: the browser's chooser (ble.js requestAdvertiser); supported: the browser has Web Bluetooth.
  constructor({ choose, supported = true, clock = realClock } = {}) {
    super();
    Object.assign(this, { chooser: choose, isSupported: !!supported, clock });
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
    if (!this.supported) { this.error = { code: 'unsupported', text: '' }; this.emit('change'); return false; }
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
    this.last = null;
    this.state = 'watching';
    this.emit('change');
    return true;
  }
  stop() {
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
  get hex() {
    const l = this.last;
    if (!l) return '';
    return Object.entries(l.mfr || {}).map(([k, v]) => `${k}:${v}`).concat(Object.entries(l.svc || {}).map(([k, v]) => `${k}:${v}`)).join(' ');
  }
}
