'use strict';
/**
 * Minimal PNG writer (no native deps): builds small RGBA PNGs for the tray icon
 * and the app icon on first run. zlib deflate comes from node core.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function pngFromRgba(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  // filter 0 per scanline
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Draw a rounded blob creature with two eyes at the given size. */
function drawBlobIcon(size, bodyColor, alpha = 255) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = size * 0.42, cx = size / 2, cy = size * 0.55;
  const eyeY = cy - size * 0.04, eyeDX = size * 0.15, eyeR = size * 0.06;
  const ear = size * 0.16; // little cat ears
  const earX = size * 0.24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = ((x - cx) / r) ** 2 + ((y - cy) / r) ** 2 <= 1;
      // ears: two triangles-ish circles above the body
      const e1 = ((x - earX) / ear) ** 2 + ((y - (cy - r * 0.85)) / ear) ** 2 <= 1;
      const e2 = ((x - (size - earX)) / ear) ** 2 + ((y - (cy - r * 0.85)) / ear) ** 2 <= 1;
      if (e1 || e2) inside = true;
      const i = (y * size + x) * 4;
      if (!inside) { rgba[i + 3] = 0; continue; }
      let [rr, gg, bb] = bodyColor;
      const dEye = Math.min(
        Math.hypot(x - (cx - eyeDX), y - eyeY),
        Math.hypot(x - (cx + eyeDX), y - eyeY)
      );
      if (dEye <= eyeR) { rr = gg = bb = 30; } // dark eyes
      rgba[i] = rr; rgba[i + 1] = gg; rgba[i + 2] = bb; rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

/** Draw the EVE mascot: wide black visor wrapping the head, body tapering
 *  downward, small blue LED eyes — matching the petdex spritesheet.
 *  Small sizes use bolder shapes plus a gray rim so the tray glyph stays
 *  legible on both dark and light taskbars. */
function drawEveIcon(size) {
  const bold = size <= 24;
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size * 0.55;
  const rx = size * 0.40, ry = size * 0.46;
  const faceL = cx - size * (bold ? 0.40 : 0.375), faceR = cx + size * (bold ? 0.40 : 0.375);
  const faceT = cy - size * (bold ? 0.42 : 0.40), faceB = cy - size * (bold ? 0.00 : 0.02);
  const fr = size * (bold ? 0.18 : 0.16);
  const eyeW = size * (bold ? 0.075 : 0.052), eyeH = size * (bold ? 0.10 : 0.075), eyeDx = size * (bold ? 0.14 : 0.13);
  const eyeY = cy - size * 0.24;
  const outline = size * 0.02; // thin gray rim so the egg reads on light bg
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inEgg = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const inRim = !inEgg && ((x - cx) / (rx + outline)) ** 2 + ((y - cy) / (ry + outline)) ** 2 <= 1;
      if (!inEgg && !inRim) continue;
      const i = (y * size + x) * 4;
      let rr = 248, gg = 250, bb = 253; // white shell
      if (inRim) { rr = 106; gg = 110; bb = 120; } // gray rim
      const nx = Math.max(faceL + fr - x, 0, x - (faceR - fr));
      const ny = Math.max(faceT + fr - y, 0, y - (faceB - fr));
      const inFaceRect = x >= faceL && x <= faceR && y >= faceT && y <= faceB;
      if (inEgg && (nx * nx + ny * ny <= fr * fr || inFaceRect)) {
        rr = 10; gg = 15; bb = 26; // dark visor
        const dL = Math.hypot((x - (cx - eyeDx)) / eyeW, (y - eyeY) / eyeH);
        const dR = Math.hypot((x - (cx + eyeDx)) / eyeW, (y - eyeY) / eyeH);
        if (Math.min(dL, dR) <= 1) { rr = 53; gg = 200; bb = 255; } // LED eyes
      }
      rgba[i] = rr; rgba[i + 1] = gg; rgba[i + 2] = bb; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const ICONS_VERSION = 'eve-ico-v3';

/**
 * Build a real multi-resolution .ico: every size is rendered natively by the
 * draw function (no downscaling), so 16px tray glyphs stay crisp.
 * Entry format: BITMAPINFOHEADER + 32bpp bottom-up XOR + empty AND mask.
 */
function icoFromDraw(draw, sizes) {
  const images = sizes.map((size) => {
    const rgba = draw(size);
    const w = size, h = size;
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(w, 4);
    header.writeInt32LE(h * 2, 8); // XOR + AND mask height
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(w * h * 4, 20);
    const xor = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = ((h - 1 - y) * w + x) * 4;
        const di = (y * w + x) * 4;
        xor[di] = rgba[si + 2]; xor[di + 1] = rgba[si + 1];
        xor[di + 2] = rgba[si]; xor[di + 3] = rgba[si + 3];
      }
    }
    const andRow = Math.ceil(w / 32) * 4;
    const and = Buffer.alloc(andRow * h);
    return { buf: Buffer.concat([header, xor, and]), size };
  });
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = [];
  const datas = [];
  for (const { buf, size } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e); datas.push(buf);
  }
  return Buffer.concat([dir, ...entries, ...datas]);
}

function ensureIcons(assetsDir) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const tray = path.join(assetsDir, 'tray.ico');
  const icon = path.join(assetsDir, 'icon.ico');
  const marker = path.join(assetsDir, '.' + ICONS_VERSION);
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(tray, icoFromDraw(drawEveIcon, [16, 20, 24, 32, 48]));
    fs.writeFileSync(icon, icoFromDraw(drawEveIcon, [32, 48, 64, 128, 256]));
    fs.writeFileSync(marker, '1');
    for (const old of ['tray.png', 'icon.png']) {
      try { fs.unlinkSync(path.join(assetsDir, old)); } catch {}
    }
  }
  return { tray, icon };
}

module.exports = { ensureIcons, pngFromRgba, drawBlobIcon, drawEveIcon };
