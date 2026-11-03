// Face recognition for the office kiosk (runs on the tablet, offline). Built to www/face.js
// and loaded only on the kiosk / admin face registration, so the phone app stays light.
import * as faceapi from '@vladmandic/face-api/dist/face-api.esm.js';

let ready = null;
function load() {
  if (!ready) {
    ready = (async () => {
      try { await faceapi.tf.setBackend('webgl'); } catch (e) { await faceapi.tf.setBackend('cpu'); }
      await faceapi.tf.ready();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('models'),
      ]);
      return faceapi.tf.getBackend();
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

// One image / video frame → { faces, desc (128 numbers) of the biggest face, score, box }
async function describe(input) {
  await load();
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
  const res = await faceapi.detectAllFaces(input, opts).withFaceLandmarks().withFaceDescriptors();
  if (!res.length) return { faces: 0 };
  const area = (r) => r.detection.box.width * r.detection.box.height;
  const best = res.reduce((a, b) => (area(b) > area(a) ? b : a));
  const W = input.videoWidth || input.naturalWidth || input.width || 1;
  return { faces: res.length, desc: Array.from(best.descriptor), score: best.detection.score, size: best.detection.box.width / W };
}

const distance = (a, b) => faceapi.euclideanDistance(a, b);
// Smallest distance to any saved descriptor (lower = more alike). Same person is usually < 0.45.
const best = (desc, saved) => Math.min(...saved.map((s) => distance(desc, s)));

// Boxes of every face found (used for testing and diagnostics)
async function boxes(input) {
  await load();
  const r = await faceapi.detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }));
  return r.map((d) => ({ x: d.box.x, y: d.box.y, w: d.box.width, h: d.box.height }));
}

window.FitxFace = { load, describe, distance, best, boxes, MATCH: 0.5 };
