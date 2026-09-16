'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, Notification, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const apps = require('./lib/apps');
const fetchicon = require('./lib/fetchicon');
const store = require('./lib/store');
const { ensureIcons } = require('./lib/icon');
const { createApiServer, listen } = require('./lib/server');
const { pollApps } = require('./lib/watchdog');
const { sendKeysToApp, focusTarget, keySequences, answerSequence } = require('./lib/confirm');
const taskTimer = require('./lib/tasktimer');
const tokenstats = require('./lib/tokenstats');
const { shouldNotify, buildNotification } = require('./lib/notify');
const detect = require('./lib/detect');

const VERSION = require('../package.json').version;
const ASSETS = path.join(__dirname, 'assets');
const LOG_PATH = path.join(store.DATA_DIR, 'petbuddy.log');

// -------------------------------------------------------- petdex manifest --
const https = require('https');
let manifestCache = null;
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PetBuddy' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchJson(new URL(res.headers.location, url).href));
      }
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function fetchBin(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PetBuddy' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchBin(new URL(res.headers.location, url).href));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
async function petdexManifest() {
  if (manifestCache && Date.now() - manifestCache.at < 10 * 60 * 1000) return manifestCache.data;
  const data = await fetchJson('https://petdex.dev/api/manifest/v2');
  manifestCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------- logging ---
let logStream = null;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  try {
    if (!logStream) {
      store.ensureDataDir();
      try { if (fs.statSync(LOG_PATH).size > 512 * 1024) fs.truncateSync(LOG_PATH, 0); } catch {}
      logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    }
    logStream.write(line);
  } catch {}
}
process.on('uncaughtException', (e) => log('uncaughtException', e.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection', (e && e.stack) || e));

// Windows 上透明小窗口对 GPU 驱动很敏感（驱动异常时整个渲染进程会被杀，表现为
// 桌宠不显示 / 设置窗口全黑）。桌宠面积很小，走软件渲染更稳，避免这类白屏。
app.disableHardwareAcceleration();

// ------------------------------------------------------------ notify -------
/** 系统通知：桌宠被窗口挡住 / 隐藏时，任务完成与出错也能第一时间知道 */
function notifyState(s, prev) {
  if (!shouldNotify(prev, s.state)) return;
  if (settings.behavior.notifyEnabled === false) return;
  try {
    if (!Notification.isSupported()) return;
    const { title, body } = buildNotification(s.meta, s.state, {
      id: s.id, title: s.title, detail: s.detail,
      startedAt: s.state === 'done' ? s.startedAt : 0,
      todos: s.todos,
    });
    const n = new Notification({ title, body, silent: !!settings.behavior.confirmSound });
    n.on('click', () => { showPet(true); });
    n.show();
    log('notify', s.id, s.state, title);
  } catch (e) {
    log('notify failed', String((e && e.message) || e));
  }
}

// ----------------------------------------------------------- shortcuts ----
function setupShortcuts() {
  const reg = (accel, fn) => {
    try { globalShortcut.register(accel, fn); }
    catch (e) { log('shortcut failed', accel, String((e && e.message) || e)); }
  };
  reg('Control+Alt+P', () => { showPet(true); });
  reg('Control+Alt+O', () => { createSettingsWindow(); });
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
  log('shortcuts armed: Ctrl+Alt+P 唤起桌宠 / Ctrl+Alt+O 打开设置');
}

// --------------------------------------------------------------- updater ---
// 自动更新：只在打包版启用（开发模式没有 app-update.yml）。
// 更新源来自 package.json 的 build.publish（打包时写进 resources/app-update.yml），
// 因此发布时必须把 latest.yml 一起传到 Release 里。
let updater = null;
function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.logger = {
      info: (m) => log('updater', String(m)),
      warn: (m) => log('updater warn', String(m)),
      error: (m) => log('updater error', String(m)),
      debug: () => {},
    };
    autoUpdater.on('update-available', (i) => log('update available', i && i.version));
    autoUpdater.on('update-downloaded', (i) => log('update downloaded', i && i.version, '- 重启后生效'));
    autoUpdater.on('error', (e) => log('update error', String((e && e.message) || e)));
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 20000);
    log('updater armed');
  } catch (e) {
    log('updater unavailable', String((e && e.message) || e));
  }
}

// --------------------------------------------------------- single instance --
const gotLock = app.requestSingleInstanceLock();
try { fs.appendFileSync(store.DATA_DIR + '/boot-debug.txt', '\nlock=' + gotLock); } catch {}
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--show')) showPet(true);
  });
  app.whenReady().then(boot).catch((e) => {
  try { fs.appendFileSync(store.DATA_DIR + '/boot-debug.txt', 'BOOT FAILED: ' + (e.stack || e)); } catch {}
  log('boot failed', e.stack || e);
  app.exit(1);
});
}

// ----------------------------------------------------------------- state ----
let settings = store.loadSettings();
let settingsWindow = null;
let petWindow = null;
let tray = null;
let server = null;
let serverPort = 0;
let userPinned = false;        // 固定显示: pet stays visible even with no apps
let manualHidden = false;      // user hid the pet via tray click
let lastPreToolLog = {};       // per-app throttle for pre-tool event logs
let lastAnyAppSeen = 0;        // watchdog timestamp
let noAppSince = null;
let argvHidden = process.argv.includes('--hidden');

