// 预检：用 run4 已经采到的真实产物，把三个导入脚本各跑一遍 **dry-run**（不加 --apply ⇒ 不写飞书）。
// 目的：在花十几分钟重跑之前，先证明「XLS/ZIP 解析这一层」现在通了、而且五家店都通。
// 为什么要有这层预检：上一轮五家店的采集全绿、导入全灭，重跑一次的成本是十几分钟 + 一次真实采集，
// 而解析层的失败可以在 1 分钟内离线复现 —— 先在这一层拿结论，再决定要不要重跑。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
// 默认跑「修复前那一轮」的产物（用来定位解析层故障）；给参数则跑指到的那一轮
// （修复后那一轮用它证明幂等：刚写完的同一批数据再算一次，计划行数应当是 0）。
const RUN_DIR = process.argv[2]
  ? path.resolve(ROOT, process.argv[2])
  : path.join(ROOT, 'evidence', 'product-data-job-2026-09-26', '2026-09-26-20260927143811154-0ab5dd12');
const OUT_ROOT = path.resolve(ROOT, 'evidence', 'import-ebusy-fix-2026-09-27', 'dryrun', path.basename(RUN_DIR));
const DATE = '2026-09-26';

const run = (file, args) => {
  const result = spawnSync(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
};

const pick = (text, keys) => {
  try {
    const parsed = JSON.parse(text);
    return Object.fromEntries(keys.filter((key) => key in parsed).map((key) => [key, parsed[key]]));
  } catch { return null; }
};

const items = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'collection.json'), 'utf8'));
const rows = [];
for (const item of items) {
  const dir = path.join(OUT_ROOT, item.shop);
  fs.mkdirSync(dir, { recursive: true });
  const stages = {};
  stages.product = run('skills/sycm-product-data/scripts/import-product-data.mjs', ['--file', item.productFile, '--shop', item.shop, '--evidence', path.join(dir, 'product')]);
  stages.inquiry = run('skills/sycm-inquiry-data/scripts/import-inquiry-data.mjs', ['--file', item.inquiryFile, '--date', DATE, '--shop', item.shop, '--evidence', path.join(dir, 'inquiry')]);
  stages.promotion = run('skills/sycm-promotion-data/scripts/import-promotion-data.mjs', ['--file', item.promotionFile, '--shop', item.shop, '--evidence', path.join(dir, 'promotion')]);

  const line = { shop: item.shop };
  for (const [stage, result] of Object.entries(stages)) {
    const receipt = result.code === 0
      ? pick(result.out, ['sourceRows', 'existingRows', 'plannedRows', 'duplicateRows', 'date'])
      : null;
    line[stage] = receipt ? { exit: 0, ...receipt } : { exit: result.code, error: (result.err || result.out).trim().split('\n').slice(0, 2).join(' | ').slice(0, 220) };
  }
  rows.push(line);
  console.log(JSON.stringify(line));
}

fs.writeFileSync(path.join(OUT_ROOT, 'dryrun-summary.json'), `${JSON.stringify(rows, null, 2)}\n`);
const failed = rows.filter((row) => Object.values(row).some((value) => value && typeof value === 'object' && value.exit !== 0)).length;
console.log(`\n结论：${rows.length - failed}/${rows.length} 家店三段 dry-run 全通；失败 ${failed} 家`);
process.exitCode = failed === 0 ? 0 : 1;
