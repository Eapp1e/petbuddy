'use strict';
/**
 * App registry — the single source of truth for "which apps does PetBuddy watch".
 *
 * Merge order: built-in defaults < ~/.petbuddy/apps.config.json < runtime
 * dynamic registrations (persisted back into apps.config.json).
 *
 * Adding a new app (standard flow, see README):
 *   1. drop a block into ~/.petbuddy/apps.config.json (any integration style),
 *      or just let the app POST /api/event with its own app id — it gets
 *      registered automatically in mirror mode;
 *   2. click 重装/安装接入 in settings (or `node integrations/install.mjs install <id>`).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.PETBUDDY_HOME || path.join(os.homedir(), '.petbuddy');
const REG_PATH = path.join(DATA_DIR, 'apps.config.json');
const defaults = require('./app-defaults');

let registry = {};        // id -> app meta
let order = [];           // display order

function normalizeEntry(raw) {
  if (!raw || !raw.id) return null;
  return {
    id: String(raw.id).toLowerCase(),
    name: raw.name || raw.id,
    color: raw.color || '#9aa4b2',
    emoji: raw.emoji || '🍡',
    icon: raw.icon || '',
    processNames: Array.isArray(raw.processNames) ? raw.processNames : [],
    ports: Array.isArray(raw.ports) ? raw.ports : [],
    keys: {
      approve: (raw.keys && raw.keys.approve) !== undefined ? raw.keys.approve : '',
      deny: (raw.keys && raw.keys.deny) !== undefined ? raw.keys.deny : '',
    },
    integration: Array.isArray(raw.integration) ? raw.integration : [],
    dynamic: !!raw.dynamic,
    user: !!raw.user,
    // 自动探测出来的用量数据源（接入应用时后台填上）
    tokenRoots: Array.isArray(raw.tokenRoots) ? raw.tokenRoots : [],
    tokenDiscovered: !!raw.tokenDiscovered,
  };
}

function upsert(app) {
  if (!registry[app.id]) order.push(app.id);
  registry[app.id] = app;
}

function persistDynamic() {
  try {
    const cfg = readRegFile();
    const dyn = order.map((id) => registry[id]).filter((a) => a.dynamic);
    cfg.apps = (cfg.apps || []).filter((a) => !a.dynamic).concat(dyn);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REG_PATH, JSON.stringify(cfg, null, 2));
  } catch {}
}

/** Add a user-defined app (settings UI). Overwrites dynamic registrations. */
function addUserApp(entry) {
  const app = normalizeEntry({ ...entry, user: true });
  if (!app) throw new Error('应用配置不完整(需要 id)');
  if (!/^[a-z0-9_-]{1,32}$/.test(app.id)) throw new Error('应用 id 只能用小写字母/数字/连字符');
  const existing = registry[app.id];
  if (existing && !existing.dynamic && !existing.user) {
    throw new Error(`应用 id 已被占用: ${app.id}`);
  }
  const cfg = readRegFile();
  cfg.apps = (cfg.apps || []).filter((a) => String(a.id).toLowerCase() !== app.id);
  cfg.apps.push({ ...app });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REG_PATH, JSON.stringify(cfg, null, 2));
  upsert(app);
  return app;
}

/** Update an app's editable fields (works for built-in and user apps alike).
 *  Built-ins get an override record in apps.config.json carrying their current
 *  definition, so nothing beyond the patched fields is lost. */
function updateApp(id, patch) {
  const key = String(id).toLowerCase();
  const cur = registry[key];
  if (!cur) return { ok: false, error: '应用不存在' };
  const cfg = readRegFile();
  const list = cfg.apps || (cfg.apps = []);
  let rec = list.find((a) => String(a.id).toLowerCase() === key);
  if (!rec) {
    rec = { user: true };
    for (const k of ['id', 'name', 'color', 'emoji', 'icon', 'processNames', 'ports', 'keys', 'integration']) {
      if (cur[k] !== undefined) rec[k] = cur[k];
    }
    list.push(rec);
  }
  for (const k of ['name', 'color', 'emoji', 'icon', 'processNames', 'ports', 'keys']) {
    if (patch && patch[k] !== undefined) rec[k] = patch[k];
  }
  rec.id = key;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REG_PATH, JSON.stringify(cfg, null, 2));
  upsert(normalizeEntry(rec));
  return { ok: true };
}

/** Remove a user-added/dynamic app. Built-ins cannot be removed. */
function removeUserApp(id) {
  const key = String(id).toLowerCase();
  const app = registry[key];
  const cfg = readRegFile();
  const inFile = (cfg.apps || []).some((a) => String(a.id).toLowerCase() === key);
  if (!app) return { ok: false, error: '应用不存在' };
  if (!app.dynamic && !app.user && !inFile) return { ok: false, error: '内置应用不能删除' };
  delete registry[key];
  order = order.filter((x) => x !== key);
  cfg.apps = (cfg.apps || []).filter((a) => String(a.id).toLowerCase() !== key);
  fs.writeFileSync(REG_PATH, JSON.stringify(cfg, null, 2));
  return { ok: true };
}

function readRegFile() {
  try { return JSON.parse(fs.readFileSync(REG_PATH, 'utf8')); } catch { return { apps: [] }; }
}

function reload() {
  registry = {};
  order = [];
  for (const raw of defaults.apps || []) {
    const app = normalizeEntry(raw);
    if (app) upsert(app);
  }
  const user = readRegFile();
  for (const raw of user.apps || []) {
    const app = normalizeEntry(raw);
    if (app) upsert(app); // user entries override defaults with the same id
  }
}

/**
 * Resolve an app id coming from an event. Unknown ids are auto-registered in
 * mirror mode (no integration, no keys) so any tool that can POST /api/event
 * shows up on the pet without any setup.
 */
function resolveApp(id) {
  if (!id) return null;
  const key = String(id).toLowerCase();
  if (registry[key]) return registry[key];
  const app = normalizeEntry({ id: key, name: id, dynamic: true });
  upsert(app);
  persistDynamic();
  return app;
}

function getApp(id) {
  return registry[String(id).toLowerCase()] || null;
}

function allApps() {
  return order.map((id) => registry[id]);
}

function iconUrl(app) {
  try {
    if (app && app.icon && fs.existsSync(app.icon)) {
      return require('url').pathToFileURL(app.icon).href;
    }
  } catch {}
  return '';
}

reload();

module.exports = {
  REG_PATH, reload, resolveApp, getApp, allApps, iconUrl, persistDynamic, normalizeEntry,
  addUserApp, removeUserApp, updateApp,
  /** legacy helpers */
  get APP_IDS() { return order.slice(); },
  get APPS() { return registry; },
  normalizeAppId: (id) => (getApp(id) ? String(id).toLowerCase() : null),
};
