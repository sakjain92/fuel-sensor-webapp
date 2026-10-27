// The Connect screen: one big button (Web Bluetooth needs a tap), progress, plain-language errors.
import { STR, errText } from '../core.js';
import { $ } from './dom.js';

// Failures where the sensor may simply be out of reach, taken by another phone, off, or hidden by a missing Android permission.
const HELP_KEYS = ['ce_cancelled', 'ce_notfound', 'ce_failed'];

export function initConnect(ctx) {
  const { client } = ctx;
  let working = false;
  let cancelled = false;

  function setStep(step) {
    const s = { choosing: STR.cn_choosing, connecting: STR.cn_connecting, starting: STR.cn_starting }[step] || '';
    $('cnStatus').textContent = s;
  }
  function setBusy(on) {
    working = on;
    $('bConnect').hidden = on;
    $('cnBusy').hidden = !on;
    if (on) { $('cnErr').hidden = true; $('cnFail').hidden = true; }
  }
  function showError(e) {
    const key = e && e.key;
    $('cnErr').textContent = key && STR[key] ? STR[key] : errText(e);
    $('cnErr').hidden = false;
    $('cnFail').hidden = HELP_KEYS.indexOf(key) < 0;
    $('bConnect').textContent = STR.cn_again;
  }
  async function connect() {
    if (working) return;
    cancelled = false;
    setBusy(true);
    setStep('choosing');
    try {
      await client.connect({ pick: true, onStep: setStep });
      await ctx.onConnected();
    } catch (e) {
      if (!cancelled) showError(e);
    } finally {
      setBusy(false);
    }
  }
  $('bConnect').addEventListener('click', connect);
  $('bConnectCancel').addEventListener('click', () => { cancelled = true; client.disconnect(); });
  $('bWaitConnect').addEventListener('click', () => ctx.leaveWait(true));

  return {
    enter() {
      const sid = ctx.sensor;
      $('cnIdBox').hidden = !sid;
      if (sid) $('cnId').textContent = sid.mac;
      $('cnHelp').textContent = sid ? STR.cn_help : STR.cn_helpAny;
      $('cnDemo').hidden = ctx.mode !== 'demo';
    },
    leave() {},
  };
}
