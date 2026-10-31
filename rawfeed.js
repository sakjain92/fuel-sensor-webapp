// The raw radar stream of a debug build (PROTOCOL.md 9) is switched on and off per connection, but several screens want it (the live plot,
// the recorder). RawFeed counts them: `raw_start` goes out when the first one asks, `raw_stop` when the last one lets go. No DOM.
import { Emitter } from './util.js';

export class RawFeed extends Emitter {
  constructor({ client }) {
    super();
    this.client = client;
    this.refs = 0;
    this.active = false;           // the sensor is sending frames to this connection
    this.radar = null;             // the `radar` block of raw_start's reply
    this._pending = null;
    client.on('disconnected', () => { this.active = false; this._pending = null; this.emit('change'); });   // the sensor forgets the stream with the link
  }
  // Takes a share of the stream; rejects (and takes nothing) if the sensor refuses, e.g. `link_mode` in long-range mode.
  async acquire() {
    this.refs++;
    try { await this._ensure(); } catch (e) { this.refs--; throw e; }
    return this.radar;
  }
  async release() {
    if (this.refs > 0) this.refs--;
    if (this.refs === 0 && this.active) {
      this.active = false;
      this.emit('change');
      await this.client.request('raw_stop').catch(() => {});
    }
  }
  // After a reconnect: ask again for the shares that are still held.
  async resume() {
    if (this.refs > 0 && !this.active) await this._ensure();
    return this.radar;
  }
  async _ensure() {
    if (this.active) return;
    if (!this._pending) {
      this._pending = this.client.request('raw_start').then((r) => {
        this.radar = (r && r.radar) || null;
        this.active = true;
        this.emit('change');
      }).finally(() => { this._pending = null; });
    }
    await this._pending;
    if (this.refs === 0 && this.active) { this.active = false; await this.client.request('raw_stop').catch(() => {}); }   // everyone left while it started
  }
}
