// 完成通知的「数字从哪来」的守卫（2026-10-13 统一预警机制，用户定稿第 5 条）。
//
// 这一层的判据错了，收信人看到的就是一个**对数不上现场**的数字 ——
// 而「8/8 家、底单 8 行」正是他判断「今天是不是真收全了」的唯一依据。
// 所以这里用**真实形状的工件**（读不到就不猜、下界不当结论、一家缺就整条不发），
// 并且钉住一条 2026-10-12 用真金白银换来的口径：**全店共一张的表按 recordId
// 跨店去重取并集**——求和会把同一个事实数 N 遍（那天底单被说成 36 行，实际 8 行）。

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { batchDirs, dailyOkFacts, productOkFacts, promotionOkFacts, readSummaries } from './flow-ok-facts.mjs';

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'flow-ok-facts-'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/** 真实形状的一行：带 recordId（底单/询单表都按它跨店去重取并集）。 */
function row(recordId) {
  return { recordId, values: { '店铺名称': { display: '某店' }, 统计日期: { display: '2026-10-12' } } };
}

/** 询单表一天的 8 行：同一批 recordId ⇒ 不同店的回读指向同一批行（并集仍为 8）。 */
function inquiryRows(prefix) {
  return Array.from({ length: 8 }, (_, i) => row(`${prefix}${i + 1}`));
}