const appStates = {};
// rest reminder scheduling: first remind = boot + configured interval
let lastRestShownAt = 0;
function restIntervalMs() { return Math.max(1, settings.behavior.restRemindMin || 45) * 60000; }
let nextRemindAt = Date.now() + restIntervalMs();
setInterval(() => {
  const b = settings.behavior;
  if (!b.restRemindEnabled || app.isQuitting) return;
  if (anyPendingConfirm()) return; // never stack on real confirmations
  for (const c of confirms.values()) if (c.rest) return;
  if (Date.now() < nextRemindAt) return;
  const id = `r${Date.now().toString(36)}`;
  const last = lastRestShownAt ? `上次提醒: ${new Date(lastRestShownAt).toTimeString().slice(0, 5)}` : '首次提醒';
  confirms.set(id, {
    id, app: 'rest', rest: true,
    question: '连续工作挺久了，休息一下吧 ~',
    detail: last,
    ts: Date.now(), status: 'pending',
    canApprove: true, canDeny: true,
    approveText: '知道了', denyText: `${Math.max(1, b.restSnoozeMin || 5)} 分钟后再提醒`,
  });
  lastRestShownAt = Date.now();
  nextRemindAt = Date.now() + Math.max(1, b.restSnoozeMin) * 60000; // re-ask until acknowledged
  log('rest reminder shown');
  broadcast();
}, 30000);
function ensureState(app) {
  let s = appStates[app.id];
  if (!s) {
    s = appStates[app.id] = {
      id: app.id, meta: app, running: false, state: 'idle',
      title: '', detail: '', steps: 0, errors: 0,
      lastTs: 0, since: Date.now(),
      sessions: {}, // per-task state (sessionId -> state), enables multi-task apps
      tasks: 0,     // active task count (snapshot)
    };
    if (petWindow) broadcast(); // petWindow is null during module init
  } else {
    s.meta = app;
  }
  return s;
}

/** TaskCreate/TaskUpdate style plans arrive as incremental ops — keep a
 *  running list per session so progress stays real-time and accurate. */
function applyTaskOp(sess, op) {
  if (!Array.isArray(sess.taskList)) sess.taskList = [];
  if (op.kind === 'create' && op.content) {
    sess.taskList.push({ id: sess.taskList.length + 1, content: op.content, status: 'pending' });
  } else if (op.kind === 'update') {
    const idx = (parseInt(op.taskId, 10) || 0) - 1;
    let it = sess.taskList[idx];
    if (!it && op.content) it = sess.taskList.find((x) => x.content === op.content);
    if (!it && op.content) { // update for a task we never saw created
      it = { id: idx + 1 || sess.taskList.length + 1, content: op.content, status: 'pending' };
      sess.taskList.push(it);
    }
    if (it) {
      if (op.status) it.status = op.status;
      if (op.content && !it.content) it.content = op.content;
    }
  }
  if (sess.taskList.length > 30) sess.taskList = sess.taskList.slice(-30);
  sess.todos = sess.taskList.slice();
}

/** Multi-task per app: the app stays busy while any of its sessions works.
 *  The bubble shows the most recently active session; sessions only retire
 *  after a long silence (30 min while the app still runs, 10 min once it is
 *  gone) — thinking/reconnecting must never look like a dead task. */
function reconcileAppState(s) {
  if (!s.sessions) return;
  const all = Object.values(s.sessions);
  const staleMs = s.running ? 30 * 60000 : 10 * 60000; // quiet sessions only retire early once the app is gone
  for (const x of all) {
    if ((x.state === 'working' || x.state === 'confirm') && Date.now() - x.lastTs > staleMs) x.state = 'done';
  }
  const active = all.filter((x) => x.state === 'working' || x.state === 'confirm');
  s.tasks = active.length;
  if (!active.length) return;
  active.sort((a, b) => b.lastTs - a.lastTs);
  const cur = active[0];
  const next = cur.state === 'confirm' ? 'confirm' : 'working';
  if (s.state !== next) { s.state = next; s.since = Date.now(); }
  s.title = cur.title || s.title;
  s.detail = cur.detail || s.detail;
  s.steps = cur.steps;
  s.todos = Array.isArray(cur.todos) ? cur.todos : null;
  s.action = cur.action || s.action;
  s.target = cur.target !== undefined ? cur.target : s.target;
  s.startedAt = cur.startedAt || s.startedAt || 0;
  s.lastTs = Math.max(s.lastTs, cur.lastTs);
}
for (const a of apps.allApps()) ensureState(a);
/** pending confirms: Map<string, card> */
const confirms = new Map();
let confirmSeq = 0;

function anyPendingConfirm() {
  for (const c of confirms.values()) if (c.status === 'pending') return true;
  return false;
}

function aggregateState() {
  if (anyPendingConfirm()) return 'confirm';
  let best = 'idle';
  const rank = { idle: 0, done: 1, error: 2, working: 3, confirm: 4 };
  for (const s of Object.values(appStates)) {
    if (settings.integrations.enabled[s.id] === false) continue; // 停用的应用不参与聚合
    if (s.state === 'confirm') return 'confirm';
    if (rank[s.state] > rank[best]) best = s.state;
  }
  return best;
}

function snapshot() {
  return {
    version: VERSION,
    port: serverPort,
    aggregate: aggregateState(),
    apps: Object.values(appStates).map((s) => {
      const meta = s.meta;
      return {
        id: s.id, name: meta.name, color: meta.color, emoji: meta.emoji,
        icon: apps.iconUrl(meta),
        processNames: meta.processNames || [], ports: meta.ports || [],
        deletable: !!(meta.dynamic || meta.user),
        running: s.running, state: s.state,
        title: s.title, detail: s.detail, steps: s.steps,
        tasks: s.tasks || 0,
        todos: Array.isArray(s.todos) ? s.todos : [],
        action: s.action || '', target: s.target || '',
        startedAt: s.startedAt || 0,
        since: s.since, lastTs: s.lastTs,
        tokens: s.tokens || null,
        // 停用的应用仍然要出现在"设置"里（否则用户没法再启用它）；
        // 桌宠自己的面板/圆点/气泡按这个标记过滤
        enabled: settings.integrations.enabled[s.id] !== false,
      };
    }),
    petsDir: pathToFileURL(path.join(store.DATA_DIR, 'pets')).href.replace(/$/, '/'),
    confirms: [...confirms.values()].filter((c) => c.status === 'pending').map((c) => ({
      id: c.id, app: c.app, question: c.question, detail: c.detail, ts: c.ts,
      canApprove: !!c.canApprove, canDeny: !!c.canDeny,
      rest: !!c.rest, approveText: c.approveText, denyText: c.denyText,
      freeText: !!c.freeText, options: Array.isArray(c.options) ? c.options : [],
    })),
    settings,
    pinned: userPinned,
  };
}

