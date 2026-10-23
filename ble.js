// Bluetooth LE transport and the JSON-lines protocol client (PROTOCOL.md section 3).
//
//   UI  ->  JsonLinesClient  ->  Transport  ->  Web Bluetooth (WebBluetoothTransport) or a fake sensor (fake_sensor.js)
//
// A Transport is any object with:
//   pick()            optional: let the user choose the device (needs a user tap); resolves {name}
//   connect()         connect, enable notifications on TX; resolves when the sensor can be written to
//   write(bytes, {noResponse})   one GATT write (at most writeSize bytes); resolves when it was handed to the radio
//   disconnect()      close the link on purpose
//   maxWrite          number or null: the browser's maxWriteWithoutResponseSize when it has one
//   onData(bytes)     set by the client: one notification piece
//   onClose(reason)   set by the client: the link went away
import { Emitter, realClock, utf8, utf8Decode, concatBytes } from './util.js';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
export const MAX_LINE = 2048;       // bytes per line, newline included, both directions (PROTOCOL.md 3.2)
export const MIN_WRITE = 20;        // ATT MTU 23 minus 3
export const MAX_WRITE = 512;       // the largest value Web Bluetooth writes at once
export const PROTO = 1;
// Feature level of this app (PROTOCOL.md 12 `hello.min_app`): a sensor that needs a higher level refuses this app. Raise it only when
// the app gains behaviour that a newer firmware may depend on.
export const APP_LEVEL = 1;
// Must this app stop because the sensor asks for a newer one? (`min_app` missing or not a number: no.)
export function needsNewerApp(hello) {
  return !!hello && typeof hello.min_app === 'number' && hello.min_app > APP_LEVEL;
}

// ---------------------------------------------------------------- errors
export class ProtocolError extends Error {
  constructor(code, msg, reply) {
    super(msg || code || 'error');
    this.name = 'ProtocolError';
    this.code = code || 'error';
    this.msg = msg || '';
    this.reply = reply || null;
  }
}
export class TimeoutError extends Error {
  constructor(cmd) { super('No answer to "' + cmd + '"'); this.name = 'TimeoutError'; this.cmd = cmd; }
}
export class DisconnectedError extends Error {
  constructor(msg) { super(msg || 'Bluetooth connection lost'); this.name = 'DisconnectedError'; }
}
// A write failed but the link is still up (Web Bluetooth reports that as a NetworkError too, e.g. "GATT operation already in progress").
export class GattError extends Error {
  constructor(msg) { super(msg || 'GATT operation failed'); this.name = 'GattError'; }
}
export class BadRequestError extends Error {
  constructor(code, msg) { super(msg || code); this.name = 'BadRequestError'; this.code = code; }
}
// A connection attempt failed; `key` is the STRINGS key with the plain-language reason (ce_*).
export class ConnectError extends Error {
  constructor(key, cause) { super(key + (cause && cause.message ? ': ' + cause.message : '')); this.name = 'ConnectError'; this.key = key; this.cause = cause || null; }
}

// ---------------------------------------------------------------- lines
// Collects notification pieces into complete lines. A line ends at LF (a CR before it is dropped); empty lines are
// skipped. Bytes are collected first and decoded as UTF-8 per line, so a character cut between two pieces is fine.
export class LineAssembler {
  constructor(maxLine = 4 * MAX_LINE) {
    this.max = maxLine;
    this.overflows = 0;           // lines dropped for being longer than `max`
    this._parts = [];
    this._len = 0;
    this._skip = false;
  }
  push(bytes) {
    const lines = [];
    let start = 0;
    for (;;) {
      const nl = bytes.indexOf(10, start);
      if (nl < 0) { this._add(bytes.subarray(start)); break; }
      this._add(bytes.subarray(start, nl));
      const line = this._finish();
      if (line !== null) lines.push(line);
      start = nl + 1;
      if (start >= bytes.length) break;
    }
    return lines;
  }
  _add(chunk) {
    if (!chunk.length || this._skip) return;
    this._len += chunk.length;
    if (this._len > this.max) { this._skip = true; this._parts = []; this.overflows++; return; }
    this._parts.push(chunk.slice());      // copy: the caller may reuse its buffer
  }
  _finish() {
    const skipped = this._skip, parts = this._parts;
    this._parts = []; this._len = 0; this._skip = false;
    if (skipped) return null;
    const bytes = parts.length === 1 ? parts[0] : concatBytes(...parts);
    let end = bytes.length;
    if (end && bytes[end - 1] === 13) end--;
    return end ? utf8Decode(bytes.subarray(0, end)) : null;
  }
}

