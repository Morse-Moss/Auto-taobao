#!/usr/bin/env node
// 突变验证：「内容热度判定 + 本地分析入口」的判据**真的能拦住 X**。
//
// 为什么它在仓库里、而不是留在会话的探针目录：
//   判据写完到报绿灯之间，「这条判据能拦住 X」只是一个说法。突变是唯一能把说法变成证据的动作 ——
//   本项目已经吃过「测试全绿、现场还是错」的亏（见 LESSONS-2026-09-14_15.md）。
//   而如果这个脚本只存在于某次会话的临时目录里，那么「判据有效」这件事本身就没有仓库记录，
//   和「判定逻辑寄存在一次对话里」是同一个病 —— 那个病刚被 content-heat-judge.mjs 治好，别在这里复发。
//
// 做法：精确字面量替换（出现次数必须恰好 1，否则当场报 BAD_FIXTURE，绝不模糊匹配），
// 跑 `node --test <测试文件>`，抓 `not ok N - <用例名>`，
// 要求红的用例**点名到期望的那一条**（红了但红在别的用例上等于没验证到），
// 然后逐字节还原并用 sha256 自证。
//
// 跑它：node runtime/content-heat-judge.mutation.mjs
// 注意：它会临时改 runtime/ 下的源码再还原。**不要**给它起 .test.mjs 的后缀 ——
// 套件的发现逻辑按后缀扫（scripts/test-suite-discovery.mjs），叫 .test.mjs 会被套件当测试跑起来，
// 于是一次「跑测试」会顺手改源码。这个后缀是刻意的。

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const JUDGE = path.join(REPO, 'runtime', 'content-heat-judge.mjs');
const RUNNER = path.join(REPO, 'runtime', 'run-keyword-weekly-local-analysis.mjs');
const JUDGE_TEST = path.join(REPO, 'runtime', 'content-heat-judge.test.mjs');
const RUNNER_TEST = path.join(REPO, 'runtime', 'run-keyword-weekly-local-analysis.test.mjs');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function runTests(testFile) {
  try {
    return execFileSync(process.execPath, ['--test', testFile], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

function failedCases(output) {
  return [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => match[1].trim());
}

// 前提：基线必须是绿的。
// 没有这一步，「突变之后变红」就不能归因于突变 —— 基线本来就红时，突变验证会把自己演成一次假成功。
const baselineFailures = [];
for (const testFile of [JUDGE_TEST, RUNNER_TEST]) {
  const failures = failedCases(runTests(testFile));
  if (failures.length > 0) baselineFailures.push({ file: path.relative(REPO, testFile).replaceAll('\\', '/'), failures });
}
if (baselineFailures.length > 0) {
  console.log(JSON.stringify({ status: 'BASELINE_RED', baselineFailures }, null, 2));
  console.log('');
  console.log('BASELINE_RED: 基线测试没有全绿，突变验证无法归因。先修基线，再跑这里。');
  process.exitCode = 1;
} else {

const MUTATIONS = [
  {
    name: '提示词指纹被改（提示词本身没动）',
    file: JUDGE,
    test: JUDGE_TEST,
    find: "export const PROMPT_DIGEST = '1945f62bf7c0a655985206f6ff83431dab3024c7cf5039c71878a27fb5a624dc';",
    replace: "export const PROMPT_DIGEST = '0000000000000000000000000000000000000000000000000000000000000000';",
    expect: '判定被钉在提示词原文上',
  },
  {
    name: '「信号未知」的判定挪到导航/纯品牌捷径之前',
    file: JUDGE,
    test: JUDGE_TEST,
    find: `  if (features.navigation) return '低';
  if (features.brandOnly) return '低';
  if (features.signalUnknown) return '待核验';`,
    replace: `  if (features.signalUnknown) return '待核验';
  if (features.navigation) return '低';
  if (features.brandOnly) return '低';`,
    expect: '信号读不到时落「待核验」',
  },
  {
    name: '标签只认数组形态（字符串形态被当成空）',
    file: JUDGE,
    test: JUDGE_TEST,
    find: `  if (Array.isArray(value)) return value.map((item) => readbackText(item)).filter(Boolean);
  return readbackText(value).split(/[、,，;；\\n]+/u).map((item) => item.trim()).filter(Boolean);`,
    replace: `  if (Array.isArray(value)) return value.map((item) => readbackText(item)).filter(Boolean);
  return [];`,
    expect: '标签切片两种读回形态都要认',
  },
  {
    name: '分布先去重再统计（把「各档多少条」变成「有几种值」）',
    file: JUDGE,
    test: JUDGE_TEST,
    find: '  for (const value of values) counts.set(value || \'(空)\', (counts.get(value || \'(空)\') ?? 0) + 1);',
    replace: '  for (const value of [...new Set(values)]) counts.set(value || \'(空)\', (counts.get(value || \'(空)\') ?? 0) + 1);',
    expect: '产物按「出现次数」统计分布',
  },
  {
    name: '本地规则覆盖表上已有的值（不再是只补空白格）',
    file: RUNNER,
    test: RUNNER_TEST,
    find: "      if (isBlank(fields[name])) { fields[name] = analysis[name]; filledFrom[name] = 'local-rule'; }",
    replace: "      if (true) { fields[name] = analysis[name]; filledFrom[name] = 'local-rule'; }",
    expect: '本地规则只补空白格',
  },
  {
    name: '表名与表 id 各指一张表时不再报错（删掉一致性断言）',
    file: RUNNER,
    test: RUNNER_TEST,
    find: "  if (tableName && table.name !== tableName) throw new Error(`Table identity mismatch: ${tableId} is ${table.name}, expected ${tableName}`);\n",
    replace: '',
    expect: '表解析',
  },
  {
    name: '真写只要求 base 确认，不要求 table 确认',
    file: RUNNER,
    test: RUNNER_TEST,
    find: "  if (options.apply && options.confirmTable !== options.tableId) throw new Error('Write mode requires matching --confirm-table <table-id>');\n",
    replace: '',
    expect: '入口默认 dry-run',
  },
  // 2026-09-21 新增三条，照的是刚接进来的第三段（决策历史同步）。它们抓的是同一类病：
  // 「写入器自己报成功」和「它真的该写」不是一回事 —— 下面每一条都能把「先只读探路」这层保护删掉。
  {
    name: '第三段的只读探路跟进入口的 --apply（于是探路那一次也真写）',
    file: RUNNER,
    test: RUNNER_TEST,
    find: 'backupDir, write: false });',
    replace: 'backupDir });',
    expect: '第三段幂等',
  },
  {
    name: '历史表快照定格了也不再补第二遍（自愈被关掉）',
    file: RUNNER,
    test: RUNNER_TEST,
    find: '  if (readback.visualMismatchCount > 0) {',
    replace: '  if (readback.visualMismatchCount > 999999) {',
    expect: '第三段自愈',
  },
  {
    name: '回读不按批次筛（上一批的有值率把本批的缺口洗绿）',
    file: RUNNER,
    test: RUNNER_TEST,
    find: "  const batchRows = historyRecords.filter((record) => Number(readbackText(record.fields?.['批次编号'])) === Number(batchNumber));",
    replace: '  const batchRows = historyRecords;',
    expect: '第三段独立回读',
  },
  {
    name: '整体状态判据退回「表上不能有空格」（本来就该空的列被判成缺口）',
    file: RUNNER,
    test: RUNNER_TEST,
    find: '    .filter(([field, filled]) => filled < afterRows - expectedBlank[field])',
    replace: '    .filter(([field, filled]) => filled < afterRows)',
    expect: '整体状态判据',
  },
];

// 开跑前记下所有会被改到的文件的指纹，结束时全量复核 ——
// 只逐个复核「改过的」会漏掉「改到一半就抛错、剩下的没跑」这种情况。
const watched = new Map([...new Set(MUTATIONS.map((item) => item.file))].map((file) => [file, sha(file)]));

const report = [];
try {
  for (const mutation of MUTATIONS) {
    const before = sha(mutation.file);
    const source = fs.readFileSync(mutation.file, 'utf8');
    const occurrences = source.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      report.push({ name: mutation.name, verdict: 'BAD_FIXTURE', detail: `字面量出现 ${occurrences} 次（要求恰好 1 次）` });
      continue;
    }
    fs.writeFileSync(mutation.file, source.replace(mutation.find, mutation.replace), 'utf8');
    let output;
    try {
      output = runTests(mutation.test);
    } finally {
      // 还原放在 finally：突变跑测试时抛错（比如测试文件语法错）也必须还原，
      // 否则源码会带着一处故意改坏的地方留在工作区，而下一个人看到的是「仓库里有个 bug」。
      fs.writeFileSync(mutation.file, source, 'utf8');
    }

    const failed = failedCases(output);
    const named = failed.some((name) => name.includes(mutation.expect));
    report.push({
      name: mutation.name,
      verdict: failed.length === 0 ? 'NOT_CAUGHT' : (named ? 'CAUGHT_AND_NAMED' : 'CAUGHT_BUT_WRONG_TEST'),
      failed,
      expected: mutation.expect,
      restored: sha(mutation.file) === before,
    });
  }
} finally {
  for (const [file, hash] of watched) {
    if (fs.existsSync(file) && sha(file) !== hash) {
      console.error(`WATCHED_FILE_MODIFIED: ${path.relative(REPO, file)} 未还原（可能在写入时被中断）`);
      process.exitCode = 1;
    }
  }
}

const restoredOk = report.every((item) => item.restored !== false);
console.log(JSON.stringify({ restoredOk, report }, null, 2));
console.log('');
for (const item of report) {
  console.log(`${item.verdict.padEnd(24)} ${item.name}${item.failed?.length ? `  → ${item.failed.join(' / ')}` : ''}`);
}
const allCaught = report.every((item) => item.verdict === 'CAUGHT_AND_NAMED');
console.log('');
console.log(allCaught && restoredOk ? 'MUTATION_ALL_CAUGHT_AND_RESTORED' : 'MUTATION_INCOMPLETE');
if (!(allCaught && restoredOk)) process.exitCode = 1;

}
