'use strict';
/**
 * 语法巡检：对所有 JS 文件做 node --check，并对 HTML 里的内联 <script> 做编译检查。
 *
 * 这条测试的由来：把应用文件搬进 app/ 目录时，一次性踩了 5 个相对路径坑
 * （loadFile / require / path.join / 动态 import），当时没有任何测试能兜住。
 * 现在只要文件语法或内联脚本写坏，CI 立刻会红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'release', 'test']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, out);
    else out.push(fp);
  }
  return out;
}

const files = walk(ROOT);

test('所有 JS/CJS/MJS 文件通过 node --check', () => {
  const js = files.filter((f) => /\.(js|cjs|mjs)$/.test(f));
  assert.ok(js.length > 5, '至少应该扫到若干个 JS 文件');
  for (const fp of js) {
    try {
      execFileSync(process.execPath, ['--check', fp], { stdio: 'pipe' });
    } catch (e) {
      assert.fail(`${path.relative(ROOT, fp)} 语法错误: ${String(e.stderr || e.message).slice(0, 300)}`);
    }
  }
});

test('HTML 内联 <script> 可编译', () => {
  const htmls = files.filter((f) => /\.html$/.test(f) && !f.includes('showcase'));
  assert.ok(htmls.length >= 1);
  for (const fp of htmls) {
    const src = fs.readFileSync(fp, 'utf8');
    const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    for (const [i, m] of blocks.entries()) {
      try {
        new vm.Script(m[1]);
      } catch (e) {
        assert.fail(`${path.relative(ROOT, fp)} 内联脚本 #${i} 编译失败: ${e.message}`);
      }
    }
  }
});

test('package.json 关键字段与入口文件存在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.main, 'main 字段必须存在');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), `main 指向的文件必须存在: ${pkg.main}`);
  assert.ok(pkg.scripts && pkg.scripts.test, 'npm test 脚本必须存在');
  assert.ok(pkg.build && Array.isArray(pkg.build.files), '打包 files 配置必须存在');
});

test('仓库内引用的顶层目录都存在（防止重组后路径悬空）', () => {
  for (const dir of ['app', 'bridge', 'integrations', 'docs']) {
    assert.ok(fs.existsSync(path.join(ROOT, dir)), `缺少目录: ${dir}`);
  }
  for (const f of ['app/main.js', 'app/pet.html', 'app/settings.html', 'app/preload.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少文件: ${f}`);
  }
});
