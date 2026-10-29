// The resistive output calibration page (behind the maintenance login, settings grant), and the output test inside it. A proof of concept: the
// operator types the readings of the multimeter; production does the calibration once over the USB-UART tool with a 4-wire meter.
// Calibration: one reading per step with exactly that branch switched on. Step 1 is the meter with its probes touching (taken off every other
// reading), then branches 14 to 1; the last step saves. The output test (from step 1, or after a save): for 9 values from 10 to 200 ohm the sensor
// drives the combination it would use and says what it calculates; the operator types the meter, the page takes the probes off and shows the difference.
import { STR, t, parseOhm, rescalSteps, rescalLimits, rescalTestRow, rescalTestWorst, fmtOhm, fmtReading, fmtPlain, fmtDiff, RESCAL_NOM, RESCAL_PROBE_MAX, RESCAL_TEST_POINTS } from '../core.js';
import { $, msg, setBar } from './dom.js';

export function initRescal(ctx) {
  const { maint } = ctx;
  const steps = rescalSteps();
  let nom = RESCAL_NOM, i = 0, vals = [], probe = null;
  let mode = 'cal', ti = 0, rows = [], calcs = [];
  let running = false, working = false;

  function lock(on) {
    working = on;
    for (const id of ['resIn', 'bResNext', 'bResCancel', 'bResTest']) $(id).disabled = on;
    $('bResBack').disabled = on || (mode === 'test' ? ti === 0 : i === 0);
  }

  function render() {
    const st = steps[i], last = i === steps.length - 1;
    setBar($('resBar'), (100 * i) / steps.length);
    $('resStepN').textContent = t('resStep', { i: i + 1, t: steps.length });
    if (st.kind === 'probe') {
      $('resWhat').textContent = STR.resProbeStep;
      $('resNom').textContent = STR.resProbeHint;
    } else {
      $('resWhat').textContent = t('resBranch', { n: st.n });
      $('resNom').textContent = probe === null ? t('resNom', { v: fmtOhm(nom[st.n - 1]) }) : t('resExpect', { v: fmtReading(nom[st.n - 1] + probe) });
    }
    $('resProbe').hidden = st.kind === 'probe' || probe === null;
    if (!$('resProbe').hidden) $('resProbe').textContent = t('resProbe', { v: fmtReading(probe) });
    $('resIn').value = vals[i] || '';
    $('bResNext').textContent = last ? STR.resSave : STR.resNext;
    $('bResBack').disabled = i === 0;
    $('bResTest').hidden = st.kind !== 'probe';                      // the output test is offered here, once the probes are read
    msg('resErr', '', '');
  }

  function renderTest() {
    const target = RESCAL_TEST_POINTS[ti], last = ti === RESCAL_TEST_POINTS.length - 1;
    setBar($('resBar'), (100 * ti) / RESCAL_TEST_POINTS.length);
    $('resStepN').textContent = t('resTestStep', { i: ti + 1, t: RESCAL_TEST_POINTS.length });
    $('resWhat').textContent = fmtOhm(target);
    $('resNom').textContent = typeof calcs[ti] === 'number' ? t('resTestCalc', { v: fmtReading(calcs[ti]) }) : '';
    $('resProbe').hidden = false;
    $('resProbe').textContent = t('resProbe', { v: fmtReading(probe) });
    $('resIn').value = rows[ti] ? String(rows[ti].reading) : '';
    $('bResNext').textContent = last ? STR.resDone : STR.resNext;
    $('bResBack').disabled = ti === 0;
    $('bResTest').hidden = true;
    msg('resErr', '', '');
  }

  function renderRows() {
    const ul = $('resRows');
    ul.textContent = '';
    for (const r of rows) {
      const li = document.createElement('li');
      li.textContent = t('resTestRow', { w: fmtOhm(r.target), c: fmtReading(r.calc), o: fmtReading(r.out), d: fmtDiff(r.diff) });
      ul.appendChild(li);
    }
    $('resWorst').textContent = rows.length ? t('resTestWorst', { v: fmtReading(rescalTestWorst(rows)) }) : '';
  }

  // Switch the step's branch on (the others off) and wait for the sensor before the operator reads the meter.
  async function goStep(k) {
    i = k;
    render();
    if (steps[i].kind === 'probe') { $('resIn').focus(); return; }   // (the probes touching: whatever the output is doing does not matter)
    lock(true);
    const r = await maint.rescalOn(steps[i].n);
    lock(false);
    if (!r.ok) { if (!r.ended) msg('resErr', r.text, 'bad'); return; }
    $('resIn').focus();
  }

  // The probes reading: checked here (saves a round trip for a typo) and by the sensor.
  async function takeProbe() {
    const v = parseOhm($('resIn').value, true);
    if (!v.ok) { msg('resErr', STR['resErr_' + v.err], 'bad'); return false; }
    if (v.v > RESCAL_PROBE_MAX) { msg('resErr', t('resProbeErr', { max: RESCAL_PROBE_MAX }), 'bad'); return false; }
    lock(true);
    const r = await maint.rescalProbe(v.v);
    if (!r.ok) { lock(false); if (!r.ended) msg('resErr', r.text, 'bad'); return false; }
    vals[0] = $('resIn').value.trim();
    probe = typeof r.state.probe === 'number' ? r.state.probe : v.v;
    return true;
  }

  async function next() {
    if (working || !running) return;
    if (mode === 'test') { await testNext(); return; }
    const st = steps[i];
    if (st.kind === 'probe') {
      if (!(await takeProbe())) return;
      lock(false);
      await goStep(1);
      return;
    }
    const v = parseOhm($('resIn').value);
    if (!v.ok) { msg('resErr', STR['resErr_' + v.err], 'bad'); return; }
    const lim = rescalLimits(st.n, probe, nom);                      // the sensor checks too; this saves a round trip for a typo
    if (v.v < lim.lo || v.v > lim.hi) { msg('resErr', t('resErr_range', { lo: fmtPlain(lim.lo), hi: fmtPlain(lim.hi) }), 'bad'); return; }
    lock(true);
    const r = await maint.rescalSet(st.n, v.v);
    if (!r.ok) { lock(false); if (!r.ended) msg('resErr', r.text, 'bad'); return; }
    vals[i] = $('resIn').value.trim();
    if (i < steps.length - 1) { lock(false); await goStep(i + 1); return; }
    const s = await maint.rescalSave();                              // the last reading: all of them go to the device memory
    if (!s.ok) { lock(false); if (!s.ended) msg('resErr', s.text, 'bad'); return; }
    running = false;
    $('resBox').hidden = true;
    $('resDoneMsg').textContent = STR.resSaved;
    $('bResTestAfter').hidden = false;
    $('resDone').hidden = false;
  }

  // ---- the output test
  async function startTest() {
    mode = 'test';
    rows = [];
    calcs = [];
    renderRows();
    $('resTbl').hidden = false;
    await goTest(0);
  }

  async function goTest(k) {
    ti = k;
    rows.length = k;                                                 // going back drops the later points
    renderRows();
    renderTest();
    lock(true);
    const r = await maint.rescalTest(RESCAL_TEST_POINTS[k]);
    lock(false);
    if (!r.ok) { if (!r.ended) msg('resErr', r.text, 'bad'); return; }
    calcs[k] = r.state.calc;
    renderTest();
    $('resIn').focus();
  }

  async function testNext() {
    const v = parseOhm($('resIn').value);
    if (!v.ok) { msg('resErr', STR['resErr_' + v.err], 'bad'); return; }
    if (typeof calcs[ti] !== 'number') return;                       // the sensor has not answered for this value
    rows[ti] = rescalTestRow(RESCAL_TEST_POINTS[ti], calcs[ti], v.v, probe);
    renderRows();
    if (ti < RESCAL_TEST_POINTS.length - 1) { await goTest(ti + 1); return; }
    lock(true);
    await maint.rescalCancel();                                      // the output goes back to the fuel level
    lock(false);
    running = false;
    $('resBox').hidden = true;
    $('resDoneMsg').textContent = STR.resTestDone;
    $('bResTestAfter').hidden = true;
    $('resDone').hidden = false;
  }

  async function back() {
    if (working || !running) return;
    if (mode === 'test') { if (ti > 0) await goTest(ti - 1); return; }
    if (i > 0) await goStep(i - 1);
  }
  async function cancel() {
    if (working) return;
    running = false;
    await maint.rescalCancel();
    ctx.nav.go('maint');
  }

  // The button on step 1: read the probes, then test the output instead of calibrating.
  async function testFromProbe() {
    if (working || !running || mode !== 'cal' || steps[i].kind !== 'probe') return;
    if (!(await takeProbe())) return;
    lock(false);
    await startTest();
  }

  // After a save the session has ended: open a new one, tell it the probes again and test.
  async function testAfterSave() {
    const p = probe;
    await begin(p);
  }

  async function begin(testWithProbe) {
    running = true;
    mode = 'cal';
    i = 0; vals = []; probe = null; nom = RESCAL_NOM; rows = []; calcs = [];
    $('resBox').hidden = true;
    $('resDone').hidden = true;
    $('resTbl').hidden = true;
    $('resStart').hidden = false;
    $('bResBackM').hidden = true;
    msg('resFail', '', '');
    const r = await maint.rescalStart();                              // every branch off
    $('resStart').hidden = true;
    if (!running) return;                                             // left the page meanwhile
    if (!r.ok) {
      running = false;
      if (!r.ended) { msg('resFail', t('resFail', { e: r.text }), 'bad'); $('bResBackM').hidden = false; }
      return;
    }
    if (Array.isArray(r.state.nom) && r.state.nom.length === RESCAL_NOM.length) nom = r.state.nom;
    $('resBox').hidden = false;
    if (typeof testWithProbe === 'number') {
      const p = await maint.rescalProbe(testWithProbe);
      if (!p.ok) { running = false; if (!p.ended) { $('resBox').hidden = true; msg('resFail', t('resFail', { e: p.text }), 'bad'); $('bResBackM').hidden = false; } return; }
      probe = testWithProbe;
      await startTest();
      return;
    }
    await goStep(0);
  }

  $('bResNext').addEventListener('click', next);
  $('bResBack').addEventListener('click', back);
  $('bResCancel').addEventListener('click', cancel);
  $('bResTest').addEventListener('click', testFromProbe);
  $('bResTestAfter').addEventListener('click', testAfterSave);
  $('bResDone').addEventListener('click', () => ctx.nav.go('maint'));
  $('resIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
  $('resIn').addEventListener('input', () => msg('resErr', '', ''));

  return {
    // enter() runs on every route; a calibration under way must not restart
    enter() { if (!running && $('resDone').hidden && $('bResBackM').hidden) begin(); },
    leave() {
      if (running) { running = false; maint.rescalCancel(); }       // the output goes back to the fuel level (the sensor also does it when the link ends)
      $('resDone').hidden = true;
      $('resTbl').hidden = true;
      $('bResBackM').hidden = true;
    },
  };
}
