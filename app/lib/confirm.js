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
function sendKeysToApp(processName, seq, delayMs = 160, focusOnly = false) {
  return new Promise((resolve) => {
    if (!processName) return resolve({ sent: false, error: 'no target' });
    if (!focusOnly && !seq) return resolve({ sent: false, error: 'no keys' });
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_SEND_PS1,
      '-Process', processName,
      '-DelayMs', String(delayMs),
    ];
    if (focusOnly) args.push('-FocusOnly');
    else args.push('-Keys', seq);
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

/** SendKeys 特殊字符转义（+ ^ % ~ ( ) { } [ ] 需用花括号包起来） */
function escapeSendKeys(text) {
  // 顺序很重要：先转义特殊字符，再把换行换成 {ENTER}，
  // 否则刚插进去的 {ENTER} 会被再次转义成 {{}ENTER{}}（测试抓到过的真实 bug）
  return String(text == null ? '' : text)
    .replace(/[+^%~(){}\[\]]/g, (ch) => '{' + ch + '}')
    .replace(/[\r\n]+/g, '{ENTER}');
}

/** 把一段自由文本转成"输入文本并回车"的按键序列 */
function answerSequence(text) {
  return escapeSendKeys(text) + '{ENTER}';
}

module.exports = { sendKeysToApp, focusTarget, keySequences, FOCUS_SEND_PS1, escapeSendKeys, answerSequence };
