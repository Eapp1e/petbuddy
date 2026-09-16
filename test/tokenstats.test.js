'use strict';
/**
 * Token 统计的解析测试：用临时构造的会话文件验证两种格式。
 *   node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ts = require('../app/lib/tokenstats.js');

function tmpFile(name, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-'));
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
  return fp;
}

const today = new Date().toISOString();

test('Claude 系：output 累加、上下文取峰值', () => {
  const fp = tmpFile('sess.jsonl', [
    JSON.stringify({ type: 'assistant', timestamp: today, message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 } } }),
    JSON.stringify({ type: 'assistant', timestamp: today, message: { usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 5000 } } }),
    JSON.stringify({ type: 'assistant', timestamp: today, message: { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 } } }),
    JSON.stringify({ type: 'user', timestamp: today, message: { role: 'user', content: 'hi' } }),
  ]);
  const t = ts._internals.scanFile('workbuddy', fp, Date.now() - 86400000);
  assert.strictEqual(t.out, 100, 'output 应该是 50+30+20');
  assert.strictEqual(t.ctx, 5200, '上下文峰值应为 200+5000');
  assert.strictEqual(t.cache, 5000);
});

test('Claude 系：顶层 usage 也能识别（WorkBuddy 的 function_call 行）', () => {
  const fp = tmpFile('top.jsonl', [
    JSON.stringify({ type: 'function_call', timestamp: today, usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 60 } }),
  ]);
  const t = ts._internals.scanFile('workbuddy', fp, Date.now() - 86400000);
  assert.strictEqual(t.out, 40);
  assert.strictEqual(t.ctx, 360);
});

test('Codex：累计值直接采用，不做求和', () => {
  const fp = tmpFile('rollout-2026.jsonl', [
    JSON.stringify({ timestamp: today, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10 } } } }),
    JSON.stringify({ timestamp: today, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 4000, cached_input_tokens: 800, output_tokens: 200, reasoning_output_tokens: 25 } } } }),
  ]);
  const t = ts._internals.scanFile('codex', fp, Date.now() - 86400000);
  assert.strictEqual(t.out, 225, '应为最后一条累计值 200+25，而不是求和');
  assert.strictEqual(t.ctx, 4800);
  assert.strictEqual(t.cache, 800);
});

test('昨天的行不计入今天', () => {
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  const fp = tmpFile('old.jsonl', [
    JSON.stringify({ type: 'assistant', timestamp: old, message: { usage: { input_tokens: 9999, output_tokens: 9999 } } }),
  ]);
  const t = ts._internals.scanFile('workbuddy', fp, Date.now() - 86400000);
  assert.strictEqual(t.out, 0);
});

test('坏行不影响解析', () => {
  const fp = tmpFile('broken.jsonl', [
    '{ this is not json',
    JSON.stringify({ type: 'assistant', timestamp: today, message: { usage: { input_tokens: 5, output_tokens: 7 } } }),
    '',
  ]);
  const t = ts._internals.scanFile('workbuddy', fp, Date.now() - 86400000);
  assert.strictEqual(t.out, 7);
});

test('DSH 投影缓存：取会话累计值与当前上下文', () => {
  const fp = tmpFile('session-x.json', [JSON.stringify({
    record: {
      rows: {
        tokenUsage: { ver: 2, val: { totals: { uncachedInputTokens: 4422490, outputTokens: 427295, cacheReadTokens: 51373824, cacheWriteTokens: 0 } } },
        contextPressure: { val: { surfaceTokens: 588910 } },
      },
    },
  })]);
  const t = ts._internals.scanDshJson(fp, Date.now() - 86400000);
  assert.strictEqual(t.out, 427295);
  assert.strictEqual(t.ctx, 588910, '上下文应取 surfaceTokens');
  assert.strictEqual(t.cache, 51373824);
});

test('ZCode 流水：读 response.usage', () => {
  const fp = tmpFile('model-io.jsonl', [JSON.stringify({
    completedAt: today,
    response: { usage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 900 } },
  })]);
  const t = ts._internals.scanFile('zcode', fp, Date.now() - 86400000);
  assert.strictEqual(t.out, 340);
  assert.strictEqual(t.ctx, 2100);
  assert.strictEqual(t.cache, 900);
});

test('通用用量提取：任意嵌套结构都能识别', () => {
  const u1 = ts.extractUsage({ a: { b: [{ meta: { usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 6 } } }] } });
  assert.deepStrictEqual(u1, { in: 10, out: 4, cache: 6, ctx: 16 });
  const u2 = ts.extractUsage({ payload: { info: { total_token_usage: { input_tokens: 7, output_tokens: 3 } } } });
  assert.ok(u2 && u2.out === 3);
  assert.strictEqual(ts.extractUsage({ nothing: 'here' }), null);
});

test('自动探测：在临时目录里找到用量来源', () => {
  const os2 = require('node:os');
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), 'pb-disc-'));
  const sub = path.join(dir, 'projects');
  fs.mkdirSync(sub, { recursive: true });
  const fp = path.join(sub, 'sess.jsonl');
  fs.writeFileSync(fp, JSON.stringify({ message: { usage: { input_tokens: 5, output_tokens: 9 } } }), 'utf8');
  const hits = ts.discoverSource('unknownapp', { extraRoots: [dir] });
  assert.ok(hits.length >= 1, '应该命中一个来源');
  assert.strictEqual(path.resolve(hits[0].file), path.resolve(fp));
  assert.strictEqual(hits[0].sample.out, 9);
});

test('自动探测：没有用量的目录不会误报', () => {
  const os2 = require('node:os');
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), 'pb-disc2-'));
  fs.mkdirSync(path.join(dir, 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'x', 'config.json'), '{"hello":"world"}', 'utf8');
  const hits = ts.discoverSource('noopapp', { extraRoots: [dir] });
  assert.strictEqual(hits.length, 0);
});