function numberText(x) {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e15) throw new BadRequestError('bad_number', 'number out of range: ' + x);
  if (Number.isInteger(x)) return String(x);
  let s = String(x);
  if (/e/i.test(s)) s = x.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');   // never an exponent: the sensor's parser is simple
  return s;
}
function valueText(key, v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      // The sensor rejects backslashes in requests: no JSON escapes are possible, so refuse such strings here.
      if (/["\\\u0000-\u001f]/.test(v)) throw new BadRequestError('bad_string', 'field "' + key + '" has a quote, backslash or control character');
      return '"' + v + '"';
    case 'number': return numberText(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'object':
      if (Array.isArray(v)) {
        return '[' + v.map((x) => {
          if (typeof x !== 'string' && typeof x !== 'number') throw new BadRequestError('nested', 'field "' + key + '": arrays hold strings or numbers only');
          return valueText(key, x);
        }).join(',') + ']';
      }
      throw new BadRequestError('nested', 'field "' + key + '": requests are flat JSON, no nested objects');
    default: throw new BadRequestError('bad_type', 'field "' + key + '" has an unsupported type');
  }
}
// One request line as bytes: flat JSON in key order (write `id` and `cmd` first), undefined values left out, "\n" at the end.
export function encodeRequest(obj) {
  const parts = [];
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) continue;
    if (!/^[A-Za-z0-9_]+$/.test(k)) throw new BadRequestError('bad_key', 'bad field name "' + k + '"');
    parts.push('"' + k + '":' + valueText(k, obj[k]));
  }
  const bytes = utf8('{' + parts.join(',') + '}\n');
  if (bytes.length > MAX_LINE) throw new BadRequestError('line_too_long', 'request is ' + bytes.length + ' bytes, the limit is ' + MAX_LINE);
  return bytes;
}
export function splitWrites(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, Math.min(bytes.length, i + size)));
  return out;
}
// Bytes per write: the smaller of what the browser reports (maxWriteWithoutResponseSize) and mtu-3 from the `link` reply
// (whichever is known), else 20 (the minimum ATT payload). Never above what Web Bluetooth writes at once.
export function chooseWriteSize({ maxWrite, mtu } = {}) {
  const c = [];
  if (Number.isFinite(mtu) && mtu >= 23) c.push(mtu - 3);
  if (Number.isFinite(maxWrite) && maxWrite > 0) c.push(maxWrite);
  const w = c.length ? Math.min(...c) : MIN_WRITE;
  return Math.max(MIN_WRITE, Math.min(MAX_WRITE, Math.floor(w)));
}

// ---------------------------------------------------------------- the client
// What the client tells its own listeners (the screens, the update, the maintenance session). A sensor event with one of these names
// (a later firmware may add an event called "state" or "connected") must not set them off: "disconnected" would end the login and
// abort a firmware update. Such events still reach the listeners of "ev".
const OWN_EVENTS = new Set(['ev', 'state', 'connected', 'disconnected', 'protocol_error', 'late_reply', 'unmatched_error']);
export class JsonLinesClient extends Emitter {
  constructor(transport, opts = {}) {
    super();
    this.transport = transport;
    this.clock = opts.clock || realClock;
    this.timeoutMs = opts.timeoutMs || 6000;
    this.helloTimeoutMs = opts.helloTimeoutMs || 3000;
    this.writeTimeoutMs = opts.writeTimeoutMs || 10000;   // a write that never completes would block the queue for good
    this.state = 'idle';              // idle | connecting | connected | closed
    this.hello = null;
    this.link = null;                 // latest `link` reply or event
    this.mtu = null;
    this.topics = new Set();          // what the UI wants: restored after a reconnect
    this._pending = new Map();
    this._id = 0;
    this._q = Promise.resolve();      // serialised writes
    this._asm = new LineAssembler();
    this._writeSize = chooseWriteSize({ maxWrite: transport.maxWrite });
    this._expectClose = false;
    this._userClose = false;
    transport.onData = (b) => this._onData(b);
    transport.onClose = (reason) => this._onClose(reason);
  }

