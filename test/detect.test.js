'use strict';
/** 可接入应用探测与"接入配置自动补齐"（添加应用不再卡在"请填写路径"） */
const test = require('node:test');
const assert = require('node:assert');
const d = require('../app/lib/detect.js');

test('已知应用直接给出推荐接入配置', () => {
  const steps = d.suggestIntegration('gemini');
  assert.strictEqual(steps[0].style, 'claude-file');
  assert.strictEqual(steps[0].path, '~/.gemini/settings.json');
});

test('未知应用走镜像模式（不需要任何路径）', () => {
  const steps = d.suggestIntegration('什么鬼应用');
  assert.deepStrictEqual(steps, [{ style: 'none' }]);
});

test('只填 id + name 时也能拿到可用的接入配置', () => {
  const steps = d.resolveIntegration({ id: 'cursor', name: 'Cursor' });
  assert.ok(steps.length >= 1);
  assert.strictEqual(steps[0].style, 'none', '未知 hook 格式应为镜像模式');
});

test('选了 claude-file 却没写路径：自动补，不报错', () => {
  const steps = d.resolveIntegration({
    id: 'myapp', name: 'MyApp', integration: [{ style: 'claude-file' }],
  });
  assert.strictEqual(steps[0].style, 'claude-file');
  assert.strictEqual(steps[0].path, '~/.myapp/settings.json');
  assert.strictEqual(steps[0].eventCase, 'pascal');
});

test('claude-file 已知应用补出正确路径', () => {
  const steps = d.resolveIntegration({ id: 'gemini', integration: [{ style: 'claude-file' }] });
  assert.strictEqual(steps[0].path, '~/.gemini/settings.json');
});

test('用户显式给的路径不会被覆盖', () => {
  const steps = d.resolveIntegration({
    id: 'x', integration: [{ style: 'claude-file', path: 'D:/custom/hooks.json', eventCase: 'kebab' }],
  });
  assert.strictEqual(steps[0].path, 'D:/custom/hooks.json');
  assert.strictEqual(steps[0].eventCase, 'kebab');
});

test('空条目兜底为镜像模式', () => {
  assert.deepStrictEqual(d.resolveIntegration({}), [{ style: 'none' }]);
  assert.deepStrictEqual(d.resolveIntegration(null), [{ style: 'none' }]);
});

test('detect() 返回数组且不重复已添加的应用', () => {
  const ids = d.CATALOG.map((a) => a.id);
  const found = d.detect(ids);
  assert.ok(Array.isArray(found));
  assert.strictEqual(found.length, 0, '全部已添加时不应再报可接入');
});

test('扩展 ~ 与 %APPDATA% 变量', () => {
  assert.ok(!d.expand('~/.claude').startsWith('~'));
  assert.ok(!/%.*%/.test(d.expand('%APPDATA%/Code')));
});
