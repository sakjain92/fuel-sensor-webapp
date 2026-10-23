// MRM fuel sensor phone app: start-up, connection, routing between the screens.
// Everything the screens need hangs off `ctx`; the screens never touch Web Bluetooth (they talk to ctx.client).
import { STR, t, parseQuery, browserSupport } from './core.js';
import { JsonLinesClient, WebBluetoothTransport } from './ble.js';
import { Maintenance } from './maint.js';
import { FillFlow } from './fill.js';
import { LinkControl } from './link.js';
import { browserGeo } from './geo.js';
import { makeStorage } from './storage.js';
import { realClock, Emitter } from './util.js';
import { $, applyStrings, busy } from './ui/dom.js';
import { initConnect } from './ui/connect.js';
import { initHome } from './ui/home.js';
import { initFill } from './ui/fill.js';
import { initLogin } from './ui/login.js';
import { initMaint } from './ui/maint.js';
import { initFw } from './ui/fw.js';
import { initRegs } from './ui/regs.js';
import { initLogs } from './ui/logs.js';
import { initWait } from './ui/wait.js';

const PAGES = ['pUnsupported', 'pConnect', 'pHome', 'pLogin', 'pMaint', 'pFw', 'pRegs', 'pLogs', 'pWait'];

async function main() {
  applyStrings();
  registerServiceWorker();
  const q = parseQuery(location.search);
  const noop = { enter() {}, leave() {} };
  const screens = { pUnsupported: noop };
  const app = { page: '', status: null, statusAt: 0, link: null, lost: false, everConnected: false, reconnecting: false, wait: null, lockNav: false };

  function showPage(id) {
    if (app.page !== id) {
      const prev = screens[app.page];
      if (prev && prev.leave) prev.leave();
      window.scrollTo(0, 0);
    }
    app.page = id;
    for (const p of PAGES) $(p).hidden = p !== id;
    const s = screens[id];
    if (s && s.enter) s.enter();
  }

  const support = browserSupport({ navigator, isSecureContext: window.isSecureContext });
  if (!support.ok && !q.demo) {
    if (q.sensor) { $('unsId').textContent = t('unsupportedId', { id: q.sensor.mac }); $('unsId').hidden = false; }
    showPage('pUnsupported');
    return;
  }

  let demoKit = null, transport;
  if (q.demo) {
    const mod = await import('./fake_sensor.js');
    demoKit = mod.createDemo({ fast: q.demo === 'fast', mac: q.sensor ? q.sensor.mac : undefined, variant: q.debug ? 'debug' : 'production', rtc: q.rtc });
    window.__demo = demoKit;                       // demo mode only: lets the browser test look at the simulated sensor
    transport = demoKit.transport;
    $('demoTag').hidden = false;
  } else {
    transport = new WebBluetoothTransport({ bluetooth: navigator.bluetooth, sensorName: q.sensor ? q.sensor.name : null });
  }
  const clock = realClock;
  const bus = new Emitter();
  const client = new JsonLinesClient(transport, { clock });
  const maint = new Maintenance({ client, clock });
  const geo = browserGeo();
  const fill = new FillFlow({ client, geo, storage: makeStorage(), clock, mac: q.sensor ? q.sensor.mac : '' });
  const link = new LinkControl({ client, clock });

  // ---- navigation
  const nav = {
    go(h) {
      if (h === location.hash.replace(/^#/, '')) route(); else location.hash = h;
    },
  };
  function route() {
    if (app.wait) { showPage('pWait'); return; }
    if (!client.connected && !app.lost) { showPage('pConnect'); return; }
    const h = location.hash.replace(/^#/, '');
    if (app.lockNav && h !== 'fw') { location.hash = 'fw'; return; }
    if (h === 'maint') showPage(maint.active ? 'pMaint' : 'pLogin');
    else if (h === 'fw') {
      if ((maint.active && maint.grant.firmware) || screens.pFw.holdsResult) showPage('pFw'); else nav.go('maint');
    } else if (h === 'regs') showPage('pRegs');
    else if (h === 'logs' && ctx.variant === 'debug') showPage('pLogs');
    else showPage('pHome');
  }

  // ---- connection
  async function onConnected() {
    app.everConnected = true;
    app.lost = false;
    ctx.variant = (client.hello && client.hello.variant) || '';
    if (client.hello && client.hello.mac) fill.forSensor(client.hello.mac);
    $('lostBar').hidden = true;
    try { await client.subscribe(['status', 'link']); } catch (e) { /* the status event follows, or the link is down again */ }
    fill.start();                                  // the first fill_state reply brings the newest report (`last`) for the card
    link.refresh();
    bus.emit('connected');
    route();
  }
  async function reconnect() {
    if (app.reconnecting) return;
    app.reconnecting = true;
    busy($('bReconnect'), true, STR.bt_reconnecting);
    $('lostMsg').hidden = true;
    try {
      await client.connect();
      await onConnected();
    } catch (e) {
      $('lostMsg').textContent = (e && e.key && STR[e.key]) || STR.bt_reconnectFail;
      $('lostMsg').hidden = false;
    } finally {
      app.reconnecting = false;
      busy($('bReconnect'), false);
    }
  }
  function disconnect() {
    fill.dispose();
    client.disconnect();
    app.everConnected = false;
    app.lost = false;
    app.status = null;
    $('lostBar').hidden = true;
    maint.endSession('user');
    if (location.hash) location.hash = ''; else route();
  }
  client.on('status', (st) => { app.status = st; app.statusAt = clock.now(); bus.emit('status', st); });
  client.on('link', (l) => { app.link = l; });
  client.on('connected', () => { app.link = client.link; });
  client.on('disconnected', (e) => {
    if (e.byUser || e.expected || app.wait || !e.wasConnected) return;
    app.lost = true;
    $('lostMsg').hidden = true;
    $('lostBar').hidden = false;
    bus.emit('lost');
    route();
  });
  maint.on('login', () => bus.emit('maint'));
  maint.on('ended', (reason) => {
    bus.emit('maint');
    if (reason === 'device') screens.pLogin.setMessage(STR.sessEnded);
    if (app.page === 'pMaint' || app.page === 'pFw') route();
  });

  // ---- the context the screens use
  const ctx = {
    $, client, app, bus, clock, maint, fill, link, geo, nav, mode: q.demo ? 'demo' : 'ble', sensor: q.sensor,
    demoCode: demoKit ? demoKit.loginCode : '', variant: '',
    pace: q.demo === 'fast' ? { firstTryMs: 1500, retryMs: 500, dropWaitMs: 8000, giveUpMs: 6500 } : { firstTryMs: 5000, retryMs: 3000 },
    onConnected,
    disconnect,
    async maintLoggedIn() { await maint.loadState(); route(); },
    async finishMaint() { await maint.logout(); nav.go(''); },
    startWait(kind, o = {}) {
      app.wait = { kind, ...o };
      app.lost = false;
      $('lostBar').hidden = true;
      route();
      screens.pWait.run(app.wait);
    },
    leaveWait(toConnect) {
      screens.pWait.cancel();
      app.wait = null;
      if (toConnect) { app.everConnected = false; client.disconnect(); }
      if (location.hash) location.hash = ''; else route();
    },
  };

  screens.pConnect = initConnect(ctx);
  screens.pHome = initHome(ctx);
  const fillUi = initFill(ctx);
  screens.pLogin = initLogin(ctx);
  screens.pMaint = initMaint(ctx);
  screens.pFw = initFw(ctx);
  screens.pRegs = initRegs(ctx);
  screens.pLogs = initLogs(ctx);
  screens.pWait = initWait(ctx);

  // ---- wiring
  for (const el of document.querySelectorAll('[data-go]')) el.addEventListener('click', () => nav.go(el.getAttribute('data-go')));
  $('bReconnect').addEventListener('click', reconnect);
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && app.lost && !app.reconnecting) reconnect(); });
  window.addEventListener('pagehide', () => { try { client.disconnect(); } catch (e) { /* closing anyway */ } });
  window.addEventListener('pageshow', (e) => { if (e.persisted) { app.everConnected = false; app.status = null; route(); } });   // back from the page cache: the link is gone
  setInterval(() => {
    const s = screens[app.page];
    if (s && s.tick) s.tick();
    if (app.page === 'pHome') fillUi.tick();
  }, 1000);

  route();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  const reg = () => navigator.serviceWorker.register('./sw.js').catch(() => { /* works without it, just not offline */ });
  if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg);
}

main();
