// The maintenance login: the code for IT, the pasted reply, the lock-out countdown (PROTOCOL.md section 5).
import { STR, t, fin, codeGroups, respCheck, fmtWait } from '../core.js';
import { $, msg, busy, confirmBox, legacyCopy } from './dom.js';

export function initLogin(ctx) {
  const { maint } = ctx;
  let chal = '';
  let lockUntil = 0;
  let warnFor = null;
  let entryMsg = '';

  function renderCode(c) {
    const el = $('code');
    el.textContent = '';
    el.className = c ? 'code' : 'code wait';
    if (!c) el.textContent = c === '' ? STR.codeFail : STR.codeWait;
    else {
      for (const g of codeGroups(c)) {
        const s = document.createElement('span');
        s.textContent = g;
        el.appendChild(s);
      }
    }
    $('bCopy').disabled = $('bShare').disabled = !c;
    $('bRetry').hidden = c !== '';
  }
  async function loadChallenge(isNew) {
    const prev = chal;
    chal = '';
    $('codeNote').hidden = true;
    renderCode(null);
    try {
      const r = await maint.getChallenge({ isNew });
      chal = r.challenge;
      renderCode(chal);
      setLock(r.lockoutS);
      // A new code is made at most once per 10 minutes: the sensor then returns the current code, and IT's reply for it still works.
      if (isNew && prev && chal === prev && r.newWaitS > 0) {
        $('codeNote').textContent = t('newSame', { t: fmtWait(r.newWaitS) });
        $('codeNote').hidden = false;
      }
    } catch (e) { renderCode(''); }
  }
  function setLock(s) { lockUntil = fin(s) && s > 0 ? ctx.clock.now() + s * 1000 : 0; tick(); }
  function tick() {
    const left = (lockUntil - ctx.clock.now()) / 1000;
    $('lock').hidden = left <= 0;
    if (left > 0) $('lock').textContent = t('lockWait', { t: fmtWait(left) });
    if ($('bUnlock').getAttribute('data-l') === null) $('bUnlock').disabled = left > 0;
  }
  function respInput() {
    const raw = $('resp').value, c = respCheck(raw);
    $('respInfo').textContent = !raw.trim() ? '' : c.ok ? STR.respFull : t('respCount', { n: c.n });
  }
  function copyCode() {
    const done = (ok) => {
      if (ok) {
        busy($('bCopy'), true, STR.copied);
        setTimeout(() => busy($('bCopy'), false), 2000);
        $('copyMsg').hidden = true;
      } else {
        const r = document.createRange(), sel = window.getSelection();
        r.selectNodeContents($('code'));
        sel.removeAllRanges();
        sel.addRange(r);
        $('copyMsg').textContent = STR.copyHold;
        $('copyMsg').hidden = false;
      }
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(chal).then(() => done(true), () => done(legacyCopy(chal)));
    else done(legacyCopy(chal));
  }
  function shareCode() {
    const text = t('shareText', { m: mac(), c: chal }), enc = encodeURIComponent;
    if (navigator.share) { navigator.share({ title: STR.shareSubj, text }).catch(() => {}); return; }
    $('shWa').href = 'whatsapp://send?text=' + enc(text);
    $('shSms').href = 'sms:?&body=' + enc(text);
    $('shMail').href = 'mailto:?subject=' + enc(STR.shareSubj) + '&body=' + enc(text);
    $('shareAlt').hidden = !$('shareAlt').hidden;
  }
  const mac = () => (ctx.client.hello && ctx.client.hello.mac) || (ctx.sensor && ctx.sensor.mac) || '?';

  async function unlock() {
    const raw = $('resp').value, c = respCheck(raw);
    $('lgErr').hidden = true;
    if (!raw.trim()) { msg('lgErr', STR.respEmpty, 'bad'); return; }
    if (!c.ok && warnFor !== raw) {                   // a first press only warns; pressing again sends it anyway
      warnFor = raw;
      msg('lgErr', c.bad ? STR.respBad : t('respShort', { n: c.n }), 'warn');
      return;
    }
    warnFor = null;
    busy($('bUnlock'), true, STR.checking);
    const r = await maint.login(raw);
    busy($('bUnlock'), false);
    if (r.ok && r.kind === 'service') {               // a service approval opens nothing here
      await maint.logout();
      msg('lgErr', STR.lg_service, 'bad');
    } else if (r.ok) {
      $('resp').value = '';
      respInput();
      await ctx.maintLoggedIn();
      return;
    } else {
      if (r.lockS) setLock(r.lockS);
      msg('lgErr', STR[r.key] || r.text || STR.errNet, 'bad');
    }
    tick();
  }

  $('resp').addEventListener('input', respInput);
  $('bCopy').addEventListener('click', copyCode);
  $('bShare').addEventListener('click', shareCode);
  $('bRetry').addEventListener('click', () => loadChallenge(false));
  $('bUnlock').addEventListener('click', unlock);
  confirmBox($('bNew'), $('newConf'), $('bNewYes'), $('bNewNo'), () => {
    $('lgErr').hidden = true;
    $('resp').value = '';
    respInput();
    loadChallenge(true);
  });

  return {
    enter() {
      msg('lgMsg', entryMsg, 'bad');
      entryMsg = '';
      $('lgErr').hidden = true;
      $('shareAlt').hidden = true;
      $('copyMsg').hidden = true;
      $('lgId').textContent = t('sensorId', { m: mac() });
      const demo = ctx.mode === 'demo';
      $('demoReply').hidden = !demo;
      if (demo) $('demoReply').textContent = t('demoReply', { c: String(ctx.demoCode || '').match(/.{4}/g).join('-') });
      respInput();
      loadChallenge(false);
    },
    leave() {},
    tick,
    setMessage(text) { entryMsg = text; },
  };
}
