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
const CATALOG = [
  {
    id: 'claude', name: 'Claude Code', emoji: '✳️', color: '#d97757',
    processNames: ['claude.exe'], ports: [],
    site: 'claude.ai',
    markers: ['~/.claude/settings.json', '~/.claude/projects', '~/.claude.json'],
    integration: [{ style: 'claude-file', path: '~/.claude/settings.json', eventCase: 'pascal', standalone: false }],
    note: '写入 ~/.claude/settings.json 的 hooks 键',
  },
  {
    id: 'codex', name: 'Codex', emoji: '🦉', color: '#eef0f4',
    processNames: ['ChatGPT.exe', 'codex.exe'], ports: [],
    site: 'openai.com',
    markers: ['~/.codex/config.toml', '~/.codex/hooks.json', '~/.codex/sessions'],
    integration: [{ style: 'claude-file', path: '~/.codex/hooks.json', eventCase: 'kebab', standalone: true }, { style: 'codex-notify' }],
    note: 'hooks.json + notify 包装（原 notify 链式保留）',
  },
  {
    id: 'cursor', name: 'Cursor', emoji: '🖱️', color: '#8b95a5',
    processNames: ['Cursor.exe'], ports: [],
    site: 'cursor.com',
    markers: ['~/.cursor', '%APPDATA%/Cursor'],
    integration: MIRROR,
    note: '镜像模式：Cursor 暂无通用 hooks 写入点',
  },
  {
    id: 'trae', name: 'Trae', emoji: '🧭', color: '#2f80ed',
    processNames: ['Trae.exe'], ports: [],
    site: 'trae.ai',
    markers: ['~/.trae', '%APPDATA%/Trae'],
    integration: MIRROR,
    note: '镜像模式',
  },
  {
    id: 'opencode', name: 'OpenCode', emoji: '🅾️', color: '#7aa2f7',
    processNames: ['opencode.exe'], ports: [],
    site: 'opencode.ai',
    markers: ['~/.config/opencode', '~/.opencode', '%APPDATA%/opencode'],
    integration: MIRROR,
    note: '镜像模式',
  },
  {
    id: 'workbuddy', name: 'WorkBuddy', emoji: '🐝', color: '#57d9b5',
    processNames: ['WorkBuddy.exe'], ports: [],
    site: 'workbuddy.cn',
    markers: ['~/.workbuddy/settings.json', '~/.codebuddy/settings.json'],
    integration: [{ style: 'claude-file', path: '~/.workbuddy/settings.json', eventCase: 'pascal', standalone: false }, { style: 'claude-file', path: '~/.codebuddy/settings.json', eventCase: 'pascal', standalone: false }],
    note: '写入 settings.json 的 hooks 键（桌面端与内置 CLI 两处）',
  },
  {
    id: 'qoder', name: 'Qoder', emoji: '🧠', color: '#615ced',
    processNames: ['Qoder.exe'], ports: [],
    site: 'qoder.com',
    markers: ['~/.qoder', '%APPDATA%/Qoder'],
    integration: MIRROR,
    note: '镜像模式',
  },
  {
    id: 'windsurf', name: 'Windsurf', emoji: '🏄', color: '#3ba6a0',
    processNames: ['Windsurf.exe'], ports: [],
    site: 'windsurf.com',
    markers: ['~/.windsurf', '%APPDATA%/Windsurf'],
    integration: MIRROR,
    note: '镜像模式',
  },
  {
    id: 'gemini', name: 'Gemini CLI', emoji: '♊', color: '#4285f4',
    processNames: ['gemini.exe'], ports: [],
    site: 'gemini.google.com',
    markers: ['~/.gemini/settings.json', '~/.gemini'],
    integration: [{ style: 'claude-file', path: '~/.gemini/settings.json', eventCase: 'pascal', standalone: false }],
    note: '写入 ~/.gemini/settings.json（hooks 格式与 Claude 一致）',
  },
  {
    id: 'aider', name: 'Aider', emoji: '🛠️', color: '#4caf50',
    processNames: [], ports: [],
    site: 'aider.chat',
    markers: ['~/.aider.conf.yml', '~/.aider'],
    integration: MIRROR,
    note: '镜像模式（命令行工具）',
  },
  {
    id: 'cline', name: 'Cline', emoji: '🧩', color: '#4b8bf5',
    processNames: ['Code.exe'], ports: [],
    site: 'cline.bot',
    markers: ['~/.cline', '%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev'],
    integration: MIRROR,
    note: 'VS Code 扩展，镜像模式',
  },
  {
    id: 'roo', name: 'Roo Code', emoji: '🦘', color: '#e07a3f',
    processNames: ['Code.exe'], ports: [],
    site: 'roocode.com',
    markers: ['%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline'],
    integration: MIRROR,
    note: 'VS Code 扩展，镜像模式',
  },
  {
    id: 'continue', name: 'Continue', emoji: '➡️', color: '#7c5cff',
    processNames: ['Code.exe'], ports: [],
    site: 'continue.dev',
    markers: ['~/.continue'],
    integration: MIRROR,
    note: '镜像模式',
  },
  {
    id: 'qwen', name: 'Qwen Code', emoji: '🌙', color: '#615ced',
    processNames: ['qwen.exe'], ports: [],
    site: 'qwenlm.github.io',
    markers: ['~/.qwen/settings.json', '~/.qwen'],
    integration: [{ style: 'claude-file', path: '~/.qwen/settings.json', eventCase: 'pascal', standalone: false }],
    note: '写入 ~/.qwen/settings.json',
  },
  {
    id: 'iflow', name: 'iFlow CLI', emoji: '🌊', color: '#0ea5e9',
    processNames: ['iflow.exe'], ports: [],
    site: 'iflow.cn',
    markers: ['~/.iflow/settings.json', '~/.iflow'],
    integration: [{ style: 'claude-file', path: '~/.iflow/settings.json', eventCase: 'pascal', standalone: false }],
    note: '写入 ~/.iflow/settings.json',
  },
  {
    id: 'kimi', name: 'Kimi Code', emoji: '🌕', color: '#8b5cf6',
    processNames: ['kimi.exe'], ports: [],
    site: 'moonshot.cn',
    markers: ['~/.kimi', '%APPDATA%/Kimi'],
    integration: MIRROR,
    note: '镜像模式',
  },
  {
    id: 'zcode', name: 'ZCode', emoji: '🤖', color: '#17181c',
    processNames: ['ZCode.exe'], ports: [],
    site: 'zcode.ai',
    markers: ['~/.zcode/cli/config.json', '~/.zcode'],
    integration: [{ style: 'zcode-config' }],
    note: '写入 ~/.zcode/cli/config.json 的 hooks 键',
  },
  {
    id: 'dsh', name: 'DeepSeek Harness', emoji: '🐋', color: '#4d6bfe',
    processNames: [], ports: [],
    site: 'deepseek.com',
    markers: ['~/.dsh', '~/DeepSeekHarness/dsh-data', 'D:/DeepSeekHarness/dsh-data'],
    integration: [{ style: 'dsh-patch' }],
    note: '挂载 dsh-hooks-claude-code 指向 ~/.petbuddy/dsh-hooks.json',
  },
  {
    id: 'pi', name: 'Pi agent', emoji: '🥧', color: '#f97316',
    processNames: ['Pi.exe'], ports: [],
    site: 'pi.dev',
    markers: ['~/.pi', '%APPDATA%/Pi agent', '%APPDATA%/Pi'],
    integration: MIRROR,
    note: '镜像模式',
  },
  {
    id: 'mimo', name: 'Xiaomi MiMo', emoji: '📱', color: '#ff6900',
    processNames: ['MiMo.exe'], ports: [],
    site: 'mimo.xiaomi.com',
    markers: ['~/.mimo', '%APPDATA%/MiMo', '%LOCALAPPDATA%/MiMo'],
    integration: MIRROR,
    note: '镜像模式',
  },
  {
    id: 'goose', name: 'Goose', emoji: '🪿', color: '#8a8f98',
    processNames: ['goose.exe'], ports: [],
    site: 'block.github.io',
    markers: ['~/.config/goose'],
    integration: MIRROR,
    note: '镜像模式，原生支持 MCP',
  },
  {
    id: 'amp', name: 'Amp', emoji: '🔌', color: '#c084fc',
    processNames: ['amp.exe'], ports: [],
    site: 'ampcode.com',
    markers: ['~/.config/amp', '~/.amp'],
    integration: MIRROR,
    note: '镜像模式',
  },
];

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
