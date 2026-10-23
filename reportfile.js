// The encrypted report file. The format is defined in ENCRYPTED_FILE.md; keep the two in step.
//
// The container (binary, unchanged since the first version):
//   "MRMR" | 0x01 | key id (4) | ephemeral public key (65) | IV (12) | AES-256-GCM(CSV in UTF-8) + 16-byte tag
//   key  = HKDF-SHA256(ECDH(ephemeral private, IT public), salt = empty, info = "MRM-FUEL-REPORT-1")
//   AAD  = everything before the IV (magic .. ephemeral key)
// The file the operator shares is that container as armored text, so that a phone's share sheet takes it as a text/CSV file:
//   -----BEGIN MRM FUEL REPORT-----
//   <Base64 of the container, 64 characters per line>
//   -----END MRM FUEL REPORT-----
//
// WebCrypto only: no library, no network.
import { utf8, concatBytes, base64Encode, base64Decode } from './util.js';

export const MAGIC = 'MRMR';
export const VERSION = 1;
export const HKDF_INFO = 'MRM-FUEL-REPORT-1';
export const HEADER_LEN = 4 + 1 + 4 + 65;       // magic, version, key id, ephemeral public key
export const IV_LEN = 12;
export const TAG_LEN = 16;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export class ReportFileError extends Error {
  constructor(code, msg) { super(msg || code); this.name = 'ReportFileError'; this.code = code; }
}

// config.js holds the key as Base64 of the raw 65-byte uncompressed point (0x04 | X | Y).
export function parsePublicKeyB64(b64) {
  let raw;
  try { raw = base64Decode(String(b64 || '').trim()); } catch (e) { throw new ReportFileError('bad_key', 'IT public key is not Base64'); }
  if (raw.length !== 65 || raw[0] !== 4) throw new ReportFileError('bad_key', 'IT public key must be a 65-byte uncompressed P-256 point');
  return raw;
}

export async function keyIdOf(rawPublic, crypto = globalThis.crypto) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublic)).slice(0, 4);
}

// csvText -> file bytes. itPublicRaw: Uint8Array(65).
export async function encryptReport(csvText, itPublicRaw, { crypto = globalThis.crypto } = {}) {
  const subtle = crypto.subtle;
  let itKey;
  try { itKey = await subtle.importKey('raw', itPublicRaw, ECDH, false, []); } catch (e) { throw new ReportFileError('bad_key', 'IT public key is not a valid P-256 point'); }
  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephPublic = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const secret = await subtle.deriveBits({ name: 'ECDH', public: itKey }, eph.privateKey, 256);
  const hkdfKey = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const keyBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(HKDF_INFO) }, hkdfKey, 256);
  const aes = await subtle.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const header = concatBytes(utf8(MAGIC), Uint8Array.of(VERSION), await keyIdOf(itPublicRaw, crypto), ephPublic);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, aes, utf8(csvText)));
  return concatBytes(header, iv, ct);
}

// ---- armored text
export const ARMOR_LABEL = 'MRM FUEL REPORT';
export const ARMOR_BEGIN = '-----BEGIN ' + ARMOR_LABEL + '-----';
export const ARMOR_END = '-----END ' + ARMOR_LABEL + '-----';
export const ARMOR_LINE = 64;

export class ArmorError extends Error {
  // code: no_begin | label | no_end | empty | base64
  constructor(code, msg) { super(msg || code); this.name = 'ArmorError'; this.code = code; }
}

// container bytes -> the text of the shared file: BEGIN line, Base64 in lines of 64, END line, "\n" line ends, one at the very end.
export function armor(container) {
  const b64 = base64Encode(container);
  const lines = [];
  for (let i = 0; i < b64.length; i += ARMOR_LINE) lines.push(b64.slice(i, i + ARMOR_LINE));
  return ARMOR_BEGIN + '\n' + lines.join('\n') + (lines.length ? '\n' : '') + ARMOR_END + '\n';
}

// White space of every kind, and the invisible characters chat apps and word processors leave in text.
const INVISIBLE = /[\s\u00ad\u200b-\u200f\u2060\ufeff]+/g;
const MARKER = (word) => new RegExp('-{3,}[ \\t\\u00a0]*' + word + '[ \\t\\u00a0]+([^\\n]*?)[ \\t\\u00a0]*-{3,}', 'gi');
const labelOf = (m) => m[1].replace(INVISIBLE, ' ').trim().toUpperCase();

// Text (the file's content, or text pasted from a chat) -> the container bytes. Tolerates CRLF, a missing final newline, blank
// lines, other line widths, spaces and invisible characters inside the Base64, and any text before the BEGIN line or after the
// END line (a chat message around it). Refuses a BEGIN or END line with another label, a missing END, and anything that is not Base64.
export function dearmor(text) {
  const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const begins = [...t.matchAll(MARKER('BEGIN'))];
  if (!begins.length) throw new ArmorError('no_begin', 'no "' + ARMOR_BEGIN + '" line');
  const begin = begins.find((m) => labelOf(m) === ARMOR_LABEL);
  if (!begin) throw new ArmorError('label', 'the BEGIN line says "' + begins[0][1].trim() + '", not "' + ARMOR_LABEL + '"');
  const after = t.slice(begin.index + begin[0].length);
  const end = MARKER('END').exec(after);
  if (!end) throw new ArmorError('no_end', 'no "' + ARMOR_END + '" line');
  if (labelOf(end) !== ARMOR_LABEL) throw new ArmorError('label', 'the END line says "' + end[1].trim() + '", not "' + ARMOR_LABEL + '"');
  const body = after.slice(0, end.index).replace(INVISIBLE, '');
  if (!body) throw new ArmorError('empty', 'nothing between the BEGIN and END lines');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 === 1 || (body.includes('=') && body.length % 4 !== 0)) throw new ArmorError('base64', 'the text between the lines is not Base64');
  return base64Decode(body);
}

// ---- file name: fuel-report_<site id or MAC>_<serial>_<yyyymmdd-hhmm>.csv  (text/csv, so share sheets accept it)
export function safeNamePart(s) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
}
// whenUnix: the report's time (seconds); tzMin: minutes east of UTC at that time. Falls back to now when the time is unknown.
export function stamp(whenUnix, tzMin) {
  const d = new Date((whenUnix + tzMin * 60) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes());
}
// reports: newest first. One report: its serial; several: "<oldest>-<newest>".
export function reportFileName({ reports, siteId, mac, nowUnix, nowTzMin }) {
  const newest = reports[0] || {};
  const oldest = reports[reports.length - 1] || {};
  const id = safeNamePart(siteId || newest.site_id) || safeNamePart(mac) || 'sensor';
  const serial = reports.length > 1 ? oldest.serial + '-' + newest.serial : String(newest.serial);
  const t = newest.phone_end > 0 ? newest.phone_end : newest.phone_start > 0 ? newest.phone_start : nowUnix;
  const tz = Number.isFinite(newest.tz_min) && (newest.phone_end > 0 || newest.phone_start > 0) ? newest.tz_min : nowTzMin || 0;
  return 'fuel-report_' + id + '_' + serial + '_' + stamp(t, tz) + '.csv';
}
