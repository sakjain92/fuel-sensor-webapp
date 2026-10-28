// The RS-485 (Modbus) register view: decode the `regs` block with the table generated from firmware/docs/REGISTERS.md
// (regs_table.js), and keep the live state (staleness) of the view. No DOM.
//
// The table is chosen by the `map` (register map version) of the sensor's reply, because one app serves sensors of every age:
//   map 2 (REGS_MAP)    regs_table.js as generated: tilt at 40039-41, the receiver's registers at 40042-45
//   map 1 or no map     the same table without the tilt rows, the receiver's registers at 40039-42 (built here from REG_ITEMS)
//   a newer map         only 40001-40038, which map 1 and map 2 share; everything after that is shown raw, never named
import { Emitter, realClock } from './util.js';
import { REG_ITEMS } from './regs_table.js';
import { t, STR, fmtNum, fmtDuration } from './core.js';

export const FIRST_REG = 40001;
export const STALE_AFTER_S = 5;
export const REGS_MAP = 2;                  // the register map version that regs_table.js was generated from (test/regs.test.mjs pins its layout)
const MAP1_SENSOR_END = 40038;              // map 1: the sensor sent 40001-40038; the sensor registers after that came with map 2

// The map-1 table, derived from the generated one so that no value is typed twice: drop the sensor registers that came after
// map 1 (tilt) and move the receiver's registers up by the room they took.
const later = (i) => i.sentBy === 'sensor' && i.reg + i.words - 1 > MAP1_SENSOR_END;
const laterWords = REG_ITEMS.filter(later).reduce((a, i) => a + i.words, 0);
export const MAP1_ITEMS = REG_ITEMS.filter((i) => !later(i)).map((i) => (i.sentBy === 'receiver' ? { ...i, reg: i.reg - laterWords } : i));
// What every known map agrees on: the sensor registers of map 1.
const COMMON_ITEMS = MAP1_ITEMS.filter((i) => i.sentBy === 'sensor');

// The map of a `regs` reply or event: a missing or malformed `map` is an old sensor (map 1).
export const regsMapOf = (e) => (e && Number.isInteger(e.map) && e.map >= 1 ? e.map : 1);
// The items to decode a block of this map with. A newer map than we know may have moved anything after 40038.
export function itemsFor(map) {
  if (map === REGS_MAP) return REG_ITEMS;
  return Number.isInteger(map) && map > REGS_MAP ? COMMON_ITEMS : MAP1_ITEMS;
}

const hex16 = (w) => '0x' + w.toString(16).toUpperCase().padStart(4, '0');
const UNIT_TEXT = { 'deg C': '°C', deg: '°' };
const unitText = (u) => (u ? ' ' + (UNIT_TEXT[u] || u) : '');
const decimalsOf = (scale) => (scale && scale < 1 ? Math.min(9, Math.round(-Math.log10(scale))) : 0);

function invalidText(name) {
  return name === 'not_set' ? STR.rgNotSet : name === 'never' ? STR.rgNever : STR.rgInvalid;
}

// Decode one item from its words (high word first). Returns {text, num}: num is the decoded number where there is one.
export function decodeItem(item, w) {
  switch (item.type) {
    case 'u16': case 's16': case 'u32': case 's32': {
      let raw;
      if (item.type === 'u16') raw = w[0];
      else if (item.type === 's16') raw = w[0] > 0x7fff ? w[0] - 0x10000 : w[0];
      else if (item.type === 'u32') raw = w[0] * 65536 + w[1];
      else raw = (((w[0] << 16) | w[1]) | 0);
      const rawUnsigned = item.type === 'u16' ? w[0] : item.type === 's16' ? w[0] : item.type === 'u32' ? raw : (((w[0] << 16) | w[1]) >>> 0);
      if (item.invalid !== undefined && rawUnsigned === item.invalid) return { text: invalidText(item.invalidName), num: null };
      const num = item.scale ? raw * item.scale : raw;
      return { text: fmtNum(num, decimalsOf(item.scale)) + unitText(item.unit), num };
    }
    case 'mac':
      return { text: w.slice(0, 3).map((x) => ((x >> 8) & 255).toString(16).padStart(2, '0') + (x & 255).toString(16).padStart(2, '0')).join('').toUpperCase().replace(/(..)(?=.)/g, '$1:'), num: null };
    case 'text': {                                      // two characters per register, the text ends at the first zero byte
      let s = '', end = false;
      for (const x of w) {
        for (const c of [(x >> 8) & 255, x & 255]) {
          if (c === 0) { end = true; break; }
          s += c >= 32 && c < 127 ? String.fromCharCode(c) : '?';
        }
        if (end) break;
      }
      return { text: s || STR.notSet, num: null };
    }
    case 'enum': {
      const name = item.values[String(w[0])];
      return { text: (name || STR.rgUnknownValue) + ' (' + w[0] + ')', num: w[0] };
    }
    case 'bits': {
      const on = [];
      for (let b = 0; b < 16; b++) if ((w[0] >> b) & 1) on.push(item.bits[String(b)] || 'bit ' + b);
      return { text: on.length ? on.join(', ') : STR.rgNone, num: w[0] };
    }
    case 'fwver':
      return { text: ((w[0] >> 11) & 31) + '.' + ((w[0] >> 5) & 63) + '.' + (w[0] & 31), num: null };
    default:
      return { text: '', num: null };
  }
}

