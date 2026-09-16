'use strict';
/**
 * Token 用量统计：从各 Agent 自己的会话记录里累计 token 消耗。
 *
 * 数据源：
 *  - Claude 系（WorkBuddy / CodeBuddy / Claude Code）JSONL：assistant 行的
 *    message.usage，或部分的顶层 usage {input_tokens, output_tokens,
 *    cache_read_input_tokens, cache_creation_input_tokens}
 *  - Codex rollout JSONL：event_msg → payload.type === 'token_count'，
 *    payload.info.total_token_usage 是**累计值**（取最后一条，不做求和）
 *
 * 统计口径（只算"今天"，本地零点起）：
 *  - out   今天生成量：output tokens 逐条累加（各格式都准确）
 *  - ctx   上下文峰值：单次请求里 input+cache 的最大值。注意**不能累加**——
 *          WorkBuddy/Claude 的 input_tokens 是"每次请求的完整上下文"，
 *          一个会话几十上百次请求，累加出来的数字没有意义（会虚高几千倍）
 *  - cache 缓存读取量（同样只取峰值，避免重复计数）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 默认单价（USD / 1M tokens），仅用于估算；可在 config.system.tokenPrices 覆盖 */
const DEFAULT_PRICES = { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** 各应用的历史记录根目录 */
const ROOTS = {
  workbuddy: [path.join(os.homedir(), '.workbuddy', 'projects')],
  codebuddy: [path.join(os.homedir(), '.codebuddy', 'projects')],
  claude: [path.join(os.homedir(), '.claude', 'projects')],
  codex: [path.join(os.homedir(), '.codex', 'sessions')],
  // ZCode：模型 I/O 流水（每条带 response.usage）
  zcode: [path.join(os.homedir(), '.zcode', 'cli', 'rollout')],
  // DSH：投影缓存（每个会话一个 json，里面是 tokenUsage）
  dsh: [
    process.env.DSH_HOME,
    path.join(os.homedir(), '.dsh'),
    path.join(os.homedir(), 'DeepSeekHarness', 'dsh-data'),
    'D:\\DeepSeekHarness\\dsh-data',
  ].filter(Boolean),
};

/** 每个应用扫哪些扩展名（DSH 的投影缓存是 .json） */
const EXTS = { dsh: ['.json'] };

const fileCache = new Map();   // fp -> { key, size, day, totals }
const appCache = new Map();    // appId -> { ts, totals }
const APP_TTL = 60000;         // 同一应用 60s 内不重复扫描（首次全扫约百毫秒）
const MAX_READ = 8 * 1024 * 1024;


// --------------------------------------------------------------- 自动探测 --
// 目的：接入任意应用时自动找到它的用量数据源，而不是每个应用手写一套路径。
// 做法：从"可能相关的目录"里找最近改动的 json/jsonl，抽样嗅探有没有用量字段。

/** 通用用量提取：在任意嵌套结构里找第一个"像 token 用量"的对象 */
function extractUsage(node, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) { const r = extractUsage(v, depth + 1, seen); if (r) return r; }
    return null;
  }
  const pick = (...names) => {
    for (const n of names) {
      const v = node[n];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    }
    return 0;
  };
  const inp = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'uncachedInputTokens');
  const out = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'decodeTokens');
  const cac = pick('cachedInputTokens', 'cached_input_tokens', 'cacheReadTokens', 'cache_read_input_tokens', 'cacheReadInputTokens');
  if (inp || out || cac) return { in: inp, out, cache: cac, ctx: inp + cac };
  for (const v of Object.values(node)) {
    const r = extractUsage(v, depth + 1, seen);
    if (r) return r;
  }
  return null;
}

/** 读文件的一段（offset 起 len 字节） */
function readChunk(fp, offset, len) {
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.allocUnsafe(Math.max(0, len));
    const n = fs.readSync(fd, buf, 0, Math.max(0, len), Math.max(0, offset));
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
}

/** 在一段文本里找用量：先按行（JSONL），再整体当 JSON 试 */
function sniffText(text, maxLines = 80) {
  if (!text) return null;
  const lines = text.split(String.fromCharCode(10)).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0 && i > lines.length - maxLines; i--) {
    try {
      const u = extractUsage(JSON.parse(lines[i]));
      if (u) return u;
    } catch {}
  }
  try {
    const u = extractUsage(JSON.parse(text));
    if (u) return u;
  } catch {}
  return null;
}

/**
 * 抽样嗅探一个文件：尾部 512KB 找不到就再看头部 256KB。
 * （只读尾部会漏：有些流水文件末尾全是报错条目，真正的用量的在中间/前部。）
 */
function sniffFile(fp) {
  let size = 0;
  try {
    const st = fs.statSync(fp);
    size = st.size;
    if (size < 40) return null;
  } catch { return null; }

  const tailLen = Math.min(size, 512 * 1024);
  let hit = sniffText(readChunk(fp, size - tailLen, tailLen));
  if (hit) return hit;

  if (size > tailLen) {
    const headLen = Math.min(size, 256 * 1024);
    hit = sniffText(readChunk(fp, 0, headLen));
    if (hit) return hit;
  }
  return null;
}

