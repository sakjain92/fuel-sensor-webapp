// The Bluetooth radio mode of this connection (`link`, PROTOCOL.md 4.5): the long-range toggle, the radio and the signal.
// The sensor only asks the phone's Bluetooth chip; whether Long Range happens is visible in `phy`. No DOM.
import { Emitter, realClock } from './util.js';
import { STR, t, phyText, fin } from './core.js';
import { ProtocolError } from './ble.js';

export const SWITCH_TIMEOUT_MS = 12000;

// What the screen shows for a `link` reply or event.
export function linkView(l, { switching = false } = {}) {
  l = l || {};
  const wantRange = l.mode === 'range';
  const pending = !!l.pending || switching;
  let note = '';
  if (wantRange && pending) note = 'switching';
  else if (wantRange && l.phy === 'coded') note = 'coded';
  else if (wantRange && l.phy) note = 'unsupported';          // asked for Long Range, the radio stays on 2M/1M
  return {
    on: wantRange, pending, mode: l.mode || '', phy: l.phy || '', phyText: phyText(l.phy), rssi: fin(l.rssi) ? l.rssi : null,
    rssiText: fin(l.rssi) ? t('lrRssi', { s: Math.round(l.rssi) }) : STR.lrRssiNone, known: !!l.mode, note,
    noteText: note === 'unsupported' ? t('lrNoSupport', { p: phyText(l.phy) }) : note === 'coded' ? STR.lrOkCoded : note === 'switching' ? STR.lrSwitching : '',
  };
}

export class LinkControl extends Emitter {
  constructor({ client, clock = realClock }) {
    super();
    Object.assign(this, { client, clock });
    this.cur = client.link || null;
    this.switching = false;
    this.error = '';
    this._off = client.on('link', (e) => { this.cur = e; this.emit('change'); });
  }
  dispose() { this._off(); }
  get view() { return linkView(this.cur, { switching: this.switching }); }
  async refresh() {
    try { this.cur = await this.client.request('link'); this.emit('change'); } catch (e) { /* keep the last values */ }
  }
  // on: true = long range, false = fast. Resolves the final view; the `link` event or polling reports the end of the change.
  async setRange(on) {
    this.error = '';
    this.switching = true;
    this.emit('change');
    try {
      this.cur = await this.client.request('link', { mode: on ? 'range' : 'fast' });
      const t0 = this.clock.now();
      while (this.cur.pending && this.clock.now() - t0 < SWITCH_TIMEOUT_MS) {
        await new Promise((r) => this.clock.setTimeout(r, 500));
        this.cur = await this.client.request('link');
        this.emit('change');
      }
    } catch (e) {
      this.error = e instanceof ProtocolError ? e.msg || e.code : (e && e.message) || 'error';
    } finally {
      this.switching = false;
      this.emit('change');
    }
    return this.view;
  }
}
