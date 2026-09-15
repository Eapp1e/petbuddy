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
// DeepSeek Harness (DSH) keeps a plain-JSON projection cache per session —
// usable as a heartbeat even though its raw logs are zstd-compressed.
const DSH_HOMES = [
  process.env.DSH_HOME,
  path.join(os.homedir(), '.dsh'),
].filter(Boolean);
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
  for (const home of DSH_HOMES) {
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
  const ts = f.fp.endsWith('.json') ? projTurnStart(f.fp) : readTail(f.fp);
  cache.set(sessionId, { ts, key });
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return ts;
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

/** App-authoritative turn state where the app exposes one.
 *  DSH's projection cache carries turnBoundary.openTurnStartSeq and
 *  sessionStats.{openStep,pendingCalls}: non-null means a turn is really
 *  running, null means the turn ended (successfully OR with an error like a
 *  429) — far more accurate than any silence heuristic, and it never
 *  misfires during long thinking because the turn stays open then.
 *  Returns 'busy' | 'idle' | 'unknown'. */
function turnState(sessionId) {
  if (!sessionId) return 'unknown';
  for (const home of DSH_HOMES) {
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
function dshActive(freshMs = 5 * 60000) {
  const now = Date.now();
  let best = null;
  for (const home of DSH_HOMES) {
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
      if (turnState(sid) !== 'busy') continue;
      let title = '';
      try {
        const o = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const rows = (o.record && o.record.rows) || {};
        const turns = (rows.turnOutline && rows.turnOutline.val && rows.turnOutline.val.turns) || [];
        const last = turns[turns.length - 1];
        title = String((last && last.prompt) || '').replace(/\s+/g, ' ').slice(0, 100);
      } catch {}
      const cand = { sessionId: sid, mtime: st.mtimeMs, startedAt: projTurnStart(fp), title };
      if (!best || cand.mtime > best.mtime) best = cand;
    }
  }
  return best;
}

module.exports = { turnStart, heartbeat, turnState, dshActive, latestTask };
