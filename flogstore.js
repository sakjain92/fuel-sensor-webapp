// Where the field log downloaded from a sensor is kept on the phone: IndexedDB (survives a closed tab), or memory where IndexedDB is not
// available (private window, tests). Per sensor (its MAC) and per log of it (FIELDLOG.md 2, the log id: a firmware update starts another
// log, whose positions start at 128 again; the logs are kept apart). A log is addressed by its `key`: the log id, or `<id>-2`, `<id>-3`
// when a log of the same id was started again (the same firmware written again into the same slot). No DOM.
//
//   device(mac)                 {mac, name, cur (key of the log last downloaded), tank, updated} or null
//   putDevice(dev)
//   newLog(mac, id, startedMs)  starts a log of this id: its doc {mac, key, id, n, startedMs, visits}; it becomes the current one
//   gen(mac, key) / gens(mac)   the docs
//   addVisit(mac, key, visit)
//   addPage(mac, key, page)     page = {pos, n, d (n x 32 bytes), next}. A cell is kept once: what is already here is cut off, and a
//                               different cell at the same position is a conflict (nothing is stored then). -> {added, same, conflict}
//   compare(mac, key, page)     the same, without storing
//   last(mac, key)              the stored page with the highest position, or null: its `next` is where to go on
//   pages(mac, key)             all pages, by position, none overlapping
//   remove(mac)

const DB_NAME = 'mrm-fuel-fieldlog';
const CELL = 32;

// What a page adds to the pages already stored around it (sorted, not overlapping each other). Pure.
export function planInsert(existing, page) {
  const end = page.pos + page.n;
  let same = 0, conflict = 0;
  const covered = [];
  for (const e of existing) {
    const lo = Math.max(page.pos, e.pos), hi = Math.min(end, e.pos + e.n);
    if (hi <= lo) continue;
    for (let p = lo; p < hi; p++) {
      const a = (p - page.pos) * CELL, b = (p - e.pos) * CELL;
      let eq = true;
      for (let i = 0; i < CELL; i++) if (page.d[a + i] !== e.d[b + i]) { eq = false; break; }
      if (eq) same++; else conflict++;
    }
    covered.push([lo, hi]);
  }
  covered.sort((x, y) => x[0] - y[0]);
  const pieces = [];
  let at = page.pos;
  const piece = (lo, hi) => { if (hi > lo) pieces.push({ pos: lo, n: hi - lo, d: page.d.slice((lo - page.pos) * CELL, (hi - page.pos) * CELL), next: hi === end ? page.next : hi }); };
  for (const [lo, hi] of covered) { piece(at, lo); at = Math.max(at, hi); }
  piece(at, end);
  return { pieces, same, conflict, added: pieces.reduce((s, p) => s + p.n, 0) };
}

