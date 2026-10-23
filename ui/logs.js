// The device log of debug builds.
import { STR, t } from '../core.js';
import { LogView } from '../logs.js';
import { $ } from './dom.js';
import { legacyCopy } from './dom.js';

export function initLogs(ctx) {
  const lv = new LogView({ client: ctx.client, max: 500 });
  let followed = true;

  function render() {
    const out = $('lgOut');
    out.textContent = '';
    for (const l of lv.visible) {
      const row = document.createElement('span');
      row.className = l.l;
      row.textContent = (l.t / 1000).toFixed(3) + ' ' + l.l + ' ' + l.m + '\n';
      out.appendChild(row);
    }
    if (!lv.visible.length) out.textContent = lv.loading ? STR.lgLoading : STR.lgEmpty;
    if (followed) out.scrollTop = out.scrollHeight;
    $('lgInfo').textContent = lv.paused ? STR.lgPaused : lv.lost ? t('lgLost', { n: lv.lost }) : '';
    $('bLgPause').textContent = lv.paused ? STR.lgResume : STR.lgPause;
  }
  lv.on('change', render);
  $('lgOut').addEventListener('scroll', () => { const o = $('lgOut'); followed = o.scrollTop + o.clientHeight >= o.scrollHeight - 8; });
  $('lgDebug').addEventListener('change', () => lv.setDebug($('lgDebug').checked));
  $('bLgPause').addEventListener('click', () => (lv.paused ? lv.resume() : lv.pause()));
  $('bLgClear').addEventListener('click', () => lv.clear());
  $('bLgCopy').addEventListener('click', () => { if (legacyCopy(lv.text())) $('lgInfo').textContent = STR.lgCopyMsg; });

  return {
    async enter() { followed = true; render(); await lv.enter(); },
    async leave() { await lv.leave(); },
  };
}
