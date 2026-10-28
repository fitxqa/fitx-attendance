// FitX Attendance — staff check-in/out inside a GPS zone around the office.
// Free Firebase "Spark" plan: Auth + Firestore only. The security rules (firestore.rules)
// re-check every punch: server time, today's date, the punch order, the phone and the zone.
import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
} from 'firebase/auth';
import {
  initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, onSnapshot,
  serverTimestamp, writeBatch, getDocs, Timestamp,
} from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import * as T from './time.js';
import { distance, flatDistance, angle, getFix, mockCheck, startWatch, stopWatch, officeWatch, officeStop, batteryState, openBattery } from './geo.js';

const VERSION = '1.0';
const CFG = window.FITX_CONFIG || {};
const DOMAIN = CFG.loginDomain || 'fitxatt.local';
const native = Capacitor.isNativePlatform();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const cleanId = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
const validId = (s) => /^[a-z0-9][a-z0-9._-]{1,30}$/.test(s);
const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : typeof ts === 'number' ? ts : 0);
const withTimeout = (p, t, code) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code }), t))]);
$('ver').textContent = `FitX Attendance v${VERSION}`;

// ---------- Punch slots ----------
const SLOTS = [
  // Straight shift: office in the morning → site visits all day → back to the office at night.
  { id: 'amIn', shift: 'Morning', kind: 'Check-in', short: 'AM in', isIn: true, label: 'Morning check-in', btn: 'Check in' },
  { id: 'amOut', shift: 'Morning', kind: 'Out to visits', short: 'AM out', isIn: false, label: 'Leave for site visits', btn: 'Go to visits' },
  { id: 'pmIn', shift: 'Night', kind: 'Back from visits', short: 'Night in', isIn: true, label: 'Back from visits', btn: 'Back in' },
  { id: 'pmOut', shift: 'Night', kind: 'Check-out', short: 'Night out', isIn: false, label: 'Night check-out', btn: 'Check out' },
];
const SLOT = Object.fromEntries(SLOTS.map((s) => [s.id, s]));
const OFFICE_DEFAULT = { name: 'FitX Office', lat: null, lng: null, radius: 100, away: 10, amIn: '09:00', amOut: '10:00', pmIn: '22:00', pmOut: '22:15', grace: 15 };

// Which punch comes next, given today's punches {amIn:{...}, ...}
function nextSlot(p, office) {
  const nowM = T.workMin(), nightIn = T.schedMin(office.pmIn);
  if (!p.amIn && !p.pmIn) {
    const mid = (T.schedMin(office.amOut) + nightIn) / 2;
    return nowM < mid ? 'amIn' : 'pmIn';
  }
  // Forgot "leave for visits" in the morning: by night, offer "back from visits" instead.
  if (p.amIn && !p.amOut && !p.pmIn) return nowM >= nightIn - 120 ? 'pmIn' : 'amOut';
  if (!p.pmIn) return 'pmIn';
  if (!p.pmOut) return 'pmOut';
  return null;
}
// 'ok' | 'late' (late in or early out) for a punch time
function judge(slotId, t, office) {
  const m = T.workMin(t), sched = T.schedMin(office[slotId]), g = Number(office.grace) || 0;
  if (SLOT[slotId].isIn) return m > sched + g ? 'late' : 'ok';
  return m < sched - g ? 'late' : 'ok';
}
// Duty time = morning check-in to night check-out (site visits in between count as work).
function workedMin(p, nowMs) {
  const first = p.amIn || p.pmIn;
  if (!first) return 0;
  const end = p.pmOut ? ms(p.pmOut.t) : nowMs;
  return Math.max(0, (end - ms(first.t)) / 60000);
}
// Time of the latest punch of a day (used to close an open shift on past days)
const lastT = (p) => Math.max(0, ...Object.values(p).map((x) => ms(x.t)));
const dayWorked = (p, di) => workedMin(p, di === T.dateInt() ? T.now() : lastT(p));
// Google Maps link (inside the app it opens the Maps app / browser)
const mapLink = (lat, lng, label = 'Map') => `<a class="btn small ghost" style="text-decoration:none" ${native ? '' : 'target="_blank" rel="noopener"'} href="https://www.google.com/maps?q=${lat},${lng}">${label}</a>`;
const punchId = (emp, di, slot) => `${emp}_${di}_${slot}`;

