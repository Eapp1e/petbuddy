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
};

const fileCache = new Map();   // fp -> { key, size, day, totals }
const appCache = new Map();    // appId -> { ts, totals }
const APP_TTL = 60000;         // 同一应用 60s 内不重复扫描（首次全扫约百毫秒）
const MAX_READ = 8 * 1024 * 1024;

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
    } else if (it.name.endsWith('.jsonl')) {
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
  if (!usage || typeof usage !== 'object') return;
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const ctx = num(usage.input_tokens) + cacheRead + cacheWrite;
  totals.out += num(usage.output_tokens);          // 可累加
  if (ctx > totals.ctx) {                          // 取峰值，不累加
    totals.ctx = ctx;
    totals.cache = cacheRead;
  }
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
function scanApp(appId) {
  const hit = appCache.get(appId);
  const now = Date.now();
  if (hit && now - hit.ts < APP_TTL) return hit.totals;

  const dayMs = dayStartMs();
  const files = [];
  for (const root of ROOTS[appId] || []) collectFiles(root, dayMs, files);
  const totals = zero();
  for (const fp of files) {
    const t = scanFile(appId, fp, dayMs);
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
  // 测试用：直接对指定文件跑解析（生产代码不用）
  _internals: { scanFile, accumulateLine, zero, dayStartMs },
};