export class MemoryFlogStore {
  constructor() { this.devs = new Map(); this.gs = new Map(); this.ps = new Map(); this.kind = 'memory'; }
  _k(mac, key) { return mac + '|' + key; }
  _list(mac, key) { const k = this._k(mac, key); if (!this.ps.has(k)) this.ps.set(k, []); return this.ps.get(k); }
  async device(mac) { const d = this.devs.get(mac); return d ? { ...d } : null; }
  async putDevice(dev) { this.devs.set(dev.mac, { ...dev }); }
  async newLog(mac, id, startedMs = 0) {
    const d = this.devs.get(mac) || { mac, name: '', cur: '', tank: null, updated: 0 };
    const n = [...this.gs.values()].filter((g) => g.mac === mac && g.id === id).length + 1;
    const doc = { mac, key: n === 1 ? id : id + '-' + n, id, n, startedMs, visits: [] };
    d.cur = doc.key;
    this.devs.set(mac, d);
    this.gs.set(this._k(mac, doc.key), doc);
    return { ...doc, visits: [] };
  }
  async gen(mac, key) { const g = this.gs.get(this._k(mac, key)); return g ? { ...g, visits: g.visits.slice() } : null; }
  async gens(mac) { return [...this.gs.values()].filter((g) => g.mac === mac).sort((a, b) => a.startedMs - b.startedMs || (a.key < b.key ? -1 : 1)).map((g) => ({ ...g, visits: g.visits.slice() })); }
  async addVisit(mac, key, visit) { const g = this.gs.get(this._k(mac, key)); if (!g) throw new Error('no such log'); g.visits.push(visit); }
  async compare(mac, key, page) { const { same, conflict, added } = planInsert(this._list(mac, key), page); return { same, conflict, added }; }
  async addPage(mac, key, page) {
    const list = this._list(mac, key);
    const { pieces, same, conflict, added } = planInsert(list, page);
    if (conflict) return { added: 0, same, conflict };
    for (const p of pieces) list.push({ pos: p.pos, n: p.n, d: p.d, next: p.next });
    list.sort((a, b) => a.pos - b.pos);
    return { added, same, conflict };
  }
  async last(mac, key) { const l = this._list(mac, key); return l.length ? { ...l[l.length - 1] } : null; }
  async pages(mac, key) { return this._list(mac, key).map((p) => ({ ...p })); }
  async remove(mac) {
    this.devs.delete(mac);
    for (const k of [...this.gs.keys()]) if (this.gs.get(k).mac === mac) this.gs.delete(k);
    for (const k of [...this.ps.keys()]) if (k.startsWith(mac + '|')) this.ps.delete(k);
  }
}

const req = (r) => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error || new Error('IndexedDB error')); });
const done = (tx) => new Promise((ok, bad) => { tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error || new Error('IndexedDB error')); tx.onabort = () => bad(tx.error || new Error('IndexedDB write refused')); });
const MAXPOS = Number.MAX_SAFE_INTEGER;
const HI = '\uffff';                                   // above every key text