describe('dailyOkFacts：两张表都是全店共一张 ⇒ 跨店按 recordId 去重取并集', () => {
  it('同一事实被多家读到（recordId 重叠）⇒ 并集，不求和', () => {
    // 底单是全店共一张表：一家店的回读读到的是整张表在该日的行的一个子集
    // （里面躺着别家店的行）。两家读数重叠时求和会把同一个事实数两遍。
    const root = tmpRoot();
    try {
      writeJson(path.join(root, 'evidence', 'daily-report-2026-10-12-盖文淘宝', 'independent-readback.json'), {
        tables: {
          source: { onDateCount: 2, onDateCountIsLowerBound: false,
            onDateRows: [row('recA'), row('recB')] },
          // 询单表也是共表：两家读到同一批 8 行（recordId 相同）⇒ 并集 8，不是 16
          inquiry: { onDateCount: 8, onDateCountIsLowerBound: false,
            onDateRows: inquiryRows('recQ') },
        },
      });
      writeJson(path.join(root, 'evidence', 'daily-report-2026-10-12-盖文天猫', 'independent-readback.json'), {
        tables: {
          source: { onDateCount: 2, onDateCountIsLowerBound: false,
            onDateRows: [row('recB'), row('recC')] },
          inquiry: { onDateCount: 8, onDateCountIsLowerBound: false,
            onDateRows: inquiryRows('recQ') },
        },
      });
      const facts = dailyOkFacts({ root, date: '2026-10-12', shops: ['盖文淘宝', '盖文天猫'] });
      // 求和会给出 底单 4 / 询单表 16；并集给出 3 / 8 —— 后者才是真的行数
      assert.deepEqual(facts.tables, [{ name: '底单', rows: 3 }, { name: '询单表', rows: 8 }]);
      assert.deepEqual(facts.missing, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('2026-10-12 实测形状：8 家读数 1/3/4/8/7/6/2/5（求和 36）⇒ 并集 8', () => {
    // 这就是 1.8.11 发错的那条告警的现场：各家回读时页面模型加载进度不同，
    // onDateCount 于是各不相同，但读到的都是同一张表在该日的行（子集大小不同）。
    // 真实子集不是嵌套前缀，但口径只认 recordId 并集，这里用嵌套子集复现
    // 「读数各异、并集唯一」这个性质。
    const root = tmpRoot();
    try {
      const counts = [1, 3, 4, 8, 7, 6, 2, 5];
      const shops = ['里可林淘宝', '盖文淘宝', '盖文天猫', '网林家居', '里可林天猫', '网林淘宝', '网林天猫', '科塔淘宝'];
      shops.forEach((shop, index) => {
        const count = counts[index];
        writeJson(path.join(root, 'evidence', `daily-report-2026-10-12-${shop}`, 'independent-readback.json'), {
          tables: {
            source: { onDateCount: count, onDateCountIsLowerBound: false,
              onDateRows: Array.from({ length: count }, (_, i) => row(`rec${i + 1}`)) },
            inquiry: { onDateCount: 8, onDateCountIsLowerBound: false, onDateRows: inquiryRows('recQ') },
          },
        });
      });
      const facts = dailyOkFacts({ root, date: '2026-10-12', shops });
      assert.deepEqual(facts.tables, [{ name: '底单', rows: 8 }, { name: '询单表', rows: 8 }]);
      assert.deepEqual(facts.missing, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('读不到工件的店不计入、也不补 0（读不到＝没有结论）', () => {
    const root = tmpRoot();
    try {
      writeJson(path.join(root, 'evidence', 'daily-report-2026-10-12-盖文淘宝', 'independent-readback.json'), {
        tables: { source: { onDateCount: 1, onDateCountIsLowerBound: false, onDateRows: [row('recA')] } },
      });
      const facts = dailyOkFacts({ root, date: '2026-10-12', shops: ['盖文淘宝', '盖文天猫'] });
      assert.deepEqual(facts.missing, ['盖文天猫']);
      // 缺文件的那家**不贡献行数**（不是补 0 充数，也不是把总数说成 1）。
      assert.deepEqual(facts.tables, [{ name: '底单', rows: 1 }]);
      assert.equal(facts.tables.some((t) => t.rows === 0), false, '0 行的表不该出现在完成通知里');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('行集不齐（onDateCountIsLowerBound）⇒ 那个数字只是下界，不计入', () => {
    const root = tmpRoot();
    try {
      writeJson(path.join(root, 'evidence', 'daily-report-2026-10-12-盖文淘宝', 'independent-readback.json'), {
        tables: {
          source: { onDateCount: 1, onDateCountIsLowerBound: true, onDateRows: [row('recA')] },
          inquiry: { onDateCount: 8, onDateCountIsLowerBound: false, onDateRows: inquiryRows('recQ') },
        },
      });
      const facts = dailyOkFacts({ root, date: '2026-10-12', shops: ['盖文淘宝'] });
      // 底单是下界 ⇒ 这家**整家**不计入（连同一份回读里的询单表也不读）：
      // 一份自己说「行集不齐」的回读，不能拆开挑对你有利的那个数字。
      assert.deepEqual(facts.missing, ['盖文淘宝']);
      assert.deepEqual(facts.tables, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rerun 世代按 mtime 取新（补跑会在同目录旁写 -rerun2）', () => {
    const root = tmpRoot();
    try {
      const base = path.join(root, 'evidence', 'daily-report-2026-10-12-盖文淘宝');
      writeJson(path.join(base, 'independent-readback.json'), {
        tables: { source: { onDateCount: 0, onDateCountIsLowerBound: false, onDateRows: [] } },
      });
      writeJson(path.join(`${base}-rerun2`, 'independent-readback.json'), {
        tables: { source: { onDateCount: 1, onDateCountIsLowerBound: false, onDateRows: [row('recA')] } },
      });
      // CI 的快速文件系统上，两次写可能落在同一毫秒 ⇒ latestReadback 的「严格大于」
      // 会出现平手、而先写到者（base，0 行）胜出。显式钉 mtime（base 旧、rerun2 新），
      // 让这条用例验的是「按 mtime 取新」这个口径本身，而不是碰时间的运气
      // （2026-10-13 CI 实证：不钉就是偶发红）。
      const now = Date.now() / 1000;
      utimesSync(path.join(base, 'independent-readback.json'), now - 60, now - 60);
      utimesSync(path.join(`${base}-rerun2`, 'independent-readback.json'), now, now);
      const facts = dailyOkFacts({ root, date: '2026-10-12', shops: ['盖文淘宝'] });
      assert.deepEqual(facts.tables, [{ name: '底单', rows: 1 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('老工件没有 onDateRows ⇒ 退回 onDateCount 取最大值（仍不求和）', () => {
    const root = tmpRoot();
    try {
      for (const shop of ['盖文淘宝', '盖文天猫']) {
        writeJson(path.join(root, 'evidence', `daily-report-2026-10-12-${shop}`, 'independent-readback.json'), {
          tables: {
            source: { onDateCount: 3, onDateCountIsLowerBound: false },
            inquiry: { onDateCount: 8, onDateCountIsLowerBound: false },
          },
        });
      }
      const facts = dailyOkFacts({ root, date: '2026-10-12', shops: ['盖文淘宝', '盖文天猫'] });
      assert.deepEqual(facts.tables, [{ name: '底单', rows: 3 }, { name: '询单表', rows: 8 }]);
      assert.deepEqual(facts.missing, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('promotionOkFacts：导入器写后回读的行数', () => {
  it('recordIds 是这一次真建出来的行（写后还重新 listRecords 核对过）', () => {
    const root = tmpRoot();
    try {
      const summaries = [{
        shops: {
          盖文天猫: { status: 'ok', evidence: 'evidence/promotion-batches-2026-10-12/b1/盖文天猫' },
          网林天猫: { status: 'failed', evidence: 'evidence/promotion-batches-2026-10-12/b1/网林天猫' },
        },
      }];
      writeJson(path.join(root, 'evidence/promotion-batches-2026-10-12/b1/盖文天猫/receipt.json'), {
        tables: {
          keyword: { plannedRows: 74, recordIds: new Array(74).fill('rec') },
          audience: { plannedRows: 73, recordIds: new Array(73).fill('rec') },
        },
      });
      const facts = promotionOkFacts({ root, summaries });
      assert.deepEqual(facts.tables, [{ name: '关键词推广', rows: 74 }, { name: '人群推广', rows: 73 }]);
      // 失败店**不进 missing**：它不是「对不上的事实」而是「这一轮没成」——
      // 完成通知只在该轮全成功时才会发（调用方的判据），失败店由失败告警说。
      // missing 专指「status=ok 却找不到收据」这种自相矛盾。
      assert.deepEqual(facts.missing, []);
      assert.deepEqual(facts.tables, [{ name: '关键词推广', rows: 74 }, { name: '人群推广', rows: 73 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('没有 recordIds（dry-run 或老版本收据）时退回 plannedRows', () => {
    const root = tmpRoot();
    try {
      const summaries = [{ shops: { 盖文天猫: { status: 'ok', evidence: 'evidence/p/b1/盖文天猫' } } }];
      writeJson(path.join(root, 'evidence/p/b1/盖文天猫/receipt.json'), {
        tables: { keyword: { plannedRows: 5 } },
      });
      const facts = promotionOkFacts({ root, summaries });
      assert.deepEqual(facts.tables, [{ name: '关键词推广', rows: 5 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('productOkFacts：两个导入器各自的收据落名', () => {
  it('底单 receipt.json、询单 receipt-<店>.json，按真名读', () => {
    const root = tmpRoot();
    try {
      const evidence = path.join(root, 'evidence', 'product-data-job-2026-10-12', 'run-1');
      writeJson(path.join(evidence, '盖文淘宝', 'product-import', 'receipt.json'), {
        plannedRows: 27, recordIds: new Array(27).fill('rec'),
      });
      writeJson(path.join(evidence, '盖文淘宝', 'inquiry-import', 'receipt-盖文淘宝.json'), {
        plannedRows: 4, recordIds: new Array(4).fill('rec'),
      });
      const facts = productOkFacts({ evidence, shops: ['盖文淘宝'] });
      assert.deepEqual(facts.tables, [{ name: '商品底单', rows: 27 }, { name: '商品询单', rows: 4 }]);
      assert.deepEqual(facts.missing, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('推广段被有意跳过时没有收据 ⇒ 那一行不出现（完成通知只说写过的表）', () => {
    const root = tmpRoot();
    try {
      const evidence = path.join(root, 'evidence', 'product-data-job-2026-10-12', 'run-1');
      writeJson(path.join(evidence, '盖文淘宝', 'product-import', 'receipt.json'), { plannedRows: 27, recordIds: new Array(27).fill('rec') });
      const facts = productOkFacts({ evidence, shops: ['盖文淘宝'] });
      assert.deepEqual(facts.tables, [{ name: '商品底单', rows: 27 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readSummaries / batchDirs', () => {
  it('读不到/解析不了的文件不进数组（不猜）', () => {
    const root = tmpRoot();
    try {
      writeJson(path.join(root, 'b1', 'summary.json'), { shops: {} });
      mkdirSync(path.join(root, 'b2'), { recursive: true });
      writeFileSync(path.join(root, 'b2', 'summary.json'), 'not json', 'utf8');
      const out = readSummaries([path.join(root, 'b1', 'summary.json'), path.join(root, 'b2', 'summary.json'), path.join(root, 'b3', 'summary.json')]);
      assert.equal(out.length, 1);
      assert.deepEqual(batchDirs(path.join(root, 'nope')), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// 2026-10-18 补：两张真实告警都在这儿翻过车，所以单开一组钉住。
//
// 现场：10:59 那条「采集完成（统计日 2026-10-17）」写的是
//   「3/3 家全部收齐。写了：商品底单 0 行。」
// 而那一轮真实写入是 底单 0 / 询单 0 / **推广 53 行**（同日重跑，前两张被去重闸门正确拦成 0）。
// 两个错叠在一起：① 恒 push「商品底单」把 0 说出口；② 推广段根本没进统计。
describe('productOkFacts：没写的表不许出现，写了推广要数出来', () => {
  function seedRun(evidence, shops) {
    for (const shop of shops) {
      // 同日重跑的真实形状：底单/询单收据存在，但 plannedRows=0（去重闸门拦下）
      writeJson(path.join(evidence, shop, 'product-import', 'receipt.json'), { plannedRows: 0, recordIds: [] });
      writeJson(path.join(evidence, shop, 'inquiry-import', `receipt-${shop}.json`), { plannedRows: 0, recordIds: [] });
    }
  }

  it('底单 0 行时不输出「商品底单 0 行」（不再无条件带这一行）', () => {
    const root = tmpRoot();
    try {
      const evidence = path.join(root, 'evidence', 'product-data-job-2026-10-17', 'run-1');
      seedRun(evidence, ['盖文淘宝', '科塔淘宝', '里可林天猫']);
      const facts = productOkFacts({ evidence, shops: ['盖文淘宝', '科塔淘宝', '里可林天猫'] });
      assert.deepEqual(facts.tables, [], `不该出现任何 0 行的表，实际 ${JSON.stringify(facts.tables)}`);
      assert.deepEqual(facts.missing, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('推广段按部门收据的 sources 逐家归属并求和（53 行就是 53 行）', () => {
    const root = tmpRoot();
    try {
      const shops = ['盖文淘宝', '科塔淘宝', '里可林天猫'];
      const evidence = path.join(root, 'evidence', 'product-data-job-2026-10-17', 'run-1');
      seedRun(evidence, shops);
      writeJson(path.join(evidence, 'promotion-import', 'sales1', 'receipt.json'), {
        plannedRows: 53,
        recordIds: new Array(53).fill('rec'),
        sources: [
          { file: 'a.zip', shop: '盖文淘宝', rows: 16 },
          { file: 'b.zip', shop: '科塔淘宝', rows: 24 },
          { file: 'c.zip', shop: '里可林天猫', rows: 13 },
        ],
      });
      const facts = productOkFacts({ evidence, shops });
      assert.deepEqual(facts.tables, [{ name: '商品推广', rows: 53 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('逐店收据与部门收据同时存在时同一家只算一次（不翻倍）', () => {
    const root = tmpRoot();
    try {
      const shops = ['盖文淘宝', '科塔淘宝'];
      const evidence = path.join(root, 'evidence', 'product-data-job-2026-10-17', 'run-1');
      seedRun(evidence, shops);
      // 逐店落点（这一批有店缺 ZIP 时走的那条）
      writeJson(path.join(evidence, 'promotion-import', '盖文淘宝', 'receipt.json'), { plannedRows: 16, recordIds: new Array(16).fill('rec') });
      // 部门落点里又出现同一家 ⇒ 不能再加一遍
      writeJson(path.join(evidence, 'promotion-import', 'sales1', 'receipt.json'), {
        plannedRows: 40,
        sources: [
          { file: 'a.zip', shop: '盖文淘宝', rows: 16 },
          { file: 'b.zip', shop: '科塔淘宝', rows: 24 },
        ],
      });
      const facts = productOkFacts({ evidence, shops });
      assert.deepEqual(facts.tables, [{ name: '商品推广', rows: 40 }], '16（逐店）+ 24（部门里的另一家）才是真值');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('分批形态：b1/b2/b3 三份部门收据都要读，只读最后一份就是少报 100 行', () => {
    // 2026-10-23 真机：2026-10-22 那轮 8 店 3 批，完成提醒报「商品推广 17 行」，
    // 而独立回读三张表真值是 117 行 —— 差的 100 行就在被覆盖掉的前两批收据里。
    // 现场：`promotion-import/sales1/receipt.json` 只有最后一批（里可林天猫 17、网林家居 0）。
    const root = tmpRoot();
    try {
      const shops = ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝', '网林淘宝', '里可林天猫', '网林家居'];
      const evidence = path.join(root, 'evidence', 'product-data-job-2026-10-22', 'run-1');
      seedRun(evidence, shops);
      const batches = [
        [['里可林淘宝', 16], ['网林天猫', 30], ['盖文淘宝', 28]],
        [['盖文天猫', 15], ['科塔淘宝', 11], ['网林淘宝', 0]],
        [['里可林天猫', 17], ['网林家居', 0]],
      ];
      batches.forEach((items, index) => {
        const sources = items.map(([shop, rows]) => ({ file: `${shop}.zip`, shop, rows }));
        const total = items.reduce((sum, [, rows]) => sum + rows, 0);
        writeJson(path.join(evidence, 'promotion-import', 'sales1', `b${index + 1}`, 'receipt.json'), {
          plannedRows: total,
          recordIds: new Array(total).fill('rec'),
          sources,
        });
      });
      const facts = productOkFacts({ evidence, shops });
      assert.deepEqual(facts.tables, [{ name: '商品推广', rows: 117 }],
        '三批之和才是真值；只读 b3 会得到 17，与回读差 100 行且不会自己报错');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('分批形态里同一家出现在两份收据时不翻倍', () => {
    const root = tmpRoot();
    try {
      const shops = ['盖文淘宝', '科塔淘宝'];
      const evidence = path.join(root, 'evidence', 'product-data-job-2026-10-22', 'run-1');
      seedRun(evidence, shops);
      writeJson(path.join(evidence, 'promotion-import', 'sales1', 'b1', 'receipt.json'), {
        plannedRows: 16, recordIds: new Array(16).fill('rec'),
        sources: [{ file: 'a.zip', shop: '盖文淘宝', rows: 16 }],
      });
      writeJson(path.join(evidence, 'promotion-import', 'sales1', 'b2', 'receipt.json'), {
        plannedRows: 40, recordIds: new Array(40).fill('rec'),
        sources: [{ file: 'a.zip', shop: '盖文淘宝', rows: 16 }, { file: 'b.zip', shop: '科塔淘宝', rows: 24 }],
      });
      const facts = productOkFacts({ evidence, shops });
      assert.deepEqual(facts.tables, [{ name: '商品推广', rows: 40 }], '16 + 24，不是 56');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('底单真有行时照旧出现，且排在推广前面（顺序＝人读的顺序）', () => {
    const root = tmpRoot();
    try {
      const shops = ['盖文淘宝'];
      const evidence = path.join(root, 'evidence', 'product-data-job-2026-10-17', 'run-1');
      writeJson(path.join(evidence, '盖文淘宝', 'product-import', 'receipt.json'), { plannedRows: 42, recordIds: new Array(42).fill('rec') });
      writeJson(path.join(evidence, 'promotion-import', '盖文淘宝', 'receipt.json'), { plannedRows: 16, recordIds: new Array(16).fill('rec') });
      const facts = productOkFacts({ evidence, shops });
      assert.deepEqual(facts.tables, [{ name: '商品底单', rows: 42 }, { name: '商品推广', rows: 16 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
