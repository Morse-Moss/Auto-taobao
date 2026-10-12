import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * HEAD 可加载守卫（2026-10-12 加，HEAD-VS-WORKTREE 事故的机制级防线）。
 *
 * 事故形态：`ef629d0` 提交了 import 侧、没提交导出侧 ⇒ 从 1.8.1 起干净检出 HEAD
 * 的推广链在**模块链接期**就 `SyntaxError: does not provide an export named ...`，
 * 而所有人与所有测试都跑工作区 ⇒ 整整两天、五个版本号无人发现（CI 抓到了但全红被无视）。
 *
 * 本守卫直接对 **git HEAD**（不是工作区）做静态链接检查：
 *   git archive HEAD → 临时目录 → 对 shipped 代码（runtime/ scripts/ skills/）里
 *   每个 .mjs 的每条「具名 import + 相对 .mjs 路径」，核对目标文件 HEAD 版本里
 *   确实导出了这个名字。半提交当天就红，红的信息直接点名「谁 import 了谁没有的导出」。
 *
 * 刻意保守的地方（宁可漏报也不假红）：
 *   - 目标含 `export *` 时跳过该目标的核对（再导出无法静态枚举）；
 *   - 只查「相对路径 .mjs」的具名 import；裸包名与 node: 内建不查；
 *   - 不执行任何被检代码，只做文本级导出枚举。
 */

const SHIPPED_ROOTS = ['runtime', 'scripts', 'skills'];
const NAMED_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+\.mjs)['"]/gu;
const EXPORT_FUNCTION_RE = /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gu;
const EXPORT_CONST_RE = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
const EXPORT_CLASS_RE = /export\s+class\s+([A-Za-z_$][\w$]*)/gu;
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}/gu;

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

function extractHeadTo(dir) {
  // 只归档 .mjs（约 9MB）：整个仓库的 archive 被 evidence 产物撑到数百 MB，
  // execFileSync 的 buffer 会在那里 ENOBUFS；而本守卫只读 .mjs。
  // tar 用**相对路径**（cwd=dir）：Windows 的 tar 会把 "C:\..." 的冒号当远程主机语法（host:path）。
  const archive = path.join(dir, 'head.tar');
  fs.writeFileSync(archive, execFileSync('git', ['archive', 'HEAD', '--', '*.mjs'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
  execFileSync('tar', ['-xf', 'head.tar'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
}

function listMjsFiles(rootDir) {
  const out = [];
  for (const top of SHIPPED_ROOTS) {
    const topDir = path.join(rootDir, top);
    if (!fs.existsSync(topDir)) continue;
    fs.readdirSync(topDir, { recursive: true, withFileTypes: false }).forEach(() => {});
    // readdirSync recursive 返回字符串路径（Node 20+）；手动过滤 .mjs 并排除测试基建设备目录。
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
      }
    };
    walk(topDir);
  }
  return out;
}

function exportedNames(source) {
  const names = new Set();
  if (/export\s+\*\s*from/u.test(source)) return { reExportsAll: true, names };
  for (const re of [EXPORT_FUNCTION_RE, EXPORT_CONST_RE, EXPORT_CLASS_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  EXPORT_LIST_RE.lastIndex = 0;
  let lm;
  while ((lm = EXPORT_LIST_RE.exec(source)) !== null) {
    for (const part of lm[1].split(',')) {
      // `X as Y` 导出名是最后一个标识符；裸 `X` 就是 X。
      const ident = part.trim().split(/\s+as\s+/u).pop()?.trim();
      if (ident) names.add(ident);
    }
  }
  return { reExportsAll: false, names };
}

function importedName(raw) {
  // `X as Y` 在 import 侧：模块提供的是 **X**（Y 只是本地绑定名）；export 侧才相反。
  return raw.trim().split(/\s+as\s+/u)[0]?.trim();
}

test('HEAD 可加载守卫：干净检出下每条具名 import 的导出都真实存在（半提交当天红）', { timeout: 120000 }, (t) => {
  if (!gitAvailable()) {
    t.skip('git 不可用（或不在仓库内）——守卫跳过，不算失败');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-loadable-'));
  try {
    extractHeadTo(dir);
    const files = listMjsFiles(dir);
    assert.ok(files.length > 100, `守卫扫描面异常：只找到 ${files.length} 个 .mjs（应远大于 100，否则扫描逻辑坏了）`);
    const violations = [];
    let checkedImports = 0;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      NAMED_IMPORT_RE.lastIndex = 0;
      let im;
      while ((im = NAMED_IMPORT_RE.exec(source)) !== null) {
        const [, nameListRaw, specifier] = im;
        const target = path.resolve(path.dirname(file), specifier);
        if (!fs.existsSync(target)) continue; // 仓库外/构建产物：不在本守卫职责内
        const targetSource = fs.readFileSync(target, 'utf8');
        const { reExportsAll, names } = exportedNames(targetSource);
        if (reExportsAll) continue;
        for (const raw of nameListRaw.split(',')) {
          const name = importedName(raw);
          if (!name || name === 'default') continue;
          checkedImports += 1;
          if (!names.has(name)) {
            violations.push(`${path.relative(dir, file).replaceAll('\\', '/')} imports { ${name} } from '${specifier}' — 目标 HEAD 版本没有这个导出`);
          }
        }
      }
    }
    assert.ok(checkedImports > 500, `守卫核对面异常：只核对了 ${checkedImports} 条 import（应远大于 500，否则解析逻辑坏了）`);
    assert.deepEqual(violations, [],
      `HEAD 上存在悬空具名 import（半提交）——这些文件在干净检出里链接期即崩：\n${violations.join('\n')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
