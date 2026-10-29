// The resistive output calibration page (behind the maintenance login, settings grant). A proof of concept: the operator types the readings of
// the multimeter; production does this once over the USB-UART tool. One reading per step, with exactly that branch switched on: branch 14,
// branch 13, both together (the wiring is found from these three and taken off by the sensor), then branches 12 to 1; the last step saves.
import { STR, t, parseOhm, rescalSteps, rescalLimits, rescalPairWindow, fmtOhm, fmtReading, fmtPlain, RESCAL_NOM, RESCAL_REF_A, RESCAL_REF_B } from '../core.js';
import { $, msg, setBar } from './dom.js';

export function initRescal(ctx) {
  const { maint } = ctx;
  const steps = rescalSteps();
  let nom = RESCAL_NOM, i = 0, vals = [], nums = [], wire = null;
  let running = false, working = false;

  function lock(on) {
    working = on;
    for (const id of ['resIn', 'bResNext', 'bResCancel']) $(id).disabled = on;
    $('bResBack').disabled = on || i === 0;
  }

  function render() {
    const st = steps[i], last = i === steps.length - 1;
    setBar($('resBar'), (100 * i) / steps.length);
    $('resStepN').textContent = t('resStep', { i: i + 1, t: steps.length });
    if (st.kind === 'pair') {
      $('resWhat').textContent = t('resPair', { a: RESCAL_REF_B, b: RESCAL_REF_A });
      const w = nums[0] > 0 && nums[1] > 0 ? rescalPairWindow(nums[0], nums[1], nom) : null;      // what the two readings before it allow
      $('resNom').textContent = w ? t('resExpectRange', { lo: fmtPlain(w.lo), hi: fmtPlain(w.hi) })
        : t('resNom', { v: fmtOhm(1 / (1 / nom[RESCAL_REF_A - 1] + 1 / nom[RESCAL_REF_B - 1])) });
    } else {
      $('resWhat').textContent = t('resBranch', { n: st.n });
      $('resNom').textContent = wire === null ? t('resNom', { v: fmtOhm(nom[st.n - 1]) }) : t('resExpect', { v: fmtReading(nom[st.n - 1] + wire) });
    }
    $('resWire').hidden = wire === null;
    if (wire !== null) $('resWire').textContent = t('resWire', { v: fmtReading(wire) });
    $('resIn').value = vals[i] || '';
    $('bResNext').textContent = last ? STR.resSave : STR.resNext;
    $('bResBack').disabled = i === 0;
    msg('resErr', '', '');
  }

  // Switch the step's branch on (the others off) and wait for the sensor before the operator reads the meter.
  async function goStep(k) {
    i = k;
    render();
    lock(true);
    const st = steps[i];
    const r = st.kind === 'pair' ? await maint.rescalPairOn() : await maint.rescalOn(st.n);
    lock(false);
    if (!r.ok) { if (!r.ended) msg('resErr', r.text, 'bad'); return; }
    $('resIn').focus();
  }

  async function next() {
    if (working || !running) return;
    const st = steps[i], v = parseOhm($('resIn').value);
    if (!v.ok) { msg('resErr', STR['resErr_' + v.err], 'bad'); return; }
    if (st.kind === 'one') {                                         // the sensor checks too; this saves a round trip for a typo
      const lim = rescalLimits(st.n, wire, nom);
      if (v.v < lim.lo || v.v > lim.hi) { msg('resErr', t('resErr_range', { lo: fmtPlain(lim.lo), hi: fmtPlain(lim.hi) }), 'bad'); return; }
    }
    lock(true);
    const r = st.kind === 'pair' ? await maint.rescalPairSet(v.v) : await maint.rescalSet(st.n, v.v);
    if (!r.ok) { lock(false); if (!r.ended) msg('resErr', r.text, 'bad'); return; }
    vals[i] = $('resIn').value.trim();
    nums[i] = v.v;
    wire = typeof r.state.wire === 'number' ? r.state.wire : null;
    if (i < steps.length - 1) { lock(false); await goStep(i + 1); return; }
    const s = await maint.rescalSave();                              // the last reading: all of them go to the device memory
    if (!s.ok) { lock(false); if (!s.ended) msg('resErr', s.text, 'bad'); return; }
    running = false;
    $('resBox').hidden = true;
    $('resDone').hidden = false;
  }

  async function back() { if (!working && running && i > 0) await goStep(i - 1); }
  async function cancel() {
    if (working) return;
    running = false;
    await maint.rescalCancel();
    ctx.nav.go('maint');
  }

  async function begin() {
    running = true;
    i = 0; vals = []; nums = []; wire = null; nom = RESCAL_NOM;
    $('resBox').hidden = true;
    $('resDone').hidden = true;
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
    await goStep(0);
  }

  $('bResNext').addEventListener('click', next);
  $('bResBack').addEventListener('click', back);
  $('bResCancel').addEventListener('click', cancel);
  $('bResDone').addEventListener('click', () => ctx.nav.go('maint'));
  $('resIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
  $('resIn').addEventListener('input', () => msg('resErr', '', ''));

  return {
    // enter() runs on every route; a calibration under way must not restart
    enter() { if (!running && $('resDone').hidden && $('bResBackM').hidden) begin(); },
    leave() {
      if (running) { running = false; maint.rescalCancel(); }       // the output goes back to the fuel level (the sensor also does it when the link ends)
      $('resDone').hidden = true;
      $('bResBackM').hidden = true;
    },
  };
}