  get writeSize() { return this._writeSize; }
  get connected() { return this.state === 'connected'; }

  // `pick` shows the device chooser first (a user tap is needed for it).
  // onStep('choosing' | 'connecting' | 'starting') lets a screen say what is going on.
  async connect({ pick = false, onStep } = {}) {
    if (this.state === 'connecting' || this.state === 'connected') return this.hello;
    const step = (s) => { if (onStep) { try { onStep(s); } catch (e) { /* the screen's problem */ } } };
    this._resetLink();
    this.state = 'connecting';
    this.emit('state', 'connecting');
    try {
      if (pick) { step('choosing'); await this.transport.pick(); }
      step('connecting');
      await this.transport.connect();
      if (this.state !== 'connecting') throw new DisconnectedError();
      step('starting');
      await this._greet();
      await this._restoreTopics();
    } catch (e) {
      this._abortConnect();
      if (e instanceof TimeoutError) throw new ConnectError('ce_notsensor', e);
      throw e;
    }
    this.state = 'connected';
    this.emit('state', 'connected');
    this.emit('connected', this.hello);
    return this.hello;
  }

  // The user (or a page leaving) closes the link on purpose.
  disconnect() {
    this._userClose = true;
    try { this.transport.disconnect(); } catch (e) { /* already gone */ }
    this._onClose('user');
  }
  // The next close was asked for (restart, reset, firmware update): the UI waits instead of showing "connection lost".
  expectClose() { this._expectClose = true; }

  _resetLink() {
    this._asm = new LineAssembler();
    this._pending.clear();
    this.hello = null;
    this._expectClose = false;
    this._userClose = false;
    this._q = Promise.resolve();
  }
  _abortConnect() {
    this.state = 'closed';
    for (const e of this._pending.values()) { if (e.timer) this.clock.clearTimeout(e.timer); }
    this._pending.clear();
    try { this.transport.disconnect(); } catch (e) { /* ignore */ }
    this.emit('state', 'closed');
  }

