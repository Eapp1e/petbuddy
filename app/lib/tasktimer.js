'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * True task timer, read from the agent's own session transcript.
 *
 * WorkBuddy / CodeBuddy / Claude Code keep JSONL transcripts at
 *   <home>/projects/<workspace-slug>/<sessionId>.jsonl
 * and Codex at <home>/sessions/<Y>/<M>/<D>/rollout-*-<id>.jsonl.
 *
 * The timestamp of the LAST user message in that file is the real start of
 * the current task (same clock the app itself shows as "已处理"). Reading it
 * keeps the timer correct across pet restarts — the pet's own counter would
 * restart from zero, which is wrong.
 */
const ROOTS = [
  path.join(os.homedir(), '.workbuddy', 'projects'),
  path.join(os.homedir(), '.codebuddy', 'projects'),
  path.join(os.homedir(), '.claude', 'projects'),
];
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
// ZCode 的模型 I/O 流水：每条含 sessionId / startedAt / completedAt（ISO 或 ms）
const ZCODE_ROLLOUT = path.join(os.homedir(), '.zcode', 'cli', 'rollout');
// Qoder 的运行日志：logs/runs/<本地时间戳>-<runid>/qodercli.log，每个 agent 运行一个目录，
// 干活时持续写入、空闲时不再有新 run——mtime 和目录名里的起始时间都是可靠信号
const QODER_LOGS = path.join(os.homedir(), '.qoder', 'logs');
// DeepSeek Harness (DSH) keeps a plain-JSON projection cache per session —
// usable as a heartbeat even though its raw logs are zstd-compressed.
const DSH_HOMES = [
  process.env.DSH_HOME,
  path.join(os.homedir(), '.dsh'),
].filter(Boolean);

// DSH 数据目录覆盖：由 main 在启动时从应用定义的 activity.roots 注入，
// 使累计式扫描/回合判定不依赖可能过期的 DSH_HOME 环境变量
let DSH_HOMES_OVERRIDE = null;
function setDshHomes(list) {
  DSH_HOMES_OVERRIDE = Array.isArray(list) && list.length ? list.map(expandPath) : null;
}
const TAIL_BYTES = 256 * 1024;
const cache = new Map(); // sessionId -> { ts, key }

/** newest user-message timestamp inside a JSONL chunk (0 = none) */
function userTsFromChunk(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || l.charCodeAt(0) !== 123) continue; // '{'
    let o;
    try { o = JSON.parse(l); } catch { continue; } // partial first line is fine
    const role = o.role
      || (o.message && o.message.role)
      || (o.payload && (o.payload.role || (o.payload.message && o.payload.message.role)));
    if (role !== 'user') continue;
    // Claude 系转写把工具结果也存成 user 角色消息（content 是 tool_result 数组），
    // 这些不是真提示——把它们当回合起点会让运行时间不停归零（老问题"运行时间不准"）。
    const mc = o.message && o.message.content;
    if (Array.isArray(mc) && mc.some((x) => x && (x.type === 'tool_result' || x.tool_use_id))) continue;
    if (o.isMeta) continue;
    const t = o.timestamp || (o.payload && o.payload.timestamp);
    if (typeof t === 'number') return t > 1e12 ? t : t * 1000; // ms | seconds
    if (typeof t === 'string') { const v = Date.parse(t); if (!isNaN(v)) return v; }
  }
  return 0;
}

function readTail(fp) {
  try {
    const size = fs.statSync(fp).size;
    const len = Math.min(size, TAIL_BYTES);
    const fd = fs.openSync(fp, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return userTsFromChunk(buf.toString('utf8'));
    } finally { try { fs.closeSync(fd); } catch {} }
  } catch { return 0; }
}