function expandPath(p) {
  if (!p) return p;
  return String(p)
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%APPDATA%/gi, process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
}

/** 猜这个应用可能把会话/日志放在哪 */
function candidateRoots(appId, hints = {}) {
  const id = String(appId || '').toLowerCase();
  const home = os.homedir();
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  add(path.join(home, '.' + id));
  add(path.join(home, '.' + id, 'projects'));
  add(path.join(home, '.' + id, 'sessions'));
  add(path.join(home, '.' + id, 'logs'));
  add(path.join(home, '.' + id, 'cli', 'rollout'));
  const cap = id.charAt(0).toUpperCase() + id.slice(1);
  add(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), cap));
  for (const m of hints.markers || []) {
    const e = expandPath(m);
    out.push(fs.existsSync(e) && fs.statSync(e).isDirectory() ? e : path.dirname(e));
  }
  for (const ip of hints.integrationPaths || []) {
    if (ip) add(expandPath(path.dirname(String(ip))));
  }
  for (const r of hints.extraRoots || []) add(expandPath(r));
  return out.filter((p) => {
    try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

function collectRecent(root, sinceMs, out, depth = 0, budget = { n: 400 }) {
  if (budget.n <= 0 || depth > 4) return;
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (budget.n <= 0) return;
    const fp = path.join(root, it.name);
    if (it.isDirectory()) {
      if (!/^(node_modules|\.git|dist|build|out|cache|Cache)$/i.test(it.name)) collectRecent(fp, sinceMs, out, depth + 1, budget);
    } else if (/\.(json|jsonl)$/i.test(it.name)) {
      budget.n -= 1;
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs >= sinceMs && st.size >= 40) out.push({ fp, mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
}

/**
 * 自动探测某应用的用量数据源。
 * @returns {{root:string, file:string, sample:object}[]}
 */
function discoverSource(appId, hints = {}) {
  const since = Date.now() - 3 * 86400000;   // 近 3 天改过的文件
  const roots = candidateRoots(appId, hints);
  const files = [];
  for (const root of roots) collectRecent(root, since, files);
  files.sort((a, b) => b.mtime - a.mtime);
  const hits = [];
  const seenRoot = new Set();
  const t0 = Date.now();
  for (const f of files) {
    if (Date.now() - t0 > 2500) break;        // 时间预算：别让接入卡住
    if (hits.length >= 3) break;
    const root = roots.find((r) => f.fp.startsWith(r)) || path.dirname(f.fp);
    if (seenRoot.has(root)) continue;
    const sample = sniffFile(f.fp);
    if (sample) {
      seenRoot.add(root);
      hits.push({ root, file: f.fp, sample });
    }
  }
  return hits;
}

function zero() { return { out: 0, ctx: 0, cache: 0 }; }
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }
function dayStartMs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayKey() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

function collectFiles(root, dayMs, out, depth = 0) {
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const fp = path.join(root, it.name);
    if (it.isDirectory()) {
      if (depth < 4) collectFiles(fp, dayMs, out, depth + 1);
    } else if (it.name.endsWith('.jsonl') || it.name.endsWith('.json')) {
      try { if (fs.statSync(fp).mtimeMs >= dayMs) out.push(fp); } catch {}
    }
  }
}

/** 解析单行，累加进 totals（按行时间戳过滤"今天"） */
function accumulateLine(appId, line, totals, dayMs, state) {
  if (!line || line.length < 20) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }

  let ts = 0;
  if (typeof j.timestamp === 'string') ts = Date.parse(j.timestamp) || 0;
  else if (typeof j.ts === 'number') ts = j.ts;
  if (ts && ts < dayMs) return;

  // ZCode：response.usage（AI SDK 风格，字段大小写不定）
  if (appId === 'zcode') {
    const u = (j.response && j.response.usage) || j.usage;
    if (!u || typeof u !== 'object') return;
    const inp = num(u.inputTokens || u.input_tokens || u.promptTokens || u.prompt_tokens);
    const cac = num(u.cachedInputTokens || u.cached_input_tokens || u.cacheReadInputTokens);
    const out2 = num(u.outputTokens || u.output_tokens || u.completionTokens || u.completion_tokens);
    totals.out += out2;
    const ctx = inp + cac;
    if (ctx > totals.ctx) { totals.ctx = ctx; totals.cache = cac; }
    return;
  }

  if (appId === 'codex') {
    const p = j.payload;
    if (p && p.type === 'token_count') {
      const u = (p.info && (p.info.total_token_usage || p.info.last_token_usage)) || {};
      state.cumulative = {
        out: num(u.output_tokens) + num(u.reasoning_output_tokens),
        ctx: num(u.input_tokens) + num(u.cached_input_tokens),
        cache: num(u.cached_input_tokens),
      };
    }
    return;
  }

  // Claude 系：assistant 消息的 usage，或顶层 usage（WorkBuddy 的 function_call 行）
  const usage = (j.message && j.message.usage) || j.usage;
  if (!usage || typeof usage !== 'object') {
    // 通用回退：结构不认识也能识别出用量（新接入的应用不用手写解析器）
    const g = extractUsage(j);
    if (g && (g.in || g.out || g.cache)) {
      totals.out += g.out;
      if (g.ctx > totals.ctx) { totals.ctx = g.ctx; totals.cache = g.cache; }
    }
    return;
  }
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const ctx = num(usage.input_tokens) + cacheRead + cacheWrite;
  totals.out += num(usage.output_tokens);          // 可累加
  if (ctx > totals.ctx) {                          // 取峰值，不累加
    totals.ctx = ctx;
    totals.cache = cacheRead;
  }
}

/**
 * DSH 的投影缓存：一个会话一个 JSON，形如
 *   record.rows.tokenUsage.val.totals = { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 *   record.rows.contextPressure.val.surfaceTokens = 当前上下文大小
 * tokenUsage 是**会话累计值**（和 Codex 一样，不做逐行求和）。
 */
function scanDshJson(fp, dayMs) {
  let st;
  try { st = fs.statSync(fp); } catch { return null; }
  const key = `${st.size}:${Math.floor(st.mtimeMs)}`;
  const day = dayKey();
  const prev = fileCache.get(fp);
  if (prev && prev.key === key && prev.day === day) return prev.totals;

  let j;
  try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return prev ? prev.totals : null; }
  const rows = (j && j.record && j.record.rows) || {};
  const totals = zero();

  const tu = rows.tokenUsage && rows.tokenUsage.val && rows.tokenUsage.val.totals;
  const surface = rows.contextPressure && rows.contextPressure.val && rows.contextPressure.val.surfaceTokens;
  if (tu && typeof tu === 'object') {
    totals.out = num(tu.outputTokens);
    totals.cache = num(tu.cacheReadTokens);
    totals.ctx = num(surface) || (num(tu.uncachedInputTokens) + num(tu.cacheReadTokens));
  }
  fileCache.set(fp, { key, size: st.size, day, totals });
  return totals;
}

