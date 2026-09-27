// 突变验证：把「已修好的 stdio」改回去，确认守卫真的会红、且点名到期望的那一处。
// 三处一起验（导入解析、stop-all 监听表、release 回读），因为它们是三个不同的症状、同一个病根。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const GUARD = 'runtime/product-data-path-sync-spawn-guard.test.mjs';
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

const cases = [
  {
    file: 'skills/sycm-product-data/scripts/import-product-data.mjs',
    from: ", { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })",
    to: ", { encoding: 'utf8' })",
    expect: /import-product-data\.mjs:\d+ spawnSync 没有写 stdio/u,
  },
  {
    file: 'scripts/stop-all.mjs',
    from: "{ stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }",
    to: "{ maxBuffer: 32 * 1024 * 1024 }",
    expect: /stop-all\.mjs:\d+ execFileSync 没有写 stdio/u,
  },
  {
    file: 'scripts/stop-all.mjs',
    from: "{ stdio: ['ignore', 'pipe', 'pipe'] }",
    to: "{ stdio: 'pipe' }",
    expect: /stop-all\.mjs:\d+ execFileSync 的 stdio 把 stdin 设成了 'pipe'/u,
  },
  {
    file: 'scripts/release-product-data-browsers.mjs',
    from: "stdio: ['ignore', 'pipe', 'pipe'], env:",
    to: "env:",
    expect: /release-product-data-browsers\.mjs:\d+ spawnSync 没有写 stdio/u,
  },
];

const runGuard = () => {
  try {
    const out = execFileSync(NODE, ['--test', GUARD], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, text: out };
  } catch (error) {
    return { code: error.status ?? -1, text: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

const baseline = runGuard();
console.log(`基线：exit=${baseline.code}（期望 0）`);
const before = new Map();
for (const file of new Set(cases.map((entry) => entry.file))) before.set(file, sha(path.join(ROOT, file)));

let failures = 0;
for (const [index, item] of cases.entries()) {
  const absolute = path.join(ROOT, item.file);
  const original = fs.readFileSync(absolute, 'utf8');
  try {
    if (!original.includes(item.from)) { console.log(`用例 ${index + 1} 跳过：锚点不在文件里（${item.file}）`); failures += 1; continue; }
    fs.writeFileSync(absolute, original.replace(item.from, item.to));
    const mutated = runGuard();
    const named = item.expect.test(mutated.text);
    console.log(`用例 ${index + 1} ${item.file}：exit=${mutated.code}（期望非 0）、点名对=${named}`);
    if (mutated.code === 0 || !named) { failures += 1; console.log(mutated.text.split('\n').filter((line) => line.includes('not ok') || line.includes('product-data') || line.includes('spawn')).slice(0, 8).join('\n')); }
  } finally {
    fs.writeFileSync(absolute, original);
  }
}

const restored = [...before].every(([file, digest]) => sha(path.join(ROOT, file)) === digest);
const finalRun = runGuard();
console.log(`还原 sha256 一致：${restored}；还原后 exit=${finalRun.code}（期望 0）`);
console.log(failures === 0 && restored && finalRun.code === 0 && baseline.code === 0 ? '结论：守卫在四种突变下都红且点名正确，还原后回绿' : `结论：有 ${failures} 个用例没达到预期`);
process.exitCode = failures === 0 && restored ? 0 : 1;
