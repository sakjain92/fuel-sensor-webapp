// From signed reports to a file the operator can pass on: CSV -> encrypted container -> armored text in a .csv file (MIME text/csv,
// which Chrome's share sheet accepts, unlike a binary file) -> share sheet or download.
import { CONFIG } from './config.js';
import { buildCsv } from './csv.js';
import { encryptReport, parsePublicKeyB64, reportFileName, armor } from './reportfile.js';
import { utf8 } from './util.js';

export const REPORT_MIME = 'text/csv';

// reports: newest first. Returns {name, bytes (the UTF-8 of the armored text), text, mime, csv, container, isTestKey}.
export async function makeReportFile(reports, { mac = '', siteId = '', config = CONFIG, nowMs = Date.now(), tzOffsetMin = new Date().getTimezoneOffset(), crypto } = {}) {
  const csv = buildCsv(reports);
  const container = await encryptReport(csv, parsePublicKeyB64(config.itPublicKeyB64), crypto ? { crypto } : undefined);
  const text = armor(container);
  const name = reportFileName({ reports, siteId, mac, nowUnix: Math.floor(nowMs / 1000), nowTzMin: -tzOffsetMin });
  return { name, bytes: utf8(text), text, mime: REPORT_MIME, csv, container, isTestKey: !!config.itKeyIsTest };
}

// A normal download through a temporary link.
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Share sheet when the browser can share this file (call it straight from the tap), else a normal download.
// Resolves 'shared' | 'cancelled' | 'downloaded'. env.navigator and env.download are replaceable for tests.
export async function deliverFile(file, env = {}) {
  const nav = env.navigator === undefined ? globalThis.navigator : env.navigator;
  const blob = new Blob([file.bytes], { type: file.mime });
  if (nav && typeof nav.canShare === 'function' && typeof nav.share === 'function' && typeof File === 'function') {
    const f = new File([blob], file.name, { type: file.mime });
    let can = false;
    try { can = !!nav.canShare({ files: [f] }); } catch (e) { can = false; }
    if (can) {
      try { await nav.share({ files: [f], title: file.name }); return 'shared'; } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';      // the operator closed the share sheet
        // anything else (not allowed, not supported for this file type): fall back to a download
      }
    }
  }
  (env.download || downloadBlob)(blob, file.name);
  return 'downloaded';
}
