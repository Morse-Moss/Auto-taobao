// 把 4 份独立回读里「目标日命中几行、分别是哪几家、询单两个字段有没有值」抽成一份可核对的精简证据。
//
// 为什么要有这一份：原始回读每份约 2.9MB（含整张底单 1900+ 行与截图基址），躺在 tmp/ 下，
// 而 tmp/ 被 gitignore —— 报告里引 tmp 路径等于没有证据。这份只留判「某天跑完没」用得着的字段。
// 原始文件位置（未随仓库走）：tmp/readback-2026-09-{24,20}-{post,rehang}/independent-readback.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'D:/Retire/sycm-automation';
const OUT_DIR = path.join(REPO, 'evidence', 'daily-job-2026-09-25-readback');

const SOURCES = [
  { label: '09-24 补齐之后（11:53 那轮跑完做的独立回读）', file: 'tmp/readback-2026-09-24-post/independent-readback.json' },
  { label: '09-24 幂等前置（12:30 那条一次性定时跑的回读）', file: 'tmp/readback-2026-09-24-rehang/independent-readback.json' },
  { label: '09-20 补齐之后（11:53 那轮跑完做的独立回读）', file: 'tmp/readback-2026-09-20-post/independent-readback.json' },
  { label: '09-20 幂等前置（12:30 那条一次性定时跑的回读）', file: 'tmp/readback-2026-09-20-rehang/independent-readback.json' },
];

const pick = (v) => (v && typeof v === 'object' && 'display' in v ? v.display : (v ?? null));

const reads = [];
for (const source of SOURCES) {
  const raw = JSON.parse(readFileSync(path.join(REPO, source.file), 'utf8'));
  const src = raw.tables.source;
  const inq = raw.tables.inquiry;
  reads.push({
    label: source.label,
    originalFile: source.file,
    readAt: raw.at,
    reportDate: raw.reportDate,
    sourceTable: {
      tableId: src.tableId,
      tableName: src.tableName,
      recordsNumFromPageModel: src.recordsNumFromPageModel,
      onDateCount: src.onDateCount,
      onDateCountIsLowerBound: src.onDateCountIsLowerBound,
      note: 'onDateCountIsLowerBound=false 才说明这个数是准的（页签没加载全时它是下界）',
      shops: src.onDateRows.map((row) => pick(row.values['店铺名称'])),
    },
    inquiryTable: {
      tableId: inq.tableId,
      tableName: inq.tableName,
      onDateCount: inq.onDateCount,
      rows: inq.onDateRows.map((row) => ({
        shop: pick(row.values['店铺']),
        inquiry: pick(row.values['询单量']),
        peerInquiry: pick(row.values['同层同行询单量']),
      })),
    },
  });
}

mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, 'summary.json');
writeFileSync(outPath, `${JSON.stringify({
  what: '2026-09-25 两笔历史日报（09-24 五家、09-20 科塔）补齐与否的独立回读汇总',
  howToJudge: '看 sourceTable.onDateCount（且 onDateCountIsLowerBound=false）：09-24 期望 5、09-20 期望 5',
  reads,
}, null, 2)}\n`, 'utf8');
console.log(`wrote ${path.relative(REPO, outPath).replaceAll('\\', '/')}（${reads.length} 份回读）`);
