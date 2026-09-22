// 突变验证：把 weekly-round-input.mjs 改坏，确认用例**真的红、且红在期望的那条上**，
// 然后还原并自证逐字节一致。
//
// 为什么必须做这一步：用例全绿只证明「跑得通」，不证明「判据有效」。
// 一个永远为真的断言和一个没接上的守卫，都是绿的。

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..'); // 本副本住在 evidence/<批次>/ 下，比原件深一层
const TARGET = path.join(ROOT, 'runtime', 'weekly-round-input.mjs');
const TEST = path.join(ROOT, 'runtime', 'weekly-round-input.test.mjs');
const NODE = process.execPath;

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const original = readFileSync(TARGET, 'utf8');
const originalSha = sha256(original);

const mutants = [
  {
    name: 'batch-off-by-one',
    from: 'return max + 1;',
    to: 'return max;',
    expect: ['batch number is the next unused one'],
  },
  {
    name: 'history-filter-inverted',
    from: 'Number(fieldOf(record, HISTORY_BATCH_FIELD)) !== target',
    to: 'Number(fieldOf(record, HISTORY_BATCH_FIELD)) === target',
    expect: ['expected history before is every row'],
  },
  {
    name: 'previous-week-drift',
    from: 'const previousCollectionDate = shiftDate(collectionDate, -7);',
    to: 'const previousCollectionDate = shiftDate(collectionDate, -6);',
    expect: ['resolves to the same tables production actually used'],
  },
  {
    name: 'fullwidth-parens-to-halfwidth',
    from: "return `${KEYWORD_WEEKLY_TABLE_PREFIX}（${requireDate(collectionDate, 'collectionDate')}）`;",
    to: "return `${KEYWORD_WEEKLY_TABLE_PREFIX}(${requireDate(collectionDate, 'collectionDate')})`;",
    expect: ['table name round-trips', 'full-width parentheses'],
  },
];

function runSuite() {
  const result = spawnSync(NODE, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failed = output.split('\n').filter((line) => line.startsWith('not ok ')).map((line) => line.trim());
  const counts = output.split('\n').filter((line) => /^# (tests|pass|fail) /.test(line)).map((line) => line.trim());
  return { output, failed, counts, status: result.status };
}

const lines = [];
lines.push(`original sha256 = ${originalSha}`);

let allGood = true;
for (const mutant of mutants) {
  if (!original.includes(mutant.from)) {
    lines.push(`\n== ${mutant.name}: SKIPPED — anchor not found: ${mutant.from}`);
    allGood = false;
    continue;
  }
  writeFileSync(TARGET, original.replace(mutant.from, mutant.to), 'utf8');
  const mutated = readFileSync(TARGET, 'utf8');
  if (mutated === original) {
    lines.push(`\n== ${mutant.name}: SKIPPED — write had no effect`);
    allGood = false;
    continue;
  }
  const result = runSuite();
  const named = mutant.expect.every((needle) => result.failed.some((line) => line.includes(needle)));
  const newOnes = result.failed.filter((line) => line.includes(mutant.expect[0]));
  lines.push(`\n== ${mutant.name}`);
  lines.push(`   ${result.counts.join(' | ')}`);
  lines.push(`   failed: ${result.failed.length}`);
  result.failed.forEach((line) => lines.push(`     - ${line}`));
  lines.push(`   names the expected case: ${named ? 'YES' : 'NO'} (${newOnes.length} matched)`);
  if (!named) allGood = false;
  // 还原后就地校验，别等到最后才发现有一轮没还原干净。
  writeFileSync(TARGET, original, 'utf8');
  const restored = readFileSync(TARGET, 'utf8');
  lines.push(`   restored byte-identical: ${sha256(restored) === originalSha ? 'YES' : 'NO'}`);
  if (sha256(restored) !== originalSha) allGood = false;
}

const finalRun = runSuite();
lines.push(`\n== restored: ${finalRun.counts.join(' | ')}`);
lines.push(`   not ok lines: ${finalRun.failed.length}`);
lines.push(`   final sha256 = ${sha256(readFileSync(TARGET, 'utf8'))}`);
lines.push(`\nALL MUTANTS BEHAVED AS EXPECTED: ${allGood ? 'YES' : 'NO'}`);

writeFileSync(path.join(ROOT, 'tmp', '_mutate-weekly-round-input.out.txt'), `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(allGood && finalRun.failed.length === 0 ? 0 : 1);
