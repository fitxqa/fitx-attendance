// Builds the FitX Attendance launcher icons + splash screens from the logo (black, white "Fit", orange "X").
// Run: node tools/make-icons.mjs
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import opentype from 'opentype.js';

const RES = 'android/app/src/main/res';
const fontBuf = fs.readFileSync('node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff');
const font = opentype.parse(fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength));
const smallBuf = fs.readFileSync('node_modules/@fontsource/inter/files/inter-latin-600-normal.woff');
const small = opentype.parse(smallBuf.buffer.slice(smallBuf.byteOffset, smallBuf.byteOffset + smallBuf.byteLength));

// Glyph-by-glyph (avoids opentype.js shaping features it can't handle)
function textPath(f, text, x, y, size) {
  let d = '', cx = x, prev = null;
  for (const ch of text) {
    const g = f.charToGlyph(ch);
    if (prev) cx += f.getKerningValue(prev, g) * size / f.unitsPerEm;
    d += g.getPath(cx, y, size).toPathData({ decimalPlaces: 2, optimize: false, flipY: false });
    cx += g.advanceWidth * size / f.unitsPerEm; prev = g;
  }
  return { d, w: cx - x };
}
const width = (f, text, size) => textPath(f, text, 0, 0, size).w;
// "Fit" + "X" as paths, centred at (cx, cy) with cap height ~ h
function logo(cx, cy, size) {
  const fit = width(font, 'Fit', size), x = width(font, 'X', size);
  const w = fit + x, left = cx - w / 2, base = cy + size * 0.35;
  const p1 = textPath(font, 'Fit', left, base, size).d;
  const p2 = textPath(font, 'X', left + fit, base, size).d;
  return `<path d="${p1}" fill="#ffffff"/><path d="${p2}" fill="#ff6b00"/>`;
}
function label(text, cx, y, size, color) {
  const w = width(small, text, size);
  return `<path d="${textPath(small, text, cx - w / 2, y, size).d}" fill="${color}"/>`;
}
// location ring motif
const ring = (cx, cy, r, sw) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff6b00" stroke-width="${sw}" stroke-dasharray="${sw * 1.6} ${sw * 1.4}" opacity=".9"/>`;

// Full icon (legacy + round): 512 canvas
function iconSvg(round) {
  const shape = round ? '<circle cx="256" cy="256" r="256" fill="#0b0b0b"/>' : '<rect width="512" height="512" rx="96" fill="#0b0b0b"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${shape}${ring(256, 256, 196, 10)}${logo(256, 238, 170)}${label('ATTENDANCE', 256, 352, 34, '#bdbdbd')}</svg>`;
}
// Adaptive foreground: 432 canvas, keep art inside the central 288 safe zone
function fgSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="0 0 432 432">${ring(216, 216, 132, 7)}${logo(216, 202, 112)}${label('ATTENDANCE', 216, 280, 22, '#bdbdbd')}</svg>`;
}

const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const fg = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [d, px] of Object.entries(legacy)) {
  const dir = path.join(RES, `mipmap-${d}`);
  await sharp(Buffer.from(iconSvg(false))).resize(px, px).png().toFile(path.join(dir, 'ic_launcher.png'));
  await sharp(Buffer.from(iconSvg(true))).resize(px, px).png().toFile(path.join(dir, 'ic_launcher_round.png'));
  await sharp(Buffer.from(fgSvg())).resize(fg[d], fg[d]).png().toFile(path.join(dir, 'ic_launcher_foreground.png'));
}
fs.writeFileSync(path.join(RES, 'values/ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B0B0B</color>\n</resources>\n');
// Splash: logo art drawn at 512 (renders cleanly), then centred on a black canvas of each splash size
const art = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${ring(256, 256, 196, 8)}${logo(256, 232, 150)}${label('SPORTS EQUIPMENT SERVICES', 256, 330, 22, '#a3a3a3')}</svg>`;
for (const dir of fs.readdirSync(RES)) {
  const f = path.join(RES, dir, 'splash.png');
  if (!fs.existsSync(f)) continue;
  const { width, height } = await sharp(f).metadata();
  const s = Math.round(Math.min(width, height) * 0.6);
  const logoPng = await sharp(Buffer.from(art)).resize(s, s).png().toBuffer();
  const out = await sharp({ create: { width, height, channels: 4, background: '#0b0b0b' } })
    .composite([{ input: logoPng, gravity: 'center' }]).png().toBuffer();
  fs.writeFileSync(f, out);
}
// Store/preview copy
await sharp(Buffer.from(iconSvg(false))).png().toFile('tools/icon-512.png');
console.log('icons + splash done');