// ------------------------------------------------------------- broadcast ----
let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const snap = snapshot();
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pb:state', snap);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('pb:state', snap);
    resizePetWindow();
  }, 60);
}

// ------------------------------------------------------------ event intake --
function setAppState(id, patch) {
  const s = appStates[id];
  if (!s) return;
  const before = s.state;
  Object.assign(s, patch, { lastTs: Date.now() });
  if (patch.state && patch.state !== before) {
    s.since = Date.now();
    notifyState(s, before);
  }
}

/** Dismiss pending confirms for an app (the user answered inside the app). */
function clearConfirmsForApp(id) {
  for (const c of confirms.values()) {
    if (c.app === id && c.status === 'pending') {
      c.status = 'resolved-elsewhere';
      confirms.delete(c.id);
    }
  }
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''));

function handleEvent(body) {
  const app = apps.resolveApp(body.app);
  if (!app) return { ignored: true, reason: 'unknown app' };
  const appId = app.id;
  if (app.integration.length === 0 && body.event === 'permission') {
    // mirror-only app: no way to inject keys, but still show the card read-only
  }
  if (settings.integrations.enabled[appId] === false) return { ignored: true, reason: 'disabled' };

  const ev = String(body.event || '');
  // event log for debugging detection issues (high-frequency events throttled)
  if (['session-start', 'prompt', 'permission', 'stop', 'turn-complete', 'post-tool-failure'].includes(ev)) {
    log('event', appId, ev);
  } else if (ev === 'pre-tool' && Date.now() - (lastPreToolLog[appId] || 0) > 10000) {
    lastPreToolLog[appId] = Date.now();
    log('event', appId, 'pre-tool (throttled)');
  }
  const title = clip(String(body.title || ''), 120);
  const detail = clip(String(body.detail || body.toolName || ''), 160);
  const s = ensureState(app);
  s.running = true; // a live event implies the app is up
  manualHidden = false; // new activity re-shows the pet
  s.lastTs = Date.now();
  lastAnyAppSeen = Date.now();

  // per-task tracking: every event belongs to a session (missing id -> '')
  let sid = String(body.sessionId || '');
  if (!sid) {
    // no session id in the payload: adopt the app's newest record file so the
    // file-based timer and multi-task grouping still work (all apps)
    const lt = taskTimer.latestTask(appId);
    if (lt && lt.sessionId) sid = lt.sessionId;
  }
  if (!s.sessions) s.sessions = {};
  if (!s.sessions[sid]) s.sessions[sid] = { state: 'idle', title: '', detail: '', steps: 0, errors: 0, lastTs: 0, startedAt: Date.now() };
  const sess = s.sessions[sid];
  sess.lastTs = Date.now();
  // true task timer: read the turn start from the app's own session transcript
  // so a pet restart never resets a running task's clock back to zero.
  // (on prompt events the switch below stamps Date.now() first — the transcript
  // write lands a moment later and the next event corrects it)
  const realStart = taskTimer.turnStart(sid, ev === 'prompt' || ev === 'session-start');
  if (realStart && ev !== 'prompt') sess.startedAt = realStart;

  // the app is doing things again: its old pending confirms are stale
  if (!['permission', 'announce'].includes(ev)) clearConfirmsForApp(appId);

  switch (ev) {
    case 'announce':
      break;
    case 'session-start':
      setAppState(appId, { state: 'working', title: title || '新会话', detail: '', steps: 0, errors: 0 });
      Object.assign(sess, { state: 'working', title: title || '新会话', detail: '', steps: 0, errors: 0 });
      break;
    case 'compact':
      // context compaction: the CLI is still busy — never show this as done
      setAppState(appId, { state: 'working', title: title || '压缩上下文中', detail: '', steps: s.steps, errors: s.errors });
      Object.assign(sess, { state: 'working', title: title || '压缩上下文中', detail: '' });
      break;
    case 'prompt':
      // a new user message starts a new exchange — restart the elapsed clock
      sess.startedAt = Date.now();
      setAppState(appId, { state: 'working', title: title || '处理中…', steps: 0, errors: 0 });
      Object.assign(sess, { state: 'working', title: title || '处理中…', detail: '', steps: 0, errors: 0 });
      break;
    case 'pre-tool': {
      if (Array.isArray(body.todos) && body.todos.length) { // full plan (TodoWrite style)
        sess.todos = body.todos;
        sess.taskList = body.todos.map((t, i) => ({ id: i + 1, content: t.content, status: t.status }));
      }
      if (body.taskOp) applyTaskOp(sess, body.taskOp); // incremental plan (TaskCreate/TaskUpdate style)
      if (body.action) sess.action = body.action;
      if (body.target !== undefined) sess.target = body.target;
      setAppState(appId, { state: 'working', detail, steps: s.steps + 1 });
      Object.assign(sess, { state: 'working', detail, steps: sess.steps + 1 });
      break;
    }
    case 'post-tool':
      setAppState(appId, { state: 'working', detail });
      Object.assign(sess, { state: 'working', detail });
      break;
    case 'post-tool-failure':
      setAppState(appId, { state: 'working', detail, errors: s.errors + 1 });
      Object.assign(sess, { state: 'working', detail, errors: sess.errors + 1 });
      break;
    case 'permission':
    case 'question': {
      sess.state = 'confirm'; sess.detail = detail;
      const id = `c${Date.now().toString(36)}-${++confirmSeq}`;
      const keys = keySequences(appId, settings);
      const freeText = ev === 'question' || !!body.freeText;
      const card = {
        id, app: appId,
        question: clip(String(body.question || body.title || (freeText ? '需要你回答' : '需要确认')), 200),
        detail,
        freeText,
        options: Array.isArray(body.options) ? body.options.slice(0, 6).map(String) : [],
        ts: Date.now(), status: 'pending',
        canApprove: !freeText && !!keys.approve, canDeny: !freeText && !!keys.deny,
      };
      confirms.set(id, card);
      setAppState(appId, { state: 'confirm', title: title || card.question });
      log('confirm created', id, appId, card.question);
      broadcast();
      setTimeout(() => {
        const c = confirms.get(id);
        if (c && c.status === 'pending') {
          c.status = 'expired';
          confirms.delete(id);
          if (appStates[appId].state === 'confirm') setAppState(appId, { state: 'idle', detail: '' });
          broadcast();
        }
      }, Math.max(15, settings.behavior.confirmTimeoutSec) * 1000);
      return { confirmId: id };
    }
    case 'stop':
    case 'turn-complete': {
      // the session that ended is done/error — the app only shows done when
      // no other session of the same app is still working (reconcile below)
      const failed = sess.errors > 0;
      Object.assign(sess, { state: failed ? 'error' : 'done', title: title || (failed ? '任务出错' : '任务完成'), detail: '' });
      setAppState(appId, { state: failed ? 'error' : 'done', title: sess.title, detail: '' });
      break;
    }
    case 'message':
      setAppState(appId, { detail });
      sess.detail = detail;
      break;
    default:
      setAppState(appId, { detail: detail || ev });
      sess.detail = detail || ev;
  }
  reconcileAppState(s);

  // visible again once an app is alive
  updateVisibility(true);
  broadcast();
  return {};
}