function scanFile(appId, fp, dayMs) {
  let st;
  try { st = fs.statSync(fp); } catch { return null; }
  const key = `${st.size}:${Math.floor(st.mtimeMs)}`;
  const day = dayKey();
  const prev = fileCache.get(fp);
  if (prev && prev.key === key && prev.day === day) return prev.totals;

  let offset = (prev && prev.day === day && prev.size <= st.size) ? prev.size : 0;
  if (st.size - offset > MAX_READ) offset = 0;
  let text = '';
  try {
    const fd = fs.openSync(fp, 'r');
    const len = st.size - offset;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return prev ? prev.totals : null; }

  const totals = (offset > 0 && prev) ? { ...prev.totals } : zero();
  const state = {};
  for (const line of text.split('\n')) accumulateLine(appId, line, totals, dayMs, state);
  if (state.cumulative) {           // codex：文件内是累计值，直接采用（不求和）
    totals.out = state.cumulative.out;
    totals.ctx = state.cumulative.ctx;
    totals.cache = state.cumulative.cache;
  }
  fileCache.set(fp, { key, size: st.size, day, totals });
  return totals;
}

/** 扫描某应用今天的 token 用量（带 TTL 缓存） */
function scanApp(appId, extraRoots) {
  const hit = appCache.get(appId);
  const now = Date.now();
  if (hit && now - hit.ts < APP_TTL) return hit.totals;

  const dayMs = dayStartMs();
  const files = [];
  const roots = (ROOTS[appId] || []).concat((extraRoots || []).map((r) => (typeof r === 'string' ? r : r && r.root)).filter(Boolean));
  for (const root of roots) collectFiles(root, dayMs, files);
  const totals = zero();
  for (const fp of files) {
    const t = appId === 'dsh' ? scanDshJson(fp, dayMs) : scanFile(appId, fp, dayMs);
    if (!t) continue;
    totals.out += t.out;                      // 生成量跨文件相加
    if (t.ctx > totals.ctx) {                 // 上下文取各文件最大值
      totals.ctx = t.ctx;
      totals.cache = t.cache;
    }
  }
  const res = { ...totals, files: files.length };
  appCache.set(appId, { ts: now, totals: res });
  return res;
}

/** 估算费用（USD），prices 可来自 config.system.tokenPrices */
function estimateCost(totals, prices) {
  const p = Object.assign({}, DEFAULT_PRICES, prices || {});
  return (num(totals.in) * p.in + num(totals.out) * p.out +
          num(totals.cacheRead) * p.cacheRead + num(totals.cacheWrite) * p.cacheWrite) / 1e6;
}

module.exports = {
  scanApp, estimateCost, DEFAULT_PRICES, ROOTS,
  discoverSource, sniffFile, extractUsage, candidateRoots,
  // 测试用：直接对指定文件跑解析（生产代码不用）
  _internals: { scanFile, scanDshJson, accumulateLine, zero, dayStartMs },
};
