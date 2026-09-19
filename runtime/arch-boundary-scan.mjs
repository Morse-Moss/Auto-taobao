// 跨目录依赖的**测量口径**（唯一实现）。
//
// 为什么抽成模块：守卫（runtime/arch-boundary.test.mjs）与一次性盘点脚本都要用同一套判据。
// 各写一份的话，两边迟早给出不同的数字 —— 那正是这套系统一直在治的病（同一个事实两处实现）。
//
// 三种 import 形态都必须认（第三种是突变验证发现的：注入 `import 'x'` 这种**副作用 import**
// 时，只认 `from '…'` 与 `import('…')` 的扫描器会完全看不见它 —— 判据全绿而依赖已经加上了）：
//   1) import x from 'spec'   → 静态
//   2) await import('spec')   → 动态字面量
//   3) import 'spec'          → 副作用（无绑定）
import fs from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** 去注释再匹配：注释里提到另一个目录是好事，不该被守卫逼着删掉。 */
export function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split(/\r?\n/u)
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/u, '$1'))
    .join('\n');
}

/** 目录下全部 .mjs 的相对路径（跳过 node_modules / __pycache__）。 */
export function walkMjs(relativeDir, root = REPO_ROOT) {
  const out = [];
  const walk = (absolute, relative) => {
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absolute, entry.name);
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
        walk(abs, rel);
      } else if (entry.name.endsWith('.mjs')) {
        out.push(rel);
      }
    }
  };
  walk(path.join(root, relativeDir), relativeDir);
  return out;
}

/** 三种 import 形态的说明符。 */
export function importSpecifiers(code) {
  const stripped = stripComments(code);
  return [
    ...[...stripped.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((m) => m[1]),
    ...[...stripped.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)].map((m) => m[1]),
    ...[...stripped.matchAll(/import\s+['"]([^'"]+)['"]/gu)].map((m) => m[1]),
  ];
}

const touches = (specifiers, dir) => specifiers.some((s) => s.includes(`/${dir}/`) || s.startsWith(`${dir}/`) || s.startsWith(`../${dir}/`));

/** 两个方向的跨目录依赖清单（已排序）。 */
export function findCrossDirDeps(root = REPO_ROOT) {
  const result = { skillsToRuntime: [], runtimeToSkills: [] };
  for (const rel of [...walkMjs('skills', root), ...walkMjs('runtime', root)]) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8');
    const specifiers = importSpecifiers(code);
    if (rel.startsWith('skills/') && touches(specifiers, 'runtime')) result.skillsToRuntime.push(rel);
    if (rel.startsWith('runtime/') && touches(specifiers, 'skills')) result.runtimeToSkills.push(rel);
  }
  result.skillsToRuntime.sort();
  result.runtimeToSkills.sort();
  return result;
}

/** 白名单比对：双向都要空，才叫「事实与登记一致」。 */
export function diffAgainstWhitelist(actual, whitelist) {
  const actualSet = new Set(actual);
  const whitelistSet = new Set(whitelist);
  return {
    added: actual.filter((file) => !whitelistSet.has(file)),
    removed: whitelist.filter((file) => !actualSet.has(file)),
  };
}