async function handleConfirm(id, decision, answerText) {
  const card = confirms.get(id);
  if (!card || card.status !== 'pending') return { found: false };
  card.status = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'dismissed';
  confirms.delete(id);

  // rest reminders never inject keys — they just reschedule themselves
  if (card.rest) {
    const b = settings.behavior;
    if (decision === 'approve') {
      nextRemindAt = Date.now() + Math.max(1, b.restRemindMin) * 60000;
      log('rest acknowledged');
    } else {
      nextRemindAt = Date.now() + Math.max(1, b.restSnoozeMin) * 60000;
      log('rest snoozed');
    }
    broadcast();
    return { found: true };
  }

  const st = appStates[card.app];
  let action = { sent: false };
  if (decision === 'answer' && card.freeText) {
    const text = String(answerText == null ? '' : answerText).slice(0, 600).trim();
    if (text) {
      action = await sendKeysToApp(focusTarget(card.app), answerSequence(text));
      log('confirm answer', card.app, 'text:', text.slice(0, 80), '=>', JSON.stringify(action));
    }
  } else if (decision === 'approve' || decision === 'deny') {
    const keys = keySequences(card.app, settings);
    const seq = decision === 'approve' ? keys.approve : keys.deny;
    if (seq) {
      action = await sendKeysToApp(focusTarget(card.app), seq);
      log('confirm', decision, card.app, 'keys:', seq, '=>', JSON.stringify(action));
    }
  }
  if (st && st.state === 'confirm') {
    setAppState(card.app, {
      state: 'working',
      title: decision === 'approve' ? '已允许，继续执行' : decision === 'deny' ? '已拒绝' : st.title,
    });
  }
  broadcast();
  return { found: true, action };
}

// ------------------------------------------------------------- visibility ---
function desiredVisible() {
  if (anyPendingConfirm()) return true;
  if (manualHidden) return false;
  if (!settings.behavior.autoHideWhenNoApp) return true;
  return Object.values(appStates).some((s) => s.running);
}

function updateVisibility(eventHint = false) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const want = desiredVisible();
  const anyRunning = Object.values(appStates).some((s) => s.running);
  if (anyRunning) { noAppSince = null; lastAnyAppSeen = Date.now(); }

  if (want) {
    if (!petWindow.isVisible()) showPet(false);
    return;
  }
  // grace period before hiding/quitting
  if (noAppSince === null) noAppSince = Date.now();
  const elapsed = (Date.now() - noAppSince) / 1000;
  if (eventHint || elapsed >= settings.behavior.hideDelaySec) {
    if (elapsed >= settings.behavior.hideDelaySec) {
      if (settings.behavior.quitWhenNoApp && !anyPendingConfirm()) { app.quit(); return; }
      if (petWindow.isVisible()) petWindow.hide();
    }
  }
}

// ---------------------------------------------------------------- windows ---
function petPos() {
  // restore the last position if it still sits on a connected display,
  // otherwise default to the bottom-right of the primary display
  const { x, y } = settings.window || {};
  if (typeof x === 'number' && typeof y === 'number') {
    const ok = screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return x >= wa.x - 60 && x + 300 <= wa.x + wa.width + 60 &&
             y >= wa.y - 60 && y + 360 <= wa.y + wa.height + 60;
    });
    if (ok) return { x, y };
  }
  const p = screen.getPrimaryDisplay().workArea;
  return { x: p.x + p.width - 330, y: p.y + p.height - 400 };
}

