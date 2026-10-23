// After a restart, a reset to defaults or a firmware update the Bluetooth link drops. This waits for the sensor to come back,
// reconnects by itself (no chooser: the browser still knows the device) and reports what happened. No DOM.
import { Emitter, realClock } from './util.js';

export class RestartWaiter extends Emitter {
  // kind: 'restart' | 'reset' | 'update'. For an update: oldVersion is what ran before, expectVersion what was sent (null when
  // the link dropped before the sensor could say). Times are milliseconds on the given clock.
  constructor({ client, clock = realClock, kind, oldVersion = '', expectVersion = null,
    dropWaitMs = 20000, firstTryMs = 5000, retryMs = 3000, giveUpMs = 150000, trialMaxMs = 240000 }) {
    super();
    Object.assign(this, { client, clock, kind, oldVersion, expectVersion, dropWaitMs, firstTryMs, retryMs, giveUpMs, trialMaxMs });
    this.phase = 'waiting';          // waiting | reconnecting | trial
    this.fw = '';
    this.cancelled = false;
  }
  cancel() { this.cancelled = true; }
  _phase(p) { this.phase = p; this.emit('phase', p); }
  _sleep(ms) { return new Promise((r) => this.clock.setTimeout(r, ms)); }

  // Resolves {result, fw}: restarted | reset_done | updated | rolled_back | trial_slow | giveup | cancelled
  async run() {
    const t0 = this.clock.now();
    const c = this.client;
    // 1. the sensor closes the link about 2 s after it accepted the command
    while (c.state === 'connected' && this.clock.now() - t0 < this.dropWaitMs) {
      if (this.cancelled) return { result: 'cancelled', fw: this.fw };
      await this._sleep(250);
    }
    if (c.state === 'connected') return { result: 'giveup', fw: c.hello ? c.hello.fw : '' };
    // 2. reconnect until it answers
    this._phase('reconnecting');
    await this._sleep(this.firstTryMs);
    let trialSince = 0;
    for (;;) {
      if (this.cancelled) return { result: 'cancelled', fw: this.fw };
      if (this.clock.now() - t0 > this.giveUpMs + (trialSince ? this.trialMaxMs : 0)) return { result: trialSince ? 'trial_slow' : 'giveup', fw: this.fw };
      if (c.state !== 'connected') {
        try { await c.connect(); } catch (e) { await this._sleep(this.retryMs); continue; }
      }
      let st;
      try { st = await c.request('status'); } catch (e) { await this._sleep(this.retryMs); continue; }
      this.fw = st.fw;
      const trial = !!(st.health && st.health.trial);
      if (this.kind === 'restart') return { result: 'restarted', fw: st.fw };
      if (this.kind === 'reset') return { result: 'reset_done', fw: st.fw };
      // update: did the new version start, and has it passed its self-check?
      const changed = this.expectVersion ? st.fw === this.expectVersion : st.fw !== this.oldVersion;
      if (!changed) return { result: 'rolled_back', fw: st.fw };
      if (!trial) return { result: 'updated', fw: st.fw };
      if (!trialSince) { trialSince = this.clock.now(); this._phase('trial'); }
      if (this.clock.now() - trialSince > this.trialMaxMs) return { result: 'trial_slow', fw: st.fw };
      await this._sleep(this.retryMs);
    }
  }
}
