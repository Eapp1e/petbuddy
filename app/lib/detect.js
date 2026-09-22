'use strict';
/**
 * 扫描机器上"可接入"的 AI 编码 Agent。
 *
 * 判定方式：看各家自己的配置目录/文件是否存在于本机（快、零副作用），
 * 命中即认为"装过/用过"。每条自带推荐的接入方式：
 *   - 有明确 hooks 文件位置的 → 直接给 claude-file 配置（添加即可用）
 *   - 没有通用 hook 写入点的 → 镜像模式（应用发 HTTP 就能显示，不需要填路径）
 * 已在内置/用户注册表里的应用会被标记 added=true，UI 只列没添加过的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function expand(p) {
  if (!p) return p;
  return p
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%APPDATA%/gi, process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
}

const MIRROR = [{ style: 'none' }];


/**
 * 已知 Agent 目录。markers 命中任意一个就算"本机装过"。
 * 顺序按 2026 年 9 月的实际热度排（综合独立 IDE 热度榜、Agent 热度榜与开发者评分），
 * 冷门或已淘汰的条目不收录。integration 是推荐接入方式：
 * 有明确 hooks 文件位置的直接写配置，没有通用写入点的走镜像模式。
 */
const CATALOG = require('../definitions/apps.json');

/**
 * @param {string[]} existingIds 已经在注册表里的应用 id
 * @returns {{id,name,emoji,color,processNames,integration,note,markers:string[]}[]}
 */
function detect(existingIds = []) {
  const have = new Set(existingIds);
  const out = [];
  for (const app of CATALOG) {
    if (have.has(app.id)) continue;
    const hit = (app.markers || []).filter((m) => {
      try { return fs.existsSync(expand(m)); } catch { return false; }
    });
    if (!hit.length) continue;
    out.push({
      id: app.id, name: app.name, emoji: app.emoji, color: app.color,
      processNames: app.processNames || [], ports: app.ports || [],
      site: app.site || '',
      integration: app.integration || MIRROR,
      note: app.note || '',
      markers: hit.map(expand),
    });
  }
  return out;
}

/** 给"手填 ID"的用户一个兜底：命中目录就照抄推荐配置，否则用镜像模式 */
function suggestIntegration(id) {
  const app = CATALOG.find((a) => a.id === String(id || '').toLowerCase());
  return app ? app.integration : MIRROR;
}

/** 手填 claude-file 但没写路径时，猜一个合理位置（不报错、不阻塞添加） */
function guessClaudePath(id) {
  const app = CATALOG.find((a) => a.id === String(id || '').toLowerCase());
  const step = app && (app.integration || []).find((s) => s.style === 'claude-file');
  if (step && step.path) return step.path;
  const clean = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return clean ? `~/.${clean}/settings.json` : '';
}

/**
 * 把用户填的应用条目补齐成一个可用的接入配置。
 * 规则：没选 → 命中已知目录用推荐配置，否则镜像模式；
 *      选了 claude-file 但没写路径 → 用已知位置或 ~/.<id>/settings.json。
 * 永远不会因为"缺路径"而失败（这是之前添加应用被卡住的原因）。
 */
function resolveIntegration(entry) {
  const e = entry || {};
  const id = String(e.id || '').trim().toLowerCase();
  let steps = Array.isArray(e.integration) ? e.integration.slice() : [];
  if (!steps.length) steps = suggestIntegration(id).slice();
  steps = steps.map((st) => {
    const out = Object.assign({}, st);
    if (out.style === 'claude-file') {
      if (!out.path) out.path = guessClaudePath(id);
      if (!out.eventCase) out.eventCase = 'pascal';
    }
    return out;
  }).filter((st) => !(st.style === 'claude-file' && !st.path));
  if (!steps.length) steps = [{ style: 'none' }];
  return steps;
}

module.exports = { detect, suggestIntegration, guessClaudePath, resolveIntegration, CATALOG, expand };