function createPetWindow() {
  const pos = petPos();
  petWindow = new BrowserWindow({
    width: 300, height: 360, x: pos.x, y: pos.y,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: settings.appearance.alwaysOnTop,
    skipTaskbar: true, hasShadow: false,
    focusable: true, show: false,
    icon: path.join(ASSETS, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  if (settings.appearance.alwaysOnTop) petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.setMenu(null);
  petWindow.loadFile(path.join(__dirname, 'pet.html'));
  petWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  petWindow.on('moved', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const [x, y] = petWindow.getPosition();
    settings.window = { x, y };
    scheduleSave();
  });
}

function showPet(focus) {
  if (!petWindow || petWindow.isDestroyed()) createPetWindow();
  if (focus) { petWindow.show(); petWindow.focus(); }
  else petWindow.showInactive();
  broadcast();
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show(); settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 520, height: 660, minWidth: 420, minHeight: 480,
    frame: false,
    backgroundColor: '#1d1f27',
    title: 'PetBuddy 设置',
    icon: path.join(ASSETS, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ------------------------------------------------------------------- tray ---
function createTray(iconPath) {
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('PetBuddy 桌宠');
  // left-click toggles visibility; right-click pops the menu.
  // (setContextMenu would swallow the left-click on Windows)
  const buildMenu = () => Menu.buildFromTemplate([
    { label: `PetBuddy v${VERSION}`, enabled: false },
    { type: 'separator' },
    { label: '打开设置', click: () => createSettingsWindow() },
    { label: '打开日志目录', click: () => shell.openPath(store.DATA_DIR) },
    { type: 'separator' },
    { label: `监控中: ${Object.values(appStates).filter((s) => s.running).map((s) => s.meta.name).join('、') || '无'}`, enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.on('click', () => {
    // left-click toggles pet visibility
    if (petWindow && petWindow.isVisible() && !manualHidden) {
      manualHidden = true;
      petWindow.hide();
    } else {
      manualHidden = false;
      showPet(true);
    }
  });
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

// --------------------------------------------------------------- autostart --
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function autostartCmd() {
  const exe = process.execPath;
  const dir = path.resolve(__dirname);
  return `"${exe}" "${dir}" --hidden`;
}
function setAutoStart(enable) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const args = enable
        ? ['add', RUN_KEY, '/v', 'PetBuddy', '/t', 'REG_SZ', '/d', autostartCmd(), '/f']
        : ['delete', RUN_KEY, '/v', 'PetBuddy', '/f'];
      const p = spawn('reg', args, { windowsHide: true });
      p.on('close', (c) => finish(enable ? c === 0 : true));
      p.on('error', () => finish(false));
    } catch { finish(false); }
  });
}
function getAutoStart() {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('reg', ['query', RUN_KEY, '/v', 'PetBuddy'], { windowsHide: true });
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', (c) => resolve(c === 0 && out.includes('PetBuddy')));
    p.on('error', () => resolve(false));
  });
}

// ----------------------------------------------------------- settings save --
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; store.saveSettings(settings); }, 400);
}

// --------------------------------------------------------------- watchdog ---
let watchdogBusy = false;
async function watchdogTick() {
  if (watchdogBusy) return;
  watchdogBusy = true;
  try {
    // token 用量：模块内部按应用缓存 60s，日常调用是零成本的
    for (const s of Object.values(appStates)) {
      if (settings.integrations.enabled[s.id] === false) continue;
      try { s.tokens = tokenstats.scanApp(s.id); } catch {}
    }
    const metas = Object.values(appStates)
      .filter((s) => settings.integrations.enabled[s.id] !== false)
      .map((s) => s.meta);
    const running = await pollApps(metas);
    if (running === null) return; // flaky tasklist: keep previous flags
    const now = Date.now();
    const stallMs = Math.max(0, settings.behavior.stallSec || 0) * 1000;
    let changed = false;
    for (const id of Object.keys(appStates)) {
      const s = appStates[id];
      if (settings.integrations.enabled[id] === false) {
        // 停用：清掉运行痕迹，避免再启用时残留旧状态
        if (s.running || s.state !== 'idle' || s.title || s.detail || s.action || s.target || s.tasks) {
          s.running = false; s.state = 'idle';
          s.title = ''; s.detail = ''; s.action = ''; s.target = '';
          s.tasks = 0; s.todos = [];
          changed = true;
        }
        continue;
      }
      // bridge events are authoritative for aliveness too: a CLI/hook source
      // may not match any watched process name (e.g. codex desktop, dsh node).
      // thinking phases / model reconnects are silent but alive, so the
      // silence window is generous (2× the interrupt threshold, min 90s);
      // stallSec=0 disables silence-based detection entirely.
      const signalAlive = stallMs === 0 ? true : now - s.lastTs < Math.max(90000, stallMs * 2);
      const newRunning = running[id] || signalAlive;
      if (s.running !== newRunning) { s.running = newRunning; changed = true; }
    }
    if (changed) updateVisibility();
    // the app itself is the best judge of whether a task is still running:
    // if its session record says no turn/step is open, the turn ended — even
    // when no stop hook ever arrived (DSH on a rate-limit failure, for one)
    const activeSid = (s) => {
      const top = Object.entries(s.sessions || {})
        .sort((a, b) => (b[1].lastTs || 0) - (a[1].lastTs || 0))[0];
      return top ? top[0] : '';
    };
    const stalled = (s) => {
      if (s.state !== 'working' || stallMs <= 0) return false;
      const sid = Object.entries(s.sessions || {})
        .sort((a, b) => (b[1].lastTs || 0) - (a[1].lastTs || 0))[0];
      const hb = sid ? taskTimer.heartbeat(sid[0]) : 0;
      const quietFrom = Math.max(s.lastTs, hb || 0);
      return now - quietFrom > stallMs;
    };
    // clear stale "working" states only when the app is really gone — silence
    // alone is never treated as interruption (long thinking / reconnecting)
    for (const id of Object.keys(appStates)) {
      const s = appStates[id];
      // file-based presence: DSH records its own open turn, so it counts as
      // running even when no hook events arrive for minutes (thinking /
      // deep-search phases are completely silent)
      if (id === 'dsh' && (s.state === 'idle' || s.state === 'done' || s.state === 'error')) {
        const act = taskTimer.dshActive();
        if (act) {
          if (!s.running) { s.running = true; changed = true; }
          const ss = s.sessions[act.sessionId];
          if (!ss) {
            s.sessions[act.sessionId] = {
              state: 'working', title: act.title || '', detail: '', steps: 0, errors: 0,
              lastTs: Date.now(), startedAt: act.startedAt || Date.now(),
            };
          } else {
            ss.state = 'working';
            ss.lastTs = Date.now();
            if (act.startedAt) ss.startedAt = act.startedAt;
            if (act.title) ss.title = act.title; // the app's latest task text beats a stale cwd
          }
          reconcileAppState(s);
          changed = true;
          log('dsh running (detected from its session file)', act.sessionId);
        }
      }
      if (!s.running && (s.state === 'working' || s.state === 'confirm')) {
        s.state = 'idle'; s.title = ''; s.detail = '';
        clearConfirmsForApp(id);
        changed = true;
        log('app vanished while working -> idle', id);
      }
      if (stalled(s)) {
        s.state = 'error'; s.title = '任务已停止响应'; s.detail = '';
        changed = true;
        log('stall (events + session file quiet) -> error', id);
      }
      if (s.state === 'working' && s.running && now - s.lastTs > 15000) {
        const sid = activeSid(s);
        // trust the app's "no open turn" verdict once events have been quiet
        // briefly (a just-arrived event may predate the app's own bookkeeping)
        if (sid && taskTimer.turnState(sid) === 'idle') {
          s.state = 'error'; s.title = '任务已停止响应'; s.detail = '';
          changed = true;
          log('app reports no open turn -> error', id);
        }
      }
      if ((s.state === 'done' && now - s.since > 15000) ||
          (s.state === 'error' && now - s.since > 20000)) {
        s.state = 'idle'; changed = true;
      }
    }
    if (changed) broadcast();
  } catch (e) {
    log('watchdog error', e.message || e);
  } finally {
    watchdogBusy = false;
  }
}

