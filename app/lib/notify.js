'use strict';
/**
 * 系统通知的判定与文案（纯函数，便于测试；真正弹通知在 main.js 里做）。
 *
 * 只在"进入"完成/出错/待确认这几个状态的那一次跃迁提醒，
 * 避免同一个状态反复刷新时刷屏。
 */

const STATE_TEXT = {
  done: '任务完成',
  error: '出错了',
  confirm: '等待你确认',
};

/** 这次状态跃迁是否需要弹通知 */
function shouldNotify(prev, next) {
  if (!next || prev === next) return false;
  return Object.prototype.hasOwnProperty.call(STATE_TEXT, next);
}

/** 组装通知标题与正文 */
function buildNotification(meta, state, extra) {
  const name = (meta && meta.name) || (extra && extra.id) || 'PetBuddy';
  const title = `${name} · ${STATE_TEXT[state] || state}`;
  const parts = [];
  const line = (extra && (extra.title || extra.detail)) || '';
  if (line) parts.push(String(line).slice(0, 120));
  const startedAt = (extra && extra.startedAt) || 0;
  if (state === 'done' && startedAt) {
    const sec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    parts.push(sec >= 60 ? `用时 ${Math.round(sec / 60)} 分钟` : `用时 ${sec} 秒`);
  }
  const todos = (extra && Array.isArray(extra.todos)) ? extra.todos : [];
  if (state === 'done' && todos.length) {
    const ok = todos.filter((t) => t && t.status === 'completed').length;
    if (ok) parts.push(`${ok}/${todos.length} 步完成`);
  }
  return { title, body: parts.join(' · ') };
}

module.exports = { shouldNotify, buildNotification, STATE_TEXT };