// ---------- UI helpers ----------
const SCREENS = ['s-loading', 's-noconfig', 's-login', 's-setup', 's-main'];
function show(id) { SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id)); }
let toastT;
function toast(msg, t = 2800) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), t);
}
// Bottom-sheet dialog. fields: [{label, type, value, min, options:[[v,label]], required}]
let modalDone = null;
function ask({ title, text = '', fields = [], ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    $('modal-text').textContent = text; $('modal-text').classList.toggle('hidden', !text);
    $('modal-ok').textContent = ok;
    $('modal-ok').classList.toggle('danger', danger);
    $('modal-fields').innerHTML = fields.map((f, i) => {
      const req = f.required === false ? '' : 'required';
      if (f.type === 'select') return `<label class="field">${esc(f.label)}<select id="mf-${i}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
      if (f.type === 'textarea') return `<label class="field">${esc(f.label)}<textarea id="mf-${i}" ${req}>${esc(f.value || '')}</textarea></label>`;
      return `<label class="field">${esc(f.label)}<input id="mf-${i}" type="${f.type || 'text'}" value="${esc(f.value || '')}" ${f.min ? `minlength="${f.min}"` : ''} autocapitalize="none" autocomplete="off" ${req}></label>`;
    }).join('');
    $('modal').classList.remove('hidden');
    const done = (val) => { $('modal').classList.add('hidden'); modalDone = null; resolve(val); };
    modalDone = done;
    $('modal-cancel').onclick = () => done(null);
    $('modal-form').onsubmit = (e) => { e.preventDefault(); done(fields.map((_, i) => $('mf-' + i).value)); };
  });
}
const confirmBox = (title, text, ok = 'Yes', danger = false) => ask({ title, text, ok, danger }).then((v) => v !== null);

// ---------- Firebase ----------
const configured = CFG.firebase && CFG.firebase.apiKey && !String(CFG.firebase.apiKey).startsWith('PASTE') && CFG.firebase.projectId;
let auth, db, creatorAuth;
if (configured) {
  const fb = initializeApp(CFG.firebase);
  auth = initializeAuth(fb, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  // Long-polling is the most reliable mode inside Android WebViews and on strict mobile networks.
  db = initializeFirestore(fb, { experimentalAutoDetectLongPolling: true });
}
// Second instance so the admin can create logins without being signed out.
function creator() {
  if (!creatorAuth) creatorAuth = initializeAuth(initializeApp(CFG.firebase, 'creator'), { persistence: inMemoryPersistence });
  return creatorAuth;
}

// A per-install phone ID: the account is tied to the first phone that uses it.
function deviceId() {
  try {
    let d = localStorage.getItem('fx-device');
    if (!d) { d = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); localStorage.setItem('fx-device', d); }
    return d;
  } catch (e) { return 'web'; }
}
const DEVICE = deviceId();
const deviceLabel = () => { const m = navigator.userAgent.match(/;\s*([^;)]+?)\s+Build\//); return m ? m[1] : (native ? 'Android phone' : 'Web browser'); };

// ---------- State ----------
let me = null;            // { id, uid, name, role, title, device, disabled }
let office = { ...OFFICE_DEFAULT };
let officeSet = false;
let today = {};           // my punches today, by slot
let todayDate = T.dateInt();
let fix = null;           // latest GPS fix
let fixErr = null;
let fixSeen = 0;          // when that fix arrived (phone clock)
let busy = false;
let tab = 'punch';
let unsubs = [];
let ticker = null;
const isAdmin = () => me && me.role === 'admin';

// ---------- Sign in ----------
async function emailFor(id) {
  try {
    const m = await withTimeout(getDoc(doc(db, 'logins', id)), 9000, 'db-timeout');
    if (m.exists() && m.data().email) return m.data().email;
  } catch (e) { /* rules not published yet → fall back */ }
  return `${id}@${DOMAIN}`;
}
function authMsg(c) {
  return c.includes('invalid') || c.includes('wrong') || c.includes('not-found') ? 'Wrong Employee ID or password'
    : c.includes('disabled') ? 'This account is disabled — contact admin'
      : c.includes('network') ? 'No internet connection'
        : c.includes('too-many') ? 'Too many tries — wait a minute and try again'
          : c.includes('operation-not-allowed') ? 'Email/Password sign-in is not switched on in Firebase yet'
            : c === 'timeout' ? 'Server not responding — check internet'
              : c.includes('weak-password') ? 'Password must be at least 6 characters'
                : 'Sign-in failed' + (c ? ` (${c.replace('auth/', '')})` : '');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Signing in…';
  $('login-err').textContent = '';
  try {
    const id = cleanId($('login-user').value);
    const email = await emailFor(id);
    await withTimeout(signInWithEmailAndPassword(auth, email, $('login-pass').value), 20000, 'timeout');
  } catch (err) { $('login-err').textContent = authMsg(String(err.code || err.message || '')); }
  btn.disabled = false; btn.textContent = 'Sign in';
});

$('setup-btn').addEventListener('click', () => { $('su-err').textContent = ''; show('s-setup'); });
$('su-back').addEventListener('click', () => show('s-login'));

let settingUp = false;
$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('su-name').value.trim(), id = cleanId($('su-user').value), pass = $('su-pass').value;
  if (!validId(id)) { $('su-err').textContent = 'Employee ID: 2–31 letters/numbers (dots, dashes allowed)'; return; }
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Creating…';
  settingUp = true;
  try {
    const s = await getDoc(doc(db, 'config', 'setup')).catch(() => null);
    if (s && s.exists()) throw { code: 'already-setup' };
    const email = `${id}@${DOMAIN}`;
    let cred;
    try { cred = await createUserWithEmailAndPassword(auth, email, pass); } catch (er) {
      if (String(er.code).includes('email-already-in-use')) cred = await signInWithEmailAndPassword(auth, email, pass);
      else throw er;
    }
    await createAdminProfile(cred.user.uid, id, name, email);
    settingUp = false;
    await afterSignIn(cred.user);
  } catch (err) {
    settingUp = false;
    const c = String(err.code || err.message || '');
    $('su-err').textContent = c === 'already-setup' ? 'Setup was already done. Sign in, or ask the admin for an account.'
      : c.includes('permission') ? 'Database rules are not published yet (run the setup script) — ' + c
        : authMsg(c);
    if (auth.currentUser) signOut(auth).catch(() => {});
  }
  btn.disabled = false; btn.textContent = 'Create admin';
});
async function createAdminProfile(uid, id, name, email) {
  const b = writeBatch(db);
  b.set(doc(db, 'logins', id), { email });
  b.set(doc(db, 'accounts', uid), { emp: id });
  b.set(doc(db, 'staff', id), { name, title: 'Admin', role: 'admin', uid, device: null, disabled: false, created: serverTimestamp() });
  b.set(doc(db, 'config', 'setup'), { by: id, at: serverTimestamp() });
  await b.commit();
}

$('logout').addEventListener('click', async () => {
  if (!(await confirmBox('Sign out?', 'You will need your Employee ID and password to sign in again.', 'Sign out'))) return;
  await officeStop();
  await signOut(auth);
});
$('change-pass').addEventListener('click', async () => {
  const v = await ask({ title: 'Change my password', fields: [
    { label: 'Current password', type: 'password' }, { label: 'New password (6+ characters)', type: 'password', min: 6 }], ok: 'Change' });
  if (!v) return;
  try {
    await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, v[0]));
    await updatePassword(auth.currentUser, v[1]);
    toast('Password changed');
  } catch (e) { toast(/invalid|wrong/.test(String(e.code)) ? 'Current password is wrong' : 'Could not change password'); }
});

// Server clock: write a server timestamp, read it back. Punch times always come from the
// server; this only keeps "today" and the on-screen clock right if the phone's clock is off.
async function syncClock(uid) {
  try {
    const r = doc(db, 'clock', uid);
    const t0 = Date.now();
    await withTimeout(setDoc(r, { t: serverTimestamp() }), 10000, 'timeout');
    const s = await getDoc(r);
    const st = ms(s.data().t);
    if (st) T.setSkew(st - (t0 + Date.now()) / 2);
  } catch (e) { /* keep phone time */ }
}

if (configured) {
  onAuthStateChanged(auth, (u) => {
    if (settingUp) return;
    if (u) afterSignIn(u); else signedOut();
  });
} else show('s-noconfig');

async function afterSignIn(u) {
  show('s-loading'); $('load-msg').textContent = 'Loading your account…';
  try {
    const acc = await withTimeout(getDoc(doc(db, 'accounts', u.uid)), 15000, 'db-timeout');
    if (!acc.exists()) throw { code: 'no-account' };
    const emp = acc.data().emp;
    const s = await getDoc(doc(db, 'staff', emp));
    if (!s.exists()) throw { code: 'no-account' };
    const d = s.data();
    if (d.uid !== u.uid) throw { code: 'replaced' };
    if (d.disabled) throw { code: 'disabled' };
    me = { id: emp, ...d };
    // Tie the account to this phone the first time it is used.
    if (!me.device) {
      try { await updateDoc(doc(db, 'staff', emp), { device: DEVICE, deviceName: deviceLabel() }); me.device = DEVICE; } catch (e) { /* admin reset race */ }
    }
    await syncClock(u.uid);
    startApp();
  } catch (err) {
    const c = String(err.code || err.message || '');
    await signOut(auth).catch(() => {});
    show('s-login');
    $('login-err').textContent = c === 'replaced' ? 'Your password was reset by the admin — sign in with the new password.'
      : c === 'disabled' ? 'This account is disabled — contact admin'
        : c === 'no-account' ? 'No employee profile for this login. Ask the admin.'
          : c === 'db-timeout' || c.includes('unavailable') ? 'Cannot reach the database — check internet'
            : c.includes('permission') ? 'Database rules are not published yet (run the setup script).'
              : 'Could not load account (' + c + ')';
  }
}

function signedOut() {
  me = null; stopAll(); tab = 'punch'; adminSub = 'live';
  document.querySelectorAll('.subtabs button').forEach((x) => x.classList.toggle('on', x.dataset.sub === 'live'));
  ['live', 'req', 'staff', 'office', 'report'].forEach((x) => $('a-' + x).classList.toggle('hidden', x !== 'live'));
  $('a-report').innerHTML = '';
  show('s-login');
  getDoc(doc(db, 'config', 'setup')).then((s) => $('setup-btn').classList.toggle('hidden', s.exists()))
    .catch(() => $('setup-btn').classList.remove('hidden'));
}
function stopAll() {
  watchKey = null;
  unsubs.forEach((f) => { try { f(); } catch (e) {} }); unsubs = [];
  stopWatch(); clearInterval(ticker); ticker = null;
}

// ---------- Main app ----------
function startApp() {
  stopAll();
  show('s-main');
  $('tab-admin').classList.toggle('hidden', !isAdmin());
  todayDate = T.dateInt();
  renderProfile();

  // My profile (detect disable / password reset / phone reset)
  unsubs.push(onSnapshot(doc(db, 'staff', me.id), (s) => {
    if (!s.exists() || s.data().uid !== auth.currentUser?.uid || s.data().disabled) {
      toast(s.exists() && s.data().disabled ? 'Your account was disabled' : 'Your login was changed — sign in again', 4000);
      signOut(auth); return;
    }
    const wasAdmin = isAdmin();
    me = { id: me.id, ...s.data() };
    if (!me.device) updateDoc(s.ref, { device: DEVICE, deviceName: deviceLabel() }).catch(() => {});
    if (wasAdmin !== isAdmin()) { $('tab-admin').classList.toggle('hidden', !isAdmin()); if (isAdmin()) startAdmin(); }
    renderProfile(); renderPunch();
  }));
  // Office zone + shift times
  unsubs.push(onSnapshot(doc(db, 'config', 'office'), (s) => {
    officeSet = s.exists() && typeof s.data().lat === 'number';
    office = { ...OFFICE_DEFAULT, ...(s.exists() ? s.data() : {}) };
    renderPunch(); renderProfile(); syncOfficeWatch();
    if (isAdmin()) renderOffice();
  }, () => {}));
  watchToday();
  if (isAdmin()) startAdmin();
  setTab(tab === 'admin' && !isAdmin() ? 'punch' : tab);
  ticker = setInterval(() => {
    if (T.dateInt() !== todayDate) { todayDate = T.dateInt(); watchToday(); if (isAdmin()) startAdmin(); }
    renderPunch();
  }, 30000);
}

let todayUnsub = null;
function watchToday() {
  if (todayUnsub) todayUnsub();
  today = {};
  const q = query(collection(db, 'punches'), where('emp', '==', me.id), where('date', '==', todayDate));
  todayUnsub = onSnapshot(q, (snap) => {
    today = {}; snap.forEach((d) => { today[d.data().slot] = d.data(); });
    renderPunch(); syncOfficeWatch();
  }, (e) => console.warn('today', e));
  unsubs.push(() => todayUnsub && todayUnsub());
}

// ---------- Office watch: notice when a checked-in technician walks out of the zone ----------
// While someone is checked in (morning, or back at night) the phone keeps checking the zone in
// the background. Outside for `office.away` minutes → the matching check-out is saved with the
// time they walked out (marked "auto"), and the watch stops.
let watchKey = null;
function watchPlan() {
  if (!me || !officeSet || !auth.currentUser || (me.device && me.device !== DEVICE)) return null;
  if (today.amIn && !today.amOut && !today.pmIn) return 'amOut';
  if (today.pmIn && !today.pmOut) return 'pmOut';
  return null;
}
async function syncOfficeWatch() {
  if (!native) return;
  const slot = watchPlan();
  const key = slot ? [todayDate, slot, office.lat, office.lng, office.radius, office.away].join('|') : 'off';
  if (key === watchKey) return;
  watchKey = key;
  if (!slot) { officeStop(); return; }
  const ok = await officeWatch({
    emp: me.id, name: me.name, slot, label: SLOT[slot].label, date: todayDate, device: DEVICE,
    lat: office.lat, lng: office.lng, radius: office.radius, awayMin: Number(office.away) || 10, officeName: office.name,
    apiKey: CFG.firebase.apiKey, projectId: CFG.firebase.projectId, refreshToken: auth.currentUser.refreshToken,
    skew: Math.round(T.getSkew()), until: T.qaToMs(todayDate, '03:59'),
  });
  if (!ok) watchKey = null; // try again next time
}

// ---------- Tabs ----------
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  ['punch', 'history', 'admin', 'profile'].forEach((x) => $('t-' + x).classList.toggle('hidden', x !== t));
  $('refresh-btn').classList.toggle('hidden', t !== 'punch');
  if (t === 'punch') beginWatch(); else stopWatch();
  if (t === 'history') loadHistory();
  if (t === 'admin') renderAdmin();
}

// ---------- Punch screen ----------
function beginWatch() {
  if (!me) return;
  startWatch((f) => { fix = f; fixSeen = Date.now(); fixErr = null; renderPunch(); }, (e) => { fixErr = e; renderPunch(); });
}
$('refresh-btn').addEventListener('click', async () => {
  fixErr = null; fix = null; stopWatch(); renderPunch();
  try { fix = await getFix(); fixSeen = Date.now(); } catch (e) { fixErr = e; }
  renderPunch(); if (tab === 'punch') beginWatch();
});

function zoneState() {
  if (!officeSet) return { s: 'none' };
  if (fixErr && !fix) return { s: 'err', msg: fixErr.message };
  if (!fix) return { s: 'wait' };
  const d = distance(fix.lat, fix.lng, office.lat, office.lng);
  return { s: d <= office.radius ? 'in' : 'out', d, acc: fix.acc, a: angle(office.lat, office.lng, fix.lat, fix.lng) };
}

function radarSvg(z) {
  const C = 56, ring = 36;
  const col = z.s === 'in' ? '#22c55e' : z.s === 'out' ? '#f87171' : '#5a5a5a';
  const bg = z.s === 'in' ? '#0f1f14' : z.s === 'out' ? '#1f1010' : '#151515';
  const inner = z.s === 'in' ? '#1f3a27' : z.s === 'out' ? '#3a1f1f' : '#262626';
  let dot = '';
  if (z.d != null) {
    const r = Math.min((z.d / office.radius) * ring, 50);
    const x = C + r * Math.cos(z.a), y = C - r * Math.sin(z.a);
    dot = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="${col}" opacity=".25"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="#fff" stroke="${col}" stroke-width="2"/>`;
  }
  return `<svg class="radar" width="112" height="112" viewBox="0 0 112 112" role="img" aria-label="Office zone radar">
    <circle cx="56" cy="56" r="54" fill="${bg}"/>
    <circle cx="56" cy="56" r="${ring}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="4 4"/>
    <circle cx="56" cy="56" r="52" fill="none" stroke="${inner}"/><circle cx="56" cy="56" r="18" fill="none" stroke="${inner}"/>
    <rect x="49" y="49" width="14" height="14" rx="4" fill="#ff6b00"/><path d="M53 59v-4h6v4" fill="none" stroke="#0b0b0b" stroke-width="1.6"/>
    ${dot}</svg>`;
}

function renderPunch() {
  if (!me || $('s-main').classList.contains('hidden')) return;
  const nowMs = T.now();
  $('h-date').textContent = T.longDate(nowMs);
  const h = T.minOfDay(nowMs);
  $('h-name').textContent = `${h < 720 ? 'Good morning' : h < 1020 ? 'Good afternoon' : 'Good evening'}, ${String(me.name || '').split(' ')[0]}`;
  $('h-role').textContent = `${me.title || (isAdmin() ? 'Admin' : 'Employee')} · ID ${me.id.toUpperCase()}`;

  // Zone card
  const z = zoneState();
  let pill, big, sub;
  if (z.s === 'none') { pill = '<span class="pill grey"><i></i>No office set</span>'; big = '— m'; sub = isAdmin() ? 'Set the office location in Admin → Office zone' : 'The admin has not set the office location yet'; }
  else if (z.s === 'err') { pill = '<span class="pill red"><i></i>No location</span>'; big = '— m'; sub = esc(z.msg); }
  else if (z.s === 'wait') { pill = '<span class="pill grey"><i></i>Finding you…</span>'; big = '… m'; sub = `${esc(office.name)} · getting GPS`; }
  else {
    pill = z.s === 'in' ? '<span class="pill green"><i></i>Inside office zone</span>' : '<span class="pill red"><i></i>Outside office zone</span>';
    big = `${Math.round(z.d)} m`; sub = `${esc(office.name)} · GPS accuracy ±${z.acc} m`;
  }
  $('zone-card').innerHTML = `${radarSvg(z)}<div class="info">${pill}<div class="dist disp">${big} <small>/ ${office.radius} m</small></div><div class="sub">${sub}</div></div>`;

  // Button
  const next = nextSlot(today, office);
  const btn = $('punch-btn');
  const lockedPhone = me.device && me.device !== DEVICE;
  btn.className = 'punch'; btn.disabled = false;
  $('exc-btn').classList.add('hidden');
  let hint = 'Tap to punch · your location is checked';
  if (lockedPhone) {
    btn.classList.add('locked'); $('pb-big').textContent = 'Locked'; $('pb-small').textContent = 'Other phone';
    hint = `Your account is registered on another phone${me.deviceName ? ' (' + esc(me.deviceName) + ')' : ''}. Ask the admin to reset your phone.`;
  } else if (!next) {
    btn.classList.add('done'); $('pb-big').textContent = 'Day done'; $('pb-small').textContent = 'All punches saved';
    hint = 'See you tomorrow';
  } else {
    const s = SLOT[next];
    $('pb-big').textContent = s.btn;
    $('pb-small').textContent = s.label;
    if (!officeSet) { btn.classList.add('locked'); hint = 'Waiting for the admin to set the office location'; }
    else if (z.s === 'out' && !s.isIn && native) {
      btn.classList.add('locked'); $('pb-big').textContent = 'Left office';
      hint = `You are outside the office. Your “${esc(s.label.toLowerCase())}” is saved automatically after ${Number(office.away) || 10} minutes away.`;
    } else if (z.s === 'out') {
      btn.classList.add('locked'); $('pb-big').textContent = 'Locked';
      hint = `Move ${Math.ceil(z.d - office.radius)} m closer to ${esc(office.name)}. The button unlocks by itself inside the zone.`;
      $('exc-btn').classList.remove('hidden');
    } else if (z.s === 'err') { hint = 'Turn on location, then tap to try again'; }
  }
  if (busy) { btn.classList.add('busy'); $('pb-small').textContent = 'Checking location…'; }
  $('punch-hint').innerHTML = hint;

  // Today's four punches
  $('slots').innerHTML = SLOTS.map((s) => {
    const p = today[s.id];
    const cls = p ? judge(s.id, ms(p.t), office) : s.id === next ? 'due' : '';
    const time = p ? T.hhmm(ms(p.t)) + (p.manual ? '*' : p.auto ? ' auto' : '') : 'Due ' + office[s.id];
    return `<div class="slot ${s.id === next && !lockedPhone ? 'next' : ''}"><div class="s1">${s.shift}</div><div class="s2">${s.kind}</div><div class="t ${cls}">${esc(time)}</div></div>`;
  }).join('');
  $('worked').textContent = T.fmtDur(workedMin(today, nowMs));
}

$('punch-btn').addEventListener('click', async () => {
  if (busy || !me) return;
  const next = nextSlot(today, office);
  if (!next || (me.device && me.device !== DEVICE)) return;
  if (!officeSet) { toast('Office location not set yet'); return; }
  busy = true; renderPunch();
  try {
    // Use the live fix if it is fresh and accurate; otherwise take a new one (live tracking paused meanwhile).
    let f = fix && Date.now() - fixSeen < 15000 && fix.acc <= 50 ? fix : null;
    if (!f) { stopWatch(); try { f = await getFix(); } finally { if (tab === 'punch') beginWatch(); } }
    fix = f; fixErr = null;
    const guard = await mockCheck();
    if (guard.mock) throw { msg: 'A fake-GPS app is active on this phone. Turn it off to punch.' };
    if (f.acc > 80) throw { msg: `GPS signal is weak (±${f.acc} m). Step near a window or outside and try again.` };
    const d = distance(f.lat, f.lng, office.lat, office.lng);
    if (d > office.radius) { renderPunch(); throw { msg: `You are ${Math.round(d)} m from the office — you must be within ${office.radius} m.` }; }
    const s = SLOT[next];
    const di = T.dateInt();
    const data = {
      emp: me.id, name: me.name, slot: next, date: di, month: Math.floor(di / 100),
      t: serverTimestamp(), lat: f.lat, lng: f.lng, acc: f.acc, dist: Math.round(d), device: DEVICE, manual: false,
    };
    await withTimeout(setDoc(doc(db, 'punches', punchId(me.id, di, next)), data), 20000, 'timeout');
    if (navigator.vibrate) navigator.vibrate(60);
    toast(`${s.label} saved ✓`);
    if (!s.isIn) officeStop();
  } catch (e) {
    const c = String(e.code || '');
    const geo = ['perm', 'off', 'timeout', 'fail'].includes(c) && e.message;
    toast(e.msg || geo
      || (c.includes('permission') ? 'Punch refused by the server (zone, phone or order of punches). Tap refresh and try again.'
        : c === 'timeout' ? 'Slow internet — the punch will be sent as soon as you are back online'
          : 'Could not save the punch' + (c ? ` (${c})` : '')), 4500);
  }
  busy = false; renderPunch();
});

// Exception request (e.g. working at a customer's gym)
$('exc-btn').addEventListener('click', async () => {
  const next = nextSlot(today, office);
  if (!next) return;
  const s = SLOT[next];
  const v = await ask({ title: `Request: ${s.label.toLowerCase()}`,
    text: 'The admin will see your reason and where you are now. If approved, the punch is added with the current time.',
    fields: [{ label: 'Reason (customer / site)', type: 'textarea' }], ok: 'Send request' });
  if (!v) return;
  try {
    const f = fix || await getFix().catch(() => null);
    await setDoc(doc(collection(db, 'requests')), {
      emp: me.id, name: me.name, slot: next, date: T.dateInt(), note: v[0].trim().slice(0, 300),
      lat: f ? f.lat : null, lng: f ? f.lng : null, acc: f ? f.acc : null,
      dist: f && officeSet ? Math.round(distance(f.lat, f.lng, office.lat, office.lng)) : null,
      t: serverTimestamp(), status: 'pending',
    });
    toast('Request sent to admin');
  } catch (e) { toast('Could not send the request'); }
});

// ---------- History ----------
(function fillMonths() {
  let m = T.monthInt(); const opts = [];
  for (let i = 0; i < 12; i++) { opts.push(`<option value="${m}">${T.monthName(m)}</option>`); m = T.prevMonth(m); }
  $('h-month').innerHTML = opts.join('');
})();
$('h-month').addEventListener('change', loadHistory);

function groupByDay(rows) {
  const by = {};
  rows.forEach((p) => { (by[p.date] = by[p.date] || {})[p.slot] = p; });
  return by;
}
async function loadHistory() {
  if (!me) return;
  const m = Number($('h-month').value) || T.monthInt();
  $('h-rows').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const snap = await getDocs(query(collection(db, 'punches'), where('emp', '==', me.id), where('month', '==', m)));
    const rows = []; snap.forEach((d) => rows.push(d.data()));
    const by = groupByDay(rows);
    const days = Object.keys(by).map(Number).sort((a, b) => b - a);
    let minutes = 0, late = 0;
    days.forEach((di) => {
      const p = by[di];
      minutes += dayWorked(p, di);
      SLOTS.forEach((s) => { if (p[s.id] && judge(s.id, ms(p[s.id].t), office) === 'late') late++; });
    });
    $('h-stats').innerHTML = `<div class="stat hot"><div class="v">${Math.round(minutes / 60)}h</div><div class="l">Duty hours</div></div>
      <div class="stat"><div class="v">${days.length}</div><div class="l">Days present</div></div>
      <div class="stat"><div class="v" style="color:var(--amber)">${late}</div><div class="l">Late / early</div></div>`;
    $('h-rows').innerHTML = days.length ? days.map((di) => {
      const p = by[di];
      const past = di < T.dateInt();
      const cells = SLOTS.map((s) => {
        const x = p[s.id];
        if (x) return `<div class="tm ${judge(s.id, ms(x.t), office)} ${x.manual ? 'man' : ''} ${x.auto ? 'auto' : ''}">${T.hhmm(ms(x.t))}</div>`;
        const missed = past && p.amIn && (s.id === 'pmIn' || s.id === 'pmOut' || (s.id === 'amOut' && !p.pmIn))
          || past && s.id === 'pmOut' && p.pmIn;
        return `<div class="tm ${missed ? 'miss' : ''}">${missed ? 'Missed' : '--'}</div>`;
      }).join('');
      return `<div class="hrow hgrid ${di === T.dateInt() ? 'today' : ''}"><div><div class="dd">${di % 100}</div><div class="dw">${T.dowShort(di)}</div></div>${cells}</div>`;
    }).join('') : '<div class="empty">No punches this month</div>';
  } catch (e) { $('h-rows').innerHTML = `<div class="empty">Could not load history (${esc(e.code || e.message)})</div>`; }
}

// ---------- Profile ----------
function renderProfile() {
  if (!me) return;
  $('p-av').textContent = initials(me.name);
  $('p-name').textContent = me.name;
  $('p-id').textContent = `ID ${me.id.toUpperCase()} · ${me.title || (isAdmin() ? 'Admin' : 'Employee')}`;
  $('p-shifts').innerHTML = `<div class="slot"><div class="s1">Morning at office</div><div class="s2">${office.amIn} – ${office.amOut}</div></div>
    <div class="slot"><div class="s1">Night at office</div><div class="s2">${office.pmIn} – ${office.pmOut}</div></div>`;
  $('p-zone').textContent = officeSet ? `${office.name} · punch within ${office.radius} m · ${office.grace} min grace · leave saved after ${office.away ?? 10} min away` : 'Office location not set yet';
  renderBattery();
}

// Phones like Xiaomi / Oppo / Huawei stop background apps unless battery limits are removed.
async function renderBattery() {
  if (!native) { $('p-battery').classList.add('hidden'); return; }
  const b = await batteryState();
  $('p-battery').classList.remove('hidden');
  $('p-batt-state').innerHTML = b.unrestricted
    ? '<span class="pill green"><i></i>Ready</span>'
    : '<span class="pill red"><i></i>Battery limits ON</span>';
  $('p-batt-btn').classList.toggle('hidden', !!b.unrestricted);
}
$('p-batt-btn').addEventListener('click', () => openBattery());

// =====================================================================
//  ADMIN
// =====================================================================
let staff = [];          // [{id, ...}]
let todayAll = {};       // emp -> {slot: punch}
let pending = [];
let adminSub = 'live';
let adminUnsubs = [];
function startAdmin() {
  adminUnsubs.forEach((f) => f()); adminUnsubs = [];
  adminUnsubs.push(onSnapshot(collection(db, 'staff'), (s) => {
    staff = []; s.forEach((d) => staff.push({ id: d.id, ...d.data() }));
    staff.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    renderAdmin();
  }, () => {}));
  adminUnsubs.push(onSnapshot(query(collection(db, 'punches'), where('date', '==', todayDate)), (s) => {
    todayAll = {}; s.forEach((d) => { const p = d.data(); (todayAll[p.emp] = todayAll[p.emp] || {})[p.slot] = p; });
    renderAdmin();
  }, () => {}));
  adminUnsubs.push(onSnapshot(query(collection(db, 'requests'), where('status', '==', 'pending')), (s) => {
    pending = []; s.forEach((d) => pending.push({ rid: d.id, ...d.data() }));
    pending.sort((a, b) => ms(b.t) - ms(a.t));
    $('req-count').textContent = pending.length ? `(${pending.length})` : '';
    $('admin-dot').textContent = pending.length; $('admin-dot').classList.toggle('hidden', !pending.length);
    renderAdmin();
  }, () => {}));
  unsubs.push(() => { adminUnsubs.forEach((f) => f()); adminUnsubs = []; });
}
document.querySelectorAll('.subtabs button').forEach((b) => b.addEventListener('click', () => {
  adminSub = b.dataset.sub;
  document.querySelectorAll('.subtabs button').forEach((x) => x.classList.toggle('on', x === b));
  ['live', 'req', 'staff', 'office', 'report'].forEach((x) => $('a-' + x).classList.toggle('hidden', x !== adminSub));
  renderAdmin();
}));
function renderAdmin() {
  if (!isAdmin() || tab !== 'admin') return;
  if (adminSub === 'live') renderLive();
  if (adminSub === 'req') renderRequests();
  if (adminSub === 'staff') renderStaff();
  if (adminSub === 'office') renderOffice();
  if (adminSub === 'report' && !$('a-report').innerHTML) renderReportShell();
}

// ----- Today (live board) -----
function statusOf(p) {
  if (!p || !Object.keys(p).length) return ['Not punched', 'grey'];
  if (p.pmOut) return ['Day done', 'grey'];
  if (p.pmIn) return ['In office', 'green'];
  if (p.amOut) return T.workMin() >= T.schedMin(office.pmIn) + 120 ? ['Not back yet', 'red'] : ['On site visits', 'orange'];
  if (p.amIn) return ['In office', 'green'];
  return ['Not punched', 'grey'];
}
function renderLive() {
  const active = staff.filter((s) => !s.disabled);
  let inside = 0, late = 0, none = 0;
  active.forEach((s) => {
    const p = todayAll[s.id] || {};
    const st = statusOf(p)[0];
    if (st === 'In office') inside++;
    if (st === 'Not punched') none++;
    if (SLOTS.some((x) => p[x.id] && x.isIn && judge(x.id, ms(p[x.id].t), office) === 'late')) late++;
  });
  $('a-live').innerHTML = `
    <div class="kpis mx">
      <div class="kpi"><div class="l">Employees</div><div class="v disp">${active.length}</div></div>
      <div class="kpi"><div class="l">In office now</div><div class="v disp" style="color:var(--green)">${inside}</div></div>
      <div class="kpi"><div class="l">Late today</div><div class="v disp" style="color:var(--amber)">${late}</div></div>
      <div class="kpi"><div class="l">Not punched</div><div class="v disp" style="color:var(--red)">${none}</div></div>
    </div>
    <div class="card pad mx" style="margin-top:12px">
      <div style="display:flex;justify-content:space-between;align-items:center"><h2 class="sec">${esc(T.longDate())}</h2><span class="pill green"><i></i>Live</span></div>
      <div class="list" style="margin-top:6px">${active.map((s) => {
        const p = todayAll[s.id] || {};
        const [st, col] = statusOf(p);
        const last = SLOTS.map((x) => p[x.id]).filter(Boolean).pop();
        return `<div class="item" style="align-items:flex-start">
          <div class="av">${esc(initials(s.name))}</div>
          <div class="who"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><div class="nm">${esc(s.name)}</div><span class="pill ${col}"><i></i>${st}</span></div>
            <div class="rl">${esc(s.title || '')}${last && last.dist != null ? ` · ${last.manual ? 'added by admin' : last.auto ? `left the office at ${T.hhmm(ms(last.t))} (auto-detected)` : last.dist + ' m from office'}` : ''}</div>
            <div class="times">${SLOTS.map((x) => { const q = p[x.id]; return `<div><small>${x.short}</small><span class="tm ${q ? judge(x.id, ms(q.t), office) : ''} ${q && q.auto ? 'auto' : ''}">${q ? T.hhmm(ms(q.t)) + (q.manual ? '*' : '') : '--'}</span></div>`; }).join('')}</div>
            <div class="actions"><button class="btn small ghost" data-fix="${esc(s.id)}">Fix punch</button>${last && last.lat != null ? mapLink(last.lat, last.lng) : ''}</div>
          </div></div>`;
      }).join('') || '<div class="empty">No employees yet — add them in Employees</div>'}</div>
    </div>`;
  $('a-live').querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => fixPunch(b.dataset.fix)));
}
async function fixPunch(emp) {
  const s = staff.find((x) => x.id === emp); if (!s) return;
  const v = await ask({ title: `Fix punch — ${s.name}`, text: 'Adds or changes today\'s punch (marked as added by admin). Leave the time empty to delete it.',
    fields: [{ label: 'Punch', type: 'select', value: 'amIn', options: SLOTS.map((x) => [x.id, x.label]) },
      { label: 'Time (Qatar)', type: 'time', required: false }, { label: 'Note', required: false }], ok: 'Save' });
  if (!v) return;
  const [slot, time, note] = v;
  const id = punchId(emp, todayDate, slot);
  try {
    if (!time) { await deleteDoc(doc(db, 'punches', id)); toast('Punch deleted'); return; }
    await setDoc(doc(db, 'punches', id), {
      emp, name: s.name, slot, date: todayDate, month: Math.floor(todayDate / 100), t: Timestamp.fromMillis(T.qaToMs(todayDate, time)),
      lat: null, lng: null, acc: null, dist: null, device: null, manual: true, by: me.id, note: (note || '').slice(0, 200),
    });
    toast('Punch saved');
  } catch (e) { toast('Could not save (' + (e.code || e.message) + ')'); }
}

