#!/usr/bin/env node
// 突变验证：`runtime/local-keyword-analysis.mjs` 的**受控词表**判据真的能拦住改动。
//
// 为什么单独一个：content-heat-judge.mutation.mjs 守的是「内容热度判定侧」，
// 这个守的是「规则侧（标签表 / 分类表）」。两者改的文件不同、测试文件不同，不合并。
//
// 与那个脚本同样的三个前提，缺一个整场验证就不成立：
//   ① 基线必须先绿（否则「突变后变红」无法归因）；
//   ② 还原放 try/finally，且开跑前记下全部待改文件指纹、结束做全量复核
//      （只逐个复核会漏掉「改到一半抛错、后面没跑」）；
//   ③ 文件名刻意不是 `.test.mjs` —— 套件按后缀发现测试（scripts/test-suite-discovery.mjs），
//      叫错了会让「跑一次测试」顺手改源码。
//
// 跑它：node runtime/local-keyword-analysis.mutation.mjs

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(REPO, 'runtime', 'local-keyword-analysis.mjs');
const TEST = path.join(REPO, 'runtime', 'local-keyword-analysis.test.mjs');

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

const EXPECTED = 'local labels cover the 2026-09-21 vocabulary additions';

const MUTATIONS = [
  {
    name: '「适老」从场景/老人 的正则里拿掉（回到只认 老人|老年）',
    find: "  ['场景/老人', /老人|老年|适老/u],",
    replace: "  ['场景/老人', /老人|老年/u],",
    expect: EXPECTED,
  },
  {
    name: '「新式」从功能/新款 的正则里拿掉（回到只认 新款|新型）',
    find: "  ['功能/新款', /新款|新型|新式/u],",
    replace: "  ['功能/新款', /新款|新型/u],",
    expect: EXPECTED,
  },
  {
    name: '把 品牌/Bette 从受控品牌表里删掉',
    find: "  ['品牌/Bette', /bette/iu],\n",
    replace: '',
    expect: EXPECTED,
  },
  {
    name: '把 品牌/tw 从受控品牌表里删掉',
    find: "  ['品牌/tw', /tw浴缸|tw卫浴|\\btw\\b/iu],\n",
    replace: '',
    expect: EXPECTED,
  },
  {
    name: '受控边界被放宽：把只在 BRANDS 里的「云涛」也塞进标签表',
    find: "  ['品牌/恩仕', /恩仕/u],",
    replace: "  ['品牌/恩仕', /恩仕/u],\n  ['品牌/云涛', /云涛/u],",
    expect: 'controlled brand vocabulary',
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
      console.error('WATCHED_FILE_MODIFIED: runtime/local-keyword-analysis.mjs 未还原（可能在写入时被中断）');
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
