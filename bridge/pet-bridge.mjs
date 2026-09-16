#!/usr/bin/env node
/**
 * PetBuddy universal hook bridge.
 *
 * Usage: node pet-bridge.mjs --app <zcode|codex|workbuddy|dsh> --event <HookEvent> [--spawn]
 *
 * Reads the hook's JSON payload from stdin (Claude Code / Codex style), posts a
 * normalized event to the PetBuddy local API, and ALWAYS exits 0 quickly so it
 * can never block or break the agent. With --spawn, a failed connection also
 * launches the pet in the background (this is how "open any app -> pet appears"
 * works even when the watchdog is off).
 *
 * Node >= 16 compatible (no fetch).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME_DIR = process.env.PETBUDDY_HOME || path.join(os.homedir(), '.petbuddy');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
const APP = arg('app', '');
const EVENT = arg('event', '');
const SPAWN = process.argv.includes('--spawn');

function readStdin(timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => { data += c; if (data.length > 512 * 1024) finish(); });
    process.stdin.on('end', () => { clearTimeout(t); finish(); });
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

function readPort() {
  try {
    const p = parseInt(fs.readFileSync(path.join(HOME_DIR, 'port'), 'utf8').trim(), 10);
    if (p > 0) return p;
  } catch {}
  return 47650;
}

function post(port, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 2000,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

function spawnPet() {
  try {
    const exe = path.join(PET_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(exe)) return;
    // Some hosts (WorkBuddy) inject ELECTRON_RUN_AS_NODE=1 into hook/agent
    // environments, which turns electron.exe into plain node (instant exit).
    // Strip it and NODE_OPTIONS, and run GPU/network services in-process so
    // restricted contexts that kill child processes can't take the pet down.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(exe, [PET_ROOT, '--hidden',
      '--in-process-gpu', '--enable-features=NetworkServiceInProcess'], {
      detached: true, stdio: 'ignore', windowsHide: true, env,
    });
    child.unref();
  } catch {}
}

// ---- normalize ----------------------------------------------------------
function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function toolDetail(toolName, input) {
  const tn = toolName || '';
  if (!input || typeof input !== 'object') return tn;
  const c = input.command || input.cmd || input.file_path || input.path ||
            input.pattern || input.url || input.query || input.description || '';
  return short(c ? `${tn}: ${c}` : tn, 160);
}

/** Human label for what the agent is doing right now (real-time progress). */
function actionLabel(toolName) {
  const t = String(toolName || '').toLowerCase();
  if (!t) return '';
  if (/^(bash|pwsh|powershell|shell|sh|zsh|cmd|exec|run|terminal|command)/.test(t)) return '运行命令';
  if (/todo|taskcreate|taskupdate|tasklist|update_plan|planner/.test(t)) return '整理任务计划';
  if (/^(read|view|cat|open|notebookread)/.test(t)) return '读取文件';
  if (/^(edit|write|multiedit|str_replace|apply_patch|notebookedit|create_file|patch)/.test(t)) return '编辑代码';
  if (/^(grep|glob|search|find|rg|ripgrep)/.test(t)) return '搜索代码';
  if (/^web(fetch|search)|^fetch|^http/.test(t)) return '查询资料';
  if (/^(agent|subagent)/.test(t)) return '执行子任务';
  if (/^mcp__/.test(t)) return '调用工具';
  return '执行步骤';
}

/** Long path-like tokens collapse to their basename so targets stay readable
 *  ("/c/Users/<you>/.../python.exe -c ..." -> "python.exe -c ..."). */
function shortPathToken(tok) {
  if (!tok || tok.length < 25) return tok;
  if (!/^([A-Za-z]:[\\/]|\/)/.test(tok)) return tok;
  const parts = tok.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : tok;
}
function cleanTarget(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (!s.includes(' ')) return shortPathToken(s);
  return s.split(' ').map(shortPathToken).join(' ');
}

/** Short human target of a tool call (file / command / pattern), no tool prefix. */
function toolTarget(input) {
  if (!input || typeof input !== 'object') return '';
  const c = input.command || input.cmd || input.file_path || input.path ||
            input.pattern || input.url || input.query || input.description || input.subject || '';
  return short(cleanTarget(c), 80);
}

