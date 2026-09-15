'use strict';
/**
 * 按官网域名抓取应用的官方图标（favicon）。
 * 尝试顺序：站点 /favicon.ico → 聚合服务 → 备用服务，
 * 校验图片魔数后存到 ~/.petbuddy/icons/<id>.<ext>。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function getBuf(url, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 3) return resolve(null);
    let mod;
    try {
      mod = url.startsWith('http:') ? http : https;
    } catch {
      return resolve(null);
    }
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 PetBuddy/1.0' }, timeout: 8000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        try {
          return resolve(getBuf(new URL(res.headers.location, url).href, depth + 1));
        } catch {
          return resolve(null);
        }
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { chunks.push(c); size += c.length; if (size > 2 * 1024 * 1024) req.destroy(); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function isImage(buf) {
  return buf && buf.length > 100 && (
    (buf[0] === 0x89 && buf[1] === 0x50) ||  // PNG
    (buf[0] === 0xFF && buf[1] === 0xD8) ||  // JPEG
    (buf[0] === 0x47 && buf[1] === 0x49) ||  // GIF
    (buf[0] === 0x3C && buf[1] === 0x3F)     // <?xml …（svg）
  );
}

function extOf(buf) {
  if (buf[0] === 0x89) return 'png';
  if (buf[0] === 0xFF) return 'jpg';
  if (buf[0] === 0x47) return 'gif';
  return 'svg';
}

/** @returns {Promise<{ok:boolean, path?:string, source?:string, error?:string}>} */
async function fetchAppIcon(id, site, dataDir) {
  const cleanId = String(id || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(cleanId)) return { ok: false, error: '应用 id 不合法' };
  const host = String(site || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  if (!host || !host.includes('.')) return { ok: false, error: '请先填写官网域名（如 cursor.com）' };

  const tries = [
    `https://${host}/favicon.ico`,
    `https://api.iowen.cn/favicon/${host}.png`,
    `https://favicon.im/${host}?larger=true`,
  ];
  for (const u of tries) {
    const buf = await getBuf(u);
    if (isImage(buf)) {
      const dir = path.join(dataDir, 'icons');
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, `${cleanId}.${extOf(buf)}`);
      fs.writeFileSync(fp, buf);
      return { ok: true, path: fp, source: u };
    }
  }
  return { ok: false, error: '没抓到可用图标：可确认官网域名，或手动填图标路径' };
}

module.exports = { fetchAppIcon };
