'use strict';
/** 系统通知的触发判定与文案组装 */
const test = require('node:test');
const assert = require('node:assert');
const { shouldNotify, buildNotification } = require('../app/lib/notify.js');

test('进入完成/出错/待确认才提醒', () => {
  assert.strictEqual(shouldNotify('working', 'done'), true);
  assert.strictEqual(shouldNotify('working', 'error'), true);
  assert.strictEqual(shouldNotify('working', 'confirm'), true);
});

test('相同状态重复刷新不提醒', () => {
  assert.strictEqual(shouldNotify('done', 'done'), false);
  assert.strictEqual(shouldNotify('working', 'working'), false);
});

test('空闲/运行中等中间态不提醒', () => {
  assert.strictEqual(shouldNotify('done', 'idle'), false);
  assert.strictEqual(shouldNotify('idle', 'working'), false);
  assert.strictEqual(shouldNotify('', ''), false);
  assert.strictEqual(shouldNotify('done', undefined), false);
});

test('标题带应用名与状态', () => {
  const n = buildNotification({ name: 'Codex' }, 'done', { title: '修复登录超时' });
  assert.strictEqual(n.title, 'Codex · 任务完成');
  assert.ok(n.body.includes('修复登录超时'));
});

test('完成通知带用时', () => {
  const n = buildNotification({ name: 'ZCode' }, 'done', {
    title: '改完了', startedAt: Date.now() - 150000,
  });
  assert.ok(/用时 2 分钟|用时 3 分钟/.test(n.body), '应包含用时分秒: ' + n.body);
});

test('完成通知带步骤统计', () => {
  const n = buildNotification({ name: 'Claude' }, 'done', {
    title: 'x',
    todos: [{ status: 'completed' }, { status: 'completed' }, { status: 'pending' }],
  });
  assert.ok(n.body.includes('2/3 步完成'), n.body);
});

test('缺名字时也有兜底标题', () => {
  const n = buildNotification(null, 'error', { id: 'myapp' });
  assert.strictEqual(n.title, 'myapp · 出错了');
});

test('超长标题截断', () => {
  const long = 'x'.repeat(400);
  const n = buildNotification({ name: 'Codex' }, 'done', { title: long });
  assert.ok(n.body.length <= 130, '正文应截断: ' + n.body.length);
});