/** newest-first candidate transcript files for a session id */
function candidates(sessionId) {
  const out = [];
  for (const root of ROOTS) {
    let slugs = [];
    try { slugs = fs.readdirSync(root); } catch { continue; }
    for (const slug of slugs) {
      const fp = path.join(root, slug, sessionId + '.jsonl');
      try {
        const st = fs.statSync(fp);
        out.push({ fp, mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  // codex: sessions/<Y>/<M>/<D>/rollout-<ts>-<id>.jsonl — scan the last 3 days
  try {
    const now = Date.now();
    for (let d = 0; d < 3; d++) {
      const day = new Date(now - d * 86400000);
      const dir = path.join(CODEX_SESSIONS, String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        if (!f.includes(sessionId)) continue;
        const fp = path.join(dir, f);
        try {
          const st = fs.statSync(fp);
          out.push({ fp, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  } catch {}
  // DeepSeek Harness: projcache JSON is written continuously while a turn runs
  for (const home of (DSH_HOMES_OVERRIDE && DSH_HOMES_OVERRIDE.length ? DSH_HOMES_OVERRIDE : DSH_HOMES)) {
    for (const name of [sessionId + '.json', 'session-' + sessionId + '.json']) {
      const fp = path.join(home, 'storages', 'session_projcache', 'sessions', name);
      try {
        const st = fs.statSync(fp);
        out.push({ fp, mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
    let slugs = [];
    try { slugs = fs.readdirSync(path.join(home, 'sessions')); } catch {}
    for (const slug of slugs) {
      for (const dir of [sessionId, 'session-' + sessionId]) {
        const fp = path.join(home, 'sessions', slug, dir, 'session.jsonl.zstd');
        try {
          const st = fs.statSync(fp);
          out.push({ fp, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  }
  // zcode: rollout/model-io-sess_<id>.jsonl — 文件名含 sessionId，取最近 3 天
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(ZCODE_ROLLOUT)) {
      if (!f.startsWith('model-io-')) continue;
      if (sessionId && !f.includes(sessionId)) continue;
      const fp = path.join(ZCODE_ROLLOUT, f);
      const st = fs.statSync(fp);
      if (now - st.mtimeMs > 3 * 86400000) continue;
      out.push({ fp, mtime: st.mtimeMs, size: st.size, zcode: true });
    }
  } catch {}
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 3);
}

/** DSH keeps the authoritative turn start in its plain-JSON projection cache
 *  (sessionListMetadata.lastPromptAt — the same clock its UI counts from). */
function projTurnStart(fp) {
  try {
    const o = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const rows = (o.record && o.record.rows) || {};
    const meta = rows.sessionListMetadata && rows.sessionListMetadata.val;
    const sub = rows.subagentTiming && rows.subagentTiming.val;
    const t = (meta && meta.lastPromptAt) || (sub && sub.pendingTurnStart);
    return typeof t === 'number' && t > 0 ? t : 0;
  } catch { return 0; }
}

/** ms timestamp when the current task/turn started (0 = unknown).
 *  The cached value is keyed by the transcript's (mtime,size), so a new user
 *  message in the file is picked up on the next call without waiting a TTL. */
function turnStart(sessionId, force) {
  if (!sessionId) return 0;
  const files = candidates(sessionId);
  if (!files.length) return 0;
  const f = files[0];
  const key = `${f.mtime}:${f.size}`;
  const c = cache.get(sessionId);
  if (!force && c && c.key === key) return c.ts;
  const ts = f.zcode ? zcodeTurnStart(f.fp)
    : f.fp.endsWith('.json') ? projTurnStart(f.fp) : readTail(f.fp);
  cache.set(sessionId, { ts, key });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return ts;
}

/**
 * ZCode 当前回合起点：model-io 流水里每条请求都有 startedAt。
 * 取尾部记录按时间排序后，从最新往回走，把间隔 ≤ 3 分钟的算作同一回合，
 * 该回合最早一条的 startedAt 就是本回合真正开始的时间——
 * 桌宠重启、钩子静默都不影响（数据在 ZCode 自己的流水里）。
 */
function zcodeTurnStart(fp, maxBytes = 512 * 1024) {
  let entries = [];
  try {
    const st = fs.statSync(fp);
    const len = Math.min(st.size, maxBytes);
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    for (const l of text.split('\n')) {
      const t = l.trim();
      if (!t.startsWith('{')) continue;
      let o;
      try { o = JSON.parse(t); } catch { continue; }
      const v = Date.parse(o.startedAt || o.completedAt || '');
      if (!isNaN(v)) entries.push(v);
    }
  } catch { return 0; }
  entries = entries.sort((a, b) => a - b);
  if (!entries.length) return 0;
  const GAP = 3 * 60000;
  let start = entries[entries.length - 1];
  for (let i = entries.length - 2; i >= 0; i--) {
    if (entries[i + 1] - entries[i] > GAP) break;
    start = entries[i];
  }
  return start;
}

/** newest mtime (ms) among this session's record files — the agent writes
 *  them continuously while a turn runs, so silence here means it stopped
 *  (a turn can end without a stop hook: crash, rate limit, …). 0 = unknown. */
function heartbeat(sessionId) {
  if (!sessionId) return 0;
  const files = candidates(sessionId);
  return files.length ? files[0].mtime : 0;
}

const stateCache = new Map(); // sessionId -> { key, state }

/** Per-app record roots (Claude-family JSONL transcripts). */
const APP_ROOTS = {
  workbuddy: [path.join(os.homedir(), '.workbuddy', 'projects')],
  codebuddy: [path.join(os.homedir(), '.codebuddy', 'projects')],
  claude: [path.join(os.homedir(), '.claude', 'projects')],
};

/** Newest session record of an app, used when an event arrives without a
 *  session id — keeps the file-based timer working for every app. */
function latestTask(appId, freshMs = 15 * 60000) {
  const now = Date.now();
  let best = null;
  for (const root of APP_ROOTS[appId] || []) {
    let slugs = [];
    try { slugs = fs.readdirSync(root); } catch { continue; }
    for (const slug of slugs) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, slug)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(root, slug, f);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (now - st.mtimeMs > freshMs) continue;
        if (!best || st.mtimeMs > best.mtime) best = { sessionId: f.slice(0, -6), mtime: st.mtimeMs, fp };
      }
    }
  }
  if (!best) return null;
  const startedAt = readTail(best.fp);
  return { sessionId: best.sessionId, mtime: best.mtime, startedAt };
}


/** 通用最近任务：在自动探测到的数据源目录里找最近改动的 json/jsonl，
 *  回合起点用同一个"最后一条真提示"逻辑。给没有专属解析器的应用兜底，
 *  这样新接入的应用不必等手写解析也能让计时跨重启连续。 */
function latestTaskGeneric(roots, freshMs = 15 * 60000) {
  const now = Date.now();
  let best = null;
  const list = (roots || []).map((r) => (typeof r === 'string' ? r : r && r.root)).filter(Boolean);
  for (const root of list) {
    let items = [];
    try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const fp = path.join(root, it.name);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.isDirectory()) {
        let subs = [];
        try { subs = fs.readdirSync(fp); } catch { continue; }
        for (const s2 of subs) {
          const fp2 = path.join(fp, s2);
          if (!/\.(json|jsonl)$/i.test(fp2)) continue;
          try { st = fs.statSync(fp2); } catch { continue; }
          if (now - st.mtimeMs > freshMs) continue;
          if (!best || st.mtimeMs > best.mtime) best = { fp: fp2, mtime: st.mtimeMs };
        }
        continue;
      }
      if (!/\.(json|jsonl)$/i.test(fp)) continue;
      if (now - st.mtimeMs > freshMs) continue;
      if (!best || st.mtimeMs > best.mtime) best = { fp, mtime: st.mtimeMs };
    }
  }
  if (!best) return null;
  const startedAt = best.fp.endsWith('.json')
    ? (projTurnStart(best.fp) || 0)
    : readTail(best.fp);
  return { sessionId: path.basename(best.fp).replace(/\.(json|jsonl)$/i, ''), mtime: best.mtime, fp: best.fp, startedAt };
}

/** App-authoritative turn state where the app exposes one.
 *  DSH's projection cache carries turnBoundary.openTurnStartSeq and
 *  sessionStats.{openStep,pendingCalls}: non-null means a turn is really
 *  running, null means the turn ended (successfully OR with an error like a
 *  429) — far more accurate than any silence heuristic, and it never
 *  misfires during long thinking because the turn stays open then.
 *  Returns 'busy' | 'idle' | 'unknown'. */
function turnState(sessionId, homes) {
  if (!sessionId) return 'unknown';
  for (const home of (DSH_HOMES_OVERRIDE && DSH_HOMES_OVERRIDE.length ? DSH_HOMES_OVERRIDE : DSH_HOMES)) {
    for (const name of [sessionId + '.json', 'session-' + sessionId + '.json']) {
      const fp = path.join(home, 'storages', 'session_projcache', 'sessions', name);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      const key = `${st.mtimeMs}:${st.size}`;
      const c = stateCache.get(sessionId);
      if (c && c.key === key) return c.state;
      let out = 'unknown';
      try {
        const o = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const rows = (o.record && o.record.rows) || {};
        const tb = rows.turnBoundary && rows.turnBoundary.val;
        const ss = rows.sessionStats && rows.sessionStats.val;
        if (tb || ss) {
          const open = !!(tb && tb.openTurnStartSeq != null)
            || !!(ss && (ss.openStep != null || Object.keys(ss.pendingCalls || {}).length));
          out = open ? 'busy' : 'idle';
        }
      } catch {}
      stateCache.set(sessionId, { key, state: out });
      if (stateCache.size > 60) stateCache.delete(stateCache.keys().next().value);
      return out;
    }
  }
  return 'unknown';
}

/** The most recently touched DSH session that still has an OPEN turn.
 *  File-based presence: DSH shows as running even when its hooks are silent
 *  (thinking / deep-search phases emit no tool events at all). */
function dshActive(freshMs = 5 * 60000, homes) {
  const now = Date.now();
  let best = null;
  for (const home of (DSH_HOMES_OVERRIDE && DSH_HOMES_OVERRIDE.length ? DSH_HOMES_OVERRIDE : DSH_HOMES)) {
    const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(dir, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (now - st.mtimeMs > freshMs) continue;
      const sid = f.replace(/^session-/, '').replace(/\.json$/, '');
      if (turnState(sid, homes) !== 'busy') continue;
      let title = '', detail = '';
      try {
        const o = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const rows = (o.record && o.record.rows) || {};
        const turns = (rows.turnOutline && rows.turnOutline.val && rows.turnOutline.val.turns) || [];
        const last = turns[turns.length - 1];
        title = tidyTitle((last && last.prompt) || '', 100);
        try {
          const ss = rows.sessionStats && rows.sessionStats.val;
          if (ss && ss.turns != null) detail = '回合 ' + ss.turns + (ss.steps != null ? ' · 已执行 ' + ss.steps + ' 步' : '');
        } catch {}
        try {
          const cp = rows.contextPressure && rows.contextPressure.val;
          if (cp && cp.surfaceTokens && cp.contextWindow) detail = (detail ? detail + ' · ' : '') + '上下文 ' + Math.round(cp.surfaceTokens / cp.contextWindow * 100) + '%';
        } catch {}
      } catch {}
      const cand = { sessionId: sid, mtime: st.mtimeMs, startedAt: projTurnStart(fp), title, detail };
      if (!best || cand.mtime > best.mtime) best = cand;
    }
  }
  return best;
}

/** The most recently written zcode model-io journal (fresh within `freshMs`).
 *  ZCode's agent loop appends to it continuously while a turn runs (including
 *  pure-thinking stretches), and goes quiet when the session is idle — so its
 *  mtime is a reliable "the agent is actually doing something" signal. */
function zcodeActive(freshMs = 90 * 1000) {
  const now = Date.now();
  let best = null;
  let files = [];
  try { files = fs.readdirSync(ZCODE_ROLLOUT); } catch { return null; }
  for (const f of files) {
    if (!f.startsWith('model-io-')) continue;
    const fp = path.join(ZCODE_ROLLOUT, f);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (now - st.mtimeMs > freshMs) continue;
    const sid = (f.match(/sess_[a-f0-9-]+/) || [''])[0];
    const cand = { sessionId: sid, mtime: st.mtimeMs, startedAt: zcodeTurnStart(fp) };
    if (!best || cand.mtime > best.mtime) best = cand;
  }
  return best;
}

/** The most recently active qoder run (fresh within `freshMs`).
 *  Qoder writes runs/<start-timestamp>/qodercli.log continuously while its
 *  agent executes (thinking included) and stops creating runs when idle, so a
 *  fresh run log is a reliable "agent is actually working" signal. startedAt
 *  is the earliest run start within the contiguous burst (gap <= 10 min). */
function qoderActive(freshMs = 90 * 1000) {
  const now = Date.now();
  const runsDir = path.join(QODER_LOGS, 'runs');
  let dirs = [];
  try { dirs = fs.readdirSync(runsDir); } catch { return null; }
  const runs = [];
  for (const d of dirs) {
    const lp = path.join(runsDir, d, 'qodercli.log');
    let st;
    try { st = fs.statSync(lp); } catch { continue; }
    if (now - st.mtimeMs > freshMs) continue;
    const m = d.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})\+(\d{2})-(\d{2})/);
    let start = st.mtimeMs;
    if (m) {
      const iso = m[1] + ' ' + m[2] + ':' + m[3] + ':' + m[4] + '.' + m[5] + ' +' + m[6] + ':' + m[7];
      const v = Date.parse(iso);
      if (!isNaN(v)) start = v;
    }
    runs.push({ start, mtime: st.mtimeMs });
  }
  if (!runs.length) return null;
  runs.sort((a, b) => a.start - b.start);
  let startedAt = runs[runs.length - 1].start;
  for (let i = runs.length - 2; i >= 0; i--) {
    if (runs[i + 1].start - runs[i].start > 10 * 60000) break;
    startedAt = runs[i].start;
  }
  return { sessionId: 'qoder-runs', mtime: Math.max.apply(null, runs.map((r) => r.mtime)), startedAt };
}

// ------------------------------------------------ activity engine ---------
// 应用在目录/配置里声明 activity 数据源后，计时与"正在运行"判定全部由这里
// 数据驱动完成，不再需要为每个应用手写探测函数：
//   activity: {
//     roots:  ['~/.qoder/logs/sessions'],   // 活动记录目录（支持 ~ 与 %环境变量%）
//     glob:   '**/*.jsonl',                 // 文件匹配（* 段内、** 跨层）
//     freshMs: 90000,                       // 可选：文件多久内算"正在运行"
//     gapMs:   600000,                      // 可选：活动点间隔超过此值算新回合
//     tsField: 'ts',                        // 可选：从记录里取活动时间戳的字段
//     journal: { typePath: 'type', typeValue: 'tool.requested',
//                namePath: 'data.tool_name', detailPath: 'data.args.command' }, // 可选：标题/工具提取
//   }
function expandPath(p) {
  let out = String(p);
  if (out[0] === '~') out = path.join(os.homedir(), out.slice(1));
  out = out.replace(/%([^%]+)%/g, (m, name) => (process.env[name] !== undefined ? process.env[name] : m));
  return path.normalize(out);
}

/** 极简 glob：按段匹配，* 段内通配，** 跨任意层 */
function globMatch(pattern, rel) {
  // 支持 **（跨任意层，含零层）与 *（段内通配）；** 自带分隔符，避免多余斜杠
  const segs = String(pattern).split(/[\\/]/).filter((x) => x !== '');
  let re = '^';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '**') { re += '(?:(?:.*)/)?'; continue; }
    re += seg.replace(/[.+{}()[\]]/g, '\\$&').replace(/\*/g, '[^/]*');
    if (i < segs.length - 1) re += '/';
  }
  re += '$';
  try { return new RegExp(re, 'i').test(rel); } catch { return false; }
}


function get(obj, dotted) {
  let cur = obj;
  for (const k of String(dotted || '').split('.')) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function journalFiles(cfg) {
  const out = [];
  const depth = Math.max(1, cfg.depth || 6);
  for (const root of cfg.roots || []) {
    const base = expandPath(root);
    const walk = (dir, rel, level) => {
      let items = [];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const fp = path.join(dir, it.name);
        const relPath = rel ? rel + '/' + it.name : it.name;
        if (it.isDirectory()) {
          if (level < depth) walk(fp, relPath, level + 1);
          continue;
        }
        if (cfg.glob && !globMatch(cfg.glob, relPath)) continue;
        try {
          const st = fs.statSync(fp);
          out.push({ fp, mtime: st.mtimeMs, size: st.size, rel: relPath });
        } catch {}
      }
    };
    walk(base, '', 1);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function parseTs(v) {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
  return 0;
}

/** 通用活动判定：命中 activity 配置的应用，"正在运行"与回合起点全部由此得出。
 *  presence = 最新文件 mtime 在 freshMs 内；startedAt = 全部活动时间戳按 gapMs
 *  分段后当前段最早的点（有 tsField 用记录里的时间，否则用文件 mtime）；
 *  journal 配置存在时同时提取当前工具/命令作为标题与详情。 */
function journalActivity(app, freshMs) {
  const cfg = app && app.activity;
  if (!cfg || !Array.isArray(cfg.roots) || !cfg.roots.length) return null;
  const files = journalFiles(cfg);
  if (!files.length) return null;
  const now = Date.now();
  const freshMs2 = cfg.freshMs || freshMs || 90 * 1000;
  // presence 判定分两档：
  //  - 配了 journal.presenceValues（"agent 真正在工作"的事件类型白名单）时，
  //    以「最新一条白名单事件」的新鲜度为准——应用单纯开着也会写生命周期杂音
  //    （session/hook/route 等），只看文件 mtime 会把"打开但没任务"误判成运行中 ✗
  //  - 未配置时退回文件 mtime 新鲜度
  const j0 = cfg.journal || {};
  const presenceValues = Array.isArray(j0.presenceValues) ? j0.presenceValues : null;
  if (presenceValues) {
    const pf = cfg.presenceFreshMs || freshMs2;
    let newestWorkTs = 0;
    for (const f of files.slice(0, 4)) {
      try {
        const st = fs.statSync(f.fp);
        const len = Math.min(st.size, cfg.tailBytes || 96 * 1024);
        const fd = fs.openSync(f.fp, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        for (const l of buf.toString('utf8').split('\n').reverse()) {
          const t = l.trim();
          if (!t.startsWith('{')) continue;
          let o;
          try { o = JSON.parse(t); } catch { continue; }
          if (presenceValues.includes(get(o, j0.typePath || 'type'))) {
            newestWorkTs = Math.max(newestWorkTs, parseTs(get(o, cfg.tsField)) || st.mtimeMs);
            break; // 该文件里最新一条白名单事件已找到
          }
        }
        if (newestWorkTs) break;
      } catch {}
    }
    if (!newestWorkTs || now - newestWorkTs > pf) return null;
  } else if (now - files[0].mtime > freshMs2) {
    return null;
  }

  // 活动时间点：优先记录内的 ts 字段（每文件读尾部），否则用文件 mtime
  const pts = [];
  if (cfg.tsField) {
    for (const f of files.slice(0, 12)) {
      try {
        const st = fs.statSync(f.fp);
        const len = Math.min(st.size, cfg.tailBytes || 64 * 1024);
        const fd = fs.openSync(f.fp, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        for (const l of buf.toString('utf8').split('\n')) {
          const t = l.trim();
          if (!t.startsWith('{')) continue;
          let o;
          try { o = JSON.parse(t); } catch { continue; }
          const v = parseTs(get(o, cfg.tsField));
          if (v > 0) pts.push({ ts: v, turn: cfg.turnIdPath ? String(get(o, cfg.turnIdPath) || '') : '' });
        }
      } catch {}
    }
  }
  // 可选：按回合 id 分组——任务时间只统计最新回合，跨回合的长间隔不回溯
  let points;
  if (cfg.turnIdPath && pts.length) {
    let newestTurn = '';
    let newestTs = 0;
    for (const p of pts) if (p.ts > newestTs) { newestTs = p.ts; newestTurn = p.turn; }
    points = pts.filter((p) => p.turn === newestTurn).map((p) => p.ts);
  } else {
    points = pts.map((p) => p.ts);
  }
  if (points.length < 2) points = files.map((f) => f.mtime);
  points = points.slice().sort((a, b) => a - b);

  const gap = cfg.gapMs || 10 * 60000;
  let startedAt = points[points.length - 1];
  for (let i = points.length - 2; i >= 0; i--) {
    if (points[i + 1] - points[i] > gap) break;
    startedAt = points[i];
  }

  // —— 会话状态文件（fileState）：最新匹配文件本身就是一份 JSON 会话快照 ——
  // 声明 runningWhen（满足才算运行中）、startedAtPath（回合起点字段）、
  // titleFromLastUserMessage（最后一条 user 消息文本 = 任务标题）即可，
  // 无需了解该应用的事件流格式。messages/role/content/text 是各 Agent 的通用约定。
  const st8 = cfg.fileState;
  if (st8) {
    try {
      const raw = fs.readFileSync(files[0].fp, 'utf8');
      const o = JSON.parse(raw);
      if (st8.runningWhen) {
        const v = get(o, st8.runningWhen.path);
        if (String(v) !== String(st8.runningWhen.equals)) {
          const touched = Date.now() - files[0].mtime <= (cfg.freshMs || 180000);
          if (v === undefined && st8.runningWhen.fallbackFresh && touched) {
            // 无状态字段的文件（如 Cline 的 .messages.json）：新鲜即 Agent 活跃 → working
          } else if (st8.appOpenState && touched) {
            // 状态不是 running 但文件仍被守护进程触写：应用开着、Agent 没干活 → running
            return { state: 'running', sessionId: sid, mtime: files[0].mtime };
          } else {
            return null;
          }
        }
      }
      if (st8.startedAtPath) {
        const v = parseTs(get(o, st8.startedAtPath));
        if (v > 0) startedAt = v;
        else startedAt = files[0].birthtimeMs;   // 无起点字段：会话文件创建时间
      }
      if (st8.titleFromLastUserMessage) {
        let msgs = o.messages;
        if (typeof msgs === 'string') { try { msgs = JSON.parse(msgs); } catch {} }
        if (Array.isArray(msgs)) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i] || {};
            if (String(get(msg, st8.rolePath || 'role')) !== (st8.roleValue || 'user')) continue;
            let c = msg.content;
            if (typeof c === 'string') { title = c; break; }
            if (Array.isArray(c)) {
              const t = c.find((x) => x && (x.type === 'text' || typeof x.text === 'string'));
              if (t && typeof t.text === 'string') { title = t.text; break; }
            }
          }
          if (title) {
            title = tidyTitle(title.replace(/^<[^>]+>/, ''));
          }
        }
      }
    } catch {}
  }
  // 标题/详情：最新文件尾部里最新一条匹配事件
  let title = '', detail = '';
  const j = cfg.journal;
  // 任务标题：最新一条「用户提交任务」事件的文本（如 qoder 的 input.prompt.submitted）
  if (j && j.prompt && j.prompt.typeValue) {
    for (const f of files.slice(0, 6)) {
      try {
        const st = fs.statSync(f.fp);
        const len = Math.min(st.size, 128 * 1024);
        const fd = fs.openSync(f.fp, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        for (const l of buf.toString('utf8').split('\n').reverse()) {
          const t = l.trim();
          if (!t.startsWith('{')) continue;
          let o;
          try { o = JSON.parse(t); } catch { continue; }
          if (get(o, j.prompt.typePath || 'type') !== j.prompt.typeValue) continue;
          const v = get(o, j.prompt.textPath || 'data.text_preview');
          if (v) title = tidyTitle(v);
          break;
        }
        if (title) break;
      } catch {}
    }
  }
  // 回合起点：最新一条 turn 开始事件的 ts（比按间隔分段更精确）
  if (j && j.turnStart && j.turnStart.typeValue) {
    for (const f of files.slice(0, 6)) {
      try {
        const st = fs.statSync(f.fp);
        const len = Math.min(st.size, 128 * 1024);
        const fd = fs.openSync(f.fp, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        for (const l of buf.toString('utf8').split('\n').reverse()) {
          const t = l.trim();
          if (!t.startsWith('{')) continue;
          let o;
          try { o = JSON.parse(t); } catch { continue; }
          if (get(o, j.turnStart.typePath || 'type') !== j.turnStart.typeValue) continue;
          const v = parseTs(get(o, cfg.tsField));
          if (v > 0) startedAt = v;
          break;
        }
        if (startedAt === points[0] || startedAt > 0) break;
      } catch {}
    }
  }
  if (j && j.typeValue) {
    // 按新鲜度逐个文件尝试：活动信号文件（如 CLI 运行日志）未必是结构化的，
    // 真正的事件记录可能在另一个匹配文件里
    for (const f of files.slice(0, 6)) {
      try {
        const st = fs.statSync(f.fp);
        const len = Math.min(st.size, 96 * 1024);
        const fd = fs.openSync(f.fp, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').reverse();
        for (const l of lines) {
          const t = l.trim();
          if (!t.startsWith('{')) continue;
          let o;
          try { o = JSON.parse(t); } catch { continue; }
          if (get(o, j.typePath || 'type') !== j.typeValue) continue;
          title = tidyTitle(get(o, j.namePath) || '', 40);
          detail = String(get(o, j.detailPath) || '').slice(0, 160);
          break;
        }
        if (title) break;
      } catch {}
    }
  }
  // 可选：从最新一条记录的 messages 里提取最后一条用户消息作为任务标题
  // （如 ZCode 的 model_io 记录带完整请求体；tool_result 块自动跳过）
  const tfm = cfg.titleFromMessages;
  if (tfm && !title) {
    try {
      const st = fs.statSync(files[0].fp);
      const len = Math.min(st.size, cfg.tailBytes || 96 * 1024);
      const fd = fs.openSync(files[0].fp, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      fs.closeSync(fd);
      const ls = buf.toString('utf8').split('\n').reverse();
      for (const l of ls) {
        const t = l.trim();
        if (!t.startsWith('{')) continue;
        let o;
        try { o = JSON.parse(t); } catch { continue; }
        const msgs = get(o, tfm.messagesPath);
        if (!Array.isArray(msgs)) continue;
        for (let k = msgs.length - 1; k >= 0; k--) {
          const msg = msgs[k] || {};
          if (String(get(msg, tfm.rolePath || 'role')) !== (tfm.roleValue || 'user')) continue;
          let c = get(msg, tfm.textPath || 'content');
          if (Array.isArray(c)) {
            const texts = c.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text);
            if (!texts.length) continue;   // 纯 tool_result：继续找更早的用户消息
            c = texts.join(' ');
          }
          if (typeof c === 'string' && c.trim()) { title = tidyTitle(c, 80); break; }
        }
        if (title) break;
      }
    } catch {}
  }
  return { sessionId: 'activity:' + app.id, mtime: files[0].mtime, startedAt, title, detail };
}

/** 任务标题整理：只取第一行、去多余空白、限长（整段用户原文没有信息量） */
function tidyTitle(text, max) {
  const first = String(text || '').split('\n').find((l) => l.trim());
  return (first || '').replace(/\s+/g, ' ').trim().slice(0, max || 60);
}


/** 日志驱动的权限询问检测：扫描 roots 下最新文件，找未决的 permission.requested
 *  （比对应 resolved 新）。返回 {state:'confirm', sessionId, question, options,
 *  toolCallId, startedAt} 或 null。与 journalActivity 解耦，避免互相干扰。 */
function detectJournalQuestion(perm, roots) {
  const out = [];
  for (const r of (roots || [])) {
    const dir = expandPath(r);
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const fp = path.join(dir, e.name);
      try {
        const st = fs.statSync(fp);
        if (st.size < 50) continue;
        out.push({ fp, mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  for (const f0 of out.slice(0, 4)) {
    try {
      const len = Math.min(f0.size, 192 * 1024);
      const fd = fs.openSync(f0.fp, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, f0.size - len));
      fs.closeSync(fd);
      let lastReq = null, lastRes = null;
      for (const l of buf.toString('utf8').split('\n')) {
        if (l.indexOf(perm.typeRequested) < 0 && l.indexOf(perm.typeResolved) < 0) continue;
        try {
          const o = JSON.parse(l);
          if (o.type === perm.typeRequested) lastReq = o;
          else if (o.type === perm.typeResolved) lastRes = o;
        } catch {}
      }
      if (lastReq && (!lastRes || Number(lastReq.seq || 0) > Number(lastRes.seq || 0))) {
        const q = get(lastReq, perm.questionPath) || '';
        const optsRaw = get(lastReq, perm.optionsPath);
        const opts = (Array.isArray(optsRaw) ? optsRaw : [])
          .map((x) => (typeof x === 'string' ? x : (x && x.label) || ''))
          .filter(Boolean).slice(0, 6);
        const sid = path.basename(f0.fp).replace(/\.(jsonl?|json)$/i, '');
        return {
          state: 'confirm',
          sessionId: sid,
          question: String(q).slice(0, 200),
          options: opts,
          toolCallId: String(lastReq.tool_call_id || ''),
          startedAt: parseTs(lastReq.ts) || Date.now(),
        };
      }
    } catch {}
  }
  return null;
}

module.exports = { detectJournalQuestion, setDshHomes, tidyTitle, turnStart, heartbeat, turnState, dshActive, latestTask, latestTaskGeneric, zcodeTurnStart, zcodeActive, qoderActive, journalActivity, userTsFromChunk };
