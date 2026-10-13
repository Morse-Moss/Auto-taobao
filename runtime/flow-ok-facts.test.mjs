// 完成通知的「数字从哪来」的守卫（2026-10-13 统一预警机制，用户定稿第 5 条）。
//
// 这一层的判据错了，收信人看到的就是一个**对数不上现场**的数字 ——
// 而「8/8 家、底单 8 行」正是他判断「今天是不是真收全了」的唯一依据。
// 所以这里用**真实形状的工件**（读不到就不猜、下界不当结论、一家缺就整条不发）。

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('dailyOkFacts：底单行数求和、询单表取最大值', () => {
  it('两家各写 1 行 ⇒ 底单 2 行；询单表是一天一张 ⇒ 取最大值不求和', () => {
    const root = tmpRoot();
    try {
      for (const shop of ['盖文淘宝', '盖文天猫']) {
        writeJson(path.join(root, 'evidence', `daily-report-2026-10-12-${shop}`, 'independent-readback.json'), {
          tables: {
            source: { onDateCount: 1, onDateCountIsLowerBound: false },
            inquiry: { onDateCount: 8, onDateCountIsLowerBound: false },
          },
        });
      }
      const facts = dailyOkFacts({ root, date: '2026-10-12', shops: ['盖文淘宝', '盖文天猫'] });
      assert.deepEqual(facts.tables, [{ name: '底单', rows: 2 }, { name: '询单表', rows: 8 }]);
      assert.deepEqual(facts.missing, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('读不到工件的店不计入、也不补 0（读不到＝没有结论）', () => {
    const root = tmpRoot();
    try {
      writeJson(path.join(root, 'evidence', 'daily-report-2026-10-12-盖文淘宝', 'independent-readback.json'), {
        tables: { source: { onDateCount: 1, onDateCountIsLowerBound: false } },
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
          source: { onDateCount: 1, onDateCountIsLowerBound: true },
          inquiry: { onDateCount: 8, onDateCountIsLowerBound: false },
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
        tables: { source: { onDateCount: 0, onDateCountIsLowerBound: false } },
      });
      writeJson(path.join(`${base}-rerun2`, 'independent-readback.json'), {
        tables: { source: { onDateCount: 1, onDateCountIsLowerBound: false } },
      });
      const facts = dailyOkFacts({ root, date: '2026-10-12', shops: ['盖文淘宝'] });
      assert.deepEqual(facts.tables, [{ name: '底单', rows: 1 }]);
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
