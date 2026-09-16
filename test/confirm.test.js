'use strict';
/** 按键序列转义：自由文本回复走的就是这条路径 */
const test = require('node:test');
const assert = require('node:assert');
const { escapeSendKeys, answerSequence } = require('../app/lib/confirm.js');

test('普通文本原样保留并补回车', () => {
  assert.strictEqual(answerSequence('hello'), 'hello{ENTER}');
});

test('SendKeys 特殊字符逐个加花括号', () => {
  assert.strictEqual(escapeSendKeys('a+b'), 'a{+}b');
  assert.strictEqual(escapeSendKeys('100%'), '100{%}');
  assert.strictEqual(escapeSendKeys('(x)'), '{(}x{)}');
  assert.strictEqual(escapeSendKeys('[1]'), '{[}1{]}');
  assert.strictEqual(escapeSendKeys('^~'), '{^}{~}');
});

test('换行变成回车，不会多打一个回车', () => {
  assert.strictEqual(answerSequence('第一行\n第二行'), '第一行{ENTER}第二行{ENTER}');
  assert.strictEqual(answerSequence('a\r\nb'), 'a{ENTER}b{ENTER}');
});

test('中文与标点不受影响', () => {
  assert.strictEqual(answerSequence('要，补上'), '要，补上{ENTER}');
});

test('空值安全', () => {
  assert.strictEqual(escapeSendKeys(null), '');
  assert.strictEqual(answerSequence(undefined), '{ENTER}');
});