// ------------------------------------------------------------------- IPC ----
function setupIpc() {
  ipcMain.handle('pb:get-state', () => snapshot());
  ipcMain.handle('pb:decide', (_e, { id, decision, text }) => handleConfirm(id, decision, text));
  ipcMain.handle('pb:check-update', async () => {
    if (!app.isPackaged) return { ok: false, error: '开发模式不检查更新' };
    if (!updater) return { ok: false, error: '更新组件未启用' };
    try {
      const r = await updater.checkForUpdates();
      const v = r && r.updateInfo && r.updateInfo.version;
      return { ok: true, version: v, current: VERSION, hasUpdate: !!(v && v !== VERSION) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('pb:focus-app', async (_e, id) => {
    const proc = focusTarget(id);
    if (!proc) return { ok: false, error: '该应用没有配置进程名' };
    const r = await sendKeysToApp(proc, '', 60, true);   // 只聚焦，不发按键
    return { ok: !!r.sent, error: r.error };
  });
  ipcMain.handle('pb:open-settings', () => { createSettingsWindow(); });
  ipcMain.handle('pb:quit', () => { app.isQuitting = true; app.quit(); });
  ipcMain.handle('pb:fetch-icon', async (_e, { id, site }) => {
    try {
      return await fetchicon.fetchAppIcon(id, site, store.DATA_DIR);
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('pb:open-petdex', () => shell.openExternal('https://petdex.dev/zh'));
  // 宠物右键菜单的「日志目录」与设置页的「打开 ~/.petbuddy」都走这个接口，
  // 之前漏注册导致点击静默失败
  ipcMain.handle('pb:open-data-dir', async () => {
    const err = await shell.openPath(store.DATA_DIR);
    if (err) log('open data dir failed:', err);
    return { ok: !err, error: err || '' };
  });
  ipcMain.handle('pb:log', (_e, line) => { log('renderer:', String(line || '').slice(0, 300)); });
  ipcMain.handle('pb:set-need-height', (_e, px) => {
    petNeedHeight = Math.max(360, Math.min(900, parseInt(px, 10) || 360));
    resizePetWindow();
    return { ok: true };
  });
  ipcMain.handle('pb:set-pinned', (_e, on) => {
    userPinned = !!on;
    if (userPinned) manualHidden = false;
    updateVisibility();
    broadcast();
    return { ok: true, pinned: userPinned };
  });

  ipcMain.handle('pb:get-settings', async () => ({
    settings,
    autostart: await getAutoStart(),
    port: serverPort,
    appVersion: VERSION,
  }));
  ipcMain.handle('pb:patch-settings', async (_e, patch) => {
    const preview = !!(patch && patch.__preview);
    if (patch && patch.appearance) log('patch appearance' + (preview ? ' (preview)' : ''), JSON.stringify(patch.appearance));
    // never let an invalid sprite value reach the config (would render the blob)
    if (patch && patch.appearance && 'sprite' in patch.appearance) {
      const sv = String(patch.appearance.sprite || '');
      const valid = sv === 'eve' || sv === 'blob' || sv === 'custom' || sv.startsWith('petdex:');
      if (!valid) {
        log('rejected invalid sprite patch:', sv);
        delete patch.appearance.sprite;
      } else if (sv.startsWith('petdex:') && sv.length > 7) {
        const sheet = path.join(store.DATA_DIR, 'pets', sv.slice(7), 'spritesheet.webp');
        if (!fs.existsSync(sheet)) {
          log('rejected sprite with missing sheet:', sv);
          delete patch.appearance.sprite;
        }
      }
    }
    for (const key of Object.keys(patch || {})) {
      if (key === '__preview') continue;
      if (settings[key] && typeof settings[key] === 'object' && typeof patch[key] === 'object') {
        Object.assign(settings[key], patch[key]);
      } else {
        settings[key] = patch[key];
      }
    }
    // preview mode: apply live + broadcast but do not persist to disk
    if (!preview) store.saveSettings(settings);
    if (patch.behavior && (patch.behavior.restRemindEnabled !== undefined ||
        patch.behavior.restRemindMin !== undefined || patch.behavior.restSnoozeMin !== undefined)) {
      nextRemindAt = Date.now() + restIntervalMs(); // reschedule on reminder setting change
    }
    applySettingsSideEffects();
    broadcast();
    return { ok: true };
  });
  ipcMain.handle('pb:set-autostart', async (_e, enable) => {
    const ok = await setAutoStart(enable);
    settings.system.autoStart = enable;
    store.saveSettings(settings);
    return { ok };
  });
  ipcMain.handle('pb:rescan-apps', () => {
    apps.reload();
    for (const a of apps.allApps()) ensureState(a);
    for (const id of Object.keys(appStates)) {
      if (!apps.getApp(id)) { delete appStates[id]; }
    }
    updateVisibility();
    broadcast();
    // 顺便把"本机装过、但还没加进桌宠"的应用一并返回，让设置页能直接一键添加
    let detected = [];
    try { detected = detect.detect(apps.allApps().map((a) => a.id)); } catch (e) { log('detect failed', String(e.message || e)); }
    return { ok: true, count: apps.allApps().length, detected };
  });
  ipcMain.handle('pb:add-app', (_e, entry) => {
    try {
      // 接入方式自动补齐（见 lib/detect.js#resolveIntegration）
      const e2 = Object.assign({}, entry);
      e2.integration = detect.resolveIntegration(e2);
      const app = apps.addUserApp(e2);
      ensureState(app);
      updateVisibility();
      broadcast();
      return { ok: true, id: app.id };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('pb:update-app', (_e, { id, patch }) => {
    try {
      const r = apps.updateApp(id, patch);
      if (r.ok) {
        const app = apps.getApp(id);
        if (app) ensureState(app);
        broadcast();
      }
      return r;
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('pb:delete-app', (_e, id) => {
    try {
      const r = apps.removeUserApp(id);
      if (r.ok) {
        clearConfirmsForApp(id);
        delete appStates[String(id).toLowerCase()];
        updateVisibility();
        broadcast();
      }
      return r;
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('pb:drag-by', (_e, { dx, dy }) => {
    if (!petWindow || petWindow.isDestroyed()) return { ok: false };
    const [x, y] = petWindow.getPosition();
    petWindow.setPosition(x + Math.round(dx), y + Math.round(dy));
    return { ok: true };
  });
  ipcMain.handle('pb:drag-end', () => {
    if (!petWindow || petWindow.isDestroyed()) return { ok: false };
    const [x, y] = petWindow.getPosition();
    settings.window = { x, y };
    scheduleSave();
    return { ok: true };
  });

  ipcMain.handle('pb:petdex-search', (_e, q) => new Promise((resolve) => {
    const query = String(q || '').trim().toLowerCase();
    (async () => {
      if (!query) return resolve({ ok: true, candidates: [] });
      const manifest = await petdexManifest();
      const cands = (manifest.pets || [])
        .filter((p) => (String(p[0]) + ' ' + String(p[1])).toLowerCase().includes(query))
        .slice(0, 14)
        .map((p) => ({ slug: String(p[0]), displayName: String(p[1]) }));
      resolve({ ok: true, candidates: cands });
    })().catch((e) => resolve({ ok: false, error: String(e.message || e) }));
  }));
  ipcMain.handle('pb:petdex-install', (_e, name) => new Promise((resolve) => {
    const q = String(name || '').trim();
    if (!q || q.length > 60) return resolve({ ok: false, error: '请输入名字或 slug' });
    (async () => {
      const manifest = await petdexManifest();
      const pets = manifest.pets || [];
      const ql = q.toLowerCase();
      // exact slug > exact display name > slug prefix > contains (slug or display name)
      let candidates = pets.filter((p) => String(p[0]).toLowerCase() === ql);
      if (!candidates.length) candidates = pets.filter((p) => String(p[1]).toLowerCase() === ql);
      if (!candidates.length) candidates = pets.filter((p) => String(p[0]).toLowerCase().startsWith(ql));
      if (!candidates.length) candidates = pets.filter((p) => (String(p[0]) + ' ' + String(p[1])).toLowerCase().includes(ql));
      if (!candidates.length) return resolve({ ok: false, error: `petdex 上没有匹配"${q}"的形象` });
      const best = candidates[0];
      const slug = String(best[0]);
      const displayName = String(best[1]);
      // fetch pet json + spritesheet straight from the asset base
      const pj = await fetchJson(manifest.assetBase + '/' + best[5]);
      const spriteBuf = await fetchBin(manifest.assetBase + '/' + best[4]);
      const dest = path.join(store.DATA_DIR, 'pets', slug);
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'pet.json'), JSON.stringify({
        id: pj.id || slug, displayName: pj.displayName || displayName,
        description: pj.description || '', spritesheetPath: 'spritesheet.webp',
      }, null, 2));
      fs.writeFileSync(path.join(dest, 'spritesheet.webp'), spriteBuf);
      log('petdex imported', slug, 'candidates:', candidates.length);
      resolve({
        ok: true, name: slug, displayName,
        candidates: candidates.slice(0, 12).map((p) => String(p[0])),
        ambiguous: candidates.length > 1,
      });
    })().catch((e) => resolve({ ok: false, error: String(e.message || e) }));
  }));
  ipcMain.handle('pb:petdex-list', () => {
    try {
      const dir = path.join(store.DATA_DIR, 'pets');
      const pets = fs.readdirSync(dir)
        .filter((d) => fs.existsSync(path.join(dir, d, 'spritesheet.webp')))
        .map((d) => {
          let displayName = d;
          try {
            displayName = JSON.parse(fs.readFileSync(path.join(dir, d, 'pet.json'), 'utf8')).displayName || d;
          } catch {}
          return { slug: d, displayName };
        });
      return { ok: true, pets };
    } catch { return { ok: true, pets: [] }; }
  });

  ipcMain.handle('pb:win-min', () => { if (settingsWindow) settingsWindow.minimize(); });
  ipcMain.handle('pb:win-close', () => { if (settingsWindow) settingsWindow.close(); });
  ipcMain.handle('pb:petdex-delete', (_e, name) => {
    const pet = String(name || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(pet)) return { ok: false, error: '名字不合法' };
    try {
      for (const base of [path.join(store.DATA_DIR, 'pets'), path.join(os.homedir(), '.petdex', 'pets')]) {
        const dir = path.join(base, pet);
        if (dir.startsWith(base) && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      }
      log('petdex deleted', pet);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('pb:test-keys', async (_e, { appId, seq }) => {
    return sendKeysToApp(focusTarget(appId), seq);
  });
  ipcMain.handle('pb:integration', async (_e, { action, appId }) => {
    try {
      const mod = await import(pathToFileURL(path.join(__dirname, '..', 'integrations', 'install.mjs')).href);
      if (action === 'status') return { ok: true, status: await mod.statusAll() };
      if (action === 'install') return { ok: true, result: await mod.installOne(appId) };
      if (action === 'uninstall') return { ok: true, result: await mod.uninstallOne(appId) };
      return { ok: false, error: 'unknown action' };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });
}

function applySettingsSideEffects() {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setAlwaysOnTop(!!settings.appearance.alwaysOnTop, 'screen-saver');
  }
  resizePetWindow();
  updateVisibility();
}

/** The stage scales with appearance.scale — grow the window so the pet and
 *  its background ring never clip, keeping the bottom edge anchored.
 *  petNeedHeight: renderer-reported stack height (stage px). */
let petNeedHeight = 360;
function resizePetWindow() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const s = Math.max(0.5, Math.min(3, settings.appearance.scale || 1));
  const need = Math.max(360, Math.min(900, petNeedHeight));
  const w = Math.round(300 * s), h = Math.round(need * s);
  const [x, y] = petWindow.getPosition();
  const [ow, oh] = petWindow.getSize();
  if (ow === w && oh === h) return;
  // 面板/气泡变高时窗口向上长，但位置可能被推到屏幕外（甚至整只桌宠看不见）。
  // 这里把窗口钳制回工作区内：水平留边、底边不得越界，顶边最多超出屏幕 1/3。
  const disp = screen.getDisplayNearestPoint({ x: Math.round(x + ow / 2), y: Math.round(y + oh / 2) });
  const wa = disp.workArea;
  const clampX = Math.max(wa.x + 8, Math.min(Math.round(x + (ow - w) / 2), wa.x + wa.width - w - 8));
  const maxTop = wa.y - Math.round(h / 3);
  const clampY = Math.max(maxTop, Math.min(y + (oh - h), wa.y + wa.height - h - 8));
  petWindow.setBounds({ x: clampX, y: clampY, width: w, height: h });
  // keep the saved spot in sync with the resized window
  const [nx, ny] = petWindow.getPosition();
  settings.window = { x: nx, y: ny };
  scheduleSave();
}

// ------------------------------------------------------------------- boot ---
async function boot() {
  try { fs.appendFileSync(store.DATA_DIR + '/boot-debug.txt', 'boot enter'); } catch {}
  store.ensureDataDir();
  const icons = ensureIcons(ASSETS);
  app.setAppUserModelId('com.petbuddy.app');

  server = createApiServer({
    version: VERSION,
    handleEvent,
    handleConfirm,
    snapshot,
  });
  try {
    serverPort = await listen(server, settings.integrations.port || 47650);
  } catch (e) {
    log('api server failed', e.message || e);
  }
  if (serverPort) {
    store.writePortFile(serverPort);
    log('api listening on', serverPort);
  }

  setupIpc();
  createPetWindow();
  resizePetWindow();
  createTray(icons.tray);

  if (process.argv.includes('--settings')) createSettingsWindow();
  if (!argvHidden && !settings.system.startHidden) showPet(false);
  else updateVisibility();

  setupUpdater();
  setupShortcuts();

  setInterval(watchdogTick, 2500);
  watchdogTick();

  // sync registry autostart flag with stored setting (e.g. after reinstall)
  if (settings.system.autoStart) setAutoStart(true).then(() => {});

  // dev hot reload: with a .hotreload marker in the project root, UI file
  // changes (pet.html / preload.js / settings.html) hot-reload the windows —
  // state-safe because confirms live in this process — and main.js changes
  // relaunch the app. Delete the marker to disable.
  try {
    if (fs.existsSync(path.join(__dirname, '.hotreload'))) {
      let uiTimer = null, mainTimer = null;
      const reloadUi = () => {
        clearTimeout(uiTimer);
        uiTimer = setTimeout(() => {
          try { if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.reload(); } catch {}
          try { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.reload(); } catch {}
        }, 600);
      };
      const relaunchApp = () => {
        clearTimeout(mainTimer);
        mainTimer = setTimeout(() => { try { app.isQuitting = true; app.relaunch(); app.exit(0); } catch {} }, 1200);
      };
      fs.watch(__dirname, (_ev, f) => {
        if (f === 'pet.html' || f === 'preload.js' || f === 'settings.html') reloadUi();
        else if (f === 'main.js') relaunchApp();
      });
      try { // lib/*.js lives in the main process too — needs a relaunch
        fs.watch(path.join(__dirname, 'lib'), (_ev, f) => { if (f && f.endsWith('.js')) relaunchApp(); });
      } catch {}
      // fs.watch can silently miss writes on Windows — poll mtimes as a fallback
      const watchFiles = ['main.js', 'pet.html', 'preload.js', 'settings.html'];
      const seenMtime = {};
      for (const f of watchFiles) {
        try { seenMtime[f] = fs.statSync(path.join(__dirname, f)).mtimeMs; } catch {}
      }
      const seenLib = {};
      try {
        for (const f of fs.readdirSync(path.join(__dirname, 'lib'))) {
          if (f.endsWith('.js')) seenLib[f] = fs.statSync(path.join(__dirname, 'lib', f)).mtimeMs;
        }
      } catch {}
      setInterval(() => {
        for (const f of watchFiles) {
          let mt = 0;
          try { mt = fs.statSync(path.join(__dirname, f)).mtimeMs; } catch {}
          if (mt && mt !== seenMtime[f]) {
            seenMtime[f] = mt;
            if (f === 'main.js') relaunchApp(); else reloadUi();
          }
        }
        let libChanged = false;
        try {
          for (const f of fs.readdirSync(path.join(__dirname, 'lib'))) {
            if (!f.endsWith('.js')) continue;
            const mt = fs.statSync(path.join(__dirname, 'lib', f)).mtimeMs;
            if (seenLib[f] !== undefined && mt !== seenLib[f]) libChanged = true;
            seenLib[f] = mt;
          }
        } catch {}
        if (libChanged) relaunchApp();
      }, 3000);
      log('hot reload armed (.hotreload)');
    }
  } catch {}
}

app.on('window-all-closed', (e) => {
  // tray app: keep running
  e.preventDefault();
});
app.on('before-quit', () => {
  // persist the final position so the next boot restores it
  try {
    if (petWindow && !petWindow.isDestroyed()) {
      const [x, y] = petWindow.getPosition();
      settings.window = { x, y };
    }
    store.saveSettings(settings);
  } catch {}
  store.removePortFile();
  try { if (logStream) logStream.end(); } catch {}
});
