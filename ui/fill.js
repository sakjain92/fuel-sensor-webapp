// The fill-report card on the dashboard and the "last fill report" card with the encrypted file for IT.
import { STR, t, fmtClock, fmtWait, fillLineDisplay, fillFigs, fillShareText, waUrl } from '../core.js';
import { makeReportFile, deliverFile } from '../export.js';
import { $, msg, busy, copyTxt } from './dom.js';

const STAGES = ['idle', 'locating', 'nolocation', 'starting', 'filling', 'measuring', 'ready'];

export function initFill(ctx) {
  const flow = ctx.fill;
  let shown = null;           // signed code of the report whose file is prepared / being prepared
  let file = null;            // {name, bytes, mime, isTestKey}

  function render() {
    const v = flow.view;
    $('cFill').hidden = !v.enabled || !v.known;
    const st = STAGES.includes(v.stage) ? v.stage : 'idle';
    for (const id of STAGES) $('fr_' + id).hidden = id !== st;
    const open = st === 'filling' || st === 'measuring' || st === 'ready';
    if (st === 'filling') $('frFillT').textContent = t('frFilling', { t: v.phoneStart > 0 ? fmtClock(v.phoneStart * 1000, ctx.clock.now()) : '?' });
    if (st === 'nolocation') $('frNoLoc').textContent = t('frNoLoc', { why: STR['loc_' + v.locWhy] || STR.loc_unavailable });
    tick();
    $('frLocLine').hidden = !(open && !v.fix);                      // only a missing position is worth a line; a saved one is not shown
    if (open && !v.fix) $('frLocLine').textContent = STR.frLocNone;
    $('frMoved').hidden = !(open && v.movedWarn);
    if (open && v.movedWarn) $('frMoved').textContent = t('frMoved', { m: v.movedM });
    $('frRst').hidden = !(open && v.restarted);
    msg('frMsg', v.message && v.message.text, v.message && v.message.kind);
    for (const id of ['bFrStart', 'bFrEnd', 'bFrOk', 'bFrRetry']) $(id).disabled = v.busy;
    renderLast(v.lastReport);
  }
  // the preparing countdown ticks between polls
  function tick() {
    const v = flow.view;
    if (v.stage === 'measuring') {
      const since = v.sinceEndS + (ctx.clock.now() - v.fsAt) / 1000;
      $('frMeasT').textContent = t('frMeas', { t: fmtWait(since), m: fmtWait(v.settleMaxS) });
    }
  }

  function renderLast(r) {
    $('cLast').hidden = !r;
    if (!r) { shown = null; file = null; return; }
    $('frLine').textContent = fillLineDisplay(r.line);
    $('frFigs').textContent = fillFigs(r);
    $('frCode').textContent = r.code;
    $('aFrWa').href = waUrl(r);
    if (shown !== r.code) {                           // a new report (another sensor can have the same serial): encrypt its file now, so the Share tap needs no waiting
      shown = r.code;
      file = null;
      $('bFrFile').disabled = true;
      msg('frFileMsg', '', '');
      $('frFileHint').textContent = STR.frFileMaking;
      const site = ctx.app.status && ctx.app.status.site_id;
      makeReportFile([r], { mac: ctx.sensor ? ctx.sensor.mac : (ctx.app.status && ctx.app.status.mac) || '', siteId: site || '' }).then((f) => {
        if (shown !== r.code) return;
        file = f;
        $('bFrFile').disabled = false;
        $('frFileHint').textContent = STR.frFileHint + (f.isTestKey ? ' ' + STR.frFileTest : '');
      }, () => {
        if (shown === r.code) { $('frFileHint').textContent = ''; msg('frFileMsg', STR.frFileFail, 'bad'); }
      });
    }
  }

  async function shareFile() {
    if (!file) return;
    const how = await deliverFile(file);
    if (how === 'shared') msg('frFileMsg', STR.frFileShared, 'ok');
    else if (how === 'downloaded') msg('frFileMsg', STR.frFileSaved, 'ok');
  }

  flow.on('change', render);
  flow.on('report', () => { const c = $('cLast'); if (c.scrollIntoView) setTimeout(() => c.scrollIntoView({ block: 'start' }), 50); });
  $('bFrStart').addEventListener('click', () => flow.pressStart());
  $('bFrSkip').addEventListener('click', () => flow.continueWithoutLocation());
  $('bFrSkip2').addEventListener('click', () => flow.continueWithoutLocation());
  $('bFrRetry').addEventListener('click', () => flow.retryLocation());
  $('bFrCancel').addEventListener('click', () => flow.cancelStart());
  $('bFrCancel2').addEventListener('click', () => flow.cancelStart());
  $('bFrEnd').addEventListener('click', () => flow.pressEnd());
  $('bFrOk').addEventListener('click', async () => {
    const r = await flow.confirmReport($('frL').value);
    $('frL').setAttribute('aria-invalid', r.ok || r.reason !== 'input' ? 'false' : 'true');
    if (r.ok) $('frL').value = '';
  });
  $('bFrCopy').addEventListener('click', () => { const r = flow.view.lastReport; if (r) copyTxt(fillShareText(r), $('bFrCopy'), 'frCopyMsg', $('frCode')); });
  $('bFrFile').addEventListener('click', shareFile);
  busy($('bFrFile'), false);

  return { enter: render, leave() {}, tick };
}
