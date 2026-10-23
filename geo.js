// The phone's position, behind a small interface so that the flows can be tested with a fake.
//   geo.getPosition({timeoutMs}) -> Promise<{lat, lon, acc}>   one high-accuracy fix, rejects with GeoError
//   geo.watch(onFix, onError)    -> stop()                      every new fix while the caller needs them
// lat/lon are degrees rounded to 6 decimals (what the sensor stores), acc is the accuracy in metres.
import { round6 } from './core.js';

export class GeoError extends Error {
  // code: denied | unavailable | timeout | unsupported
  constructor(code, msg) { super(msg || code); this.name = 'GeoError'; this.code = code; }
}

function fixOf(pos) {
  const c = pos.coords;
  return { lat: round6(c.latitude), lon: round6(c.longitude), acc: Number.isFinite(c.accuracy) ? c.accuracy : null, ts: pos.timestamp };
}
function errOf(e) {
  const code = e && e.code === 1 ? 'denied' : e && e.code === 3 ? 'timeout' : 'unavailable';
  return new GeoError(code, e && e.message);
}

export function browserGeo(nav = globalThis.navigator) {
  const g = nav && nav.geolocation;
  return {
    supported: !!g,
    getPosition({ timeoutMs = 20000 } = {}) {
      return new Promise((resolve, reject) => {
        if (!g) { reject(new GeoError('unsupported')); return; }
        // maximumAge 0: a fix from earlier would be the wrong place if the operator walked since.
        g.getCurrentPosition((p) => resolve(fixOf(p)), (e) => reject(errOf(e)), { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 });
      });
    },
    watch(onFix, onError) {
      if (!g) { if (onError) onError(new GeoError('unsupported')); return () => {}; }
      const id = g.watchPosition((p) => onFix(fixOf(p)), (e) => { if (onError) onError(errOf(e)); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
      return () => g.clearWatch(id);
    },
  };
}
