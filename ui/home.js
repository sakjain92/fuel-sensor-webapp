// The dashboard: level, litres, percentage, status, totals, Bluetooth line, device details, Raw ADC Value table.
import {
  STR, t, fin, fmtLitres, fmtMm, fmtPct, fmtLpmm, fmtNum, fmtDuration, fmtAgo, levelOf, litresOf, capacityOf, fillPctOf, clampPct, rawAdcOf,
  rawAdcFromLitres, RAW_ADC_MAX, statusView, fuelView, tiltView, healthFlags, buildText, tankText, lpmmOf, siteLocText, linkSummary, hasCap,
} from '../core.js';
import { $, rows } from './dom.js';

export function initHome(ctx) {
  const { app, client } = ctx;
  let rawTableCap = null;

  // Litres -> Raw ADC Value (0-4095, linear): every 5 L up to the capacity, plus a last row at the exact capacity.
  // Rebuilt only when the capacity changes.
  function renderRawTable(capacity) {
    const card = $('cRawTable');
    if (!(capacity > 0)) { card.hidden = true; return; }
    card.hidden = false;
    if (capacity === rawTableCap) return;
    rawTableCap = capacity;
    $('rawTableHint').textContent = t('rawTableHint', { m: String(RAW_ADC_MAX), c: fmtLitres(capacity) });
    const body = $('rawTableBody');
    body.textContent = '';
    const add = (l, r) => {
      const tr = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td');
      a.textContent = l; b.textContent = r;
      tr.appendChild(a); tr.appendChild(b); body.appendChild(tr);
    };
    const lastWhole = Math.floor(capacity / 5) * 5;
    for (let litres = 0; litres <= lastWhole; litres += 5) add(fmtLitres(litres), fmtNum(rawAdcFromLitres(litres, capacity), 0));
    if (lastWhole < capacity) add(fmtLitres(capacity), String(RAW_ADC_MAX));
  }

  function renderBt() {
    $('btLine').textContent = STR.bt_label + ': ' + (app.lost ? STR.bt_off : linkSummary(app.link));
  }

  function render() {
    const st = app.status;
    $('conn0').hidden = !!st;
    $('rd').hidden = !st;
    $('bMaint').textContent = ctx.maint.active ? STR.maintOpen : STR.maint;
    $('bLogs').hidden = ctx.variant !== 'debug';
    $('bViz').hidden = !(ctx.variant === 'debug' && hasCap(client.hello, 'raw'));
    renderBt();
    if (!st) return;
    $('rd').className = app.lost ? 'stale' : '';
    const v = statusView(st.status, st.source), p = fillPctOf(st);
    $('stat').className = 'stat s-' + v.cls;
    $('statT').textContent = v.text;
    $('note').textContent = v.note;
    $('note').hidden = !v.note;
    $('lit').textContent = fmtLitres(litresOf(st));
    $('mm').textContent = fmtMm(levelOf(st));
    $('barI').style.width = clampPct(p) + '%';
    $('bar').setAttribute('aria-valuenow', String(Math.round(p)));
    $('pct').textContent = fmtPct(p) + ' %';
    $('cap').textContent = t('ofCap', { c: fmtLitres(capacityOf(st)) });
    $('rawLit').textContent = t('rawAdc', { v: fmtNum(rawAdcOf(st), 0), m: String(RAW_ADC_MAX) });
    renderRawTable(capacityOf(st));
    const tv = tiltView(st);
    $('tilt').hidden = !tv;
    if (tv) {
      $('tiltV').textContent = tv.main;
      $('tiltS').textContent = tv.sides;
      $('tiltS').hidden = !tv.sides;
    }
    const fv = fuelView(st);
    $('tot').hidden = !fv;
    if (fv) {
      $('totF').textContent = fv.filled + ' L';
      $('totD').textContent = fv.drained + ' L';
      $('totF').className = fv.filled.length > 6 ? 'lg' : '';     // 7+ characters: the smaller size (a 360 px phone)
      $('totD').className = fv.drained.length > 6 ? 'lg' : '';
      $('totFn').textContent = fv.fills;
      $('totDn').textContent = fv.drains;
      $('totNow').textContent = fv.now;
      $('totNow').hidden = !fv.now;
    }
    const tk = st.tank || {}, flags = healthFlags(st.health, st.radar);
    rows($('dl'), [
      ['d_mac', st.mac],
      ['d_fw', st.fw],
      ['d_build', buildText(st.variant)],
      ['d_site', st.site_id || STR.notSet],
      ['d_siteLoc', siteLocText(st)],
      ['d_temp', fin(st.temp_c) ? t('degC', { v: Math.round(st.temp_c) }) : ''],
      ['d_tilt', tv ? tv.row : ''],
      ['d_uptime', fin(st.uptime_s) ? fmtDuration(st.uptime_s) : ''],
      ['d_pwr', fin(st.power_interruptions) ? fmtNum(st.power_interruptions, 0) : ''],
      ['d_tank', st.tank ? tankText(tk) : ''],
      ['d_lpmm', fmtLpmm(lpmmOf(st))],
      ['d_health', flags.length ? flags.join('; ') : STR.hf_ok],
    ]);
    tick();
  }

  // once a second: "Updated 5 s ago"
  function tick() {
    if (!app.status) return;
    const ago = (fin(app.status.age_s) && app.status.age_s > 0 ? app.status.age_s : 0) + (ctx.clock.now() - app.statusAt) / 1000;
    $('upd').textContent = app.lost ? t('lastUpd', { t: fmtDuration(ago) }) : fmtAgo(ago);
  }

  ctx.bus.on('status', render);
  ctx.bus.on('connected', render);
  ctx.bus.on('lost', render);
  ctx.bus.on('maint', render);
  client.on('link', renderBt);
  $('bMaint').addEventListener('click', () => ctx.nav.go('maint'));
  $('bRegs').addEventListener('click', () => ctx.nav.go('regs'));
  $('bLogs').addEventListener('click', () => ctx.nav.go('logs'));
  $('bViz').addEventListener('click', () => ctx.nav.go('viz'));
  let discArmed = null;                                    // a recording of hours is not ended by a tap on Disconnect: it asks once more
  $('bDisc').addEventListener('click', () => {
    if (ctx.recorder && ctx.recorder.active && discArmed === null) {
      const b = $('bDisc');
      b.textContent = STR.recDiscAgain;
      discArmed = setTimeout(() => { discArmed = null; b.textContent = STR.bt_disconnect; }, 6000);
      return;
    }
    if (discArmed !== null) { clearTimeout(discArmed); discArmed = null; $('bDisc').textContent = STR.bt_disconnect; }
    ctx.disconnect();
  });

  return { enter: render, leave() {}, tick };
}
