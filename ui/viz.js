// The Sensor visualization page of debug builds: the live radar echo, amplitude against distance from the sensor chip, like the
// radar vendor's live plot. The data side is viz.js; this file only draws and wires the controls.
import { STR, t, fmtLitres, fmtPct, levelOf, litresOf, fillPctOf, statusView } from '../core.js';
import { SensorViz, RANGES, SCALES, niceCeil, niceTicks, FLAGS } from '../viz.js';
import { $, msg, busy } from './dom.js';
import { initRecord } from './record.js';

const M = { l: 60, r: 10, t: 10, b: 38 };                  // plot margins in CSS pixels (room for the labels)
const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function fmtAmp(a) { return a >= 100 ? String(Math.round(a)) : a.toFixed(1); }
function fmtMm(d) { return d.toFixed(1); }

export function initViz(ctx) {
  const viz = new SensorViz({ client: ctx.client, clock: ctx.clock, feed: ctx.feed });
  const record = initRecord(ctx);
  const canvas = $('vzCanvas');
  let range = RANGES[0], yFixed = null;                    // range: the distance window; yFixed: a fixed top of the amplitude axis, or null (automatic)
  let yAuto = 100, lowRun = 0;                             // the automatic top and how many frames in a row it could have been lower
  let cursor = null;                                       // CSS x of the pointer over the plot, or null
  let raf = 0, shown = false;

  // ---- controls
  for (const r of RANGES) $('vzRange').add(new Option(STR[r.key], r.id));
  for (const s of SCALES) $('vzScale').add(new Option(s === null ? STR.vizScaleAuto : String(s), s === null ? 'auto' : String(s)));
  canvas.setAttribute('aria-label', STR.vizChartLabel);
  $('vzRange').addEventListener('change', () => { range = RANGES.find((r) => r.id === $('vzRange').value) || RANGES[0]; lowRun = 0; schedule(); });
  $('vzScale').addEventListener('change', () => { yFixed = $('vzScale').value === 'auto' ? null : Number($('vzScale').value); lowRun = 0; schedule(); });
  $('vzPeakHold').addEventListener('change', () => viz.setPeakHold($('vzPeakHold').checked));
  $('bVzPeakReset').addEventListener('click', () => viz.resetPeak());
  $('bVzPause').addEventListener('click', () => (viz.paused ? viz.resume() : viz.pause()));
  $('bVzFast').addEventListener('click', async () => {
    busy($('bVzFast'), true);
    try { await ctx.link.setRange(false); } finally { busy($('bVzFast'), false); }
    await viz.stop();
    await viz.start();
  });
  const pointer = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    cursor = x >= M.l && x <= r.width - M.r ? x : null;
    schedule();
  };
  canvas.addEventListener('pointerdown', pointer);
  canvas.addEventListener('pointermove', pointer);
  canvas.addEventListener('pointerleave', () => { cursor = null; schedule(); });
  window.addEventListener('resize', () => { if (shown) schedule(); });
  viz.on('frame', () => { if (viz.frames === 1) renderState(); schedule(); });          // (the first frame clears "waiting")
  viz.on('estimate', () => { renderEstimate(); });
  viz.on('change', () => { renderState(); schedule(); });

  // ---- the current values (the same numbers as the dashboard, next to the plot)
  function renderVals() {
    const st = ctx.app.status, set = (id, v) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };
    if (st) {
      set('lvLevel', fmtMm(levelOf(st)));
      set('lvLitres', fmtLitres(litresOf(st)));
      set('lvPct', fmtPct(fillPctOf(st)) + ' %');
      set('lvStatus', statusView(st.status, st.source).text);
      set('lvTemp', Number.isFinite(st.temp_c) ? st.temp_c + ' °C' : '–');
    }
    const e = viz.estimate, l = ctx.app.link;
    set('lvEst', e && e.state ? e.state : '–');
    set('lvShown', e && e.out !== null ? fmtMm(e.out) : '–');
    set('lvLink', l && Number.isFinite(l.rssi) ? Math.round(l.rssi) + ' dBm' : '–');
  }
  ctx.bus.on('status', () => { if (shown) renderVals(); });

  // ---- text around the chart
  function viewRange() {
    const lo = range.lo === null ? viz.axis.x0 : Math.max(range.lo, viz.axis.x0);
    const hi = range.hi === null ? viz.axis.x1 : Math.min(range.hi, viz.axis.x1);
    return hi > lo ? { lo, hi } : { lo: viz.axis.x0, hi: viz.axis.x1 };
  }
  function renderState() {
    $('bVzPause').textContent = viz.paused ? STR.vizResume : STR.vizPause;
    $('bVzPeakReset').hidden = !viz.peakHold;
    const fast = viz.state === 'error' && viz.error && viz.error.code === 'link_mode';
    $('bVzFast').hidden = !fast;
    if (viz.state === 'starting') msg('vzMsg', STR.vizStarting, '');
    else if (viz.state === 'error') msg('vzMsg', fast ? STR.vizLinkMode : t('vizErr', { e: viz.error ? viz.error.text : '' }), 'bad');
    else if (viz.state === 'running' && viz.frames === 0) msg('vzMsg', STR.vizWaiting, '');
    else if (viz.state === 'idle' && shown && viz.frames > 0) msg('vzMsg', STR.vizLost, 'warn');
    else msg('vzMsg', '', '');
  }
  function renderEstimate() {
    const e = viz.estimate;
    $('vzEst').textContent = e && e.h !== null ? t('vizEstimate', { h: e.h.toFixed(1), state: e.state }) : STR.vizEstimateNone;
  }
  function renderStats() {
    if (viz.seq === null) { $('vzStat').textContent = ''; $('vzFlags').textContent = ''; $('vzPeak').textContent = ''; return; }
    $('vzStat').textContent = t('vizStat', { seq: viz.seq, fps: viz.fps.toFixed(1), temp: viz.temp === null ? '–' : viz.temp }) + (viz.lost ? t('vizStatLost', { n: viz.lost }) : '');
    const f = [];
    if (viz.flags & FLAGS.saturated) f.push(STR.vizFlagSat);
    if (viz.flags & FLAGS.delayed) f.push(STR.vizFlagDelay);
    if (viz.flags & FLAGS.calibration) f.push(STR.vizFlagCal);
    if (viz.flags & FLAGS.lost) f.push(STR.vizFlagLost);
    $('vzFlags').textContent = f.join(' · ');
    const { lo, hi } = viewRange();
    const p = viz.strongest(lo, hi);
    $('vzPeak').textContent = p ? t('vizPeak', { a: fmtAmp(p.amp), d: fmtMm(p.mm) }) : '';
  }

  // ---- the chart
  function schedule() {
    if (!shown || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }
  function colors() {
    const cs = getComputedStyle(document.documentElement);
    const c = (n) => cs.getPropertyValue(n).trim();
    return { ink: c('--ink'), mut: c('--mut'), line: c('--line'), acc: c('--acc'), card: c('--card') };
  }
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = colors();
    g.clearRect(0, 0, W, H);
    const pl = M.l, pr = W - M.r, pt = M.t, pb = H - M.b;
    const { lo, hi } = viewRange();
    const ax = viz.axis;

    // the amplitude axis: fixed, or the next round number above the strongest point in view (it only drops after a second of lower frames)
    let top = yFixed;
    if (top === null) {
      let mx = 0;
      for (let i = 0; i < ax.n; i++) { const d = ax.mm(i); if (d >= lo && d <= hi) { if (viz.amp && viz.amp[i] > mx) mx = viz.amp[i]; if (viz.peak && viz.peak[i] > mx) mx = viz.peak[i]; } }
      const want = niceCeil(mx * 1.08);
      if (want >= yAuto) { yAuto = want; lowRun = 0; } else if (++lowRun > 10) { yAuto = want; lowRun = 0; }
      top = yAuto;
    }
    const X = (d) => pl + ((d - lo) / (hi - lo)) * (pr - pl);
    const Y = (a) => pb - (Math.min(a, top) / top) * (pb - pt);

    // grid and labels
    g.font = FONT;
    g.lineWidth = 1;
    g.strokeStyle = col.line;
    g.fillStyle = col.mut;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const v of niceTicks(0, top, 4)) {
      const y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(pl, y); g.lineTo(pr, y); g.stroke();
      g.fillText(String(v), pl - 6, y);
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const v of niceTicks(lo, hi, 6)) {
      const x = Math.round(X(v)) + 0.5;
      g.beginPath(); g.moveTo(x, pt); g.lineTo(x, pb); g.stroke();
      g.fillText(String(v), x, pb + 5);
    }
    g.fillStyle = col.ink;
    g.fillText(STR.vizAxisX, (pl + pr) / 2, pb + 21);
    g.save();
    g.translate(11, (pt + pb) / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = 'middle';
    g.fillText(STR.vizAxisY, 0, 0);
    g.restore();
    g.strokeStyle = col.mut;
    g.strokeRect(pl + 0.5, pt + 0.5, pr - pl, pb - pt);

    // the curves, clipped to the plot
    g.save();
    g.beginPath(); g.rect(pl, pt, pr - pl, pb - pt); g.clip();
    const trace = (a) => { g.beginPath(); let first = true; for (let i = 0; i < ax.n; i++) { const d = ax.mm(i); if (d < lo - ax.dx || d > hi + ax.dx) continue; const x = X(d), y = Y(a[i]); if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y); } };
    if (viz.peak) { trace(viz.peak); g.strokeStyle = col.mut; g.lineWidth = 1; g.stroke(); }
    if (viz.amp) {
      trace(viz.amp);
      g.strokeStyle = col.acc; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
      g.lineTo(X(Math.min(hi, ax.x1)), pb); g.lineTo(X(Math.max(lo, ax.x0)), pb); g.closePath();
      g.globalAlpha = 0.14; g.fillStyle = col.acc; g.fill(); g.globalAlpha = 1;
    }
    g.restore();

    // the cursor
    let cur = '';
    if (cursor !== null && viz.amp) {
      const d = lo + ((cursor - pl) / (pr - pl)) * (hi - lo);
      const i = Math.max(0, Math.min(ax.n - 1, Math.round((d - ax.x0) / ax.dx)));
      g.strokeStyle = col.ink; g.lineWidth = 1; g.setLineDash([4, 3]);
      const x = Math.round(X(ax.mm(i))) + 0.5;
      g.beginPath(); g.moveTo(x, pt); g.lineTo(x, pb); g.stroke();
      g.setLineDash([]);
      cur = t('vizCursor', { d: fmtMm(ax.mm(i)), a: fmtAmp(viz.amp[i]) });
    }
    $('vzCursor').textContent = cur;
    renderStats();
    renderVals();
    canvas.dataset.frames = String(viz.frames);
    canvas.dataset.range = range.id;
    canvas.dataset.top = String(top);
  }

  return {
    async enter() {
      shown = true;
      cursor = null; yAuto = 100; lowRun = 0;
      renderVals();
      const started = viz.start();                       // (resets the frames and moves to 'starting' before its first await)
      renderEstimate();
      renderState();
      schedule();
      await Promise.all([started, record.enter()]);
    },
    async leave() {
      shown = false;
      record.leave();
      await viz.stop();                                  // (a recording keeps its own share of the stream)
    },
    tick() { if (shown && viz.running) draw(); record.tick(); },        // once a second: the frame rate and the axis follow even if no frame comes
    record,
  };
}
