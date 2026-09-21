// 竞品周表「商品ID」补写判据的守卫（2026-09-21 建）。
//
// 守的是什么：这一列是**跨表联结键的原料**（`SKU唯一键 = 商品ID|SKU ID`，文档也把它写成
// 「SKU 采集的入口参数」），而它在周表上 0/1417 全空。补它的动作一旦出错，错法有两种且都静默：
//   ① 把已有值覆盖掉 —— 某一行会接到另一个商品上，页面看不出任何异常；
//   ② 「提不出 id」被并进「已填」—— 结果是「收齐了」这个结论建立在把缺口算成产出的基础上。
// 所以这里逐条钉住：只填空、不一致要报不许改、提不出 id 单独计数、读回空白数必须正好等于缺口数。
import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeProductIdBackfill, normalizeCell, planProductIdFills } from './fill-weekly-product-id-core.mjs';

const LINK = (id) => `https://item.taobao.com/item.htm?spm=a21n57.1.0.0.abc&id=${id}&ns=1`;

test('planProductIdFills：空的填上，已有且相同的跳过', () => {
  const { updates, stats } = planProductIdFills([
    { recordId: 'rec1', existing: '', link: LINK('921092099640') },
    { recordId: 'rec2', existing: '822695648811', link: LINK('822695648811') },
  ]);
  assert.deepEqual(updates, [{ recordId: 'rec1', productId: '921092099640' }]);
  assert.equal(stats.filled, 1);
  assert.equal(stats.alreadyCorrect, 1);
  assert.equal(stats.conflictCount, 0);
  assert.equal(stats.noIdCount, 0);
});

test('planProductIdFills：已有值与链接 id 不一致时既不写也不丢，单独报出来', () => {
  const { updates, stats } = planProductIdFills([
    { recordId: 'rec1', existing: '111111111111', link: LINK('222222222222') },
  ]);
  assert.deepEqual(updates, []);
  assert.equal(stats.filled, 0);
  assert.deepEqual(stats.conflict, [{ recordId: 'rec1', existing: '111111111111', derived: '222222222222' }]);
  assert.equal(stats.conflictCount, 1);
});

test('planProductIdFills：链接提不出 id 的行单独计数，不许并进「已填」', () => {
  const { updates, stats } = planProductIdFills([
    { recordId: 'rec1', existing: '', link: 'https://item.taobao.com/item.htm?spm=a21n57' },
    { recordId: 'rec2', existing: '', link: '' },
    { recordId: 'rec3', existing: '', link: null },
  ]);
  assert.deepEqual(updates, []);
  assert.equal(stats.filled, 0);
  assert.equal(stats.noIdCount, 3);
  // 关键：缺口不能算成产出 —— 否则「1417 行都收齐了」会建立在 0 行真值上
  assert.equal(stats.filled + stats.noIdCount, 3);
});

test('planProductIdFills：飞书回读的数组/对象形态不吃掉 id', () => {
  const { updates } = planProductIdFills([
    { recordId: 'rec1', existing: [], link: [{ text: LINK('753900871424') }] },
    { recordId: 'rec2', existing: { text: '' }, link: { value: LINK('1038622504551') } },
  ]);
  assert.deepEqual(updates.map((item) => item.productId), ['753900871424', '1038622504551']);
});

test('planProductIdFills：跑第二遍必须是零更新（幂等）', () => {
  const rows = [
    { recordId: 'rec1', existing: '', link: LINK('921092099640') },
    { recordId: 'rec2', existing: '', link: LINK('822695648811') },
  ];
  const first = planProductIdFills(rows);
  assert.equal(first.stats.filled, 2);
  const applied = new Map(first.updates.map((item) => [item.recordId, item.productId]));
  const second = planProductIdFills(rows.map((row) => ({ ...row, existing: applied.get(row.recordId) })));
  assert.deepEqual(second.updates, []);
  assert.equal(second.stats.alreadyCorrect, 2);
});

test('planProductIdFills：recordId 缺失或重复时直接抛，不静默少写/多写', () => {
  assert.throws(() => planProductIdFills([{ recordId: '', existing: '', link: LINK('1') }]), /recordId/u);
  assert.throws(
    () => planProductIdFills([
      { recordId: 'rec1', existing: '', link: LINK('1') },
      { recordId: 'rec1', existing: '', link: LINK('2') },
    ]),
    /重复/u,
  );
  assert.deepEqual(planProductIdFills([]).stats, {
    rows: 0, filled: 0, alreadyCorrect: 0, conflictCount: 0, noIdCount: 0, conflict: [], noId: [],
  });
});

test('normalizeCell：三种回读形态都归一成字符串', () => {
  assert.equal(normalizeCell(null), '');
  assert.equal(normalizeCell(undefined), '');
  assert.equal(normalizeCell(' 921092099640 '), '921092099640');
  assert.equal(normalizeCell([{ text: 'a' }, { text: 'b' }]), 'a,b');
  assert.equal(normalizeCell({ value: 'x' }), 'x');
  assert.equal(normalizeCell(921092099640), '921092099640');
});

test('judgeProductIdBackfill：空白数只该等于「提不出 id」的行数', () => {
  const ok = judgeProductIdBackfill({ stats: { rows: 1417, noIdCount: 0 }, blanksAfter: 0, rowsAfter: 1417 });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /正好等于/u);

  // 少写了一些（算进了 updates 却没落上）—— 必须红，且要点出预期与实际
  const short = judgeProductIdBackfill({ stats: { rows: 1417, noIdCount: 0 }, blanksAfter: 12, rowsAfter: 1417 });
  assert.equal(short.ok, false);
  assert.equal(short.expected, 0);
  assert.equal(short.actual, 12);
  assert.match(short.detail, /没落上/u);

  // 有 3 行链接提不出 id ⇒ 剩 3 格空是正常的，不许判成失败
  const withGap = judgeProductIdBackfill({ stats: { rows: 1417, noIdCount: 3 }, blanksAfter: 3, rowsAfter: 1417 });
  assert.equal(withGap.ok, true);
});

test('judgeProductIdBackfill：行数变了先怀疑有人同时在写这张表', () => {
  const drifted = judgeProductIdBackfill({ stats: { rows: 1417, noIdCount: 0 }, blanksAfter: 0, rowsAfter: 1420 });
  assert.equal(drifted.ok, false);
  assert.match(drifted.detail, /同时在写/u);
  assert.throws(() => judgeProductIdBackfill({ stats: { noIdCount: 0 }, blanksAfter: null }), /blanksAfter/u);
});
