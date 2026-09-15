#!/usr/bin/env node
/**
 * Codex `notify` wrapper for PetBuddy.
 *
 * config.toml:  notify = ["<node>", "<this script>", "--", "<original notify cmd>", "..."]
 *
 * Codex appends the event JSON as the last argv. This wrapper forwards it to
 * PetBuddy as a `turn-complete` event, then chains to the original notify
 * program (preserving whatever the user had configured before) and exits 0.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME_DIR = process.env.PETBUDDY_HOME || path.join(os.homedir(), '.petbuddy');

function readPort() {
  try {
    const p = parseInt(fs.readFileSync(path.join(HOME_DIR, 'port'), 'utf8').trim(), 10);
    if (p > 0) return p;
  } catch {}
  return 47650;
}

function post(port, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 2000,
    }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

const sep = process.argv.indexOf('--');
const chain = sep >= 0 ? process.argv.slice(sep + 1) : [];
const jsonArg = process.argv[process.argv.length - 1];

(async () => {
  let payload = {};
  try { payload = JSON.parse(jsonArg); } catch {}
  if (payload && (payload.type === 'agent-turn-complete' || payload['turn-id'])) {
    const msg = String(payload['last-assistant-message'] || payload.message || '任务完成');
    await post(readPort(), {
      app: 'codex', event: 'turn-complete',
      title: msg.length > 100 ? msg.slice(0, 99) + '…' : msg,
    });
  }
  // chain to the original notify program with the raw JSON argument
  if (chain.length) {
    try {
      const child = spawn(chain[0], [...chain.slice(1), jsonArg], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
    } catch {}
  }
  process.exit(0);
})().catch(() => process.exit(0));
