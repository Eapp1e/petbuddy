'use strict';
/** Shared CJS helpers so both the ESM installer and CJS main process can resolve node. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function findNode() {
  if (process.env.PETBUDDY_NODE && fs.existsSync(process.env.PETBUDDY_NODE)) {
    return process.env.PETBUDDY_NODE;
  }
  const candidates = [];
  try {
    const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
    const vers = fs.readdirSync(base).sort().reverse();
    for (const v of vers) candidates.push(path.join(base, v, 'node.exe'));
  } catch {}
  candidates.push('D:\\NodeJS\\node.exe');
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return execSync('where node', { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); }
  catch { return 'node'; }
}

module.exports = { findNode };
