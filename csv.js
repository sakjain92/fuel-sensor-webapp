// Fill reports as CSV for customer IT (PROTOCOL.md section 6.3): exactly 26 columns, one row per report, newest first.
// The signed FR- code is the truth; the other columns are a convenience copy of the same report.

export const CSV_COLUMNS = [
  'serial', 'since_reset', 'operator_l', 'sensor_l', 'drained_l', 'level_before_mm', 'level_after_mm', 'lpmm',
  'phone_start', 'phone_end', 'tz_min', 'duration_s', 'lookback_s', 'gen', 'settings_changes', 'flags',
  'site_id', 'site_lat', 'site_lon', 'op_lat', 'op_lon', 'moved_m', 'dev_utc_start', 'dev_utc_end', 'line', 'signed_code',
];
// A fixed number of decimals per column, written from the parsed number with toFixed (not copied from the JSON text), so
// trailing zeros survive. Every column not listed here is an integer (0 decimals), also dev_utc_start and dev_utc_end (the sensor's
// own clock, unix seconds UTC; an empty cell when the sensor's clock was not set).
export const DECIMALS = {
  operator_l: 2, sensor_l: 2, drained_l: 2, level_before_mm: 2, level_after_mm: 2, lpmm: 6,
  site_lat: 6, site_lon: 6, op_lat: 6, op_lon: 6,
};
// A non-null text cell is always double-quoted (a quote inside is doubled), so "" is an empty site ID and a null one is empty.
const TEXT = new Set(['site_id', 'line', 'signed_code']);
const SOURCE = { signed_code: 'code' };      // the CSV calls the report's `code` field signed_code

export function csvQuote(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

// A spreadsheet runs a cell that starts with = + - @ (or a tab or a carriage return) as a formula. Valid data never does: the
// Site ID must start with a letter or a digit, the line with "Fill report", the code with "FR-". Should a text ever arrive that
// would, a leading apostrophe makes it plain text, so the writer never emits such a cell.
export function formulaSafe(text) {
  const s = String(text);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// toFixed without a minus sign on a zero ("-0.00" -> "0.00"); '' for anything that is not a finite number
export function fixed(v, decimals) {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) >= 1e21) return '';
  const s = v.toFixed(decimals);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

export function cell(report, col) {
  const v = report ? report[SOURCE[col] || col] : undefined;
  if (v === null || v === undefined) return '';
  if (TEXT.has(col)) return csvQuote(formulaSafe(v));
  return fixed(v, DECIMALS[col] === undefined ? 0 : DECIMALS[col]);
}

export function reportRow(report) { return CSV_COLUMNS.map((c) => cell(report, c)).join(','); }

// reports: array of report objects, newest first (as fill_log returns them, or one report from fill_confirm / fill_state `last`). Lines end with CRLF, also the last one.
export function buildCsv(reports) {
  return [CSV_COLUMNS.join(','), ...(reports || []).map(reportRow)].map((l) => l + '\r\n').join('');
}