  async _greet() {
    if (!this.hello) {
      await this._waitFor('hello', this.helloTimeoutMs).catch((e) => {
        if (e instanceof TimeoutError) return null;   // some firmware only answers the command: ask for it below
        throw e;
      });
    }
    if (!this.hello) {
      const r = await this._request('hello', {}, { timeoutMs: this.helloTimeoutMs });
      this.hello = { ev: 'hello', proto: r.proto, fw: r.fw, variant: r.variant, chip: r.chip, mac: r.mac, caps: r.caps, min_app: r.min_app };
      this.emit('hello', this.hello);
    }
    if (this.hello.proto !== PROTO) throw new ConnectError('ce_proto', new Error('sensor speaks protocol ' + this.hello.proto));
    if (needsNewerApp(this.hello)) throw new ConnectError('ce_minapp', new Error('sensor needs app level ' + this.hello.min_app));
    // How big may one write be? The `link` reply knows the negotiated MTU.
    try { this._setLink(await this._request('link', {}, { timeoutMs: 3000 })); } catch (e) {
      if (e instanceof DisconnectedError) throw e;
    }
  }
  async _restoreTopics() {
    if (this.topics.size) await this._request('subscribe', { topics: [...this.topics] }, {});
  }
  _setLink(l) {
    this.link = { mode: l.mode, phy: l.phy, rssi: l.rssi === undefined ? null : l.rssi, pending: !!l.pending, mtu: l.mtu };
    if (Number.isFinite(l.mtu)) {
      this.mtu = l.mtu;
      this._writeSize = chooseWriteSize({ maxWrite: this.transport.maxWrite, mtu: l.mtu });
    }
  }
  _waitFor(name, ms) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const offs = [];
      const done = (fn, v) => { if (timer) this.clock.clearTimeout(timer); offs.forEach((f) => f()); fn(v); };
      offs.push(this.on(name, (m) => done(resolve, m)));
      offs.push(this.on('disconnected', () => done(reject, new DisconnectedError())));
      timer = this.clock.setTimeout(() => done(reject, new TimeoutError(name)), ms);
    });
  }

  // ---- requests
  request(cmd, fields = {}, opts = {}) {
    if (this.state !== 'connected') return Promise.reject(new DisconnectedError());
    return this._request(cmd, fields, opts);
  }
  _nextId() { this._id = (this._id % 0xffffffff) + 1; return this._id; }
  _request(cmd, fields, opts) {
    let bytes, id;
    try {
      id = this._nextId();
      bytes = encodeRequest({ id, cmd, ...fields });
    } catch (e) { return Promise.reject(e); }
    const timeoutMs = opts.timeoutMs || this.timeoutMs;
    return new Promise((resolve, reject) => {
      const entry = { id, cmd, resolve, reject, timer: null };
      this._pending.set(id, entry);
      this._enqueue(async () => {
        if (!this._pending.has(id)) return;           // dropped meanwhile (link closed)
        await this._writeBytes(bytes, false);
        if (this._pending.has(id)) entry.timer = this.clock.setTimeout(() => this._timeout(id), timeoutMs);
      }).catch((err) => this._settle(id, 'reject', err));
    });
  }
  // A raw line without `id`, for firmware chunks. Resolves when the line was written.
  sendLine(obj, { noResponse = true } = {}) {
    if (this.state !== 'connected') return Promise.reject(new DisconnectedError());
    let bytes;
    try { bytes = encodeRequest(obj); } catch (e) { return Promise.reject(e); }
    return this._enqueue(() => this._writeBytes(bytes, noResponse));
  }
  _enqueue(fn) {
    const p = this._q.then(fn);
    this._q = p.catch(() => { /* a failed write must not block the next one */ });
    return p;
  }
  async _writeBytes(bytes, noResponse) {
    const pieces = splitWrites(bytes, this._writeSize);
    for (const piece of pieces) {
      if (this.state === 'closed') throw new DisconnectedError();
      await this._withTimeout(this.transport.write(piece, { noResponse }), 'write');
    }
  }
  _withTimeout(promise, what) {
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => reject(new TimeoutError(what)), this.writeTimeoutMs);
      promise.then((v) => { this.clock.clearTimeout(timer); resolve(v); }, (e) => { this.clock.clearTimeout(timer); reject(e); });
    });
  }
  _timeout(id) {
    this._settle(id, 'reject', new TimeoutError((this._pending.get(id) || {}).cmd || '?'));
  }
  _settle(id, how, value) {
    const e = this._pending.get(id);
    if (!e) return;
    this._pending.delete(id);
    if (e.timer) this.clock.clearTimeout(e.timer);
    if (how === 'resolve') e.resolve(value); else e.reject(value);
  }

  // ---- topics
  async subscribe(topics) {
    const added = topics.filter((t) => !this.topics.has(t));
    for (const t of topics) this.topics.add(t);
    try {
      return await this.request('subscribe', { topics: [...topics] });
    } catch (e) {
      if (e instanceof ProtocolError) for (const t of added) this.topics.delete(t);   // the sensor refused: do not restore it later
      throw e;
    }
  }
  async unsubscribe(topics) {
    for (const t of topics) this.topics.delete(t);
    if (this.state !== 'connected') return null;
    return this.request('unsubscribe', { topics: [...topics] });
  }

  // ---- incoming
  _onData(bytes) {
    if (this.state !== 'connecting' && this.state !== 'connected') return;     // late bytes of a link that is gone
    const before = this._asm.overflows;
    const lines = this._asm.push(bytes);
    if (this._asm.overflows !== before) this.emit('protocol_error', { kind: 'line_too_long' });
    for (const text of lines) this._onLine(text);
  }
  _onLine(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { this.emit('protocol_error', { kind: 'json', text }); return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { this.emit('protocol_error', { kind: 'shape', text }); return; }
    if (typeof msg.ev === 'string') { this._onEvent(msg); return; }
    if ('id' in msg) { this._onReply(msg); return; }
    this.emit('protocol_error', { kind: 'unknown', text });
  }
  _onReply(msg) {
    if (msg.id === null || msg.id === undefined) {            // e.g. line_too_long: the sensor could not read our id
      this.emit('unmatched_error', msg);
      return;
    }
    const e = this._pending.get(msg.id);
    if (!e) { this.emit('late_reply', msg); return; }
    if (msg.ok === true) this._settle(msg.id, 'resolve', msg);
    else this._settle(msg.id, 'reject', new ProtocolError(msg.err, msg.msg, msg));
  }
  _onEvent(msg) {
    if (msg.ev === 'hello') this.hello = msg;
    if (msg.ev === 'link') this._setLink(msg);
    this.emit('ev', msg);
    if (!OWN_EVENTS.has(msg.ev)) this.emit(msg.ev, msg);       // a sensor event never speaks as one of the client's own notices
  }
  _onClose(reason) {
    if (this.state === 'closed' || this.state === 'idle') { this.state = 'closed'; return; }
    const was = this.state;
    this.state = 'closed';
    const err = new DisconnectedError();
    for (const e of [...this._pending.values()]) { if (e.timer) this.clock.clearTimeout(e.timer); e.reject(err); }
    this._pending.clear();
    this.emit('state', 'closed');
    this.emit('disconnected', { reason, expected: this._expectClose, byUser: this._userClose, wasConnected: was === 'connected' });
    this._expectClose = false;
  }
}

