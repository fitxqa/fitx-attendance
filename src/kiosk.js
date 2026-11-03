// Office kiosk: one shared tablet in the office. Technician taps their name, enters their
// 4-digit PIN, the front camera takes a photo, and the next punch is saved for them.
// The kiosk signs in with its own "kiosk" login, which can only create punches + photos.
import { doc, collection, query, where, onSnapshot, writeBatch, setDoc, serverTimestamp } from 'firebase/firestore';

// Face engine (www/face.js) is loaded on demand. Tests can put their own window.FitxFace first.
let faceLoading = null;
export function loadFaceLib() {
  if (window.FitxFace) return window.FitxFace.load().then(() => window.FitxFace);
  if (!faceLoading) {
    faceLoading = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'face.js'; s.onload = () => ok(); s.onerror = () => { faceLoading = null; fail(new Error('face.js')); };
      document.head.appendChild(s);
    }).then(() => window.FitxFace.load()).then(() => window.FitxFace);
    faceLoading.catch(() => { faceLoading = null; });
  }
  return faceLoading;
}
const sleep = (t) => new Promise((r) => setTimeout(r, t));
// Scan the video until a clear face is seen. Returns { desc } or { error }.
export async function scanFace(video, onMsg, { frames = 1, timeout = 10000 } = {}) {
  const F = await loadFaceLib();
  const got = [];
  const end = Date.now() + timeout;
  while (Date.now() < end && got.length < frames) {
    if (!video.videoWidth) { await sleep(200); continue; }
    let r;
    try { r = await F.describe(video); } catch (e) { return { error: 'Face scan failed' }; }
    if (!r.faces) onMsg('Look straight at the camera');
    else if (r.size < 0.12) onMsg('Come a little closer');
    else { got.push(r.desc); onMsg(frames > 1 ? `Hold still… ${got.length}/${frames}` : 'Face found'); }
    await sleep(frames > 1 ? 350 : 120);
  }
  if (got.length < frames) return { error: 'No clear face found — look at the camera and try again' };
  return { desc: got[0], descs: got };
}

