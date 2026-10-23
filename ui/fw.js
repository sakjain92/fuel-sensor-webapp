// Firmware update screen: pick the .fwpkg, check it, send it over Bluetooth with progress, speed and a live countdown.
import {
  STR, t, fmtBytes, fmtIST, fmtSpeed, fmtEta, chipName, buildText, parseFwpkgHeader, checkPackage, fwSummary, FWPKG_HEADER,
} from '../core.js';
import { OtaUploader, otaErrorText } from '../ota.js';
import { $, msg, rows, setBar } from './dom.js';

export function initFw(ctx) {
  const { maint, app } = ctx;
  let pkg = null;                 // {file, h, old}
  let up = null;                  // the running OtaUploader
  let lastP = null;               // latest progress snapshot
  let wake = null;
  let resultShown = false;        // the card with the outcome is on screen: coming back to this screen must not wipe it

  // What the sensor says it is (the hello line is the authority), and the size of its update area (maint_state).
  function device() {
    const h = ctx.client.hello || {}, st = app.status || {};
    return { fw: h.fw || st.fw, chip: h.chip || st.chip, variant: h.variant || st.variant };
  }
  function slotBytes() {
    const o = maint.state && maint.state.ota;
    return o && Number.isFinite(o.slot_bytes) ? o.slot_bytes : 0;
  }

  function reset() {
    resultShown = false;
    pkg = null;
    for (const id of ['fwSummary', 'fwDl', 'fwErr', 'fwWarn', 'bFwGo', 'fwProg', 'fwRes']) $(id).hidden = true;
    $('fwPick').hidden = false;
    $('fwFile').value = '';
    const d = device();
    $('fwNow2').textContent = d.fw ? t('fwNow', { v: d.fw, b: buildText(d.variant) }) : '';
    maint.loadState();                                    // the size of the update area, for the check before sending
  }

  async function readHead(f) {
    const b = f.slice(0, FWPKG_HEADER);
    return new Uint8Array(await b.arrayBuffer());
  }
  async function pick() {
    const f = $('fwFile').files && $('fwFile').files[0];
    pkg = null;
    for (const id of ['fwSummary', 'fwDl', 'fwErr', 'fwWarn', 'bFwGo']) $(id).hidden = true;
    if (!f) return;
    try {
      const h = parseFwpkgHeader(await readHead(f));
      const dev = device();
      const info = [['fw_file', f.name + ', ' + fmtBytes(f.size)]];
      const c = checkPackage(h, f.size, dev, maint.grant, slotBytes());
      if (ctx.mode === 'demo' && !h.ok && (h.err === 'magic' || h.err === 'short')) { c.ok = true; c.errs = []; c.warns = ['demo']; }   // the simulated sensor accepts any file that is not a package at all
      if (h.ok) {
        $('fwSummary').textContent = fwSummary(h);                      // "ESP32-C3 - production - version 2.0.1"
        $('fwSummary').hidden = false;
        info.push(['fw_ver', dev.fw ? t('fw_verVs', { v: h.version, i: dev.fw }) : h.version], ['fw_chip', chipName(h.chipId)],
          ['fw_var', STR['var_' + h.variant] || h.variant], ['fw_built', fmtIST(h.built) + (h.git ? ' · ' + h.git : '')]);
      }
      rows($('fwDl'), info);
      $('fwDl').hidden = false;
      const vars = { p: chipName(h.chipId), d: chipName(dev.chip), v: dev.fw };
      const vv = { p: h.variant, d: dev.variant };
      msg('fwErr', c.errs.map((e) => t('fw_e_' + e, vars)).join(' '), 'bad');
      msg('fwWarn', c.warns.map((e) => t('fw_w_' + e, e === 'variant' ? vv : vars)).join(' '), 'warn');
      if (c.ok) {
        pkg = { file: f, h, old: dev.fw };
        $('bFwGo').textContent = h.ok ? t('fwInstall', { v: h.version }) : STR.fwInstallAny;
        $('bFwGo').hidden = false;
      }
    } catch (e) { msg('fwErr', STR.fw_e_notpkg, 'bad'); }
  }

  // ---- progress
  function renderProgress(p) {
    lastP = p;
    $('fwPhase').textContent = p.state === 'switching' ? STR.fwRadio : p.state === 'begin' ? STR.fwBegin : p.state === 'finishing' ? STR.fwChecking : t('fwSending', { p: p.percent });
    setBar($('fwBar'), p.state === 'finishing' ? 100 : p.percent);
    $('fwBytes').textContent = t('fwBytes', { a: fmtBytes(p.bytes), b: fmtBytes(p.total) });
    $('fwSpeed').textContent = t('fwSpeedLbl', { v: fmtSpeed(p.rate) });
    $('bFwCancel').disabled = p.state === 'finishing';
    tick();
  }
  // the countdown runs every second between the updates from the sensor
  function tick() {
    if (!up || !lastP) return;
    if (lastP.state === 'sending') {
      const left = lastP.etaS - (ctx.clock.now() - lastP.at) / 1000;
      $('fwEta').textContent = fmtEta(Number.isFinite(left) ? Math.max(0, left) : NaN);
    } else $('fwEta').textContent = '';
  }

  async function keepAwake() {
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
  }
  function release() { try { if (wake) wake.release(); } catch (e) { /* ignore */ } wake = null; }

  function result(title, text, cls) {
    resultShown = true;
    $('fwProg').hidden = true;
    $('fwPick').hidden = true;
    $('fwRes').hidden = false;
    $('fwRes').className = 'card waitc ' + (cls || '');
    $('fwResT').textContent = title;
    $('fwResText').textContent = text || '';
  }

  async function start() {
    if (!pkg || up) return;
    const p = pkg;
    $('fwPick').hidden = true;
    $('fwRes').hidden = true;
    $('fwProg').hidden = false;
    $('fwPhase').textContent = STR.fwRadio;
    setBar($('fwBar'), 0);
    $('fwEta').textContent = '';
    app.lockNav = true;
    ctx.fill.pause();
    window.onbeforeunload = () => STR.fwChecking;
    keepAwake();
    let bytes;
    try { bytes = new Uint8Array(await p.file.arrayBuffer()); } catch (e) {
      app.lockNav = false; window.onbeforeunload = null; release(); ctx.fill.resume();
      result(STR.fw_e_notpkg, '', 'bad');
      return;
    }
    up = new OtaUploader({ client: ctx.client, bytes, clock: ctx.clock });
    up.on('progress', renderProgress);
    renderProgress(up.progress);
    try {
      const r = await up.run();
      app.lockNav = false;
      window.onbeforeunload = null;
      release();
      ctx.fill.resume();
      up = null;
      ctx.startWait('update', { oldVersion: p.old, expectVersion: r.version || p.h.version || null });
    } catch (e) {
      app.lockNav = false;
      window.onbeforeunload = null;
      release();
      ctx.fill.resume();
      const cancelled = e && e.code === 'cancelled';
      up = null;
      result(cancelled ? STR.fwCancelled : STR.fwFailed, cancelled ? '' : otaErrorText(e), cancelled ? 'warn' : 'bad');
      ctx.nav.go('fw');                                     // a lost link has ended the login and moved the page to the login screen: show the outcome
    }
  }

  $('fwFile').addEventListener('change', pick);
  $('bFwGo').addEventListener('click', start);
  $('bFwCancel').addEventListener('click', async () => { if (up) { $('bFwCancel').disabled = true; await up.cancel(); } });
  $('bFwAgain').addEventListener('click', reset);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && up) keepAwake(); });

  // route() calls enter() again whenever it runs: with an update running (the operator tapped Back) or an outcome on screen it must not start over
  return { enter() { if (!up && !resultShown) reset(); }, leave() { resultShown = false; }, tick, get busy() { return !!up; }, get holdsResult() { return resultShown; } };
}
