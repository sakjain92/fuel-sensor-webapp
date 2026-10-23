// While the sensor restarts (restart, reset to defaults, firmware update) the app waits, reconnects by itself and says what happened.
import { STR, t } from '../core.js';
import { RestartWaiter } from '../restart.js';
import { $ } from './dom.js';

export function initWait(ctx) {
  let waiter = null;

  function card(title, text, sub, spin, cls) {
    $('wCard').className = 'card waitc ' + (cls || '');
    $('wTitle').textContent = title;
    $('wText').textContent = text || '';
    $('wSub').textContent = sub || '';
    $('spin').hidden = !spin;
    $('bWaitHome').hidden = spin;
    $('bWaitConnect').hidden = true;
  }

  async function run(w) {
    if (waiter) waiter.cancel();
    const kind = w.kind;
    card(kind === 'reset' ? STR.w_resetting : STR.w_restarting, STR.w_reconnect, STR.w_hint, true);
    waiter = new RestartWaiter({ client: ctx.client, clock: ctx.clock, kind, oldVersion: w.oldVersion || '', expectVersion: w.expectVersion || null, ...ctx.pace });
    const me = waiter;
    me.on('phase', (p) => {
      if (p === 'trial') card(t('w_trial', { v: me.fw || w.expectVersion || '' }), STR.w_trialSub, '', true);
    });
    const r = await me.run();
    if (waiter !== me || r.result === 'cancelled') return;
    waiter = null;
    if (r.result === 'giveup') {
      card(STR.w_long, STR.w_giveup, '', false, 'warn');
      $('bWaitHome').hidden = true;
      $('bWaitConnect').hidden = false;
      return;
    }
    await ctx.onConnected();
    const done = (title, text, cls) => { card(title, text, STR.w_ended, false, cls); };
    if (r.result === 'restarted') done(STR.w_restarted, '', 'ok');
    else if (r.result === 'reset_done') done(STR.w_resetDone, STR.w_resetSub, 'ok');
    else if (r.result === 'updated') done(t('w_updated', { v: r.fw }), '', 'ok');
    else if (r.result === 'rolled_back') done(t('w_rolledBack', { v: r.fw }), STR.w_rolledSub, 'bad');
    else done(t('w_trialSlow', { v: r.fw }), '', 'warn');
  }

  $('bWaitHome').addEventListener('click', () => ctx.leaveWait(false));

  return {
    enter() {},
    leave() {},
    run,
    cancel() { if (waiter) { waiter.cancel(); waiter = null; } },
  };
}