export class IdbFlogStore {
  constructor(db) { this.db = db; this.kind = 'indexeddb'; }
  static open(idb = globalThis.indexedDB) {
    return new Promise((ok, bad) => {
      const o = idb.open(DB_NAME, 1);
      o.onupgradeneeded = () => {
        const db = o.result;
        db.createObjectStore('devs', { keyPath: 'mac' });
        db.createObjectStore('gens', { keyPath: ['mac', 'key'] });
        db.createObjectStore('pages', { keyPath: ['mac', 'key', 'pos'] });
      };
      o.onsuccess = () => ok(new IdbFlogStore(o.result));
      o.onerror = () => bad(o.error || new Error('IndexedDB cannot be opened'));
      o.onblocked = () => bad(new Error('IndexedDB is blocked'));
    });
  }
  async device(mac) { return (await req(this.db.transaction('devs').objectStore('devs').get(mac))) || null; }
  async putDevice(dev) { const tx = this.db.transaction('devs', 'readwrite'); tx.objectStore('devs').put(dev); await done(tx); }
  async newLog(mac, id, startedMs = 0) {
    const tx = this.db.transaction(['devs', 'gens'], 'readwrite');
    const devs = tx.objectStore('devs'), gens = tx.objectStore('gens');
    const d = (await req(devs.get(mac))) || { mac, name: '', cur: '', tank: null, updated: 0 };
    const n = (await req(gens.getAll(IDBKeyRange.bound([mac, ''], [mac, HI])))).filter((g) => g.id === id).length + 1;
    const doc = { mac, key: n === 1 ? id : id + '-' + n, id, n, startedMs, visits: [] };
    d.cur = doc.key;
    devs.put(d);
    gens.put(doc);
    await done(tx);
    return doc;
  }
  async gen(mac, key) { return (await req(this.db.transaction('gens').objectStore('gens').get([mac, key]))) || null; }
  async gens(mac) {
    const all = await req(this.db.transaction('gens').objectStore('gens').getAll(IDBKeyRange.bound([mac, ''], [mac, HI])));
    return all.sort((a, b) => a.startedMs - b.startedMs || (a.key < b.key ? -1 : 1));
  }
  async addVisit(mac, key, visit) {
    const tx = this.db.transaction('gens', 'readwrite');
    const st = tx.objectStore('gens');
    const g = await req(st.get([mac, key]));
    if (!g) { tx.abort(); throw new Error('no such log'); }
    g.visits.push(visit);
    st.put(g);
    await done(tx);
  }
  // the stored pages that touch [pos, end): the last one that starts before pos, and those that start inside
  async _around(st, mac, key, pos, end) {
    const out = [];
    const before = await new Promise((ok, bad) => {
      const c = st.openCursor(IDBKeyRange.bound([mac, key, 0], [mac, key, pos], false, true), 'prev');
      c.onsuccess = () => ok(c.result ? c.result.value : null);
      c.onerror = () => bad(c.error);
    });
    if (before && before.pos + before.n > pos) out.push(before);
    out.push(...(await req(st.getAll(IDBKeyRange.bound([mac, key, pos], [mac, key, Math.max(pos, end - 1)])))));
    return out.sort((a, b) => a.pos - b.pos);
  }
  async compare(mac, key, page) {
    const st = this.db.transaction('pages').objectStore('pages');
    const { same, conflict, added } = planInsert(await this._around(st, mac, key, page.pos, page.pos + page.n), page);
    return { same, conflict, added };
  }
  async addPage(mac, key, page) {
    const tx = this.db.transaction('pages', 'readwrite');
    const st = tx.objectStore('pages');
    const { pieces, same, conflict, added } = planInsert(await this._around(st, mac, key, page.pos, page.pos + page.n), page);
    if (conflict) { tx.abort(); await done(tx).catch(() => {}); return { added: 0, same, conflict }; }
    for (const p of pieces) st.put({ mac, key, pos: p.pos, n: p.n, d: p.d, next: p.next });
    await done(tx);
    return { added, same, conflict };
  }
  async last(mac, key) {
    const st = this.db.transaction('pages').objectStore('pages');
    return new Promise((ok, bad) => {
      const c = st.openCursor(IDBKeyRange.bound([mac, key, 0], [mac, key, MAXPOS]), 'prev');
      c.onsuccess = () => ok(c.result ? c.result.value : null);
      c.onerror = () => bad(c.error);
    });
  }
  async pages(mac, key) { return req(this.db.transaction('pages').objectStore('pages').getAll(IDBKeyRange.bound([mac, key, 0], [mac, key, MAXPOS]))); }
  async remove(mac) {
    const tx = this.db.transaction(['devs', 'gens', 'pages'], 'readwrite');
    tx.objectStore('devs').delete(mac);
    tx.objectStore('gens').delete(IDBKeyRange.bound([mac, ''], [mac, HI]));
    tx.objectStore('pages').delete(IDBKeyRange.bound([mac, '', 0], [mac, HI, MAXPOS]));
    await done(tx);
  }
}

// IndexedDB if it works, else memory.
export async function openFlogStore(env = {}) {
  const idb = env.indexedDB === undefined ? globalThis.indexedDB : env.indexedDB;
  if (idb) { try { return await IdbFlogStore.open(idb); } catch (e) { /* fall back to memory */ } }
  return new MemoryFlogStore();
}

// Opens the store on first use: a sensor without the field log, or a page that never looks at it, never creates the database.
export class LazyFlogStore {
  constructor(open = openFlogStore) { this._open = open; this._p = null; this._real = null; }
  _s() { if (!this._p) this._p = Promise.resolve().then(() => this._open()).then((s) => { this._real = s; return s; }); return this._p; }
  get kind() { return this._real ? this._real.kind : 'lazy'; }
  get opened() { return this._p !== null; }
  async ready() { await this._s(); return this.kind; }
}
for (const m of ['device', 'putDevice', 'newLog', 'gen', 'gens', 'addVisit', 'addPage', 'compare', 'last', 'pages', 'remove']) {
  LazyFlogStore.prototype[m] = async function lazy(...a) { return (await this._s())[m](...a); };
}
