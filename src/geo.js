// GPS: distance to the office, one-off fixes, live watching, fake-GPS check.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';

const native = Capacitor.isNativePlatform();
const Guard = registerPlugin('FitxGuard'); // android/app/src/main/java/qa/fitx/attendance/GuardPlugin.java

export const M_PER_DEG = 111320;
const rad = (d) => (d * Math.PI) / 180;

// Metres between two points (haversine).
export function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
// Same flat-earth formula the security rules use (good to ~0.1% at office scale).
export function flatDistance(lat, lng, olat, olng, k) {
  const dy = (lat - olat) * M_PER_DEG, dx = (lng - olng) * k * M_PER_DEG;
  return Math.sqrt(dx * dx + dy * dy);
}
// Direction from office to the person, radians (0 = east, counter-clockwise; screen y is flipped by caller)
export function angle(olat, olng, lat, lng) {
  return Math.atan2((lat - olat), (lng - olng) * Math.cos(rad(olat)));
}

export class GeoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function ensurePermission() {
  if (!native) return;
  let p = await Geolocation.checkPermissions().catch(() => null);
  if (!p || p.location !== 'granted') p = await Geolocation.requestPermissions({ permissions: ['location'] }).catch(() => null);
  if (!p || p.location !== 'granted') {
    throw new GeoError('perm', 'Location permission is off. Allow "Location → While using the app" (Precise ON) for FitX Attendance in phone Settings.');
  }
}

function explain(e) {
  const m = String((e && (e.message || e.code)) || e || '');
  if (e instanceof GeoError) return e;
  if (/disabled|not enabled|services/i.test(m)) return new GeoError('off', 'Turn on Location (GPS) on your phone, then try again.');
  if (/denied|permission/i.test(m)) return new GeoError('perm', 'Location permission is off. Allow it for FitX Attendance in phone Settings.');
  if (/timeout|timed out/i.test(m)) return new GeoError('timeout', 'Could not get a GPS fix. Step near a window or outside and try again.');
  return new GeoError('fail', 'Could not read your location (' + m.slice(0, 80) + ')');
}

// One fresh, accurate fix. Takes up to two readings and keeps the more accurate one.
export async function getFix() {
  try {
    await ensurePermission();
    const opts = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };
    let p = await Geolocation.getCurrentPosition(opts);
    if (p.coords.accuracy > 40) {
      try {
        const p2 = await Geolocation.getCurrentPosition({ ...opts, timeout: 12000 });
        if (p2.coords.accuracy < p.coords.accuracy) p = p2;
      } catch (e) { /* keep the first */ }
    }
    return { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 999), at: p.timestamp || Date.now() };
  } catch (e) { throw explain(e); }
}

// Is a fake-GPS (mock location) app feeding the phone? Android only.
export async function mockCheck() {
  if (!native) return { mock: false };
  try { return await Guard.check(); } catch (e) { return { mock: false }; }
}

// Live position while the Punch screen is open.
let watchId = null, gen = 0;
export async function startWatch(onFix, onErr) {
  stopWatch();
  const my = gen;
  try {
    await ensurePermission();
    const id = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 25000, maximumAge: 5000 }, (p, err) => {
      if (err) { onErr(explain(err)); return; }
      if (p) onFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 999), at: p.timestamp || Date.now() });
    });
    if (my !== gen) Geolocation.clearWatch({ id }).catch(() => {}); else watchId = id;
  } catch (e) { if (my === gen) onErr(explain(e)); }
}
export function stopWatch() {
  gen++;
  if (watchId != null) { Geolocation.clearWatch({ id: watchId }).catch(() => {}); watchId = null; }
}
