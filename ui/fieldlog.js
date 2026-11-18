// The Field log page (firmware 3.0.3): download the sensor's log to the phone, save or share the file, write a note into the log, and see
// the numbers and four plots. The data side is fieldlog.js (the decoder, the download) and flogstore.js (the phone's copy); this file only
// shows it. The charts are drawn on canvases the way ui/viz.js draws the radar echo.
import { STR, t, fmtDuration, fmtNum } from '../core.js';
import { niceTicks } from '../viz.js';
import {
  decodeLog, layoutTime, buildSeries, summarize, RANGES, rangeWindow, openRuns, confirmedPerHour, nearestIndex, timeTicks, elapsedTicks,
  parseNote, NOTE_KINDS, CELLS_PER_DAY, UNREAD_CELLS,
} from '../fieldlog.js';
import { deliverTextFiles } from '../export.js';
import { $, msg, busy, setBar } from './dom.js';

const M = { l: 40, r: 30, t: 8, b: 22 };                    // plot margins in CSS pixels (room for the labels); the same on every chart, so one cursor fits all
const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const pad = (n) => String(n).padStart(2, '0');
const dayText = (s) => fmtDuration(Math.max(60, (s / CELLS_PER_DAY) * 86400));
// "15 Nov 08:12" in the phone's time zone
function fmtWhen(unixS) {
  const d = new Date(unixS * 1000);
  return d.getDate() + ' ' + STR.months[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');

export function initFieldLog(ctx) {
  const { flog, client } = ctx;
  let shown = false, data = null, range = '4d', cursor = null, raf = 0, resume = false, wakeLock = null, sig = '';

  // ---- controls
  for (const r of RANGES) $('flRange').add(new Option(STR[r.key], r.id));
  $('flRange').value = range;
  $('flRange').addEventListener('change', () => { range = $('flRange').value; schedule(); });
  for (const [k, key] of [[NOTE_KINDS.DIPSTICK, 'flNoteK1'], [NOTE_KINDS.FUEL, 'flNoteK2'], [NOTE_KINDS.OTHER, 'flNoteK3']]) $('flNoteKind').add(new Option(STR[key], String(k)));
  const kindChanged = () => {
    const k = Number($('flNoteKind').value);
    $('flNoteMmBox').hidden = k !== NOTE_KINDS.DIPSTICK;
    $('flNoteLBox').hidden = k !== NOTE_KINDS.FUEL;
    msg('flNoteMsg', '', '');
  };
  $('flNoteKind').addEventListener('change', kindChanged);
  kindChanged();
  for (const id of ['flNoteMm', 'flNoteL']) {
    $(id).addEventListener('input', () => msg('flNoteMsg', '', ''));
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNote(); } });
  }
  $('bFlNote').addEventListener('click', addNote);
  $('bFlGet').addEventListener('click', () => download());
  $('bFlStop').addEventListener('click', () => { flog.abort(); $('bFlStop').disabled = true; });
  $('bFlSave').addEventListener('click', () => deliver(true));
  $('bFlShare').addEventListener('click', () => deliver(false));
  for (const id of ['flC1', 'flC2', 'flC3', 'flC4']) {
    const c = $(id);
    c.setAttribute('aria-label', t('flChartAria', { what: STR[{ flC1: 'flChartLevel', flC2: 'flChartConf', flC3: 'flChartTv', flC4: 'flChartTilt' }[id]] }));
    const point = (e) => {
      if (!data || !data.window) return;
      const r = c.getBoundingClientRect(), x = e.clientX - r.left, pl = M.l, pr = r.width - M.r;
      cursor = x >= pl && x <= pr ? data.window.lo + ((x - pl) / (pr - pl)) * (data.window.hi - data.window.lo) : null;
      schedule();
    };
    c.addEventListener('pointerdown', point);
    c.addEventListener('pointermove', point);
    c.addEventListener('pointerleave', () => { cursor = null; schedule(); });
  }
  window.addEventListener('resize', () => { if (shown) schedule(); });

  // ---- the phone's copy of the log, decoded
  async function refresh() {
    const l = await flog.load();
    const last = l.pages.length ? l.pages[l.pages.length - 1] : null;
    const s = l.key + ':' + l.pages.length + ':' + (last ? last.pos + ':' + last.n : '') + ':' + l.visits.length;
    if (data && s === sig) { data.load = l; render(); return; }
    sig = s;
    if (!l.pages.length) { data = { load: l, empty: true }; render(); return; }
    const decoded = decodeLog(l.pages, { logId: l.id });
    const timeline = layoutTime(decoded.records);
    const series = buildSeries(decoded.records);
    data = { load: l, empty: false, decoded, timeline, series, summary: summarize(decoded, timeline, series), runs: openRuns(series) };
    render();
  }

  // ---- text and tiles
  async function renderBehind() {
    let u = null;
    try { u = await flog.unread(); } catch (e) { u = null; }
    const el = $('flBehind');
    if (!u || !u.known || u.cells <= UNREAD_CELLS) { el.hidden = true; return; }
    el.textContent = t('flBehind', { t: dayText(u.cells) });
    el.hidden = false;
  }
  function render() {
    const d = data;
    $('flMem').hidden = !(d && d.load.kind === 'memory');
    const has = !!d && !d.empty;
    $('bFlGet').textContent = has ? STR.flGetNew : STR.flGet;
    if (!has) { $('flPhone').textContent = STR.flPhoneNone; $('flLast').textContent = ''; } else {
      const sm = d.summary;
      $('flPhone').textContent = t('flPhoneHas', { minutes: fmtNum(sm.minutes, 0), span: d.timeline.anyDated ? t('flPhoneSpan', { when: fmtWhen(d.timeline.datedTo) }) : STR.flPhoneSpanUnknown });
      const v = d.load.visits.length ? d.load.visits[d.load.visits.length - 1] : null;
      $('flLast').textContent = v ? t('flLastDl', { when: fmtWhen(v.phone_ms / 1000) }) : STR.flNoDl;
    }
    renderOlder();
    renderTiles();
    $('flNoData').hidden = has;
    $('flCharts').hidden = !has;
    $('bFlSave').disabled = $('bFlShare').disabled = !has;
    schedule();
  }
  function renderOlder() {
    const ul = $('flOlder');
    ul.textContent = '';
    const older = data ? data.load.older : [];
    ul.hidden = !older.length;
    for (const key of older) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = t('flOlder', { id: key });
      b.addEventListener('click', () => deliver(true, key));
      li.appendChild(b);
      ul.appendChild(li);
    }
  }
  function renderTiles() {
    const has = !!data && !data.empty;
    $('flSumEmpty').hidden = has;
    $('flTiles').hidden = !has;
    if (!has) return;
    const s = data.summary, set = (id, v, sub = '') => { $('flT_' + id).textContent = v; $('flT_' + id + '_s').textContent = sub; };
    set('span', s.datedFrom === null ? '–' : t('flSpanDated', { d: s.datedDays.toFixed(1) }), s.undatedBoots ? t('flSpanUnknown', { h: s.undatedHours.toFixed(1) }) : '');
    set('min', fmtNum(s.minutes, 0));
    set('starts', fmtNum(s.starts, 0), t('flStartsSub', { p: s.startGroups.power, r: s.startGroups.restart, f: s.startGroups.fault }));
    set('steps', fmtNum(s.steps, 0), t('flStepsSub', { u: s.stepsUp, d: s.stepsDown }));
    set('conf', s.confPct === null ? '–' : s.confPct.toFixed(1) + ' %', STR.flConfSub);
    set('open', fmtNum(s.wireOpenMin, 0), STR.flOpenSub);
    set('dmg', fmtNum(s.damaged, 0));
    set('snaps', fmtNum(s.snapshots, 0), t('flSnapsSub', { b: s.badSnapshots }));
  }

  // ---- the download
  function renderProgress(p) {
    const total = Math.max(1, (p.head || 0) - (p.from || 0)), pct = p.phase === 'read' || p.phase === 'end' ? Math.max(0, Math.min(100, (((p.to || 0) - (p.from || 0)) / total) * 100)) : 0;
    setBar($('flBar'), pct);
    $('flProgT').textContent = p.phase === 'read' || p.phase === 'end' ? t('flProg', { cells: fmtNum(p.cells, 0), kb: Math.round(p.bytes / 1024), pages: p.pages, p: Math.round(pct) }) : STR.flWorking;
  }
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      else if (!on && wakeLock) { const l = wakeLock; wakeLock = null; await l.release(); }
    } catch (e) { wakeLock = null; }
  }
  const resLine = (text, cls) => { const p = document.createElement('p'); p.className = 'msg ' + (cls || ''); p.textContent = text; $('flRes').appendChild(p); };
  function renderResult(res) {
    const box = $('flRes');
    box.textContent = '';
    if (res.empty) resLine(STR['flOff_' + res.why] || STR.flOff_other, 'warn');
    else if (res.ok) {
      if (!res.cells) resLine(STR.flNothingNew, 'ok');
      else {
        resLine(t('flDone', { cells: fmtNum(res.cells, 0), kb: Math.round(res.bytes / 1024) }), 'ok');
        const fresh = data && !data.empty ? data.decoded.records.filter((r) => r.pos >= res.from) : [];
        const minutes = fresh.filter((r) => r.kind === 'minute').length;
        resLine(t('flDoneNew', { minutes: fmtNum(minutes, 0), days: (minutes / 1440).toFixed(1), events: fresh.filter((r) => r.kind === 'event').length, snaps: fresh.filter((r) => r.kind === 'snapshot').length }), 'ok');
      }
    } else if (res.reason === 'link_lost') resLine(STR.flInterrupted, 'bad');
    else if (res.reason === 'timeout') resLine(STR.flTimeout, 'bad');
    else if (res.reason === 'cancelled') resLine(STR.flCancelled, 'warn');
    else resLine(STR['flFail_' + res.reason] ? t('flFail_' + res.reason, { e: res.error }) : t('flFail', { e: res.error || res.reason }), 'bad');
    if (res.newLog) resLine(STR.flNewLog, 'warn');
    const lost = res.lost.reduce((n, l) => n + l.cells, 0);
    if (lost) resLine(t('flLost', { t: dayText(lost) }), 'warn');
    if (res.synced === false && res.syncError) resLine(STR.flSyncFail, 'warn');
    const dmg = data && !data.empty ? data.decoded.stats.damaged : 0;
    if (dmg) resLine(t('flDamaged', { n: dmg }), 'warn');
    if (res.info && res.info.dropped > 0) resLine(t('flDropped', { n: res.info.dropped }), 'warn');
    box.hidden = !box.children.length;
  }
  async function download() {
    if (flog.busy) return;
    resume = false;
    $('flRes').hidden = true;
    if (!client.connected) { renderResult({ ok: false, reason: 'link_lost', lost: [] }); resume = true; return; }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best effort: keeps the browser from clearing the log */ }
    $('flProg').hidden = false;
    $('bFlStop').disabled = false;
    setBar($('flBar'), 0);
    $('flProgT').textContent = STR.flWorking;
    busy($('bFlGet'), true, STR.flWorking);
    keepAwake(true);
    let res;
    try { res = await flog.download({ onProgress: renderProgress }); } finally { busy($('bFlGet'), false); $('flProg').hidden = true; keepAwake(false); }
    if (res.reason === 'link_lost') resume = true;           // the page carries on by itself when the link is back
    try { await refresh(); } catch (e) { /* the result below still says what happened */ }
    renderResult(res);
    renderBehind();
    $('bFlGet').dataset.done = String(res.ok);
  }

  // ---- save, share
  async function deliver(downloadOnly, key = '') {
    msg('flSaveMsg', '', '');
    try {
      const f = key ? await flog.file(key) : flog.fileOf(data && data.load);       // (the loaded copy, at once: the share sheet needs the tap that asked for it)
      if (!f) { msg('flSaveMsg', STR.flSaveNone, 'warn'); return; }
      const how = await deliverTextFiles([{ name: f.name, text: f.text }], downloadOnly ? { downloadOnly: true } : {});
      msg('flSaveMsg', how === 'shared' ? STR.flShared : how === 'downloaded' ? STR.flSaved : '', 'ok');
    } catch (e) { msg('flSaveMsg', t('flSaveFail', { e: (e && e.message) || 'error' }), 'bad'); }
  }

  // ---- a note for the log
  async function addNote() {
    const k = Number($('flNoteKind').value);
    const p = parseNote(k, k === NOTE_KINDS.DIPSTICK ? $('flNoteMm').value : k === NOTE_KINDS.FUEL ? $('flNoteL').value : '');
    if (!p.ok) { msg('flNoteMsg', STR['flNoteErr_' + p.err] || STR.flNoteErr_number, 'bad'); return; }
    busy($('bFlNote'), true);
    try {
      await flog.note(p);
      $('flNoteMm').value = '';
      $('flNoteL').value = '';
      msg('flNoteMsg', STR.flNoteOk, 'ok');
    } catch (e) { msg('flNoteMsg', t('flNoteErr_send', { e: (e && (e.msg || e.message)) || '' }), 'bad'); } finally { busy($('bFlNote'), false); }
  }

  // ---- the charts
  function schedule() {
    if (!shown || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; drawAll(); });
  }
  function colors() {
    const cs = getComputedStyle(document.documentElement), c = (n) => cs.getPropertyValue(n).trim();
    return { ink: c('--ink'), mut: c('--mut'), line: c('--line'), acc: c('--acc'), ok: c('--ok'), warn: c('--warn'), bad: c('--bad'), card: c('--card') };
  }
  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return null;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = FONT;
    return { g, W, H, pl: M.l, pr: W - M.r, pt: M.t, pb: H - M.b };
  }
  // The frame of one chart: horizontal grid with the labels at the left (and the right, when given), the time axis, the bands of the
  // boots whose time is not known, the cursor. Returns the x and y mappers. yr: {lo, hi, ticks} left; right: {hi, ticks, color} or null.
  function frame(canvas, col, win, yr, right, label) {
    const c = setup(canvas);
    if (!c) return null;
    const { g, pl, pr, pt, pb } = c, tl = data.timeline;
    const X = (tm) => pl + ((tm - win.lo) / (win.hi - win.lo)) * (pr - pl);
    const Y = (v) => pb - ((v - yr.lo) / (yr.hi - yr.lo)) * (pb - pt);
    g.lineWidth = 1;
    g.strokeStyle = col.line;
    g.fillStyle = col.mut;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of yr.ticks) { const y = Math.round(Y(v)) + 0.5; g.beginPath(); g.moveTo(pl, y); g.lineTo(pr, y); g.stroke(); g.fillText(String(v), pl - 4, y); }
    if (right) { g.fillStyle = right.color; g.textAlign = 'left'; for (const v of right.ticks) g.fillText(String(v), pr + 4, pb - (v / right.hi) * (pb - pt)); }
    // the bands of the boots without a date: shaded, with a visible break at both ends
    const unknown = tl.boots.filter((b) => !b.dated && b.lEnd >= win.lo && b.lStart <= win.hi);
    g.save();
    g.beginPath(); g.rect(pl, pt, pr - pl, pb - pt); g.clip();
    for (const b of unknown) {
      const x0 = X(Math.max(b.lStart, win.lo)), x1 = X(Math.min(b.lEnd, win.hi));
      g.globalAlpha = 0.14; g.fillStyle = col.mut; g.fillRect(x0, pt, Math.max(1, x1 - x0), pb - pt); g.globalAlpha = 1;
      g.strokeStyle = col.mut; g.setLineDash([3, 3]);
      for (const x of [X(b.lStart), X(b.lEnd)]) { if (x < pl || x > pr) continue; g.beginPath(); g.moveTo(Math.round(x) + 0.5, pt); g.lineTo(Math.round(x) + 0.5, pb); g.stroke(); }
      g.setLineDash([]);
      if (label && x1 - x0 > 64) { g.fillStyle = col.mut; g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(STR.flUnknownLabel, (x0 + x1) / 2, pt + 2); }
    }
    g.restore();
    // the time axis: clock time where the boots are dated, hours since the first record where none is; no labels inside the unknown bands
    const count = Math.max(3, Math.floor((pr - pl) / 58));
    g.fillStyle = col.mut; g.textAlign = 'center'; g.textBaseline = 'top';
    const ticks = tl.anyDated ? timeTicks(win.lo, win.hi, count, -new Date(win.hi * 1000).getTimezoneOffset(), STR.months) : elapsedTicks(win.lo - tl.tMin, win.hi - tl.tMin, count).map((x) => ({ ...x, t: x.t + tl.tMin }));
    for (const k of ticks) {
      if (tl.anyDated && unknown.some((b) => k.t >= b.lStart && k.t <= b.lEnd)) continue;
      const x = Math.round(X(k.t)) + 0.5;
      if (x < pl || x > pr) continue;
      g.strokeStyle = col.line; g.beginPath(); g.moveTo(x, pb); g.lineTo(x, pb + 3); g.stroke();
      g.fillText(k.label, x, pb + 5);
    }
    g.strokeStyle = col.mut;
    g.strokeRect(pl + 0.5, pt + 0.5, pr - pl, pb - pt);
    return { ...c, X, Y, col, win };
  }
  function clip(f) { f.g.save(); f.g.beginPath(); f.g.rect(f.pl, f.pt, f.pr - f.pl, f.pb - f.pt); f.g.clip(); }
  // One series as a line: a break at a start and at a gap in the data; where many minutes fall on one pixel column the line goes through
  // the first, lowest, highest and last value of it (a fill of six minutes stays visible on a plot of a month).
  function line(f, arr, color, width, dash) {
    const s = data.series, g = f.g, secPerPx = (f.win.hi - f.win.lo) / (f.pr - f.pl), gap = Math.max(150, 2 * secPerPx);
    g.beginPath();
    let col = null, pen = false, prevBoot = -1, prevT = -1e18;
    const flush = () => {
      if (!col) return;
      for (const v of col.n > 1 ? [col.first, col.min, col.max, col.last] : [col.first]) { const y = f.Y(v); if (!pen) { g.moveTo(col.x, y); pen = true; } else g.lineTo(col.x, y); }
      col = null;
    };
    for (let i = 0; i < s.n; i++) {
      const tm = s.tl[i];
      if (tm < f.win.lo - gap || tm > f.win.hi + gap) continue;
      const v = arr[i];
      if (!(v === v)) { flush(); pen = false; prevT = -1e18; continue; }
      if (s.boot[i] !== prevBoot || tm - prevT > gap) { flush(); pen = false; }
      prevBoot = s.boot[i]; prevT = tm;
      const x = Math.round(f.X(tm));
      if (col && col.x === x) { col.n++; col.last = v; if (v < col.min) col.min = v; if (v > col.max) col.max = v; } else { flush(); col = { x, n: 1, first: v, min: v, max: v, last: v }; }
    }
    flush();
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.setLineDash(dash || []);
    g.stroke();
    g.setLineDash([]); g.lineWidth = 1;
  }
  function extent(arrs, win) {
    const s = data.series;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < s.n; i++) {
      if (s.tl[i] < win.lo || s.tl[i] > win.hi) continue;
      for (const a of arrs) { const v = a[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    }
    if (lo > hi) { lo = 0; hi = 1; }
    if (hi - lo < 2) { const m = (lo + hi) / 2; lo = m - 1; hi = m + 1; }
    const p = (hi - lo) * 0.06;
    return { lo: lo - p, hi: hi + p };
  }
  const withTicks = (e) => ({ ...e, ticks: niceTicks(e.lo, e.hi, 4) });
  function cursorLine(f) {
    if (cursor === null || cursor < f.win.lo || cursor > f.win.hi) return;
    const x = Math.round(f.X(cursor)) + 0.5;
    f.g.strokeStyle = f.col.ink; f.g.lineWidth = 1; f.g.setLineDash([4, 3]);
    f.g.beginPath(); f.g.moveTo(x, f.pt); f.g.lineTo(x, f.pb); f.g.stroke();
    f.g.setLineDash([]);
  }
  function triangle(g, x, y, up, size) {
    g.beginPath();
    if (up) { g.moveTo(x, y - size); g.lineTo(x - size, y + size * 0.8); g.lineTo(x + size, y + size * 0.8); } else { g.moveTo(x, y + size); g.lineTo(x - size, y - size * 0.8); g.lineTo(x + size, y - size * 0.8); }
    g.closePath(); g.fill();
  }

  function drawLevel(col, win) {
    const s = data.series, e = extent([s.level, s.hsurf, s.hfenv], win);
    const f = frame($('flC1'), col, win, withTicks(e), null, true);
    if (!f) return;
    clip(f);
    f.g.globalAlpha = 0.28; f.g.fillStyle = col.warn;                       // the wire open
    for (const [a, b] of data.runs) { if (b < win.lo || a > win.hi) continue; f.g.fillRect(f.X(Math.max(a, win.lo)), f.pt, Math.max(1.5, f.X(Math.min(b, win.hi)) - f.X(Math.max(a, win.lo))), f.pb - f.pt); }
    f.g.globalAlpha = 1;
    line(f, s.hfenv, col.warn, 1, [1, 3]);
    line(f, s.hsurf, col.ok, 1, [4, 3]);
    line(f, s.level, col.acc, 2);
    for (const m of s.markers) {
      if (m.tl < win.lo || m.tl > win.hi) continue;
      const x = Math.round(f.X(m.tl)) + 0.5;
      if (m.kind === 'boot') { f.g.strokeStyle = col.bad; f.g.setLineDash([2, 3]); f.g.beginPath(); f.g.moveTo(x, f.pt); f.g.lineTo(x, f.pb); f.g.stroke(); f.g.setLineDash([]); }
      else { f.g.fillStyle = col.ink; triangle(f.g, x, Math.max(f.pt + 5, Math.min(f.pb - 5, f.Y(Number.isFinite(m.level) ? m.level : e.lo))), m.buckets > 0, 5); }
    }
    f.g.restore();
    cursorLine(f);
  }
  function drawConf(col, win) {
    const f = frame($('flC2'), col, win, { lo: 0, hi: 100, ticks: [0, 50, 100] }, null, false);
    if (!f) return;
    clip(f);
    for (const h of confirmedPerHour(data.series, win.lo, win.hi)) {
      f.g.fillStyle = h.pct >= 90 ? col.ok : h.pct >= 50 ? col.warn : col.bad;
      const x0 = f.X(Math.max(h.t, win.lo)), x1 = f.X(Math.min(h.t + 3600, win.hi)), y = f.Y(h.pct);
      f.g.fillRect(x0, y, Math.max(1, x1 - x0 - (x1 - x0 > 4 ? 1 : 0)), f.pb - y);
    }
    f.g.restore();
    cursorLine(f);
  }
  function drawTv(col, win) {
    const s = data.series, e = extent([s.temp], win);
    let vmax = 0;
    for (let i = 0; i < s.n; i++) if (s.tl[i] >= win.lo && s.tl[i] <= win.hi && s.vib[i] > vmax) vmax = s.vib[i];
    const top = niceTicks(0, Math.max(10, vmax * 1.1), 3), vhi = top[top.length - 1];
    const f = frame($('flC3'), col, win, withTicks(e), { hi: vhi, ticks: top, color: col.warn }, false);
    if (!f) return;
    clip(f);
    const scaled = new Float64Array(s.n);
    for (let i = 0; i < s.n; i++) scaled[i] = s.vib[i] === s.vib[i] ? e.lo + (s.vib[i] / vhi) * (e.hi - e.lo) : NaN;
    line(f, scaled, col.warn, 1);
    line(f, s.temp, col.acc, 2);
    f.g.restore();
    cursorLine(f);
  }
  function drawTilt(col, win) {
    const s = data.series, e0 = extent([s.tiltx, s.tilty], win), e = { lo: Math.min(e0.lo, -0.5), hi: Math.max(e0.hi, 0.5) };      // (the zero line is always in)
    const f = frame($('flC4'), col, win, withTicks(e), null, false);
    if (!f) return;
    clip(f);
    f.g.strokeStyle = col.mut; f.g.lineWidth = 1;
    const y0 = Math.round(f.Y(0)) + 0.5;
    f.g.beginPath(); f.g.moveTo(f.pl, y0); f.g.lineTo(f.pr, y0); f.g.stroke();
    line(f, s.tilty, col.warn, 2);
    line(f, s.tiltx, col.acc, 2);
    f.g.restore();
    cursorLine(f);
  }
  function drawAll() {
    if (!data || data.empty) return;
    const win = rangeWindow(data.timeline, range), col = colors();
    data.window = win;
    drawLevel(col, win); drawConf(col, win); drawTv(col, win); drawTilt(col, win);
    renderCursor();
    $('flC1').dataset.range = range;
  }
  function renderCursor() {
    const el = $('flCursor');
    if (cursor === null || !data || data.empty) { el.textContent = ''; return; }
    const s = data.series, i = nearestIndex(s, cursor);
    if (i < 0) { el.textContent = ''; return; }
    const b = data.timeline.boots[s.boot[i]];
    const when = s.t[i] === s.t[i] ? fmtWhen(s.t[i]) : t('flWhenUnknown', { boot: b ? b.boot : '?', up: fmtDuration(Math.max(0, s.uptime[i])) });
    el.textContent = t('flCursor', { when, level: num(s.level[i]), surf: num(s.hsurf[i]), fenv: num(s.hfenv[i]), temp: num(s.temp[i], 0), vib: num(s.vib[i], 0), tx: num(s.tiltx[i]), ty: num(s.tilty[i]) });
  }

  return {
    async enter() {
      shown = true;
      cursor = null;
      if (flog.busy) { $('flProg').hidden = false; busy($('bFlGet'), true, STR.flWorking); }
      try { await refresh(); } catch (e) { data = data || { load: { kind: '', older: [], visits: [], pages: [] }, empty: true }; render(); }
      renderBehind();
      if (resume && client.connected && !flog.busy) download();     // the link was lost in the middle of a download and is back: carry on
    },
    leave() { shown = false; },
    tick() {},
    get resumeWanted() { return resume; },
  };
}
