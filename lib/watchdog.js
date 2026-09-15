'use strict';
const { spawn } = require('child_process');
const net = require('net');

/**
 * Detects which watched apps are running.
 * - exe apps via `tasklist`
 * - headless/web apps via a TCP probe of their configured ports
 */

function tasklistNames() {
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true });
    let out = '';
    let settled = false;
    const done = (names, ok) => {
      if (settled) return;
      settled = true;
      resolve({ names, ok });
    };
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => done(new Set(), false));
    child.on('close', (code) => {
      const names = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/);
        if (m) names.add(m[1].toLowerCase());
      }
      // an empty list is virtually impossible on a live desktop session —
      // treat it as a failed poll so callers keep their previous state
      done(names, code === 0 && names.size > 0);
    });
    setTimeout(() => done(new Set(), false), 10000); // never hang the poll loop
  });
}

function portOpen(port, host = '127.0.0.1', timeout = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const finish = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(timeout, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

/** `metas` = array of app registry entries. Returns {appId: running} or null on failed poll. */
async function pollApps(metas) {
  const { names, ok } = await tasklistNames();
  if (!ok) return null; // keep previous state on a flaky tasklist
  const result = {};
  for (const app of metas || []) {
    let running = (app.processNames || []).some((n) => names.has(String(n).toLowerCase()));
    if (!running) {
      for (const p of app.ports || []) {
        if (await portOpen(p)) { running = true; break; }
      }
    }
    result[app.id] = running;
  }
  return result;
}

module.exports = { pollApps };
