// DOM helpers shared by the screens. Device text only ever goes in through textContent, never innerHTML.
import { STR } from '../core.js';

export const $ = (id) => document.getElementById(id);

// Fill every [data-t] (text) and [data-tp] (placeholder) from STRINGS.
export function applyStrings() {
  for (const el of document.querySelectorAll('[data-t]')) {
    const s = STR[el.getAttribute('data-t')];
    if (s !== undefined) el.textContent = s;
  }
  for (const el of document.querySelectorAll('[data-tp]')) {
    const s = STR[el.getAttribute('data-tp')];
    if (s !== undefined) el.placeholder = s;
  }
  document.documentElement.lang = STR.lang;
  document.title = STR.pageTitle;
}

// A message line: cls is '' | 'bad' | 'ok' | 'warn'; empty text hides it.
export function msg(id, text, cls) {
  const el = $(id);
  el.className = 'msg ' + (cls || '');
  el.textContent = text || '';
  el.hidden = !text;
}

// Disable a button while something runs; `text` replaces its label meanwhile.
export function busy(btn, on, text) {
  if (on) {
    if (btn.getAttribute('data-l') === null) btn.setAttribute('data-l', btn.textContent);
    if (text) btn.textContent = text;
  } else if (btn.getAttribute('data-l') !== null) {
    btn.textContent = btn.getAttribute('data-l');
    btn.removeAttribute('data-l');
  }
  btn.disabled = on;
}

export function rows(dl, list) {
  dl.textContent = '';
  for (const [key, v] of list) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = STR[key];
    dd.textContent = v === undefined || v === null || v === '' ? STR.na : String(v);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
}

// An in-page confirmation (never alert/confirm/prompt): the button opens a box with Yes and No.
export function confirmBox(openBtn, box, yesBtn, noBtn, action) {
  openBtn.addEventListener('click', () => { box.hidden = false; openBtn.hidden = true; });
  const close = () => { box.hidden = true; openBtn.hidden = false; };
  noBtn.addEventListener('click', close);
  yesBtn.addEventListener('click', () => { close(); action(); });
  return close;
}

export function setBar(el, pct) { el.style.width = Math.max(0, Math.min(100, pct)) + '%'; }

// Copy text: the clipboard API (HTTPS), else a hidden textarea, else select the text so the operator can copy it.
export function legacyCopy(txt) {
  const ta = document.createElement('textarea');
  let ok = false;
  ta.value = txt;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, txt.length);
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
export function copyTxt(txt, btn, msgId, selEl) {
  const done = (ok) => {
    if (ok) {
      busy(btn, true, STR.copied);
      setTimeout(() => busy(btn, false), 2000);
      $(msgId).hidden = true;
      return;
    }
    if (selEl) {
      const r = document.createRange(), sel = window.getSelection();
      r.selectNodeContents(selEl);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    $(msgId).textContent = STR.copyHold;
    $(msgId).hidden = false;
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(() => done(true), () => done(legacyCopy(txt)));
  else done(legacyCopy(txt));
}
