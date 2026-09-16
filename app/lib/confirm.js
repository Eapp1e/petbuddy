'use strict';
const { spawn } = require('child_process');
const path = require('path');
const apps = require('./apps');

const FOCUS_SEND_PS1 = path.join(__dirname, '..', '..', 'bridge', 'focus-send.ps1');

/**
 * Send a SendKeys sequence to an app's main window.
 * seq format: SendKeys tokens separated by `~~`, e.g. "1~~{ENTER}".
 * Returns { sent, code, error }.
 */
function sendKeysToApp(processName, seq, delayMs = 160) {
  return new Promise((resolve) => {
    if (!processName || !seq) return resolve({ sent: false, error: 'no target or keys' });
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_SEND_PS1,
      '-Process', processName,
      '-Keys', seq,
      '-DelayMs', String(delayMs),
    ];
    const child = spawn('powershell.exe', args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ sent: false, error: String(e) }));
    child.on('close', (code) => {
      if (code === 0) resolve({ sent: true });
      else resolve({ sent: false, code, error: err.trim() || `exit ${code}` });
    });
  });
}

/** Primary process name used for focusing (first configured name). */
function focusTarget(appId) {
  const app = apps.getApp(appId);
  return app && app.processNames.length ? app.processNames[0].replace(/\.exe$/i, '') : null;
}

/** Effective key sequences: settings override > registry default. */
function keySequences(appId, settings) {
  const app = apps.getApp(appId) || { keys: { approve: '', deny: '' } };
  const ov = (settings && settings.keys && settings.keys[appId]) || {};
  return {
    approve: ov.approve !== undefined ? ov.approve : app.keys.approve,
    deny: ov.deny !== undefined ? ov.deny : app.keys.deny,
  };
}

module.exports = { sendKeysToApp, focusTarget, keySequences, FOCUS_SEND_PS1 };
