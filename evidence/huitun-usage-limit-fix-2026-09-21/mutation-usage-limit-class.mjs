// 突变验证：证明这次新增的三条判据真的拦得住「改回去」。
// 规矩（与仓库既有 *.mutation.mjs 同一套）：基线必须先绿 → 每次只改一处 → 断言**点名**到期望的用例
// → 立即还原并逐字节复核 sha256 → 全部还原后再复核一遍。
// 后缀刻意不是 .test.mjs：套件按后缀发现（scripts/test-suite-discovery.mjs 的 listTestFiles），
// 叫 .test.mjs 会让「跑一次测试」顺手改源码。
// 用法：在仓库根跑 `node evidence/huitun-usage-limit-fix-2026-09-21/mutation-usage-limit-class.mjs`
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const skillTests = path.join(repo, 'skills', 'huitun-to-feishu-keyword-heat', 'tests');

const FILES = {
  flow: path.join(repo, 'skills', 'huitun-to-feishu-keyword-heat', 'scripts', 'flow.mjs'),
  adapter: path.join(repo, 'skills', 'huitun-to-feishu-keyword-heat', 'scripts', 'adapter.huitun-keyword-heat.mjs'),
  cli: path.join(repo, 'skills', 'huitun-to-feishu-keyword-heat', 'scripts', 'run-huitun-topic-heat.mjs'),
};
const TESTS = {
  flow: path.join(skillTests, 'flow.test.mjs'),
  adapter: path.join(skillTests, 'adapter-huitun-keyword-heat.test.mjs'),
  cli: path.join(skillTests, 'cli.test.mjs'),
};

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const originals = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readFileSync(file, 'utf8')]));
const digests = Object.fromEntries(Object.entries(originals).map(([key, text]) => [key, sha256(text)]));

function runTests(testFiles) {
  const result = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: repo, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => match[1].trim());
  const totals = /^# pass \d+$/mu.exec(output)?.[0] ?? '# pass ?';
  return { status: result.status, failures, output, totals };
}

const MUTATIONS = [
  {
    name: 'M1 flow.mjs 不再给配额墙挂 code（退回「普通 Error」）',
    target: 'flow',
    find: '    error.code = USAGE_LIMIT_CODE;\n',
    replace: '',
    tests: [TESTS.flow, TESTS.adapter],
    expect: 'a Huitun quota wall is a refusal, not an empty result with zero views',
  },
  {
    name: 'M2 FAILURE_CLASS_BY_CODE 不再映射这个 code',
    target: 'adapter',
    find: "  [USAGE_LIMIT_CODE]: 'POLICY_DENIED',\n",
    replace: '',
    tests: [TESTS.adapter],
    expect: 'translateFlowError 把中文策略结论映射成确定性分类，未知异常原样抛出',
  },
  {
    name: 'M3 translateFlowError 不再按 code 翻译（退回消息正则）',
    target: 'adapter',
    find: `  if (error?.code === USAGE_LIMIT_CODE) {
    return new HuitunEvidenceError(
      'Huitun refused to serve this query because the account usage limit was reached',
      USAGE_LIMIT_CODE,
      { evidence: error.details?.evidence ?? null },
    );
  }
`,
    replace: '',
    tests: [TESTS.adapter],
    expect: 'translateFlowError 把中文策略结论映射成确定性分类，未知异常原样抛出',
  },
  {
    name: 'M4 CLI 退出码判据不再认这个 code',
    target: 'cli',
    find: "  if (code === 'HUMAN_REQUIRED' || code === USAGE_LIMIT_CODE) return 2;",
    replace: "  if (code === 'HUMAN_REQUIRED') return 2;",
    tests: [TESTS.cli],
    expect: 'CLI 的两条轴（退出码 / 是否保留页签）由同一处判据给出，配额墙与登录墙同级',
  },
  {
    name: 'M5 调用点退回内联清单（判据函数还在，但没人用）',
    target: 'cli',
    find: '    preserveBrowser = preserveBrowserFor(error);\n',
    replace: "    preserveBrowser = ['HUMAN_REQUIRED', 'STALLED'].includes(error.code);\n",
    tests: [TESTS.cli],
    expect: '接线判据：两个调用点都必须走判据函数，不许再抄一份内联清单',
  },
];

const lines = [];
lines.push('=== 基线（改动前必须先绿，否则「突变后变红」无法归因）===');
const baseline = runTests(Object.values(TESTS));
lines.push(`三份用例文件：${baseline.totals}，status=${baseline.status}，失败用例 ${baseline.failures.length} 条`);
if (baseline.status !== 0 || baseline.failures.length) {
  lines.push('基线不是绿的 —— 停手，不进入突变。');
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(1);
}

let caught = 0;
let missed = 0;
for (const mutation of MUTATIONS) {
  const file = FILES[mutation.target];
  const original = originals[mutation.target];
  if (!original.includes(mutation.find)) {
    lines.push(`\n${mutation.name}\n  突变点找不到（源码已变）⇒ 记为 MISSED，不猜。`);
    missed += 1;
    continue;
  }
  writeFileSync(file, original.replace(mutation.find, mutation.replace), 'utf8');
  const result = runTests(mutation.tests);
  writeFileSync(file, original, 'utf8');
  const restored = sha256(readFileSync(file, 'utf8')) === digests[mutation.target];
  const hit = result.failures.some((name) => name === mutation.expect);
  lines.push(`\n${mutation.name}`);
  lines.push(`  ${result.totals}，status=${result.status}`);
  for (const name of result.failures) lines.push(`    not ok - ${name}`);
  lines.push(`  期望点名：${mutation.expect}`);
  lines.push(`  ⇒ ${hit ? 'CAUGHT' : 'MISSED'}　还原逐字节一致：${restored ? '是' : '否'}`);
  if (hit && restored) caught += 1;
  else missed += 1;
  if (!restored) {
    lines.push('  还原失败 —— 立即停手，源码可能已脏。');
    break;
  }
}

lines.push('');
lines.push('=== 收尾：全量复核（只逐个复核会漏「改到一半抛错」）===');
let allRestored = true;
for (const [key, file] of Object.entries(FILES)) {
  const now = sha256(readFileSync(file, 'utf8'));
  const ok = now === digests[key];
  allRestored = allRestored && ok;
  lines.push(`  ${path.basename(file)}  ${ok ? '一致' : '不一致'}  ${now.slice(0, 12)}`);
}
lines.push('');
lines.push(`结果：CAUGHT ${caught} / MISSED ${missed} / 共 ${MUTATIONS.length}${caught === MUTATIONS.length && missed === 0 && allRestored ? '　MUTATION_ALL_CAUGHT_AND_RESTORED' : '　MUTATION_NOT_CLEAN'}`);

process.stdout.write(lines.join('\n') + '\n');
process.exit(caught === MUTATIONS.length && missed === 0 && allRestored ? 0 : 1);
