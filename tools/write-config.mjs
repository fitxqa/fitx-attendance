// CI helper: turns the FITX_ATT_FIREBASE secret into www/firebase-config.js.
// The secret can be the JSON config, or the whole "const firebaseConfig = {...}" snippet from the Firebase console.
import fs from 'fs';
const raw = process.env.FITX_ATT_FIREBASE || '';
if (!raw.trim()) { console.log('::warning::FITX_ATT_FIREBASE secret not set — the app will show "Setup needed".'); process.exit(0); }
const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
if (a < 0 || b < a) { console.log('::error::FITX_ATT_FIREBASE does not contain a { ... } config block'); process.exit(1); }
let cfg;
try { cfg = Function(`"use strict"; return (${raw.slice(a, b + 1)});`)(); } catch (e) {
  console.log('::error::FITX_ATT_FIREBASE could not be read: ' + e.message); process.exit(1);
}
const need = ['apiKey', 'authDomain', 'projectId', 'appId'];
const miss = need.filter((k) => !cfg[k]);
if (miss.length) { console.log('::error::FITX_ATT_FIREBASE is missing: ' + miss.join(', ')); process.exit(1); }
// Catch the example from the instructions being pasted instead of the real settings
const fake = /xxxx|AIzaSy\.\.\.|^1234567890$|abc123/;
if (['apiKey', 'projectId', 'messagingSenderId', 'appId'].some((k) => fake.test(String(cfg[k])))) {
  console.log('::error::FITX_ATT_FIREBASE holds the EXAMPLE values (xxxx / 1234567890), not your project. Copy the real firebaseConfig from Firebase console → Project settings → Your apps.');
  process.exit(1);
}
const pick = ({ apiKey, authDomain, projectId, storageBucket = '', messagingSenderId = '', appId }) => ({ apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId });
fs.writeFileSync('www/firebase-config.js',
  `// Written by the build from the FITX_ATT_FIREBASE secret.\nwindow.FITX_CONFIG = ${JSON.stringify({ firebase: pick(cfg), loginDomain: 'fitxatt.local' }, null, 2)};\n`);
console.log(`Firebase project: ${cfg.projectId} ✔`);
