#!/usr/bin/env node
// 突变验证：`runtime/fill-weekly-product-id-core.mjs` 的判据真的能拦住改动。
//
// 守的是「商品ID 补写」这一列的三种错法（都会静默）：
//   · 把已有值覆盖掉 ⇒ 某行接到另一个商品上；
//   · 「提不出 id」被并进「已填」⇒ 「收齐了」建立在把缺口算成产出上；
//   · 读回判据恒真 ⇒ 少写了也不报。
//
// 与同仓另外两个突变脚本同样的三个前提：
//   ① 基线必须先绿（否则「突变后变红」无法归因）；
//   ② 还原放 try/finally，开跑前记指纹、结束全量复核；
//   ③ 文件名刻意不是 `.test.mjs` —— 套件按后缀发现测试（scripts/test-suite-discovery.mjs），
//      叫错了会让「跑一次测试」顺手改源码。
//
// 跑它：node runtime/fill-weekly-product-id-core.mutation.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(REPO, 'runtime', 'fill-weekly-product-id-core.mjs');
const TEST = path.join(REPO, 'runtime', 'fill-weekly-product-id-core.test.mjs');

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

const MUTATIONS = [
  {
    name: '允许覆盖已有值（把「不一致只报不改」那条分支删掉）',
    find: "    if (existing) { conflict.push({ recordId, existing, derived }); continue; }\n",
    replace: '',
    expect: '不一致时既不写也不丢',
  },
  {
    name: '把「链接提不出 id」的行并进 updates（缺口算成产出）',
    find: "    if (!derived) { noId.push({ recordId, link }); continue; }",
    replace: "    if (!derived) { updates.push({ recordId, productId: '' }); continue; }",
    expect: '不许并进「已填」',
  },
  {
    name: '已有值相同的行也重写（幂等性没了）',
    find: "    if (existing === derived) { alreadyCorrect.push({ recordId, productId: derived }); continue; }",
    replace: "    if (false) { alreadyCorrect.push({ recordId, productId: derived }); continue; }",
    expect: '幂等',
  },
  {
    name: 'recordId 重复不再抛（同一行会被写两次）',
    find: "    if (seen.has(recordId)) throw new Error(`planProductIdFills: recordId 重复 ${recordId}（会把同一行写两次）`);\n",
    replace: '',
    expect: 'recordId 缺失或重复',
  },
  {
    name: '读回判据恒真（少写了也不报）',
    find: "    ok: blanksAfter === expected,",
    replace: "    ok: true,",
    expect: 'judgeProductIdBackfill',
  },
];

// 前提：基线必须绿。
const baseline = failedCases(runTests(TEST));
if (baseline.length > 0) {
  console.log(JSON.stringify({ status: 'BASELINE_RED', baseline }, null, 2));
  console.log('');
  console.log('BASELINE_RED: 基线测试没有全绿，突变验证无法归因。先修基线，再跑这里。');
  process.exitCode = 1;
} else {
  const baselineHash = sha(SOURCE);
  const report = [];

  try {
    for (const mutation of MUTATIONS) {
      const source = fs.readFileSync(SOURCE, 'utf8');
      const occurrences = source.split(mutation.find).length - 1;
      if (occurrences !== 1) {
        report.push({ name: mutation.name, verdict: 'BAD_FIXTURE', detail: `字面量出现 ${occurrences} 次（要求恰好 1 次）` });
        continue;
      }
      fs.writeFileSync(SOURCE, source.replace(mutation.find, mutation.replace), 'utf8');
      let output;
      try {
        output = runTests(TEST);
      } finally {
        fs.writeFileSync(SOURCE, source, 'utf8');
      }
      const failed = failedCases(output);
      const named = failed.some((name) => name.includes(mutation.expect));
      report.push({
        name: mutation.name,
        verdict: failed.length === 0 ? 'NOT_CAUGHT' : (named ? 'CAUGHT_AND_NAMED' : 'CAUGHT_BUT_WRONG_TEST'),
        failed,
        expected: mutation.expect,
        restored: sha(SOURCE) === baselineHash,
      });
    }
  } finally {
    if (fs.existsSync(SOURCE) && sha(SOURCE) !== baselineHash) {
      console.error('WATCHED_FILE_MODIFIED: runtime/fill-weekly-product-id-core.mjs 未还原（可能在写入时被中断）');
      process.exitCode = 1;
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
