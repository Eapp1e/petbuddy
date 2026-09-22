'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const tt = require('../app/lib/tasktimer.js');

test('计时器：tool_result 伪 user 记录不算回合起点', () => {
  const NL = String.fromCharCode(10);
  const lines = [
    JSON.stringify({ role: 'user', timestamp: '2026-09-19T10:00:00Z', content: '真实提示' }),
    JSON.stringify({ role: 'user', timestamp: '2026-09-19T10:01:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
    JSON.stringify({ role: 'user', timestamp: '2026-09-19T10:02:00Z', isMeta: true, content: 'meta' }),
  ];
  const tsv = tt.userTsFromChunk(lines.join(NL));
  assert.strictEqual(new Date(tsv).toISOString(), '2026-09-19T10:00:00.000Z');
});

test('计时器：zcode 回合起点 = 最近连续活动段（间隔 ≤ 3 分钟）的最早值', () => {
  const os2 = require('node:os');
  const NL = String.fromCharCode(10);
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), 'pb-ztt-'));
  // 造一个 rollout 文件：10:00 一条、10:01 一条、10:20 一条（间隔 19 分钟 → 前两条算同一回合）
  const mk = (t) => JSON.stringify({ sessionId: 'sess_x', startedAt: t, completedAt: t });
  const fp = path.join(dir, 'model-io-sess_x.jsonl');
  fs.writeFileSync(fp, [
    mk('2026-09-19T10:00:00Z'), mk('2026-09-19T10:01:00Z'), mk('2026-09-19T10:20:00Z'),
  ].join(NL), 'utf8');
  const tsv = tt.zcodeTurnStart(fp);
  assert.strictEqual(new Date(tsv).toISOString(), '2026-09-19T10:20:00.000Z',
    '连续段从最后一条往回走，10:20 与 10:01 间隔超过 3 分钟 → 起点=10:20 那条的 startedAt');
});

test('通用活动引擎：journal 配置驱动 presence / 回合起点 / 标题提取', () => {
  const os2 = require('node:os');
  const NL = String.fromCharCode(10);
  const root = fs.mkdtempSync(path.join(os2.tmpdir(), 'pb-act-'));
  const runDir = path.join(root, 'runs', '2026-09-20T22-37-40-587+08-00-x');
  fs.mkdirSync(runDir, { recursive: true });
  const mk = (t) => JSON.stringify({ ts: t, type: 'tool.requested', data: { tool_name: 'Bash', args: { command: 'echo hi' } } });
  fs.writeFileSync(path.join(runDir, 'qodercli.log'), [
    mk('2026-09-19T10:00:00+08:00'), mk('2026-09-19T10:01:00+08:00'),
  ].join(NL), 'utf8');
  const app = { id: 'demo', activity: {
    roots: [root], glob: '**/qodercli.log', tsField: 'ts', gapMs: 600000,
    journal: { typePath: 'type', typeValue: 'tool.requested', namePath: 'data.tool_name', detailPath: 'data.args.command' },
  } };
  const act = tt.journalActivity(app, 90 * 1000);
  assert.ok(act, '应判定为活动（文件刚写入 ✓）');
  assert.strictEqual(act.title, 'Bash');
  assert.strictEqual(act.detail, 'echo hi');
  assert.strictEqual(act.sessionId, 'activity:demo');
  assert.ok(act.startedAt > 0, '回合起点应解析自 ts 字段');
});