// ----- Requests -----
function renderRequests() {
  $('a-req').innerHTML = `<div class="card pad mx"><h2 class="sec">Exception requests</h2><div class="list" style="margin-top:6px">${pending.map((r) => `
    <div class="item" style="align-items:flex-start"><div class="av">${esc(initials(r.name))}</div><div class="who">
      <div class="nm">${esc(r.name)} · ${esc(SLOT[r.slot] ? SLOT[r.slot].label : r.slot)}</div>
      <div class="rl">${r.t ? T.hhmm(ms(r.t)) + ' · ' + T.dowShort(r.date) + ' ' + (r.date % 100) : ''}${r.dist != null ? ` · ${r.dist} m from office` : ' · location unknown'}</div>
      <div style="margin-top:6px;font-size:14px">${esc(r.note)}</div>
      <div class="actions"><button class="btn small" data-ok="${r.rid}">Approve</button><button class="btn small danger" data-no="${r.rid}">Reject</button>${r.lat != null ? mapLink(r.lat, r.lng) : ''}</div>
    </div></div>`).join('') || '<div class="empty">No pending requests</div>'}</div></div>`;
  $('a-req').querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.ok, true)));
  $('a-req').querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.no, false)));
}
async function decide(rid, ok) {
  const r = pending.find((x) => x.rid === rid); if (!r) return;
  try {
    const b = writeBatch(db);
    if (ok) {
      b.set(doc(db, 'punches', punchId(r.emp, r.date, r.slot)), {
        emp: r.emp, name: r.name, slot: r.slot, date: r.date, month: Math.floor(r.date / 100), t: r.t || serverTimestamp(),
        lat: r.lat, lng: r.lng, acc: r.acc, dist: r.dist, device: null, manual: true, by: me.id, note: r.note || '',
      });
    }
    b.update(doc(db, 'requests', rid), { status: ok ? 'approved' : 'rejected', by: me.id, decided: serverTimestamp() });
    await b.commit();
    toast(ok ? 'Approved — punch added' : 'Rejected');
  } catch (e) { toast('Could not save (' + (e.code || e.message) + ')'); }
}