export async function pinHash(emp, pin) {
  const data = new TextEncoder().encode(`fitx:${emp}:${pin}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function startKiosk(ctx) {
  const { db, me, T, SLOTS, SLOT, nextSlot, judge, OFFICE_DEFAULT, esc, initials, toast, exitKiosk, $ } = ctx;
  const root = $('s-kiosk');
  let faces = {};
  let staff = [], pins = {}, punches = {}, office = { ...OFFICE_DEFAULT }, todayDate = T.dateInt();
  let sel = null, pin = '', busy = false, fails = {}, idleT = null, stream = null, wake = null;
  const unsubs = [];
  const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : typeof ts === 'number' ? ts : 0);

  root.innerHTML = `
    <div class="kiosk">
      <header class="k-top">
        <div><div class="logo" style="font-size:38px">Fit<b>X</b></div><div class="tag" id="k-office">Office kiosk</div></div>
        <div style="text-align:right"><div class="k-clock disp" id="k-clock">--:--</div><div class="muted" id="k-date" style="font-size:14px"></div><div id="k-face" style="margin-top:6px"><span class="pill grey"><i></i>Loading face scan…</span></div></div>
      </header>
      <div class="k-hint">Tap your name, enter your PIN and look at the camera</div>
      <div class="k-grid" id="k-grid"><div class="empty">Loading…</div></div>
      <button class="link k-exit" id="k-exit" type="button">Exit kiosk</button>
    </div>
    <div class="k-overlay hidden" id="k-ov" role="dialog" aria-modal="true" aria-labelledby="k-name">
      <div class="k-panel">
        <div class="k-cam"><video id="k-video" autoplay playsinline muted></video><div class="k-oval" aria-hidden="true"></div><div class="k-nocam hidden" id="k-nocam">Camera not available</div></div>
        <div class="k-side">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
            <div><div class="k-name" id="k-name"></div><div class="k-action" id="k-action"></div></div>
            <button class="icon-btn" id="k-close" aria-label="Cancel"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
          </div>
          <div class="k-dots" id="k-dots" aria-live="polite"></div>
          <div class="k-msg" id="k-msg" role="alert"></div>
          <div class="k-pad" id="k-pad">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join('')}
            <button type="button" data-k="clr" aria-label="Clear">C</button><button type="button" data-k="0">0</button><button type="button" data-k="del" aria-label="Delete">⌫</button>
          </div>
        </div>
      </div>
      <div class="k-done hidden" id="k-done">
        <img id="k-photo" alt="Punch photo">
        <div class="k-tick"><svg width="40" height="40" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10" fill="none" stroke="#0b0b0b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div class="k-name" id="k-dname"></div>
        <div class="k-action" id="k-daction"></div>
      </div>
    </div>`;

  // ---- data ----
  unsubs.push(onSnapshot(collection(db, 'staff'), (s) => {
    staff = []; s.forEach((d) => { const x = d.data(); if (x.role !== 'kiosk' && !x.disabled) staff.push({ id: d.id, ...x }); });
    staff.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    render();
  }, (e) => { $('k-grid').innerHTML = `<div class="empty">Cannot load employees (${esc(e.code || e.message)}). Publish the latest rules.</div>`; }));
  unsubs.push(onSnapshot(collection(db, 'pins'), (s) => { pins = {}; s.forEach((d) => { pins[d.id] = d.data().hash; }); render(); }, () => {}));
  unsubs.push(onSnapshot(collection(db, 'faces'), (s) => { faces = {}; s.forEach((d) => { faces[d.id] = d.data().descs || []; }); }, () => {}));
  // Face engine: load in the background so the first scan is quick.
  let faceReady = false;
  loadFaceLib().then(() => { faceReady = true; $('k-face').innerHTML = '<span class="pill green"><i></i>Face scan ready</span>'; })
    .catch(() => { $('k-face').innerHTML = '<span class="pill red"><i></i>Face scan not available</span>'; });
  unsubs.push(onSnapshot(doc(db, 'config', 'office'), (s) => { office = { ...OFFICE_DEFAULT, ...(s.exists() ? s.data() : {}) }; $('k-office').textContent = office.name + ' · kiosk'; render(); }, () => {}));
  let punchUnsub = null;
  function watchPunches() {
    if (punchUnsub) punchUnsub();
    punchUnsub = onSnapshot(query(collection(db, 'punches'), where('date', '==', todayDate)), (s) => {
      punches = {}; s.forEach((d) => { const p = d.data(); (punches[p.emp] = punches[p.emp] || {})[p.slot] = p; });
      render();
    }, () => {});
  }
  watchPunches();
  unsubs.push(() => punchUnsub && punchUnsub());

  // ---- clock / day roll / keep screen on ----
  const tick = () => {
    const n = T.now();
    $('k-clock').textContent = T.hhmm(n);
    $('k-date').textContent = T.longDate(n);
    if (T.dateInt() !== todayDate) { todayDate = T.dateInt(); watchPunches(); }
  };
  tick();
  const clockT = setInterval(tick, 15000);
  unsubs.push(() => clearInterval(clockT));
  const keepAwake = async () => { try { if (navigator.wakeLock && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch (e) {} };
  keepAwake();
  const vis = () => keepAwake();
  document.addEventListener('visibilitychange', vis);
  unsubs.push(() => { document.removeEventListener('visibilitychange', vis); try { wake && wake.release(); } catch (e) {} });

  // ---- tiles ----
  function status(p) {
    if (!p || !Object.keys(p).length) return ['Not in yet', 'grey'];
    if (p.pmOut) return ['Day done', 'grey'];
    if (p.pmIn) return ['In office', 'green'];
    if (p.amOut) return ['On site visits', 'orange'];
    return ['In office', 'green'];
  }
  function render() {
    if (!staff.length) { $('k-grid').innerHTML = '<div class="empty">No employees yet</div>'; return; }
    $('k-grid').innerHTML = staff.map((s) => {
      const p = punches[s.id] || {};
      const [st, col] = status(p);
      const nx = nextSlot(p, office);
      return `<button class="k-tile" data-emp="${esc(s.id)}" type="button">
        <span class="av" style="width:56px;height:56px;font-size:18px">${esc(initials(s.name))}</span>
        <span class="k-tn">${esc(s.name)}</span>
        <span class="pill ${col}"><i></i>${st}</span>
        <span class="k-next">${!pins[s.id] ? 'No PIN — ask admin' : nx ? 'Next: ' + esc(SLOT[nx].label) : 'All punches done'}</span>
      </button>`;
    }).join('');
    $('k-grid').querySelectorAll('[data-emp]').forEach((b) => b.addEventListener('click', () => open(b.dataset.emp)));
  }

  // ---- PIN panel ----
  async function startCam() {
    $('k-nocam').classList.add('hidden');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      $('k-video').srcObject = stream;
    } catch (e) { stream = null; $('k-nocam').classList.remove('hidden'); }
  }
  function stopCam() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    $('k-video').srcObject = null;
  }
  function snap() {
    const v = $('k-video');
    if (!stream || !v.videoWidth) return null;
    const w = 360, h = Math.round((v.videoHeight / v.videoWidth) * w);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.translate(w, 0); g.scale(-1, 1); // mirror, like the preview
    g.drawImage(v, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.6);
  }
  function dots() { $('k-dots').innerHTML = [0, 1, 2, 3].map((i) => `<span class="${i < pin.length ? 'on' : ''}"></span>`).join(''); }
  function idle() { clearTimeout(idleT); idleT = setTimeout(close, 30000); }

  function open(emp) {
    const s = staff.find((x) => x.id === emp); if (!s) return;
    const p = punches[emp] || {};
    const nx = nextSlot(p, office);
    if (!pins[emp]) { toast(`${s.name} has no kiosk PIN yet — ask the admin to set one`, 3500); return; }
    if (!nx) { toast(`${s.name}: all punches for today are done`, 3000); return; }
    sel = { emp, name: s.name, slot: nx };
    pin = ''; dots();
    $('k-msg').textContent = '';
    $('k-name').textContent = s.name;
    $('k-action').textContent = SLOT[nx].label;
    $('k-done').classList.add('hidden');
    $('k-ov').classList.remove('hidden');
    startCam(); idle();
  }
  function close() {
    clearTimeout(idleT); stopCam(); sel = null; pin = ''; busy = false;
    $('k-ov').classList.add('hidden');
  }
  $('k-close').addEventListener('click', close);
  $('k-pad').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]'); if (!b || !sel || busy) return;
    idle();
    const k = b.dataset.k;
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k === 'clr') pin = '';
    else if (pin.length < 4) pin += k;
    $('k-msg').textContent = '';
    dots();
    if (pin.length === 4) submit();
  });

  async function submit() {
    const { emp, name, slot } = sel;
    const f = fails[emp];
    if (f && f.until > Date.now()) {
      $('k-msg').textContent = `Too many wrong PINs. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} s.`;
      pin = ''; dots(); return;
    }
    busy = true;
    const ok = (await pinHash(emp, pin)) === pins[emp];
    if (!ok) {
      const n = (f && f.until <= Date.now() ? 0 : (f ? f.n : 0)) + 1;
      fails[emp] = { n, until: n >= 5 ? Date.now() + 60000 : 0 };
      $('k-msg').textContent = n >= 5 ? 'Wrong PIN 5 times — locked for 1 minute.' : 'Wrong PIN, try again';
      $('k-dots').classList.add('shake'); setTimeout(() => $('k-dots').classList.remove('shake'), 400);
      pin = ''; dots(); busy = false; return;
    }
    delete fails[emp];
    // ---- face scan (PIN was right) ----
    if (!stream) { $('k-msg').textContent = 'Camera needed for the face scan'; pin = ''; dots(); busy = false; return; }
    $('k-msg').style.color = 'var(--orange2)';
    const say = (t) => { $('k-msg').textContent = t; };
    const enrolled = (faces[emp] || []).length > 0;
    say(enrolled ? 'Scanning face…' : 'First time: registering your face…');
    let scan;
    try { scan = await scanFace($('k-video'), say, { frames: enrolled ? 1 : 3 }); } catch (e) { scan = { error: 'Face scan not available — ask the admin' }; }
    $('k-msg').style.color = '';
    if (scan.error) { say(scan.error); pin = ''; dots(); busy = false; idle(); return; }
    let faceVal;
    if (enrolled) {
      const d = window.FitxFace.best(scan.desc, faces[emp]);
      if (d >= window.FitxFace.MATCH) {
        const shot = snap();
        try { await setDoc(doc(collection(db, 'alerts')), { emp, name, slot, kind: 'face', dist: Math.round(d * 1000) / 1000, by: me.id, img: shot || '', t: serverTimestamp() }); } catch (e) {}
        const n = (fails[emp] ? fails[emp].n : 0) + 1;
        fails[emp] = { n, until: n >= 5 ? Date.now() + 60000 : 0 };
        say(`Face does not match ${name}. The admin has been notified.`);
        $('k-dots').classList.add('shake'); setTimeout(() => $('k-dots').classList.remove('shake'), 400);
        pin = ''; dots(); busy = false; idle(); return;
      }
      faceVal = Math.round(d * 1000) / 1000;
    } else {
      try { await setDoc(doc(db, 'faces', emp), { descs: scan.descs, by: me.id, t: serverTimestamp(), img: snap() || '' }); faces[emp] = scan.descs; }
      catch (e) { say('Could not register the face — ask the admin'); pin = ''; dots(); busy = false; return; }
      faceVal = 'new';
    }
    const photo = snap();
    const di = T.dateInt();
    const pid = `${emp}_${di}_${slot}`;
    try {
      const b = writeBatch(db);
      b.set(doc(db, 'punches', pid), {
        emp, name, slot, date: di, month: Math.floor(di / 100), t: serverTimestamp(),
        lat: null, lng: null, acc: null, dist: null, device: null, manual: false, kiosk: true, by: me.id, photo: !!photo, face: faceVal,
      });
      if (photo) b.set(doc(db, 'photos', pid), { emp, date: di, by: me.id, img: photo, t: serverTimestamp() });
      await b.commit();
      stopCam();
      $('k-photo').src = photo || '';
      $('k-photo').classList.toggle('hidden', !photo);
      $('k-dname').textContent = name;
      $('k-daction').textContent = `${SLOT[slot].label} · ${T.hhmm(T.now())}${faceVal === 'new' ? ' · face registered' : ' · face matched'}`;
      $('k-done').classList.remove('hidden');
      if (navigator.vibrate) navigator.vibrate(80);
      clearTimeout(idleT); idleT = setTimeout(close, 3500);
    } catch (e) {
      const c = String(e.code || e.message || '');
      $('k-msg').textContent = c.includes('permission') ? 'Punch refused (already saved, wrong order, or rules not published)' : 'Could not save — check the internet';
      pin = ''; dots(); busy = false;
    }
  }

  $('k-exit').addEventListener('click', exitKiosk);

  return () => { close(); unsubs.forEach((f) => { try { f(); } catch (e) {} }); root.innerHTML = ''; };
}