function normalize(event, payload) {
  const e = String(event || '').toLowerCase();
  const toolName = payload.tool_name || payload.toolName || '';
  const toolInput = payload.tool_input || payload.toolInput || {};
  switch (e) {
    case 'sessionstart': case 'session-start': {
      // Claude-style SessionStart fires with source: startup|resume|clear|compact;
      // 'compact' means the CLI just finished compacting the context
      const src = String(payload.source || '').toLowerCase();
      if (src === 'compact') return { event: 'compact', title: '上下文已压缩，任务继续' };
      return { event: 'session-start', title: short(payload.cwd || payload.project_dir || '', 100) };
    }
    case 'precompact': case 'pre-compact':
      return { event: 'compact', title: '正在压缩上下文…' };
    case 'userpromptsubmit': case 'user-prompt-submit': {
      // prompts often start with attachment markers (@image#1:foo.png) or
      // pasted image blocks — strip them so the bubble shows the real task
      const raw = String(payload.prompt || payload.message || '');
      const cleaned = raw
        .replace(/@(?:image|file|doc|document|photo|video|audio|vision|paste)#?\d*:[^\s]*/gi, ' ')
        .replace(/@[^\s@]*\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|docx?|xlsx?|pptx?|txt|csv|md|zip)\b/gi, ' ')
        .replace(/@(?:image|file|doc|photo|video|audio|vision|paste)#\d+/gi, ' ')
        .replace(/\[Image[^\]]*\]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { event: 'prompt', title: short(cleaned || raw, 100) };
    }
    case 'pretooluse': case 'pre-tool-use': {
      // Claude 系的 AskUserQuestion 是"在问你"，不是要权限 —— 转成可自由文本回复的提问卡
      if (/^askuserquestion$/i.test(String(toolName))) {
        const qs = Array.isArray(toolInput.questions) ? toolInput.questions : [];
        const first = qs[0] || {};
        const opts = Array.isArray(first.options)
          ? first.options.map((o) => short(String((o && (o.label || o.text)) || o), 40)).filter(Boolean)
          : [];
        const extra = qs.length > 1 ? `（共 ${qs.length} 个问题）` : '';
        return {
          event: 'question',
          question: short(String(first.question || first.header || '需要你回答') + extra, 160),
          options: opts,
          detail: short(String(toolName) + (opts.length ? ' · ' + opts.join(' / ') : ''), 120),
        };
      }
      const out = {
        event: 'pre-tool',
        detail: toolDetail(toolName, toolInput),
        action: actionLabel(toolName),
        target: toolTarget(toolInput),
      };
      // TodoWrite / update_plan carry the whole plan. Only ACTIVE plans are
      // forwarded (must contain an in-progress or pending item) — stale
      // all-completed plans would fabricate progress like "5/5" mid-task.
      if (/todo|plan/i.test(String(toolName))) {
        const raw = Array.isArray(toolInput.todos) ? toolInput.todos
                  : Array.isArray(toolInput.plan) ? toolInput.plan : null;
        if (raw) {
          const norm = raw.map((it) => {
            const o = typeof it === 'string' ? { content: it } : (it || {});
            return {
              content: short(o.content || o.step || o.text || o.task || o.name || o.activeForm || '', 90),
              status: String(o.status || 'pending').toLowerCase(),
            };
          }).filter((x) => x.content);
          const active = norm.some((x) => x.status === 'in_progress' || x.status === 'pending');
          if (norm.length && active) out.todos = norm;
        }
      }
      // TaskCreate / TaskUpdate (CodeBuddy/WorkBuddy style) build the list
      // incrementally — forward the op, the pet keeps the running list
      if (/^task(create|update)/i.test(String(toolName))) {
        if (/^taskcreate/i.test(String(toolName))) {
          const content = short(toolInput.subject || toolInput.description || toolInput.activeForm || '', 90);
          if (content) out.taskOp = { kind: 'create', content };
        } else {
          const status = String(toolInput.status || '').toLowerCase();
          if (status || toolInput.subject) {
            out.taskOp = {
              kind: 'update',
              taskId: String(toolInput.taskId || toolInput.task_id || ''),
              status,
              content: short(toolInput.subject || '', 90),
            };
          }
        }
      }
      return out;
    }
    case 'posttooluse': case 'post-tool-use':
      return { event: 'post-tool', detail: toolDetail(toolName, toolInput) };
    case 'posttoolusefailure': case 'post-tool-use-failure':
      return { event: 'post-tool-failure', detail: toolDetail(toolName, toolInput) };
    case 'permissionrequest': case 'permission-request': {
      const q = toolName
        ? `允许执行 ${toolName}?`
        : short(payload.message || payload.question || '需要确认', 120);
      return { event: 'permission', question: q, detail: toolDetail(toolName, toolInput) };
    }
    case 'stop': case 'subagentstop': case 'subagent-stop':
      return { event: 'stop', title: short(payload.last_assistant_message || payload.stop_reason || '任务完成', 100) };
    case 'notification':
      return { event: 'message', detail: short(payload.message || '', 120) };
    case 'subagentstart': case 'subagent-start':
      return { event: 'message', detail: '子任务启动' };
    case 'sessionend': case 'session-end':
      return { event: 'stop', title: '会话结束' };
    default:
      return { event: 'message', detail: short(event, 60) };
  }
}

// ---- main ----------------------------------------------------------------
(async () => {
  const payload = await readStdin();
  // different CLIs name the session differently — accept the common shapes
  const sid = payload.session_id || payload.sessionId
    || (payload.session && (payload.session.id || payload.session.sessionId))
    || payload.conversation_id || payload.conversationId || '';
  if (!sid) {
    // remember which fields the host actually sends, so the mapping can be fixed
    try {
      fs.appendFileSync(path.join(HOME_DIR, 'bridge-nosid.log'),
        `${new Date().toISOString()} app=${APP} event=${EVENT} keys=${Object.keys(payload).join(',')}\n`);
    } catch {}
  }
  const body = { app: APP, sessionId: sid, ...normalize(EVENT, payload) };
  const ok = await post(readPort(), body);
  if (!ok && SPAWN) spawnPet();
  process.exit(0);
})().catch(() => process.exit(0));