// ----- Employees -----
function renderStaff() {
  $('a-staff').innerHTML = `
    <div class="mx" style="margin-bottom:12px"><button class="btn block" id="add-emp">+ Add employee</button></div>
    <div class="card pad mx"><div class="list">${staff.map((s) => `
      <div class="item" style="align-items:flex-start;${s.disabled ? 'opacity:.55' : ''}"><div class="av">${esc(initials(s.name))}</div><div class="who">
        <div class="nm">${esc(s.name)} ${s.role === 'admin' ? '<span class="pill orange" style="padding:2px 8px">Admin</span>' : ''} ${s.disabled ? '<span class="pill red" style="padding:2px 8px">Disabled</span>' : ''}</div>
        <div class="rl">ID ${esc(s.id.toUpperCase())}${s.title ? ' · ' + esc(s.title) : ''} · ${s.device ? 'Phone: ' + esc(s.deviceName || 'registered') : 'No phone yet'}</div>
        ${s.id === me.id ? '' : `<div class="actions">
          <button class="btn small ghost" data-act="pass" data-id="${esc(s.id)}">Password</button>
          <button class="btn small ghost" data-act="phone" data-id="${esc(s.id)}">Reset phone</button>
          <button class="btn small ghost" data-act="edit" data-id="${esc(s.id)}">Edit</button>
          <button class="btn small ${s.disabled ? 'ghost' : 'danger'}" data-act="toggle" data-id="${esc(s.id)}">${s.disabled ? 'Enable' : 'Disable'}</button>
        </div>`}
        ${s.id === me.id && s.device ? `<div class="actions"><button class="btn small ghost" data-act="phone" data-id="${esc(s.id)}">Reset my phone</button></div>` : ''}
      </div></div>`).join('')}</div></div>`;
  $('add-emp').addEventListener('click', addEmployee);
  $('a-staff').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => staffAction(b.dataset.act, b.dataset.id)));
}
// A fresh hidden login. (The free plan can't change someone else's password, so a reset makes a new login.)
async function newLogin(id, pass) {
  const ca = creator();
  let email = `${id}@${DOMAIN}`, cred;
  try { cred = await createUserWithEmailAndPassword(ca, email, pass); } catch (e) {
    if (!String(e.code).includes('email-already-in-use')) throw e;
    email = `${id}.${Date.now().toString(36)}@${DOMAIN}`;
    cred = await createUserWithEmailAndPassword(ca, email, pass);
  }
  const uid = cred.user.uid;
  await signOut(ca).catch(() => {});
  return { uid, email };
}
async function addEmployee() {
  const v = await ask({ title: 'Add employee', fields: [
    { label: 'Full name' }, { label: 'Employee ID (they sign in with this)', value: '' }, { label: 'Job title', value: 'Technician', required: false },
    { label: 'Password (6+ characters)', type: 'password', min: 6 },
    { label: 'Role', type: 'select', value: 'staff', options: [['staff', 'Employee'], ['admin', 'Admin']] }], ok: 'Add' });
  if (!v) return;
  const [name, rawId, title, pass, role] = v;
  const id = cleanId(rawId);
  if (!validId(id)) return toast('Employee ID: 2–31 letters/numbers (dots, dashes allowed)', 3500);
  if (pass.length < 6) return toast('Password must be at least 6 characters');
  try {
    const ex = await getDoc(doc(db, 'staff', id));
    if (ex.exists()) return toast('That Employee ID is already used', 3500);
    toast('Creating login…');
    const { uid, email } = await newLogin(id, pass);
    const b = writeBatch(db);
    b.set(doc(db, 'logins', id), { email });
    b.set(doc(db, 'accounts', uid), { emp: id });
    b.set(doc(db, 'staff', id), { name: name.trim(), title: (title || '').trim(), role, uid, device: null, disabled: false, created: serverTimestamp() });
    await b.commit();
    toast(`${name} added — ID ${id.toUpperCase()}`, 3500);
  } catch (e) { toast(authMsg(String(e.code || e.message || '')), 4000); }
}
async function staffAction(act, id) {
  const s = staff.find((x) => x.id === id); if (!s) return;
  try {
    if (act === 'pass') {
      const v = await ask({ title: `New password for ${s.name}`, fields: [{ label: 'New password (6+ characters)', type: 'password', min: 6 }], ok: 'Change' });
      if (!v) return;
      const { uid, email } = await newLogin(id, v[0]);
      const b = writeBatch(db);
      b.set(doc(db, 'logins', id), { email });
      b.set(doc(db, 'accounts', uid), { emp: id });
      b.update(doc(db, 'staff', id), { uid });
      await b.commit();
      toast(`Password changed for ${s.name}`);
    } else if (act === 'phone') {
      if (!(await confirmBox('Reset phone?', `${s.name}'s account will be tied to the next phone they sign in on.`, 'Reset'))) return;
      await updateDoc(doc(db, 'staff', id), { device: null, deviceName: null });
      toast('Phone reset');
    } else if (act === 'edit') {
      const v = await ask({ title: `Edit ${s.name}`, fields: [{ label: 'Full name', value: s.name }, { label: 'Job title', value: s.title || '', required: false },
        { label: 'Role', type: 'select', value: s.role, options: [['staff', 'Employee'], ['admin', 'Admin']] }], ok: 'Save' });
      if (!v) return;
      await updateDoc(doc(db, 'staff', id), { name: v[0].trim(), title: v[1].trim(), role: v[2] });
      toast('Saved');
    } else if (act === 'toggle') {
      if (!s.disabled && !(await confirmBox(`Disable ${s.name}?`, 'They are signed out and cannot punch. Their history is kept.', 'Disable', true))) return;
      await updateDoc(doc(db, 'staff', id), { disabled: !s.disabled });
      toast(s.disabled ? 'Enabled' : 'Disabled');
    }
  } catch (e) { toast('Could not save (' + (e.code || e.message) + ')', 3500); }
}