// ---------------------------------------------------------------- Web Bluetooth
function connectErrorKey(e, phase) {
  const name = e && e.name, msg = String((e && e.message) || '');
  if (name === 'NotFoundError') {
    if (phase === 'service') return 'ce_notsensor';
    if (/cancel/i.test(msg)) return 'ce_cancelled';
    if (/adapter|bluetooth is off|turned off/i.test(msg)) return 'ce_off';
    return 'ce_notfound';
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'ce_blocked';
  if (name === 'NotSupportedError') return 'ce_off';
  return 'ce_failed';
}

export class WebBluetoothTransport {
  // sensorName: 'PROCOM-SENSOR-<MAC>' to list only that sensor in the chooser; null lists every PROCOM-SENSOR-.
  constructor({ bluetooth, sensorName = null, attempts = 3, retryMs = 700, connectTimeoutMs = 20000, clock = realClock } = {}) {
    this.bluetooth = bluetooth;
    this.sensorName = sensorName;
    this.attempts = attempts;
    this.retryMs = retryMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.clock = clock;
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.maxWrite = null;
    this.onData = () => {};
    this.onClose = () => {};
    this._connected = false;
    this._aborted = false;           // disconnect() was called: stop trying
    this._abortAttempt = null;
    this._onDisc = () => { this._connected = false; this.onClose('gatt'); };
    this._onValue = (ev) => {
      const v = ev.target.value;
      this.onData(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    };
  }

  // Must be called from a tap. The chooser lists the one sensor from the QR code (or all sensors without a QR code).
  async pick() {
    const filters = this.sensorName ? [{ name: this.sensorName }] : [{ namePrefix: 'PROCOM-SENSOR-' }];
    let dev;
    try {
      dev = await this.bluetooth.requestDevice({ filters, optionalServices: [NUS_SERVICE] });
    } catch (e) { throw new ConnectError(connectErrorKey(e, 'pick'), e); }
    if (this.device && this.device !== dev) this.device.removeEventListener('gattserverdisconnected', this._onDisc);
    this.device = dev;
    dev.addEventListener('gattserverdisconnected', this._onDisc);
    return { name: dev.name };
  }

  async connect() {
    if (!this.device) throw new ConnectError('ce_cancelled');
    this._aborted = false;
    let last = null;
    for (let i = 0; i < this.attempts; i++) {
      try { await this._connectOnce(); this.device.addEventListener('gattserverdisconnected', this._onDisc); return; } catch (e) {
        last = e;
        this._cleanup();                                  // (our own disconnect below must not look like a lost link)
        if (this._aborted || (e instanceof ConnectError && e.key === 'ce_notsensor')) break;
        if (i + 1 < this.attempts) await new Promise((r) => this.clock.setTimeout(r, this.retryMs));
      }
    }
    this.device.addEventListener('gattserverdisconnected', this._onDisc);
    throw last instanceof ConnectError ? last : new ConnectError(connectErrorKey(last, 'connect'), last);
  }
  async _connectOnce() {
    this.device.addEventListener('gattserverdisconnected', this._onDisc);
    // Android can take half a minute to give up on a sensor that is out of reach: stop waiting after connectTimeoutMs
    let timer = null;
    const attempt = this.device.gatt.connect();
    const limit = new Promise((_, reject) => {
      timer = this.clock.setTimeout(() => reject(new ConnectError('ce_failed', new Error('connect timed out'))), this.connectTimeoutMs);
      this._abortAttempt = () => reject(new ConnectError('ce_cancelled'));
    });
    let server;
    try { server = await Promise.race([attempt, limit]); } catch (e) {
      // a connection that completes after the operator cancelled must not stay open behind their back
      attempt.then(() => { if (this._aborted) { try { this.device.gatt.disconnect(); } catch (x) { /* gone */ } } }, () => {});
      throw e;
    } finally { this.clock.clearTimeout(timer); this._abortAttempt = null; }
    let svc;
    try { svc = await server.getPrimaryService(NUS_SERVICE); } catch (e) { throw new ConnectError(connectErrorKey(e, 'service'), e); }
    this.rx = await svc.getCharacteristic(NUS_RX);
    this.tx = await svc.getCharacteristic(NUS_TX);
    this.maxWrite = typeof this.rx.maxWriteWithoutResponseSize === 'number' && this.rx.maxWriteWithoutResponseSize > 0
      ? this.rx.maxWriteWithoutResponseSize : null;
    this.tx.addEventListener('characteristicvaluechanged', this._onValue);
    await this.tx.startNotifications();
    this._connected = true;
  }
  _cleanup() {
    if (this.tx) this.tx.removeEventListener('characteristicvaluechanged', this._onValue);
    this.tx = null; this.rx = null; this._connected = false;
    this.device.removeEventListener('gattserverdisconnected', this._onDisc);   // restored before the next attempt
    try { if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
  }

  async write(bytes, { noResponse = false } = {}) {
    const rx = this.rx;
    if (!rx || !this._connected) throw new DisconnectedError();
    try {
      if (noResponse && rx.properties && rx.properties.writeWithoutResponse && rx.writeValueWithoutResponse) await rx.writeValueWithoutResponse(bytes);
      else if (rx.writeValueWithResponse) await rx.writeValueWithResponse(bytes);
      else await rx.writeValue(bytes);
    } catch (e) {
      // A firmware chunk (write without response) that failed while the link is up is simply sent again by the caller: repeats are
      // harmless in the protocol. Everything else that Chrome calls a NetworkError is taken for a lost link, as before.
      const linkUp = this._connected && !(this.device && this.device.gatt && this.device.gatt.connected === false) && !/disconnect/i.test(String((e && e.message) || ''));
      if (noResponse && linkUp && e && e.name === 'NetworkError') throw new GattError(String(e.message));
      if (!this._connected || (e && e.name === 'NetworkError')) throw new DisconnectedError(String(e && e.message));
      throw e;
    }
  }

  disconnect() {
    this._aborted = true;
    if (this._abortAttempt) this._abortAttempt();                // a connection attempt in progress ends now
    if (this.tx) this.tx.removeEventListener('characteristicvaluechanged', this._onValue);
    this._connected = false;
    try { if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
  }
}
