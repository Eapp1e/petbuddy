/**
 * PetBuddy integration installer — registry-driven.
 *
 * Every watched app is described in the app registry (lib/app-defaults.js
 * overridden by ~/.petbuddy/apps.config.json). Each app lists `integration`
 * steps; this installer knows how to apply/remove each style:
 *
 *   zcode-config  hooks.events entries in ~/.zcode/cli/config.json (process hooks)
 *   claude-file   Claude-format hooks file (standalone or merged "hooks" key)
 *   codex-notify  wrap `notify` in ~/.codex/config.toml (chains the old target)
 *   dsh-patch     mount @deepseek-ai/dsh-hooks-claude-code in the web profile
 *
 * Adding a new app = add a registry block with one of these styles (or none
 * for mirror-only), then `node integrations/install.mjs install <id>`.
 * Everything is idempotent (marker-based) and backs files up before touching.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const apps = require('../app/lib/apps.js');

const PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(PET_ROOT, 'bridge', 'pet-bridge.mjs');
const NOTIFY_WRAP = path.join(PET_ROOT, 'bridge', 'codex-notify.mjs');
const HOME = os.homedir();
const PET_HOME = process.env.PETBUDDY_HOME || path.join(HOME, '.petbuddy');

const { writeBridgeShim, shimCommand } = await import(
  pathToFileURL(path.join(PET_ROOT, 'integrations', 'shim.mjs')).href
);

const expand = (p) => (p ? p.replace(/^~(?=\/|\\|$)/, HOME) : p);

// ---------------------------------------------------------------- helpers --
function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}
function backup(p) {
  if (!fs.existsSync(p)) return;
  const b = p + '.petbuddy-bak';
  if (!fs.existsSync(b)) fs.copyFileSync(p, b);
}

/** Best node.exe for hook processes (bridge is node>=16 compatible). */
export function findNode() {
  if (process.env.PETBUDDY_NODE && fs.existsSync(process.env.PETBUDDY_NODE)) {
    return process.env.PETBUDDY_NODE;
  }
  const candidates = [];
  try {
    const base = path.join(HOME, '.workbuddy', 'binaries', 'node', 'versions');
    const vers = fs.readdirSync(base).sort().reverse();
    for (const v of vers) candidates.push(path.join(base, v, 'node.exe'));
  } catch {}
  candidates.push('D:\\NodeJS\\node.exe');
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return execSync('where node', { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); }
  catch { return 'node'; }
}

const q = (p) => `"${p}"`;
const MARKER = 'pet-bridge.'; // matches both pet-bridge.mjs (legacy) and pet-bridge.cmd (shim)
/** Git Bash (WorkBuddy/CodeBuddy hooks) rejects backslash paths — always forward slashes. */
const fwd = (p) => p.replace(/\\/g, '/');