// ----- Office zone -----
let officeDraft = null;
function renderOffice() {
  if (adminSub !== 'office' || tab !== 'admin') return;
  const o = officeDraft || office;
  $('a-office').innerHTML = `<div class="card pad mx formcard">
    <h2 class="sec">Office zone</h2>
    <label class="field">Office name<input id="o-name" value="${esc(o.name)}"></label>
    <div class="row2"><label class="field">Latitude<input id="o-lat" inputmode="decimal" value="${o.lat ?? ''}" placeholder="25.2…"></label>
      <label class="field">Longitude<input id="o-lng" inputmode="decimal" value="${o.lng ?? ''}" placeholder="51.5…"></label></div>
    <button class="btn line" id="o-here" type="button">Use my current location</button>
    ${o.lat != null ? mapLink(o.lat, o.lng, 'Check on Google Maps') : ''}
    <div class="range-row"><span>Allowed radius</span><b id="o-rv">${o.radius} m</b></div>
    <input type="range" id="o-rad" min="30" max="500" step="10" value="${o.radius}" aria-label="Allowed radius in metres">
    <div class="row2"><label class="field">Morning check-in<input id="o-amIn" type="time" value="${o.amIn}"></label><label class="field">Leave for visits<input id="o-amOut" type="time" value="${o.amOut}"></label></div>
    <div class="row2"><label class="field">Back from visits<input id="o-pmIn" type="time" value="${o.pmIn}"></label><label class="field">Night check-out<input id="o-pmOut" type="time" value="${o.pmOut}"></label></div>
    <div class="muted" style="font-size:12px;line-height:1.5">The working day runs until 04:00, so a return after midnight still counts for the same day.</div>
    <label class="field">Grace period (minutes before marking late)<input id="o-grace" type="number" min="0" max="60" value="${o.grace}"></label>
    <label class="field">Count as left after (minutes outside the zone)<input id="o-away" type="number" min="3" max="60" value="${o.away ?? 10}"></label>
    <div class="muted" style="font-size:12px;line-height:1.5">While a technician is checked in, the phone notices when they walk out. After this many minutes outside, “Leave for site visits” (or the night check-out) is saved with the time they left.</div>
    <button class="btn block" id="o-save">Save zone</button>
    <div class="muted" style="font-size:12px;line-height:1.5">Tip: stand in the middle of the office and tap “Use my current location” for the most accurate centre point.</div>
  </div>`;
  const read = () => ({
    name: $('o-name').value.trim() || 'FitX Office', lat: parseFloat($('o-lat').value), lng: parseFloat($('o-lng').value),
    radius: Number($('o-rad').value), amIn: $('o-amIn').value, amOut: $('o-amOut').value, pmIn: $('o-pmIn').value, pmOut: $('o-pmOut').value,
    grace: Math.max(0, Math.min(60, Number($('o-grace').value) || 0)),
    away: Math.max(3, Math.min(60, Number($('o-away').value) || 10)),
  });
  $('o-rad').addEventListener('input', () => { $('o-rv').textContent = $('o-rad').value + ' m'; });
  $('o-here').addEventListener('click', async () => {
    $('o-here').textContent = 'Getting GPS…'; $('o-here').disabled = true;
    try {
      const f = await getFix();
      officeDraft = { ...read(), lat: +f.lat.toFixed(6), lng: +f.lng.toFixed(6) };
      toast(`Location found (±${f.acc} m) — tap Save zone`);
      renderOffice(); return;
    } catch (e) { toast(e.message, 4000); }
    $('o-here').textContent = 'Use my current location'; $('o-here').disabled = false;
  });
  $('o-save').addEventListener('click', async () => {
    const o2 = read();
    if (!isFinite(o2.lat) || !isFinite(o2.lng) || Math.abs(o2.lat) > 90 || Math.abs(o2.lng) > 180) return toast('Enter a valid latitude and longitude');
    if (!o2.amIn || !o2.amOut || !o2.pmIn || !o2.pmOut) return toast('Fill in all shift times');
    try {
      // k = cos(latitude): lets the security rules check the distance with simple maths.
      await setDoc(doc(db, 'config', 'office'), { ...o2, k: Math.cos((o2.lat * Math.PI) / 180), updated: serverTimestamp(), by: me.id });
      officeDraft = null; toast('Office zone saved');
    } catch (e) { toast('Could not save (' + (e.code || e.message) + ')'); }
  });
}

