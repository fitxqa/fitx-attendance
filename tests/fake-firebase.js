// In-memory stand-in for the parts of Firebase the app uses — for UI tests in a headless browser only.
const store = (window.__store = new Map());
const listeners = new Set();
let idc = 0;
const SERVER = { __server: true };
export class Timestamp {
  constructor(ms) { this._ms = ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
  toMillis() { return this._ms; }
}
const resolve = (data) => {
  const o = {};
  for (const [k, v] of Object.entries(data)) o[k] = v === SERVER ? new Timestamp(Date.now() + (window.__serverSkew || 0)) : v;
  return o;
};
const snap = (path) => {
  const id = path.split('/').pop();
  const d = store.get(path);
  return { id, ref: { path, id }, exists: () => d !== undefined, data: () => (d ? { ...d } : undefined) };
};
function matches(path, q) {
  const parts = path.split('/');
  if (parts.length !== 2 || parts[0] !== q.col) return false;
  const d = store.get(path);
  return (q.wheres || []).every(([f, op, v]) => op === '==' && d[f] === v);
}
function notify() {
  for (const l of listeners) l();
}
// --- app ---
export const initializeApp = () => ({});
// --- firestore ---
export const initializeFirestore = () => ({});
export const serverTimestamp = () => SERVER;
export const collection = (db, name) => ({ col: name, type: 'col' });
export function doc(a, ...segs) {
  if (a && a.type === 'col') { const id = segs[0] || 'auto' + ++idc; return { path: `${a.col}/${id}`, id }; }
  return { path: segs.join('/'), id: segs[segs.length - 1] };
}
export const where = (f, op, v) => [f, op, v];
export const query = (c, ...wheres) => ({ col: c.col, wheres });
const guard = () => { if (window.__offline) throw { code: 'unavailable' }; };
export async function getDoc(ref) { guard(); return snap(ref.path); }
export async function setDoc(ref, data) { guard(); if (window.__rules) window.__rules('set', ref.path, resolve(data)); store.set(ref.path, resolve(data)); notify(); }
export async function updateDoc(ref, data) { guard(); store.set(ref.path, { ...store.get(ref.path), ...resolve(data) }); notify(); }
export async function deleteDoc(ref) { store.delete(ref.path); notify(); }
export async function getDocs(q) {
  const docs = [...store.keys()].filter((p) => matches(p, q)).map(snap);
  return { forEach: (f) => docs.forEach(f), docs };
}
export function onSnapshot(target, cb, err) {
  const run = () => {
    if (target.wheres) { const docs = [...store.keys()].filter((p) => matches(p, target)).map(snap); cb({ forEach: (f) => docs.forEach(f), docs }); }
    else if (target.type === 'col') { const docs = [...store.keys()].filter((p) => p.split('/')[0] === target.col && p.split('/').length === 2).map(snap); cb({ forEach: (f) => docs.forEach(f), docs }); }
    else cb(snap(target.path));
  };
  const l = () => setTimeout(run, 0);
  listeners.add(l); l();
  return () => listeners.delete(l);
}
export function writeBatch() {
  const ops = [];
  return {
    set: (r, d) => ops.push(() => store.set(r.path, resolve(d))),
    update: (r, d) => ops.push(() => store.set(r.path, { ...store.get(r.path), ...resolve(d) })),
    delete: (r) => ops.push(() => store.delete(r.path)),
    commit: async () => { ops.forEach((o) => o()); notify(); },
  };
}
// --- auth ---
const users = (window.__users = new Map()); // email -> {uid, pass}
export const indexedDBLocalPersistence = {}, browserLocalPersistence = {}, inMemoryPersistence = {};
export const initializeAuth = () => ({ currentUser: null, cbs: [] });
const fire = (a) => a.cbs.forEach((c) => setTimeout(() => c(a.currentUser), 0));
export function onAuthStateChanged(a, cb) { a.cbs.push(cb); setTimeout(() => cb(a.currentUser), 0); return () => {}; }
export async function signInWithEmailAndPassword(a, email, pass) {
  const u = users.get(email);
  if (!u || u.pass !== pass) throw { code: 'auth/invalid-credential' };
  a.currentUser = { uid: u.uid, email }; fire(a); return { user: a.currentUser };
}
export async function createUserWithEmailAndPassword(a, email, pass) {
  if (users.has(email)) throw { code: 'auth/email-already-in-use' };
  const uid = 'u' + ++idc; users.set(email, { uid, pass });
  a.currentUser = { uid, email }; fire(a); return { user: a.currentUser };
}
export async function signOut(a) { a.currentUser = null; fire(a); }
export async function updatePassword(u, p) { users.get(u.email).pass = p; }
export async function reauthenticateWithCredential(u, c) { if (users.get(u.email).pass !== c.pass) throw { code: 'auth/wrong-password' }; }
export const EmailAuthProvider = { credential: (email, pass) => ({ email, pass }) };
