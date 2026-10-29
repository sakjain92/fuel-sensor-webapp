// The Maintenance screen (behind the login): tank size, site ID and location, firmware, crash report, reset, fill reports, restart.
import {
  STR, t, fin, fmtWait, fmtLpmm, fmtLitres, numStr, tankText, grantText, buildText, validateTank, parseCapacity, fmtNum, CAP_DEFAULT, siteLocText, fixIsWeak, resetPhraseOk,
  fillWhen, fillL, fillFlagNames, fillShareText, errText, clockDiffText, clockSrcText, hasCap as hasFeature, EMULATIONS,
} from '../core.js';
import { makeReportFile, deliverFile, downloadBlob } from '../export.js';
import { $, msg, busy, confirmBox, copyTxt } from './dom.js';

export function initMaint(ctx) {
  const { maint, app } = ctx;
  let tankDirty = false, capDirty = false, emuDirty = false;
  let fix = null;                       // the position found for the site location
  let fills = null;
  let allFile = null;
  let probeAt = 0;
  let clk = null;                       // the sensor clock as last read: {set, utc, src, rtc, diffS}
  let resSaved = null;                  // resistive output calibration: values in the sensor's memory (null: not read)

  function renderSess() {
    const left = maint.sessionLeftMs();
    $('sessLeft').textContent = t('sessLeft', { t: left >= 60000 ? t('dur_m', { m: Math.ceil(left / 60000) }) : fmtWait(left / 1000) });
    if (left <= 0 && maint.active && ctx.clock.now() - probeAt > 10000) {   // ask the sensor whether it ended the login as well
      probeAt = ctx.clock.now();
      load();
    }
  }

  function renderMaint() {
    const g = maint.grant, st = app.status || {}, ms = maint.state || {}, tk = ms.tank || st.tank;
    $('grantInfo').textContent = grantText(g);
    $('cTank').hidden = !g.settings;
    const hasCap = !!tk && fin(tk.cap_l);                       // a sensor from before the capacity setting has no such card
    $('cCap').hidden = !g.settings || !hasCap;
    if (hasCap) {
      $('capNow').textContent = t('capNow', { c: fmtNum(tk.cap_l, 1) });
      if (!capDirty) { $('capIn').value = numStr(tk.cap_l); capInput(false); }
    }
    $('cSite').hidden = !g.settings;
    $('cClock').hidden = !g.settings;
    $('cReset').hidden = !g.settings;
    $('cRes').hidden = !g.settings || !hasFeature(ctx.client.hello, 'rescal');     // a board with the resistive output
    $('cEmu').hidden = !g.settings || !hasFeature(ctx.client.hello, 'rescal') || !ms.output;   // (and a firmware that reports it)
    if (!$('cEmu').hidden && !emuDirty && EMULATIONS.includes(ms.output.emulation)) $('emuSel').value = ms.output.emulation;
    $('cFw').hidden = !g.firmware;
    $('tankNow').textContent = tk ? t('tankNow', { d: tankText(tk) }) : '';
    if (tk && !tankDirty) {
      $('tL').value = numStr(tk.l_mm);
      $('tW').value = numStr(tk.w_mm);
      $('tH').value = numStr(tk.h_mm);
      tankInput(false);
    }
    $('siteNow').textContent = t('siteNow', { v: st.site_id || STR.notSet });
    $('locNow').textContent = t('locNow', { v: siteLocText(st) });
    $('fwNow').textContent = st.fw ? t('fwNow', { v: st.fw, b: buildText(st.variant) }) : '';
    const cd = ms.coredump;
    const has = cd !== undefined ? !!(cd && (typeof cd === 'object' ? cd.present : cd)) : !!(st.health && st.health.coredump);
    $('cCrash').hidden = !has;
    $('cFills').hidden = !(g.settings || g.firmware || g.calibration);
    renderClock();
  }

  async function load() {
    const r = await maint.loadState();
    if (!r.ok && !r.ended) msg('mErr', r.text, 'bad'); else $('mErr').hidden = true;
    renderMaint();
  }

  // ---- Resistive Sensor Emulation: a drop-down and Save; what the sensor holds is shown again at every load
  async function emuSave() {
    $('emuMsg').hidden = true;
    const btn = $('bEmuSave');
    busy(btn, true, STR.saving);
    const r = await maint.saveEmulation($('emuSel').value);
    busy(btn, false);
    if (r.ok) { emuDirty = false; msg('emuMsg', STR.emuSaved, 'ok'); await load(); } else if (!r.ended) msg('emuMsg', t('emuFail', { e: r.text }), 'bad');
  }

  // ---- resistive output calibration (the page itself is ui/rescal.js)
  function renderRes() {
    $('resNow').textContent = resSaved === null ? '' : resSaved >= 14 ? STR.resCalibrated : STR.resNotCal;
    $('bResClr').hidden = !resSaved || !$('resConf').hidden;
  }
  async function loadRes() {
    if ($('cRes').hidden) return;
    const r = await maint.rescalState();
    resSaved = r.ok ? r.state.saved : null;
    renderRes();
  }
  async function clearRes() {
    $('resMsg').hidden = true;
    const r = await maint.rescalClear();
    if (r.ok) { msg('resMsg', STR.resCleared, 'ok'); resSaved = r.state.saved; renderRes(); } else if (!r.ended) msg('resMsg', t('resFail', { e: r.text }), 'bad');
  }

  // ---- sensor clock
  function renderClock() {
    $('clkState').textContent = clk ? (clk.set ? STR.clkSet : STR.clkNotSet) : STR.clkReading;
    $('clkSrc').textContent = clk ? clockSrcText(clk) : '';
    $('clkDiff').textContent = clk ? (clk.set ? clockDiffText(clk.diffS) : STR.clkNoneNote) : '';
    $('bClkSet').hidden = !clk || !$('clkConf').hidden;           // the confirmation box has the buttons while it is open
  }
  async function loadClock() {
    const r = await maint.readClock();
    if (r.ok) { clk = r.clock; $('clkErr').hidden = true; } else if (!r.ended) msg('clkErr', t('clkReadFail', { e: r.text }), 'bad');
    renderClock();
  }
  async function clockSet() {
    $('clkMsg').hidden = true;
    const btn = $('bClkSet');                                      // the confirmation box has closed; this button shows the work
    busy(btn, true, STR.saving);
    const r = await maint.setClockFromPhone();
    busy(btn, false);
    if (r.ok) { clk = r.clock; msg('clkMsg', STR.clkDone, 'ok'); } else if (!r.ended) msg('clkMsg', r.error && r.error.code === 'bad_input' ? STR.clkBad : t('clkFail', { e: r.text }), 'bad');
    renderClock();
  }

  // ---- tank capacity
  function capInput(showErr) {
    const v = parseCapacity($('capIn').value);
    const bad = !v.ok && (showErr || v.err !== 'empty');
    $('capIn').setAttribute('aria-invalid', bad ? 'true' : 'false');
    msg('capErr', bad ? STR['capErr_' + v.err] : '', 'bad');
    return v;
  }
  async function capSave(useDefault) {
    $('capMsg').hidden = true;
    if (useDefault) $('capIn').value = String(CAP_DEFAULT);
    if (!capInput(true).ok) return;
    const btn = $('bCapSave');
    busy(btn, true, STR.saving);
    const r = await maint.saveCapacity($('capIn').value);
    busy(btn, false);
    if (r.ok) { capDirty = false; msg('capMsg', STR.capSaved, 'ok'); await load(); } else if (!r.ended) msg('capMsg', t('tankFail', { e: r.text }), 'bad');
  }

  // ---- tank
  function tankInput(showErr) {
    const v = validateTank($('tL').value, $('tW').value, $('tH').value), errs = [];
    for (const k of ['l', 'w', 'h']) {
      const bad = !v[k].ok && (showErr || v[k].err !== 'empty');
      $('t' + k.toUpperCase()).setAttribute('aria-invalid', bad ? 'true' : 'false');
      if (bad) errs.push(t('dimErr', { f: STR['dim_' + k], m: STR['dimE_' + v[k].err] }));
    }
    msg('tankErr', errs.join('. '), 'bad');
    $('tankPrev').textContent = v.cap ? t('tankPrev', { p: fmtLpmm(v.lpmm) }) : v.lpmm ? t('tankPrev', { p: fmtLpmm(v.lpmm) }) : '';
    return v;
  }
  async function tankSave(useDefault) {
    $('tankMsg').hidden = true;
    const btn = $('bTankSave');
    let r;
    if (useDefault) { busy(btn, true, STR.saving); r = await maint.useDefaultTank(); } else {
      const v = tankInput(true);
      if (!v.ok) return;
      busy(btn, true, STR.saving);
      r = await maint.saveTank($('tL').value, $('tW').value, $('tH').value);
    }
    busy(btn, false);
    if (r.ok) { tankDirty = false; msg('tankMsg', STR.tankSaved, 'ok'); await load(); } else if (!r.ended) msg('tankMsg', t('tankFail', { e: r.text }), 'bad');
  }

  // ---- site ID
  async function siteSave() {
    $('siteMsg').hidden = true;
    const r = await maint.saveSite($('siteIn').value);
    if (r.ok) { msg('siteMsg', STR.siteSaved, 'ok'); $('siteErr').hidden = true; $('siteNow').textContent = t('siteNow', { v: r.site_id || STR.notSet }); return; }
    if (r.err === 'input') msg('siteErr', r.v.errs.map((e) => STR['siteE_' + e]).join(' '), 'bad');
    else if (r.err === 'empty') msg('siteErr', STR.siteEmpty, 'bad');
    else if (!r.ended) msg('siteMsg', t('siteFail', { e: r.text }), 'bad');
  }
  async function siteClear() {
    $('siteMsg').hidden = true;
    $('siteErr').hidden = true;
    const r = await maint.clearSite();
    if (r.ok) { $('siteIn').value = ''; msg('siteMsg', STR.siteCleared, 'ok'); $('siteNow').textContent = t('siteNow', { v: STR.notSet }); } else if (!r.ended) msg('siteMsg', t('siteFail', { e: r.text }), 'bad');
  }

  // ---- site location
  async function locUse() {
    const btn = $('bLocUse');
    fix = null;
    $('locFix').hidden = true;
    $('locWarn').hidden = true;
    $('bLocSave').hidden = true;
    $('locMsg').hidden = true;
    busy(btn, true, STR.locGetting);
    try {
      fix = await ctx.geo.getPosition({ timeoutMs: 25000 });
      $('locFix').textContent = t('locFix', { lat: fix.lat.toFixed(6), lon: fix.lon.toFixed(6), a: fix.acc === null ? '?' : Math.round(fix.acc) });
      $('locFix').hidden = false;
      if (fixIsWeak(fix.acc)) msg('locWarn', t('locWeak', { a: fix.acc === null ? '?' : Math.round(fix.acc) }), 'warn'); else $('locWarn').hidden = true;
      $('bLocSave').hidden = false;
    } catch (e) {
      msg('locMsg', STR['loc_' + (e && e.code)] || STR.loc_unavailable, 'bad');
    } finally { busy(btn, false); }
  }
  async function locSave() {
    if (!fix) return;
    busy($('bLocSave'), true, STR.saving);
    const r = await maint.saveLocation(fix);
    busy($('bLocSave'), false);
    if (r.ok) { msg('locMsg', STR.locSaved, 'ok'); $('locNow').textContent = t('locNow', { v: r.site_lat.toFixed(6) + ', ' + r.site_lon.toFixed(6) }); $('bLocSave').hidden = true; } else if (!r.ended) msg('locMsg', t('locFail', { e: r.text || '' }), 'bad');
  }

  // ---- crash report
  async function crashDownload() {
    const btn = $('bCrashDl');
    busy(btn, true);
    $('crashMsg').hidden = true;
    const r = await maint.readCoredump({ onProgress: (p) => { btn.textContent = t('crashReading', { p: Math.round(100 * p) }); } });
    busy(btn, false);
    if (r.ok && r.bytes) {
      downloadBlob(new Blob([r.bytes], { type: 'application/octet-stream' }), 'fuel-sensor-' + ((app.status && app.status.mac) || 'unknown') + '-coredump.elf');
      msg('crashMsg', STR.crashGot, 'ok');
    } else if (!r.ended) msg('crashMsg', r.text || STR.errNet, 'bad');
  }
  async function crashErase() {
    const r = await maint.eraseCoredump();
    if (!r.ok && !r.ended) msg('crashMsg', r.text, 'bad');
    await load();
  }

  // ---- reset and restart
  function closeReset() { $('rstConf').hidden = true; $('bRst').hidden = false; $('rstIn').value = ''; $('bRstYes').disabled = true; }
  async function resetDefaults() {
    if (ctx.app.lockNav) return;
    const btn = $('bRstYes');
    busy(btn, true, STR.saving);
    const r = await maint.resetDefaults($('rstIn').value);
    busy(btn, false);
    if (r.ok) { tankDirty = false; capDirty = false; closeReset(); ctx.startWait('reset', { delay: r.restartInS }); } else if (!r.ended) msg('rstMsg', t('rstFail', { e: r.text || '' }), 'bad');
  }
  async function restartDevice() {
    $('rsMsg').hidden = true;
    const r = await maint.restart();
    if (r.ok) ctx.startWait('restart', { delay: r.restartInS }); else if (!r.ended) msg('rsMsg', r.text, 'bad');
  }

  // ---- fill reports (the history needs the maintenance login, which this screen is behind; the newest report alone is public)
  function renderFills() {
    const ul = $('fillsL'), list = fills || [];
    ul.textContent = '';
    $('fillsNone').hidden = fills === null || list.length > 0;
    $('fillsLoad').hidden = fills !== null;
    for (const rep of list) {
      const li = document.createElement('li'), b = document.createElement('b'), s = document.createElement('small'), btn = document.createElement('button');
      const fl = fillFlagNames(rep.flags);
      b.textContent = '#' + rep.serial + ' · ' + fillWhen(rep);
      s.textContent = t('fillsSum', { o: fillL(rep.operator_l), s: fillL(rep.sensor_l), d: fillL(rep.drained_l) }) + (fl.length ? ' · ' + t('frFlags', { f: fl.join(', ') }) : '');
      btn.className = 'lnk';
      btn.type = 'button';
      btn.textContent = STR.fillsCopy;
      btn.addEventListener('click', () => copyTxt(fillShareText(rep), btn, 'fillsMsg'));
      li.appendChild(b); li.appendChild(s); li.appendChild(btn);
      ul.appendChild(li);
    }
    const all = $('bFillsAll');
    all.hidden = list.length === 0;
    all.textContent = t('fillsShareAll', { n: list.length });
    all.disabled = true;
  }
  async function loadFills() {
    fills = null;
    allFile = null;
    renderFills();
    const r = await maint.readFillLog();
    if (!r.ok) {                                                     // the login ended (the screen is about to change) or the link failed
      fills = [];
      renderFills();
      if (!r.ended) msg('fillsAllMsg', r.text, 'bad');
      return;
    }
    try {
      const { reports } = r.log;
      fills = reports;
      renderFills();
      if (reports.length) {
        allFile = await makeReportFile(reports, { mac: (app.status && app.status.mac) || '', siteId: (app.status && app.status.site_id) || '' });
        $('bFillsAll').disabled = false;
      }
    } catch (e) { fills = []; renderFills(); msg('fillsAllMsg', errText(e), 'bad'); }
  }
  async function shareAll() {
    if (!allFile) return;
    const how = await deliverFile(allFile);
    if (how === 'shared') msg('fillsAllMsg', STR.frFileShared, 'ok');
    else if (how === 'downloaded') msg('fillsAllMsg', STR.frFileSaved, 'ok');
  }

  // ---- wiring
  for (const id of ['tL', 'tW', 'tH']) $(id).addEventListener('input', () => { tankDirty = true; $('tankMsg').hidden = true; tankInput(false); });
  $('capIn').addEventListener('input', () => { capDirty = true; $('capMsg').hidden = true; capInput(false); });
  $('bCapSave').addEventListener('click', () => capSave(false));
  $('bCapDef').addEventListener('click', () => { capDirty = false; capSave(true); });
  $('bTankSave').addEventListener('click', () => tankSave(false));
  $('emuSel').addEventListener('change', () => { emuDirty = true; $('emuMsg').hidden = true; });
  $('bEmuSave').addEventListener('click', emuSave);
  confirmBox($('bTankDef'), $('defConf'), $('bDefYes'), $('bDefNo'), () => { tankDirty = false; tankSave(true); });
  confirmBox($('bClkSet'), $('clkConf'), $('bClkYes'), $('bClkNo'), clockSet);
  confirmBox($('bResClr'), $('resConf'), $('bResYes'), $('bResNo'), clearRes);
  $('bSiteSave').addEventListener('click', siteSave);
  $('bSiteClear').addEventListener('click', siteClear);
  $('siteIn').addEventListener('input', () => { $('siteErr').hidden = true; $('siteMsg').hidden = true; });
  $('bLocUse').addEventListener('click', locUse);
  $('bLocSave').addEventListener('click', locSave);
  $('bFwOpen').addEventListener('click', () => ctx.nav.go('fw'));
  $('bCrashDl').addEventListener('click', crashDownload);
  confirmBox($('bCrashEr'), $('ceConf'), $('bCeYes'), $('bCeNo'), crashErase);
  $('bRst').addEventListener('click', () => { $('rstMsg').hidden = true; $('rstConf').hidden = false; $('bRst').hidden = true; $('rstIn').focus(); });
  $('bRstNo').addEventListener('click', closeReset);
  $('rstIn').addEventListener('input', () => { $('bRstYes').disabled = !resetPhraseOk($('rstIn').value); });
  $('bRstYes').addEventListener('click', resetDefaults);
  confirmBox($('bRs'), $('rsConf'), $('bRsYes'), $('bRsNo'), restartDevice);
  $('bFinish').addEventListener('click', () => ctx.finishMaint());
  $('bFinish2').addEventListener('click', () => ctx.finishMaint());
  $('bFillsAll').addEventListener('click', shareAll);
  ctx.bus.on('status', () => { if (app.page === 'pMaint') renderMaint(); });

  return {
    enter() {
      for (const id of ['mErr', 'capMsg', 'capErr', 'tankMsg', 'siteMsg', 'siteErr', 'locMsg', 'crashMsg', 'rsMsg', 'rstMsg', 'fillsAllMsg', 'clkErr', 'clkMsg', 'clkConf', 'resMsg', 'resConf', 'emuMsg']) $(id).hidden = true;
      resSaved = null;
      fix = null;
      clk = null;                                                  // never show the clock of the sensor visited before
      $('siteIn').value = (app.status && app.status.site_id) || '';
      for (const id of ['locFix', 'locWarn', 'bLocSave']) $(id).hidden = true;
      closeReset();
      renderSess();
      renderMaint();
      load();
      loadClock();
      loadFills();
      loadRes();
    },
    leave() {},
    tick: renderSess,
  };
}
