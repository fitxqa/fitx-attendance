// Bundles the app with the fake Firebase for browser tests → tests/www/
import * as esbuild from 'esbuild';
import fs from 'fs';
fs.rmSync('tests/www', { recursive: true, force: true });
fs.cpSync('www', 'tests/www', { recursive: true });
fs.writeFileSync('tests/www/firebase-config.js', 'window.FITX_CONFIG={firebase:{apiKey:"test",projectId:"test"},loginDomain:"fitxatt.local"};');
const fake = new URL('./fake-firebase.js', import.meta.url).pathname;
await esbuild.build({
  entryPoints: ['src/app.js'], bundle: true, outfile: 'tests/www/app.js', target: 'es2020',
  alias: { 'firebase/app': fake, 'firebase/auth': fake, 'firebase/firestore': fake },
});
console.log('test bundle ready');