// words: the `regs` block, first: the register number of words[0], map: the reply's register map version (see regsMapOf; left out =
// the version this app is built for). Returns {rows}: one row per register, 40001 up.
// A row: {reg, name (first register of an item, else null), cont, raw (number or null), hex, value (text or null),
//         receiver, missing, unknown}
// A block longer than the table's sensor registers has registers this app does not know. They are shown raw, and the receiver's
// rows are left out because the receiver's own registers follow the sensor's and have moved with them.
export function decodeBlock(words, first = FIRST_REG, map = REGS_MAP) {
  const rows = [];
  const get = (reg) => { const i = reg - first; return i >= 0 && i < words.length ? words[i] : undefined; };
  let items = itemsFor(map);
  const sensorEnd = items.reduce((a, i) => (i.sentBy === 'sensor' ? Math.max(a, i.reg + i.words - 1) : a), 0);
  const extra = first + words.length - 1 > sensorEnd;
  if (extra) items = items.filter((i) => i.sentBy === 'sensor');
  let tableEnd = 0;
  for (const item of items) {
    const regs = Array.from({ length: item.words }, (_, k) => item.reg + k);
    tableEnd = Math.max(tableEnd, item.reg + item.words - 1);
    if (item.sentBy === 'receiver') {
      regs.forEach((r, k) => rows.push({ reg: r, name: k === 0 ? item.name : null, cont: k > 0, raw: null, hex: '', value: k === 0 ? STR.rgReceiver : null, receiver: true, missing: false, unknown: false }));
      continue;
    }
    const ws = regs.map(get);
    const have = ws.every((x) => x !== undefined);
    const dec = have ? decodeItem(item, ws) : null;
    regs.forEach((r, k) => rows.push({
      reg: r, name: k === 0 ? item.name : null, cont: k > 0, raw: ws[k] === undefined ? null : ws[k], hex: ws[k] === undefined ? '' : hex16(ws[k]),
      value: k === 0 && dec ? dec.text : null, receiver: false, missing: !have, unknown: false,
    }));
  }
  for (let r = tableEnd + 1; r < first + words.length; r++) {      // registers a newer firmware appended: raw words only
    const w = get(r);
    rows.push({ reg: r, name: t('rgUnknownItem', { r }), cont: false, raw: w, hex: hex16(w), value: null, receiver: false, missing: false, unknown: true });
  }
  return { rows };
}

// The live view: subscribes to `regs` while the screen is open and tells how fresh the data is.
export class RegsView extends Emitter {
  constructor({ client, clock = realClock }) {
    super();
    Object.assign(this, { client, clock });
    this.last = null;           // latest regs event / reply
    this.seq = null;
    this.changedAt = 0;         // clock time when `seq` last changed
    this._off = null;
    this._on = false;
  }
  async enter() {
    if (this._on) return;
    this._on = true;
    this._off = this.client.on('regs', (e) => this._take(e));
    try { this._take(await this.client.request('regs')); } catch (e) { /* the first event follows within a second */ }
    await this.client.subscribe(['regs']).catch(() => {});
  }
  async leave() {
    if (!this._on) return;
    this._on = false;
    if (this._off) this._off();
    this._off = null;
    await this.client.unsubscribe(['regs']).catch(() => {});
  }
  _take(e) {
    if (!e || !Array.isArray(e.words)) return;
    if (e.seq !== this.seq) { this.seq = e.seq; this.changedAt = this.clock.now(); }
    this.last = e;
    this.emit('change');
  }
  // {waiting, rows, seq, stale, staleForS}
  view() {
    if (!this.last) return { waiting: true, rows: decodeBlock([]).rows, seq: null, stale: false, staleForS: 0 };
    const staleForS = Math.max(0, (this.clock.now() - this.changedAt) / 1000);
    return { waiting: false, rows: decodeBlock(this.last.words, this.last.first || FIRST_REG, regsMapOf(this.last)).rows, seq: this.seq, stale: staleForS > STALE_AFTER_S, staleForS };
  }
  statusText() {
    const v = this.view();
    if (v.waiting) return STR.rgWaiting;
    return v.stale ? t('rgStale', { t: fmtDuration(v.staleForS) }) : t('rgLive', { s: v.seq });
  }
}