const PASCAL_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'PreCompact'];
const KEBAB_EVENTS = ['session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'permission-request', 'stop', 'pre-compact'];

// ------------------------------------------------------- style: zcode-config
// ~/.zcode/cli/config.json: hooks.events.<PascalEvent> = [{matcher?, hooks:[...]}]
function zcodeConfigInstall() {
  const node = findNode();
  const cfgPath = path.join(HOME, '.zcode', 'cli', 'config.json');
  const cfg = readJson(cfgPath, {});
  backup(cfgPath);
  cfg.hooks = cfg.hooks || {};
  cfg.hooks.enabled = true;
  cfg.hooks.events = cfg.hooks.events || {};
  for (const ev of PASCAL_EVENTS) {
    const list = Array.isArray(cfg.hooks.events[ev]) ? cfg.hooks.events[ev] : [];
    const has = list.some((e) => (e.hooks || []).some((h) => h.statusMessage === 'petbuddy'));
    if (!has) {
      list.push({
        hooks: [{
          type: 'process', command: node,
          args: [BRIDGE, '--app', 'zcode', '--event', ev, '--spawn'],
          timeoutMs: 4000, statusMessage: 'petbuddy',
        }],
      });
    }
    cfg.hooks.events[ev] = list;
  }
  writeJson(cfgPath, cfg);
  return { file: cfgPath };
}
function zcodeConfigUninstall() {
  const cfgPath = path.join(HOME, '.zcode', 'cli', 'config.json');
  const cfg = readJson(cfgPath, null);
  if (cfg && cfg.hooks && cfg.hooks.events) {
    for (const ev of Object.keys(cfg.hooks.events)) {
      cfg.hooks.events[ev] = (cfg.hooks.events[ev] || []).filter(
        (e) => !(e.hooks || []).some((h) => h.statusMessage === 'petbuddy'));
    }
    writeJson(cfgPath, cfg);
  }
  return { file: cfgPath };
}
function zcodeConfigStatus() {
  const cfgPath = path.join(HOME, '.zcode', 'cli', 'config.json');
  const cfg = readJson(cfgPath, {});
  const evs = (cfg.hooks && cfg.hooks.events) || {};
  const installed = Object.values(evs).some((list) =>
    (list || []).some((e) => (e.hooks || []).some((h) => h.statusMessage === 'petbuddy')));
  return { installed, hint: installed ? 'config-file hooks 已写入' : '写入 ZCode 配置钩子' };
}

// -------------------------------------------------------- style: claude-file
// Claude-format hooks: standalone {"hooks":{...}} file, or the same object
// merged under the "hooks" key of an existing settings file.
function claudeFileInstall(step, app) {
  writeBridgeShim();
  const file = expand(step.path);
  const events = step.events || (step.eventCase === 'kebab' ? KEBAB_EVENTS : PASCAL_EVENTS);
  const command = fwd(shimCommand(app.id, '{{E}}'));
  const cfg = readJson(file, {});
  backup(file);
  cfg.hooks = cfg.hooks || {};
  for (const ev of events) {
    const cmd = command.replace('{{E}}', ev);
    const list = Array.isArray(cfg.hooks[ev]) ? cfg.hooks[ev] : [];
    const has = list.some((e) => (e.hooks || []).some((h) => String(h.command || '').includes(MARKER) && String(h.command || '').includes(`--app ${app.id} `)));
    if (!has) list.push({ hooks: [{ type: 'command', command: cmd }] });
    cfg.hooks[ev] = list;
  }
  writeJson(file, cfg);
  return { file };
}
function claudeFileUninstall(step, app) {
  const file = expand(step.path);
  const cfg = readJson(file, null);
  if (cfg && cfg.hooks) {
    for (const ev of Object.keys(cfg.hooks)) {
      cfg.hooks[ev] = (cfg.hooks[ev] || []).filter(
        (e) => !(e.hooks || []).some((h) => {
          const c = String(h.command || '');
          return c.includes(MARKER) && c.includes(`--app ${app.id} `);
        }));
    }
    writeJson(file, cfg);
  }
  return { file };
}
function claudeFileStatus(step, app) {
  const file = expand(step.path);
  const cfg = readJson(file, {});
  const installed = Object.values(cfg.hooks || {}).some((list) =>
    (list || []).some((e) => (e.hooks || []).some((h) => {
      const c = String(h.command || '');
      return c.includes(MARKER) && c.includes(`--app ${app.id} `);
    })));
  return { installed, hint: installed ? 'hooks 已配置' : `写入 ${file}` };
}

// -------------------------------------------------------- style: codex-notify
function codexNotifyInstall() {
  const node = findNode();
  const tomlPath = path.join(HOME, '.codex', 'config.toml');
  if (!fs.existsSync(tomlPath)) return { file: tomlPath, note: 'no config.toml' };
  backup(tomlPath);
  let toml = fs.readFileSync(tomlPath, 'utf8');
  if (!toml.includes('codex-notify.mjs')) {
    const m = toml.match(/^notify\s*=\s*(\[[^\n]*\])/m);
    const arr = [node, NOTIFY_WRAP, '--'];
    if (m) {
      try { arr.push(...JSON.parse(m[1].replace(/'/g, '"'))); } catch {}
    }
    const line = 'notify = ' + JSON.stringify(arr);
    toml = m ? toml.replace(m[0], line) : toml.replace(/\s*$/, '') + '\n' + line + '\n';
    fs.writeFileSync(tomlPath, toml);
  }
  return { file: tomlPath };
}
function codexNotifyUninstall() {
  const tomlPath = path.join(HOME, '.codex', 'config.toml');
  if (!fs.existsSync(tomlPath)) return { file: tomlPath };
  let toml = fs.readFileSync(tomlPath, 'utf8');
  const m = toml.match(/^notify\s*=\s*(\[[^\n]*\])/m);
  if (m && m[1].includes('codex-notify.mjs')) {
    try {
      const arr = JSON.parse(m[1].replace(/'/g, '"'));
      const sep = arr.indexOf('--');
      const prev = sep >= 0 ? arr.slice(sep + 1) : [];
      const line = prev.length ? 'notify = ' + JSON.stringify(prev) : null;
      toml = line ? toml.replace(m[0], line) : toml.replace(m[0] + '\n', '');
      fs.writeFileSync(tomlPath, toml);
    } catch {}
  }
  return { file: tomlPath };
}
function codexNotifyStatus() {
  const tomlPath = path.join(HOME, '.codex', 'config.toml');
  try { return { installed: fs.readFileSync(tomlPath, 'utf8').includes('codex-notify.mjs'), hint: 'notify 包装' }; }
  catch { return { installed: false, hint: 'notify 包装(config.toml 不存在)' }; }
}

// ------------------------------------------------------------ style: dsh-patch
function dshHome() {
  // DSH 的 home 因安装方式而异：优先环境变量，其次常见位置；
  // 若某候选里已存在 profiles/web/cordis.patch.yml，直接认为就是它。
  const cands = [
    process.env.DSH_HOME,
    process.env.DSH_DATA_HOME,
    path.join(HOME, '.deepseek-harness'),
    path.join(HOME, '.dsh'),
    'D:\\DeepSeekHarness\\dsh-data',
    path.join(HOME, 'DeepSeekHarness', 'dsh-data'),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'profiles', 'web', 'cordis.patch.yml'))) return c;
    } catch {}
  }
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return cands[0];
}
const DSH_HOOKS_JSON = path.join(PET_HOME, 'dsh-hooks.json');

function dshPatchInstall(step, app) {
  writeBridgeShim();
  const events = step.events || ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
  const hj = { hooks: {} };
  for (const ev of events) {
    hj.hooks[ev] = [{ hooks: [{ type: 'command', command: shimCommand(app.id, ev), timeout: 4 }] }];
  }
  fs.mkdirSync(PET_HOME, { recursive: true });
  writeJson(DSH_HOOKS_JSON, hj);

  const patch = path.join(dshHome(), 'profiles', 'web', 'cordis.patch.yml');
  const entry = [
    '- insert:',
    '    - id: petbuddy-hooks',
    "      name: '@deepseek-ai/dsh-hooks-claude-code'",
    '      config:',
    `        configPath: '${DSH_HOOKS_JSON.replace(/\\/g, '/')}'`,
    '        defaultTimeoutMs: 4000',
    '',
  ].join('\n');
  if (fs.existsSync(patch)) {
    backup(patch);
    let yml = fs.readFileSync(patch, 'utf8');
    if (!yml.includes('id: petbuddy-hooks')) {
      if (!yml.endsWith('\n')) yml += '\n';
      yml += '\n# PetBuddy: forward session/tool events to the desktop pet\n' + entry;
      fs.writeFileSync(patch, yml);
    }
  } else {
    fs.mkdirSync(path.dirname(patch), { recursive: true });
    fs.writeFileSync(patch, '# PetBuddy: forward session/tool events to the desktop pet\n' + entry);
  }
  return { files: [DSH_HOOKS_JSON, patch] };
}
function dshPatchUninstall() {
  const patch = path.join(dshHome(), 'profiles', 'web', 'cordis.patch.yml');
  if (fs.existsSync(patch)) {
    let yml = fs.readFileSync(patch, 'utf8');
    yml = yml.replace(/\n?# PetBuddy:[^\n]*\n- insert:\n(?:[ \t]+[^\n]*\n)+/i, (m) =>
      m.includes('petbuddy-hooks') ? '' : m);
    fs.writeFileSync(patch, yml);
  }
  return { file: patch };
}
function dshPatchStatus() {  let installed = false;
  const patch = path.join(dshHome(), 'profiles', 'web', 'cordis.patch.yml');
  try { installed = fs.readFileSync(patch, 'utf8').includes('id: petbuddy-hooks'); } catch {}
  return { installed, hint: installed ? 'dsh-hooks-claude-code 已挂载' : '挂载 dsh-hooks-claude-code(网页审批仍需在网页操作)' };
}

// legacy cleanup: an earlier build wrote hooks into the desktop app's
// settings.json (~/.workbuddy) — the CLI actually reads ~/.codebuddy/settings.json
function workbuddyLegacyClean() {
  const file = path.join(HOME, '.workbuddy', 'settings.json');
  const cfg = readJson(file, null);
  if (cfg && cfg.hooks) {
    for (const ev of Object.keys(cfg.hooks)) {
      cfg.hooks[ev] = (cfg.hooks[ev] || []).filter(
        (e) => !(e.hooks || []).some((h) => String(h.command || '').includes(MARKER)));
    }
    writeJson(file, cfg);
  }
  return { file, cleaned: true };
}

// ------------------------------------------------------------- dispatch ----
const STYLE_INSTALL = {
  'zcode-config': () => zcodeConfigInstall(),
  'claude-file': (step, app) => claudeFileInstall(step, app),
  'codex-notify': () => codexNotifyInstall(),
  'dsh-patch': (step, app) => dshPatchInstall(step, app),
  'workbuddy-legacy-clean': () => workbuddyLegacyClean(),
};
const STYLE_UNINSTALL = {
  'zcode-config': () => zcodeConfigUninstall(),
  'claude-file': (step, app) => claudeFileUninstall(step, app),
  'codex-notify': () => codexNotifyUninstall(),
  'dsh-patch': () => dshPatchUninstall(),
  'workbuddy-legacy-clean': () => workbuddyLegacyClean(),
};
const STYLE_STATUS = {
  'zcode-config': () => zcodeConfigStatus(),
  'claude-file': (step, app) => claudeFileStatus(step, app),
  'codex-notify': () => codexNotifyStatus(),
  'dsh-patch': () => dshPatchStatus(),
  'workbuddy-legacy-clean': () => ({ installed: false, hint: '' }),
};

export async function statusAll() {
  const out = {};
  for (const app of apps.allApps()) {
    if (!(app.integration || []).length) {
      out[app.id] = {
        installed: false, manual: true,
        hint: '镜像模式:直接 POST /api/event 即可显示(app=' + app.id + ')',
        defaultApprove: app.keys.approve, defaultDeny: app.keys.deny,
      };
      continue;
    }
    let installed = false;
    const hints = [];
    for (const step of app.integration) {
      const fn = STYLE_STATUS[step.style];
      if (!fn) { hints.push(`未知样式 ${step.style}`); continue; }
      const st = fn(step, app);
      installed = installed || !!st.installed;
      if (st.hint) hints.push(st.hint);
    }
    if ((app.id === 'codex' || app.id === 'workbuddy') && !installed) {
      hints.push('外部写入的钩子需在该应用的 /hooks 面板中信任后才会生效');
    }
    out[app.id] = {
      installed, hint: hints.join(' · '),
      defaultApprove: app.keys.approve, defaultDeny: app.keys.deny,
    };
  }
  return out;
}

export async function installOne(appId) {
  const app = apps.getApp(appId);
  if (!app) throw new Error('unknown app: ' + appId);
  if (!(app.integration || []).length) return { skipped: true, reason: 'mirror-only app' };
  const results = [];
  for (const step of app.integration) {
    const fn = STYLE_INSTALL[step.style];
    if (fn) results.push(fn(step, app));
  }
  return { results };
}

export async function uninstallOne(appId) {
  const app = apps.getApp(appId);
  if (!app) throw new Error('unknown app: ' + appId);
  const results = [];
  for (const step of app.integration || []) {
    const fn = STYLE_UNINSTALL[step.style];
    if (fn) results.push(fn(step, app));
  }
  return { results };
}

// ------------------------------------------------------------------- CLI ----
// both sides realpath'd: the workspace dir is reached through a symlink
function sameFile(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return a === b; }
}
if (process.argv[1] && sameFile(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {  const [action, appId] = process.argv.slice(2);
  (async () => {
    if (action === 'status') {
      console.log(JSON.stringify(await statusAll(), null, 2));
    } else if (action === 'install' || action === 'uninstall') {
      const ids = appId ? [appId] : apps.allApps().map((a) => a.id);
      for (const id of ids) {
        const fn = action === 'install' ? installOne : uninstallOne;
        const r = await fn(id);
        console.log(`[${action}] ${id}:`, JSON.stringify(r));
      }
    } else {
      console.log('usage: node integrations/install.mjs install|uninstall|status [appId]');
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
