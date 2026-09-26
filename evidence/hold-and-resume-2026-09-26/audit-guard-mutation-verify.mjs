// 突变验证（2026-09-26）：确认「审计表守卫」在把扫描范围收掉 `evidence/` 之后
// **仍然真的会咬** —— 而不是被顺手改成了一条永远绿的装饰。
//
// 判据（与仓库既有口径一致）：
//   ① 把表名塞进一个**非白名单、非 evidence** 的源文件 ⇒ 守卫必须红，**且点名那个文件**；
//   ② 还原必须逐字节（sha256 自证），不是「我看它改回来了」。
//
// 第 ② 种突变（塞进 evidence/ 下）**不用做**：此刻守卫是绿的，而
// `evidence/daily-report-2026-09-24-independent-verify/probe-audit-table.mjs` 里**逐字含有**那个表名
// ⇒ 「排除真的生效了」这件事已经由当前的绿证明过了。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'VERSION'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('找不到仓库根：从本文件向上 6 层都没看见 VERSION');
})();

const GUARD = 'skills/sycm-alimama-daily-report/scripts/daily-report-audit.test.mjs';
const TABLE = 'daily_report_push_audit';
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const MUTATIONS = [
  { name: '表名被塞进 scripts/ 下的一个源文件（非白名单）', file: 'scripts/run-daily-job.mjs' },
  { name: '表名被塞进 runtime/ 下的一个源文件（非白名单）', file: 'runtime/browser-ports.mjs' },
];

const results = [];
for (const mutation of MUTATIONS) {
  const full = path.join(ROOT, mutation.file);
  const before = readFileSync(full, 'utf8');
  const beforeHash = sha256(before);
  if (before.includes(TABLE)) {
    results.push({ ...mutation, outcome: 'MUTATION_TARGET_ALREADY_HAS_TABLE' });
    continue;
  }
  writeFileSync(full, `${before}\n// 突变探针：${TABLE}\n`, 'utf8');
  if (readFileSync(full, 'utf8') === before) {
    results.push({ ...mutation, outcome: 'WRITE_DROPPED' });
    continue;
  }

  const run = spawnSync(process.execPath, ['--test', GUARD], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const failedNames = [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((m) => m[1].trim());
  const named = failedNames.some((name) => name.includes('没有第二个读者或写者'));
  const points = output.includes(mutation.file);

  // 还原并自证（逐字节，不是「看起来改回来了」）。
  writeFileSync(full, before, 'utf8');
  const restoredHash = sha256(readFileSync(full, 'utf8'));

  results.push({
    ...mutation,
    outcome: run.status === 0
      ? 'NOT_CAUGHT'
      : (!named ? 'CAUGHT_BUT_WRONG_CASE' : (points ? 'CAUGHT' : 'CAUGHT_BUT_DID_NOT_NAME_FILE')),
    failedCount: failedNames.length,
    failedNames,
    restored: restoredHash === beforeHash,
  });
}

for (const r of results) {
  const ok = r.outcome === 'CAUGHT' && r.restored;
  console.log(`${ok ? 'OK  ' : 'FAIL'} [${r.outcome}] ${r.name}`);
  console.log(`       文件 ${r.file}｜期望：守卫红且点名该文件`);
  if (r.failedNames) console.log(`       实际失败 ${r.failedCount} 条：${r.failedNames.join(' | ') || '（无）'}`);
  console.log(`       还原自证：${r.restored === undefined ? '未改动' : r.restored ? 'sha256 逐字节一致' : '**不一致**'}`);
}

const bad = results.filter((r) => r.outcome !== 'CAUGHT' || r.restored !== true);
console.log(`\n突变 ${results.length} 条：抓住 ${results.filter((r) => r.outcome === 'CAUGHT').length}，异常 ${bad.length}`);
process.exit(bad.length === 0 ? 0 : 1);
