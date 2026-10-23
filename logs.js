// The device log of debug builds (`logs` command and `log` topic, PROTOCOL.md 4.3 and 8). No DOM.
// Lines are {s: sequence, t: uptime ms, l: E|W|I|D, m: text}. Production builds need a service login for this: not used here.
import { Emitter } from './util.js';

export class LogView extends Emitter {
  constructor({ client, max = 500 }) {
    super();
    Object.assign(this, { client, max });
    this.lines = [];
    this.lost = 0;
    this.includeDebug = false;
    this.paused = false;
    this.loading = false;
    this.error = null;
    this._off = null;
    this._on = false;
    this._seq = 0;                  // next sequence number to ask for
  }
  get visible() { return this.includeDebug ? this.lines : this.lines.filter((l) => l.l !== 'D'); }

  async enter() {
    if (this._on) return;
    this._on = true;
    this._off = this.client.on('log', (e) => this._live(e));
    await this.client.subscribe(['log']).catch((e) => { this.error = e; });
    await this._backlog(0);
  }
  async leave() {
    if (!this._on) return;
    this._on = false;
    if (this._off) this._off();
    this._off = null;
    await this.client.unsubscribe(['log']).catch(() => {});
  }
  _add(l) {
    if (!l || !Number.isFinite(l.s) || this.lines.some((x) => x.s === l.s)) return;
    this.lines.push({ s: l.s, t: l.t, l: l.l, m: l.m });
    this.lines.sort((a, b) => a.s - b.s);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    this._seq = Math.max(this._seq, l.s + 1);
  }
  _live(e) {
    if (this.paused) return;
    this._add(e);
    this.emit('change');
  }
  // Page through `logs` from `since` until the sensor has nothing more.
  async _backlog(since) {
    this.loading = true;
    this.emit('change');
    try {
      let next = since;
      for (let page = 0; page < 200; page++) {
        const r = await this.client.request('logs', { since: next, debug: this.includeDebug ? true : undefined });
        if (since === 0 && page === 0) this.lost = r.lost || 0;
        for (const l of r.lines || []) this._add(l);
        if (!r.lines || !r.lines.length || !(r.next > next)) break;
        next = r.next;
      }
      this._seq = Math.max(this._seq, next);
      this.error = null;
    } catch (e) { this.error = e; } finally { this.loading = false; this.emit('change'); }
  }
  async setDebug(on) {
    this.includeDebug = !!on;
    if (this._on) await this._backlog(0);
    this.emit('change');
  }
  pause() { this.paused = true; this.emit('change'); }
  async resume() {
    this.paused = false;
    if (this._on) await this._backlog(this._seq);          // catch up with what was missed
    this.emit('change');
  }
  clear() { this.lines = []; this.emit('change'); }
  text() { return this.visible.map((l) => `${(l.t / 1000).toFixed(3)} ${l.l} ${l.m}`).join('\n'); }
}