// ----- Monthly report + Excel (CSV) export -----
function renderReportShell() {
  let m = T.monthInt(); const opts = [];
  for (let i = 0; i < 12; i++) { opts.push(`<option value="${m}">${T.monthName(m)}</option>`); m = T.prevMonth(m); }
  $('a-report').innerHTML = `<div class="mx" style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <select class="month-sel" id="r-month" style="flex:1">${opts.join('')}</select>
      <button class="btn small" id="r-export" style="height:44px">Export Excel</button></div>
    <div class="card pad mx"><div class="scroll-x" id="r-table"><div class="empty">Loading…</div></div></div>`;
  $('r-month').addEventListener('change', loadReport);
  $('r-export').addEventListener('click', exportReport);
  loadReport();
}
let reportRows = [];
async function loadReport() {
  const m = Number($('r-month').value);
  $('r-table').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const snap = await getDocs(query(collection(db, 'punches'), where('month', '==', m)));
    reportRows = []; snap.forEach((d) => reportRows.push(d.data()));
    const per = {};
    reportRows.forEach((p) => { ((per[p.emp] = per[p.emp] || {})[p.date] = per[p.emp][p.date] || {})[p.slot] = p; });
    const ids = Array.from(new Set([...staff.map((s) => s.id), ...Object.keys(per)]));
    const rows = ids.map((id) => {
      const s = staff.find((x) => x.id === id) || { name: id };
      const days = per[id] || {};
      let minutes = 0, late = 0, missed = 0;
      Object.entries(days).forEach(([di, p]) => {
        di = Number(di);
        minutes += dayWorked(p, di);
        SLOTS.forEach((x) => { if (p[x.id] && judge(x.id, ms(p[x.id].t), office) === 'late') late++; });
        if (di < T.dateInt() && !p.pmOut) missed++; // never checked out at night
      });
      return { s, id, days: Object.keys(days).length, minutes, late, missed };
    }).filter((r) => r.days || !r.s.disabled);
    $('r-table').innerHTML = `<table class="rep"><thead><tr><th>Employee</th><th>Days</th><th>Duty hours</th><th>Late / early</th><th>No night check-out</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><b>${esc(r.s.name)}</b><br><span class="muted">${esc(r.id.toUpperCase())}</span></td><td>${r.days}</td><td>${T.fmtDur(r.minutes)}</td><td style="color:${r.late ? 'var(--amber)' : 'inherit'}">${r.late}</td><td style="color:${r.missed ? 'var(--red)' : 'inherit'}">${r.missed}</td></tr>`).join('')}
    </tbody></table>`;
  } catch (e) { $('r-table').innerHTML = `<div class="empty">Could not load (${esc(e.code || e.message)})</div>`; }
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
async function exportReport() {
  const m = Number($('r-month').value);
  const per = {};
  reportRows.forEach((p) => { ((per[p.emp] = per[p.emp] || {})[p.date] = per[p.emp][p.date] || {})[p.slot] = p; });
  const lines = [['Date', 'Day', 'Employee ID', 'Name', 'Morning check-in', 'Leave for visits', 'Back from visits', 'Night check-out', 'Duty hours', 'Late / early', 'Added by admin', 'Auto-detected leave'].join(',')];
  Object.keys(per).sort().forEach((emp) => {
    const s = staff.find((x) => x.id === emp) || { name: emp };
    Object.keys(per[emp]).map(Number).sort((a, b) => a - b).forEach((di) => {
      const p = per[emp][di];
      const t = (x) => (p[x] ? T.hhmm(ms(p[x].t)) : '');
      const lateList = SLOTS.filter((x) => p[x.id] && judge(x.id, ms(p[x.id].t), office) === 'late').map((x) => x.short).join(' ');
      const man = SLOTS.filter((x) => p[x.id] && p[x.id].manual).map((x) => x.short).join(' ');
      const auto = SLOTS.filter((x) => p[x.id] && p[x.id].auto).map((x) => x.short).join(' ');
      const hrs = (dayWorked(p, di) / 60).toFixed(2);
      lines.push([T.isoDate(di), T.dowShort(di), emp.toUpperCase(), s.name, t('amIn'), t('amOut'), t('pmIn'), t('pmOut'), hrs, lateList, man, auto].map(csvCell).join(','));
    });
  });
  const csv = '﻿' + lines.join('\r\n'); // BOM so Excel reads Arabic names correctly
  const name = `FitX-Attendance-${String(m).slice(0, 4)}-${String(m).slice(4)}.csv`;
  try {
    if (native) {
      const r = await Filesystem.writeFile({ path: name, data: csv, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: name, files: [r.uri] });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  } catch (e) { if (!/cancel/i.test(String(e.message))) toast('Could not export (' + (e.message || e) + ')'); }
}

// ---------- Android lifecycle ----------
if (native) {
  App.addListener('appStateChange', ({ isActive }) => {
    if (!me) return;
    if (isActive) {
      if (auth.currentUser) syncClock(auth.currentUser.uid);
      if (T.dateInt() !== todayDate) { todayDate = T.dateInt(); watchToday(); if (isAdmin()) startAdmin(); }
      if (tab === 'punch') beginWatch();
      watchKey = null; syncOfficeWatch();
      renderPunch(); renderProfile();
    } else stopWatch();
  });
  App.addListener('backButton', () => {
    if (modalDone) { modalDone(null); return; }
    if (!$('s-setup').classList.contains('hidden')) { show('s-login'); return; }
    if (me && tab !== 'punch') { setTab('punch'); return; }
    App.minimizeApp();
  });
} else {
  document.addEventListener('visibilitychange', () => {
    if (!me) return;
    if (document.hidden) stopWatch(); else if (tab === 'punch') beginWatch();
  });
}
