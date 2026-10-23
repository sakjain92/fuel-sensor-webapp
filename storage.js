// Per-viewer convenience storage. Browsers throw on access in private windows or with blocked site data, so every call is
// wrapped and falls back to memory. Nothing stored here is needed for correctness: the page works with it empty.
export function makeStorage(win = globalThis) {
  const mem = new Map();
  let area = null;
  try { area = win.sessionStorage || null; } catch (e) { area = null; }
  return {
    get(k) {
      try { if (area) { const v = area.getItem(k); if (v !== null) return v; } } catch (e) { /* use memory */ }
      return mem.has(k) ? mem.get(k) : null;
    },
    set(k, v) {
      mem.set(k, String(v));
      try { if (area) area.setItem(k, String(v)); } catch (e) { /* memory only */ }
    },
    del(k) {
      mem.delete(k);
      try { if (area) area.removeItem(k); } catch (e) { /* ignore */ }
    },
  };
}
