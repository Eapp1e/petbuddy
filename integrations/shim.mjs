/**
 * Regenerate ~/.petbuddy/pet-bridge.cmd — a tiny cmd shim so hook command
 * strings work identically under cmd.exe, PowerShell (DSH) and direct spawn:
 *
 *     C:\Users\hh\.petbuddy\pet-bridge.cmd --app dsh --event PreToolUse --spawn
 *
 * Quoting lives INSIDE the shim, so the hook command itself needs no quotes
 * as long as the shim path has none (the petbuddy data dir is chosen by the
 * user and rarely has spaces; when it does the installer quotes the shim path).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const findNode = require('../lib/node-resolve.cjs').findNode;

const PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PET_HOME = process.env.PETBUDDY_HOME || path.join(os.homedir(), '.petbuddy');

export function writeBridgeShim() {
  const node = findNode();
  const bridge = path.join(PET_ROOT, 'bridge', 'pet-bridge.mjs');
  const shim = path.join(PET_HOME, 'pet-bridge.cmd');
  fs.mkdirSync(PET_HOME, { recursive: true });
  fs.writeFileSync(shim, `@echo off\r\n"${node}" "${bridge}" %*\r\n`);
  return shim;
}

export function shimCommand(appId, event) {
  const shim = path.join(PET_HOME, 'pet-bridge.cmd');
  const needsQuote = /\s/.test(shim);
  const p = needsQuote ? `"${shim}"` : shim;
  return `${p} --app ${appId} --event ${event} --spawn`;
}
