// "RS-485 registers": the live table of what the Modbus receiver gets, and the long-range radio mode.
import { STR, t } from '../core.js';
import { RegsView } from '../regs.js';
import { $, msg } from './dom.js';

const layoutOf = (rows) => rows.map((r) => r.reg + (r.receiver ? 'r' : '') + (r.cont ? 'c' : '') + (r.unknown ? 'u' : '')).join();

export function initRegs(ctx) {
  const view = new RegsView({ client: ctx.client, clock: ctx.clock });
  const link = ctx.link;
  let builtFor = null;             // the layout the table was built for: sensors of another register map version have other rows
  const cells = new Map();         // reg -> {name, raw, value}

  function build(rows) {
    const body = $('rgBody');
    body.textContent = '';
    cells.clear();
    for (const r of rows) {
      const tr = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td'), c = document.createElement('td');
      const nm = document.createElement('b'), no = document.createElement('small');
      tr.className = (r.cont ? 'cont ' : '') + (r.receiver ? 'rcv' : '');
      b.className = 'raw';
      c.className = 'val';
      a.appendChild(nm); a.appendChild(no);
      tr.appendChild(a); tr.appendChild(b); tr.appendChild(c);
      body.appendChild(tr);
      cells.set(r.reg, { nm, no, raw: b, val: c });
    }
    builtFor = layoutOf(rows);
  }
  function set(el, text) { if (el.textContent !== text) el.textContent = text; }
  function render() {
    const v = view.view();
    if (builtFor !== layoutOf(v.rows)) build(v.rows);
    for (const r of v.rows) {
      const c = cells.get(r.reg);
      if (!c) continue;
      set(c.nm, r.name === null ? '…' : r.name);
      set(c.no, String(r.reg));
      set(c.raw, r.receiver ? '' : r.hex);
      set(c.val, r.value === null ? '' : r.value);
    }
    $('rgLive').textContent = view.statusText();
    $('rgLive').className = 'live' + (v.stale ? ' stale' : '');
    $('rgBox').className = 'card' + (v.stale ? ' stalebox' : '');
    renderLink();
  }
  function renderLink() {
    const v = link.view;
    $('lrState').textContent = v.on ? STR.lrToggleOn : STR.lrToggleOff;
    $('bLr').textContent = v.pending ? STR.lrSwitching : v.on ? STR.lrTurnOff : STR.lrTurnOn;
    $('bLr').disabled = link.switching || v.pending || !v.known;
    $('lrRadio').textContent = (v.phy ? t('lrPhy', { p: v.phyText }) + ' · ' : '') + v.rssiText;
    const cls = v.note === 'unsupported' ? 'warn' : v.note === 'coded' ? 'ok' : '';
    msg('lrNote', v.noteText, cls);
    msg('lrErr', link.error ? t('lrFail', { e: link.error }) : '', 'bad');
  }

  view.on('change', render);
  link.on('change', renderLink);
  $('bLr').addEventListener('click', () => link.setRange(!link.view.on));

  return {
    async enter() { await link.refresh(); render(); await view.enter(); },
    async leave() { await view.leave(); },
    tick: render,
  };
}
