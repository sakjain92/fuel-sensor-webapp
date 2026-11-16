// The recording half of the Recording page of debug builds (the live plot is ui/viz.js), and the bar that tells every page a recording
// runs. The data side is recorder.js; this file shows it, takes the readings the person at the tank types, and shares the files.
import { STR, t } from '../core.js';
import { REF_KINDS, RAW_MODES, PART_BYTES } from '../recorder.js';
import { deliverTextFiles } from '../export.js';
import { CapGattLogger } from '../capble.js';
import { $, msg, busy, copyTxt } from './dom.js';

const pad = (n) => String(n).padStart(2, '0');
export const fmtDur = (s) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
const fmtClock = (pt) => { const d = new Date(pt); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fmtDate = (pt) => new Date(pt).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtMb = (b) => (b / 1e6).toFixed(b < 1e6 ? 2 : 1);
export const fmtMoved = (d) => (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1);

// One line of the recording log (entries come from Recorder._note).
export function logView(e) {
  switch (e.kind) {
    case 'started': return { text: STR.recLogStarted };
    case 'ref': {
      const k = REF_KINDS.find((x) => x.id === e.refKind);
      const value = e.value === null || e.value === undefined ? '' : `${e.value} ${e.unit}`;
      const text = e.text ? (value ? ' · ' : '') + e.text : '';
      return { text: t('recLogRef', { kind: k ? STR[k.key] : e.refKind, value, text }), cls: 'ref' };
    }
    case 'link_lost': return { text: STR.recLogLinkLost, cls: 'bad' };
    case 'link_resumed': return { text: STR.recLogResumed };
    case 'restarted': return { text: STR.recLogRestarted, cls: 'bad' };
    case 'state': return { text: t('recLogState', { from: e.from, to: e.to }), cls: e.to === 'confirmed' ? '' : 'bad' };
    case 'full_rate': return { text: t('recLogFull', { why: STR['recWhy_' + e.why] || e.why }) };
    case 'stopped': return { text: t('recLogStopped', { why: STR['recStop_' + e.reason] || e.reason }) };
    case 'app_resumed': return { text: STR.recLogAppResumed };
    case 'resume_retry': return { text: STR.recLogRetry };
    case 'memory_store': return { text: STR.recLogMemoryStore, cls: 'bad' };
    case 'event':                                            // (Recorder.event: the capacitive listener)
      if (e.what === 'cap_state') return e.watching ? { text: t('recLogEv_cap_on', { name: e.name || '?' }) } : { text: STR.recLogEv_cap_off, cls: 'ref' };
      if (e.what === 'cap_start') return { text: t('recLogEv_cap_start', { name: e.name || '?' }) };
      if (e.what === 'cap_stop') return { text: t('recLogEv_cap_stop', { n: e.packets || 0 }) };
      if (e.what === 'cap_restart') return { text: t('recLogEv_cap_restart', { s: e.quiet_s || 0 }), cls: e.ok === false ? 'bad' : '' };
      if (e.what === 'cap_failed') return { text: t('recLogEv_cap_failed', { why: STR['recCapWhy_' + e.code] || e.text || e.code || '?' }), cls: 'bad' };
      return { text: e.what };
    case 'data': {
      const n = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
      return { text: t('recLogData', { mm: n(e.level_mm), l: n(e.litres), pct: n(e.fill_pct), state: e.state || e.status || '–' }), cls: 'data' };
    }
    default: return { text: e.kind };
  }
}

export function initRecord(ctx) {
  const { recorder: rec } = ctx;
  let shown = false, stopArmed = null, startArmed = null, listBusy = false, listAgain = false, lastList = 0;
  const armed = new Map();                                 // delete buttons waiting for their second tap

  // ---- selects
  // The dropdown holds the readings with a value; a free-text note has its own row above (Add a note), so there is one way to add one.
  const READING_KINDS = REF_KINDS.filter((k) => k.value);
  for (const k of READING_KINDS) $('recKind').add(new Option(STR[k.key], k.id));
  for (const m of RAW_MODES) $('recMode').add(new Option(STR['recMode_' + m], m));
  $('recMode').value = 'all';                                 // (user 14 Nov 2026: full-rate radar data always; replays need every frame)
  const kind = () => READING_KINDS.find((k) => k.id === $('recKind').value) || READING_KINDS[0];
  function kindChanged() {
    const k = kind();
    $('recVal').placeholder = k.unit ? `${STR.recValuePh} (${k.unit})` : STR.recValuePh;
    msg('recAddMsg', '', '');
  }
  $('recKind').addEventListener('change', kindChanged);
  kindChanged();

  // ---- the screen wake lock (a long recording needs the screen on, or the browser puts the page to sleep)
  let lock = null;
  async function wake(on) {
    try {
      if (on && !lock && navigator.wakeLock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); }
      else if (!on && lock) { const l = lock; lock = null; await l.release(); }
    } catch (e) { lock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) rec.flushNow(); else if (rec.active) wake(true); });

  // ---- rendering
  function info() {
    const mb = fmtMb(rec.bytes);
    let s = t('recInfo', { t: fmtDur(rec.elapsedS), frames: rec.frames, mb });
    if (rec.lost) s += t('recInfoLost', { n: rec.lost });
    if (rec.rawMode === 'adaptive' && rec.hot) s += STR.recInfoHot;
    if (rec.memoryOnly) s += STR.recInfoMemory;
    return s;
  }
  function renderLog() {
    const ul = $('recLog');
    ul.textContent = '';
    if (!rec.log.length) { const li = document.createElement('li'); li.textContent = STR.recLogEmpty; ul.appendChild(li); return; }
    for (const e of rec.log.slice(-80).reverse()) {
      const v = logView(e);
      const li = document.createElement('li');
      const tm = document.createElement('time');
      tm.textContent = fmtClock(e.pt);
      const sp = document.createElement('span');
      sp.textContent = v.text;
      if (v.cls) sp.className = v.cls;
      li.append(tm, sp);
      ul.appendChild(li);
    }
  }
  // The level has moved and no reading was entered since: ask for one (the recorder decides when, never blocks).
  function renderRemind() {
    const d = rec.wantsRef ? rec.movedSinceRef : null;
    msg('recRemind', d === null ? '' : t(rec.refCount ? 'recRemind' : 'recRemindStart', { mm: fmtMoved(d) }), 'warn');
  }
  function renderError() {
    const e = rec.error;
    if (!e || rec.active) { msg('recErr', '', ''); return; }
    const key = 'recStartErr_' + e.code;
    msg('recErr', STR[key] ? t(key, { e: e.text }) : t('recStartErr', { e: e.text }), 'bad');
  }
  function render() {
    const live = rec.active || rec.state === 'starting';
    $('recSetup').hidden = live;
    $('recLive').hidden = !rec.active;
    $('recWait').hidden = rec.state !== 'waiting';
    if (rec.active) $('recInfo').textContent = info();
    if (!rec.active) { clearTimeout(stopArmed); stopArmed = null; $('bRecStop').textContent = STR.recStop; msg('recStopMsg', '', ''); msg('recNoteMsg', '', ''); }
    renderRemind();
    renderError();
    renderLog();
    renderBar();
    if (shown) refreshList();
  }
  function renderBar() {
    const bv = $('bViz');                                    // the dashboard's Recording button says it runs
    bv.textContent = rec.active ? t('recBtnActive', { t: fmtDur(rec.elapsedS) }) : STR.vizBtn;
    bv.classList.toggle('pri', rec.active);
    $('recKeep').hidden = !rec.active;
    const on = rec.active && !(shown && ctx.app.page === 'pViz');
    $('recBar').hidden = !on;
    if (!on) return;
    const wait = rec.state === 'waiting';
    $('recBar').className = 'banner recbar' + (wait ? ' wait' : '');
    $('recBarText').textContent = wait ? STR.recBarWait : t(rec.wantsRef ? 'recBarRemind' : 'recBarText', { t: fmtDur(rec.elapsedS) });
  }
  rec.on('change', () => { render(); wake(rec.active); });
  rec.on('log', () => { if (shown) renderLog(); });

  // ---- start, stop, readings
  // A recording without notes is asked about once (later nobody can tell what it was), and never refused: the second tap starts it.
  const disarmStart = () => { clearTimeout(startArmed); startArmed = null; $('bRecStart').textContent = STR.recStart; msg('recStartMsg', '', ''); };
  $('recNotes').addEventListener('input', () => { if (startArmed !== null) disarmStart(); });
  $('bRecStart').addEventListener('click', async () => {
    if (!$('recNotes').value.trim() && startArmed === null) {
      msg('recStartMsg', STR.recNoNotes, 'warn');
      $('bRecStart').textContent = STR.recStartNoNotes;
      startArmed = setTimeout(disarmStart, 15000);
      return;
    }
    disarmStart();
    msg('recErr', '', '');
    busy($('bRecStart'), true, STR.recStarting);
    let ok = false;
    try { ok = await rec.start({ notes: $('recNotes').value, rawMode: $('recMode').value }); } finally { busy($('bRecStart'), false); }
    if (ok) {
      wake(true);
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best effort: keeps the browser from clearing the recordings */ }
    } else renderError();
    render();
  });
  $('bRecStop').addEventListener('click', async () => {
    if (stopArmed === null) {                                // two taps: a recording of hours is not ended by a slip of the finger
      const d = rec.wantsRef ? rec.movedSinceRef : null;     // and the first tap says what the recording still lacks (it never refuses)
      const lacks = !rec.refCount ? STR.recStopNoRefs : d !== null ? t('recStopMoved', { mm: fmtMoved(d) }) : '';
      msg('recStopMsg', lacks, 'warn');
      $('bRecStop').textContent = STR.recStopAgain;
      stopArmed = setTimeout(() => { stopArmed = null; $('bRecStop').textContent = STR.recStop; msg('recStopMsg', '', ''); }, lacks ? 15000 : 4000);
      return;
    }
    clearTimeout(stopArmed);
    stopArmed = null;
    msg('recStopMsg', '', '');
    await rec.stop('user');
    wake(false);
    render();
    refreshList();
  });
  function addReading() {
    const k = kind();
    const r = rec.addRef(k.id, $('recVal').value, $('recText').value);
    if (!r.ok) { msg('recAddMsg', STR['recErr_' + r.err] || STR.recErr_kind, 'bad'); return; }
    $('recVal').value = '';
    $('recText').value = '';
    msg('recAddMsg', STR.recAdded, 'ok');
    msg('recStopMsg', '', '');
    renderRemind();
    $('recVal').focus();
  }
  $('bRecAdd').addEventListener('click', addReading);
  for (const id of ['recVal', 'recText']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addReading(); } });
  $('recVal').addEventListener('input', () => msg('recAddMsg', '', ''));
  // A free-text note: the same thing the recorder writes for a reading of kind `note` (a `ref` line), at any time while the recording
  // is active, also while the link is lost and the recording waits.
  function addNote() {
    const r = rec.addRef('note', '', $('recNote').value);
    if (!r.ok) { msg('recNoteMsg', r.err === 'empty' ? STR.recNoteEmpty : STR['recErr_' + r.err] || STR.recErr_kind, 'bad'); return; }
    $('recNote').value = '';
    msg('recNoteMsg', STR.recNoteAdded, 'ok');
    msg('recStopMsg', '', '');
    renderRemind();
    $('recNote').focus();
  }
  $('bRecNote').addEventListener('click', addNote);
  $('recNote').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNote(); } });
  $('recNote').addEventListener('input', () => msg('recNoteMsg', '', ''));

  // ---- the capacitive sensor's Bluetooth broadcast, listened to at the same time (capble.js)
  let cap = null;
  // Every recording says whether the capacitive sensor is in it, and why not: the state at the start (and when a recording is continued),
  // then every start, stop and failed try of the listener while it runs.
  const capState = () => {
    const w = !!(cap && cap.watching);
    return { watching: w, name: w ? cap.name : '', packets: w ? cap.packets : 0, error: cap && cap.error ? cap.error.code : '', bluetooth: !!ctx.adv.supported, can_watch: ctx.adv.canWatch === undefined ? null : ctx.adv.canWatch };
  };
  rec.on('started', () => rec.event('cap_state', capState()));
  // A browser that cannot listen to broadcasts: the steps to switch the setting on (Chrome, Edge), or which browser to use instead.
  const capBrowser = () => {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return { kind: 'ios' };
    return { kind: 'other' };
  };
  function renderCapGuide(show) {
    $('recCapGuide').hidden = !show;
    if (!show) return;
    const b = capBrowser(), flag = b.kind === 'flag';
    $('recCapSteps').hidden = !flag;
    $('recCapGuideNote').hidden = !flag;
    $('recCapGuideHead').textContent = flag ? t('recCapGuideHead', { browser: b.name }) : b.kind === 'ios' ? STR.recCapNoIos : STR.recCapNoChrome;
    $('recCapFlag').textContent = flag ? b.url : '';
  }
  $('bRecCapCopy').addEventListener('click', () => copyTxt($('recCapFlag').textContent, $('bRecCapCopy'), 'recCapCopyMsg', $('recCapFlag')));
  function renderCap() {
    const w = !!(cap && cap.watching);
    $('bRecCap').textContent = w ? STR.recCapStop : STR.recCapBtn;
    $('recCapAll').parentElement.hidden = w;
    $('recCapInfo').hidden = !w;
    const esc = w && cap.escort;
    if (w) $('recCapInfo').textContent = cap.last ? t('recCapInfo', { name: cap.name, n: cap.packets, ago: cap.agoS, rssi: cap.last.rssi === null ? '–' : cap.last.rssi }) + ' · ' + (esc ? t(esc.cnt === null ? 'recCapEscortGa' : 'recCapEscort', { level: esc.level, temp: esc.temp_c === null ? '–' : esc.temp_c, cnt: esc.cnt }) : t('recCapBytes', { hex: cap.hex })) : STR.recCapWait;
    const e = cap && cap.error;
    msg('recCapMsg', e ? (STR['recCapErr_' + e.code] ? t('recCapErr_' + e.code, { e: e.text }) : e.text) : '', e && e.code !== 'cancelled' ? 'bad' : '');
    renderCapGuide(!!(e && e.code === 'unsupported'));
  }
  $('bRecCap').addEventListener('click', async () => {
    if (!cap) { cap = new CapGattLogger({ choose: ctx.adv.choose, open: ctx.adv.open, close: ctx.adv.close, supported: ctx.adv.supported }); cap.on('adv', (line) => rec.writeExternal(line)); cap.on('change', renderCap); cap.on('restart', (r) => rec.event('cap_restart', r)); }
    if (cap.watching) { const was = { name: cap.name, packets: cap.packets }; cap.stop(); rec.event('cap_stop', was); return; }
    const ok = await cap.choose({ all: $('recCapAll').checked });       // (straight from the tap: the browser's chooser needs it)
    if (ok) rec.event('cap_start', { name: cap.name });
    else if (cap.error) rec.event('cap_failed', { code: cap.error.code, text: cap.error.text || '' });
    renderCap();
  });

  // ---- the saved recordings
  async function deliver(files, env = {}) {
    try {
      const how = await deliverTextFiles(files, env);
      msg('recListMsg', how === 'shared' ? STR.recShared : how === 'downloaded' ? STR.recDownloaded : '', 'ok');
    } catch (e) { msg('recListMsg', t('recShareFail', { e: (e && e.message) || 'error' }), 'bad'); }
  }
  const button = (label, onClick, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls; b.textContent = label; b.addEventListener('click', () => onClick(b)); return b; };
  function partsList(r) {
    const d = document.createElement('details');
    const sm = document.createElement('summary');
    sm.textContent = STR.recPartsSummary;
    const ul = document.createElement('ul');
    ul.className = 'log recparts';
    d.append(sm, ul);
    let loaded = false;
    d.addEventListener('toggle', async () => {
      if (!d.open || loaded) return;
      loaded = true;
      const files = await rec.files(r.id);
      files.forEach((f, i) => {
        const li = document.createElement('li');
        const nm = document.createElement('span');
        nm.textContent = t('recPartRow', { name: f.name, mb: fmtMb(f.bytes) });
        const row = document.createElement('div');
        row.className = 'row2';
        row.append(button(STR.recShare, async () => deliver([(await rec.files(r.id))[i]])), button(STR.recDownload, async () => deliver([(await rec.files(r.id))[i]], { downloadOnly: true })));
        li.append(nm, row);
        ul.appendChild(li);
      });
    });
    return d;
  }
  async function refreshList() {
    if (listBusy) { listAgain = true; return; }                // (asked again while drawing: draw once more, the data has changed)
    listBusy = true;
    lastList = Date.now();
    try {
      const recs = await rec.recordings();
      const ul = $('recList');
      ul.textContent = '';
      $('bRecShareAll').hidden = recs.length < 2;
      if (!recs.length) { const li = document.createElement('li'); li.textContent = STR.recListEmpty; ul.appendChild(li); }
      for (const r of recs) {
        const active = rec.rec && rec.rec.id === r.id && rec.active;
        const li = document.createElement('li');
        li.className = 'recrow';
        const parts = Math.max(1, Math.ceil((r.bytes || 0) / PART_BYTES));
        const dur = Math.max(0, Math.round(((r.endedPt || Date.now()) - r.startedPt) / 1000));
        const head = document.createElement('div');
        head.textContent = t('recRow', { date: fmtDate(r.startedPt), dur: fmtDur(dur), mb: fmtMb(r.bytes || 0), files: parts > 1 ? t('recFilesN', { n: parts }) : STR.recFiles1 });
        const sub = document.createElement('small');
        sub.textContent = (STR['recState_' + (active ? 'recording' : r.state)] || r.state) + (r.notes ? ' · ' + r.notes.slice(0, 80) : '');
        li.append(head, sub);
        const row = document.createElement('div');
        row.className = 'row3';
        row.append(button(STR.recShare, async () => deliver(await rec.files(r.id))), button(STR.recDownload, async () => deliver(await rec.files(r.id), { downloadOnly: true })));
        if (!active) {
          const del = button(STR.recDelete, async (b) => {
            if (!armed.has(r.id)) { b.textContent = STR.recDeleteAgain; armed.set(r.id, setTimeout(() => { armed.delete(r.id); b.textContent = STR.recDelete; }, 4000)); return; }
            clearTimeout(armed.get(r.id)); armed.delete(r.id);
            await rec.remove(r.id);
            refreshList();
          });
          row.append(del);
        }
        li.appendChild(row);
        if (!active && ctx.client.connected && (ctx.client.hello || {}).mac === r.mac && !rec.active && rec.state !== 'starting') {
          li.appendChild(button(STR.recContinue, async () => { if (await rec.continueRec(r.id)) wake(true); render(); }, 'pri'));
        }
        if (parts > 1) li.appendChild(partsList(r));
        ul.appendChild(li);
      }
      try {
        const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
        $('recStorage').textContent = est && est.quota ? t('recStorage', { used: Math.round(est.usage / 1e6), free: Math.round((est.quota - est.usage) / 1e6) }) : '';
      } catch (e) { $('recStorage').textContent = ''; }
    } finally { listBusy = false; if (listAgain) { listAgain = false; refreshList(); } }
  }
  $('bRecShareAll').addEventListener('click', async () => {
    const all = [];
    for (const r of await rec.recordings()) all.push(...(await rec.files(r.id)));
    deliver(all);
  });

  return {
    async enter() { shown = true; render(); await rec.recoverInterrupted().catch(() => {}); refreshList(); },
    leave() { shown = false; renderBar(); },
    tick() { if (rec.active) { $('recInfo').textContent = info(); renderRemind(); if (Date.now() - lastList > 15000) refreshList(); } if (cap && cap.watching) renderCap(); },
    barTick() { if (rec.active) renderBar(); },
  };
}
