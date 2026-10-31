// Where recordings are kept on the phone until they are shared: IndexedDB (survives a closed tab or a crash), or memory where
// IndexedDB is not available (private window, tests). A recording is one record in `recs` and many text chunks in `chunks`. No DOM.
//
//   create(rec)            rec = {id, mac, fw, startedPt, state, header, ...}
//   update(id, patch)      merge into the record
//   addChunk(id, n, chunk) chunk = {text, lines, frames, bytes}; n counts from 0
//   list()                 newest first
//   chunks(id)             in order
//   remove(id)

const DB_NAME = 'mrm-fuel-recordings';

export class MemoryRecStore {
  constructor() { this.recs = new Map(); this.parts = new Map(); this.kind = 'memory'; }
  async create(rec) { this.recs.set(rec.id, { ...rec }); this.parts.set(rec.id, []); return { ...rec }; }
  async update(id, patch) { const r = this.recs.get(id); if (!r) throw new Error('no such recording'); Object.assign(r, patch); return { ...r }; }
  async addChunk(id, n, chunk) { if (!this.recs.has(id)) throw new Error('no such recording'); this.parts.get(id).push({ n, ...chunk }); }
  async list() { return [...this.recs.values()].map((r) => ({ ...r })).sort((a, b) => b.startedPt - a.startedPt); }
  async chunks(id) { return (this.parts.get(id) || []).slice().sort((a, b) => a.n - b.n); }
  async remove(id) { this.recs.delete(id); this.parts.delete(id); }
}

const req = (r) => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error || new Error('IndexedDB error')); });
const done = (tx) => new Promise((ok, bad) => { tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error || new Error('IndexedDB error')); tx.onabort = () => bad(tx.error || new Error('IndexedDB write refused')); });

export class IdbRecStore {
  constructor(db) { this.db = db; this.kind = 'indexeddb'; }
  static open(idb = globalThis.indexedDB) {
    return new Promise((ok, bad) => {
      const o = idb.open(DB_NAME, 1);
      o.onupgradeneeded = () => {
        const db = o.result;
        db.createObjectStore('recs', { keyPath: 'id' });
        db.createObjectStore('chunks', { keyPath: ['rid', 'n'] });
      };
      o.onsuccess = () => ok(new IdbRecStore(o.result));
      o.onerror = () => bad(o.error || new Error('IndexedDB cannot be opened'));
      o.onblocked = () => bad(new Error('IndexedDB is blocked'));
    });
  }
  async create(rec) { const tx = this.db.transaction('recs', 'readwrite'); tx.objectStore('recs').put(rec); await done(tx); return rec; }
  async update(id, patch) {
    const tx = this.db.transaction('recs', 'readwrite');
    const st = tx.objectStore('recs');
    const cur = await req(st.get(id));
    if (!cur) { tx.abort(); throw new Error('no such recording'); }
    const next = { ...cur, ...patch };
    st.put(next);
    await done(tx);
    return next;
  }
  async addChunk(id, n, chunk) { const tx = this.db.transaction('chunks', 'readwrite'); tx.objectStore('chunks').put({ rid: id, n, ...chunk }); await done(tx); }
  async list() { const all = await req(this.db.transaction('recs').objectStore('recs').getAll()); return all.sort((a, b) => b.startedPt - a.startedPt); }
  async chunks(id) { return req(this.db.transaction('chunks').objectStore('chunks').getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))); }
  async remove(id) {
    const tx = this.db.transaction(['recs', 'chunks'], 'readwrite');
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    tx.objectStore('recs').delete(id);
    await done(tx);
  }
}

// IndexedDB if it works, else memory (the recording then lives only as long as the page).
export async function openRecStore(env = {}) {
  const idb = env.indexedDB === undefined ? globalThis.indexedDB : env.indexedDB;
  if (idb) { try { return await IdbRecStore.open(idb); } catch (e) { /* fall back to memory */ } }
  return new MemoryRecStore();
}

// Opens the store on first use. A production sensor never reaches the Recording page, so for those users the database is never created.
export class LazyRecStore {
  constructor(open = openRecStore) { this._open = open; this._p = null; this.kind = 'lazy'; }
  _s() { if (!this._p) this._p = Promise.resolve().then(() => this._open()); return this._p; }
  get opened() { return this._p !== null; }
  async create(rec) { return (await this._s()).create(rec); }
  async update(id, patch) { return (await this._s()).update(id, patch); }
  async addChunk(id, n, chunk) { return (await this._s()).addChunk(id, n, chunk); }
  async list() { return (await this._s()).list(); }
  async chunks(id) { return (await this._s()).chunks(id); }
  async remove(id) { return (await this._s()).remove(id); }
}
