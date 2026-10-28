// Time helpers. Qatar is UTC+3 all year (no daylight saving), so we work in fixed +3.
export const QA_MS = 3 * 3600 * 1000;
let skew = 0; // server time − phone time, measured at sign-in
export const setSkew = (ms) => { skew = ms; };
export const getSkew = () => skew;
export const now = () => Date.now() + skew;

const q = (ms) => new Date(ms + QA_MS); // read with getUTC* to get Qatar wall time
export const pad = (n) => String(n).padStart(2, '0');

// 20261028
export const dateInt = (ms = now()) => { const d = q(ms); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };
// 202610
export const monthInt = (ms = now()) => Math.floor(dateInt(ms) / 100);
// minutes since Qatar midnight
export const minOfDay = (ms = now()) => { const d = q(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
export const hhmm = (ms) => { const d = q(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
export const toMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
export const fmtDur = (min) => `${Math.floor(min / 60)}h ${pad(Math.max(0, Math.round(min % 60)))}m`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Parts of a date int
export const dParts = (di) => ({ y: Math.floor(di / 10000), m: Math.floor(di / 100) % 100, d: di % 100 });
export const dow = (di) => { const { y, m, d } = dParts(di); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
export const dowShort = (di) => DAYS[dow(di)];
export const longDate = (ms = now()) => { const di = dateInt(ms); const { y, m, d } = dParts(di); return `${DAYS_LONG[dow(di)]}, ${d} ${MONTHS[m - 1]} ${y}`; };
export const monthName = (mi) => `${MONTHS_LONG[(mi % 100) - 1]} ${Math.floor(mi / 100)}`;
export const daysInMonth = (mi) => new Date(Date.UTC(Math.floor(mi / 100), mi % 100, 0)).getUTCDate();
export const prevMonth = (mi) => (mi % 100 === 1 ? (Math.floor(mi / 100) - 1) * 100 + 12 : mi - 1);
export const isoDate = (di) => { const { y, m, d } = dParts(di); return `${y}-${pad(m)}-${pad(d)}`; };
// Qatar wall time (date int + "HH:MM") → epoch ms
export const qaToMs = (di, hm) => { const { y, m, d } = dParts(di); return Date.UTC(y, m - 1, d) + toMin(hm) * 60000 - QA_MS; };
