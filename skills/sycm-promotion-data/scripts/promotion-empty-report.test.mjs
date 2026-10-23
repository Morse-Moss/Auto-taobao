import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePromotionReport } from './promotion-core.mjs';

// ---------------------------------------------------------------------------
// 「平台导出零数据」是合法形态，不是坏文件（2026-10-21 加）
// ---------------------------------------------------------------------------
// 真实样本：2026-10-20 网林家居的 `商品报表_20261021_181653.zip`（596 B）。
// 解包后的 CSV 逐字长这样：
//     日期,场景ID,场景名字,...,补贴引导成交人数\n
//     \n
// 也就是「78 列表头 + 一个空行」，文件以 `\n\n` 结尾。Python `csv.reader` 会为这个空行
// 产出一个**空数组 `[]`**（长度 0），于是旧判据 `row.length !== headers.length` 把
// 「一天的正常空数据」判成坏文件，还连带把批量导入里另外两家有数据的店一起打掉。
//
// 判据必须分开三件事：零数据（放行）、文件截断（抛错）、字段缺失（抛错）。

const HEAD_78 = ['日期', '场景ID', '场景名字', '原二级场景ID', '原二级场景名字', '计划ID', '计划名字', '主体ID',
  ...Array.from({ length: 70 }, (_, i) => `指标${i}`)];
const HEAD_76 = HEAD_78.slice(0, 76);
const row78 = (date) => [date, '371', '关键词推广', '371', '关键词推广', '83930514705', '计划', '主体',
  ...Array(70).fill('0')];

test('78 列表头 + 一个空行（真实零数据样本）⇒ 放行，rows=0 且标记 empty', () => {
  const verdict = validatePromotionReport(HEAD_78, [[]], { date: '2026-10-20' });
  assert.equal(verdict.rows, 0);
  assert.equal(verdict.empty, true);
  assert.equal(verdict.blankRows, 1);
  assert.equal(verdict.columns, 78);
});

test('76 列表头的空报表同样放行（两个列族都可能出现零数据）', () => {
  const verdict = validatePromotionReport(HEAD_76, [[]], { date: '2026-10-20' });
  assert.equal(verdict.rows, 0);
  assert.equal(verdict.empty, true);
});

test('完全 0 行（连空行都没有）⇒ 正常返回 rows=0，不标 empty', () => {
  const verdict = validatePromotionReport(HEAD_78, [], { date: '2026-10-20' });
  assert.equal(verdict.rows, 0);
  assert.equal(verdict.empty, undefined, '没有空行就不是「空报表」形态，别混成同一个信号');
});

test('有真实数据 ⇒ 照常校验，empty 不出现', () => {
  const verdict = validatePromotionReport(HEAD_78, [row78('2026-10-20'), row78('2026-10-20')], { date: '2026-10-20' });
  assert.equal(verdict.rows, 2);
  assert.equal(verdict.empty, undefined);
});

test('空行后面又跟了数据行 ⇒ **必须抛错**（那是被追加了垃圾/截断后被补写）', () => {
  assert.throws(
    () => validatePromotionReport(HEAD_78, [[], row78('2026-10-20')], { date: '2026-10-20' }),
    /第2行列数与表头不一致/u,
  );
});

test('数据行中间夹空行 ⇒ 必须抛错', () => {
  assert.throws(
    () => validatePromotionReport(HEAD_78, [row78('2026-10-20'), [], row78('2026-10-20')], { date: '2026-10-20' }),
    /第3行列数与表头不一致/u,
  );
});

test('只缺一半列（真截断）⇒ 必须抛错，绝不能拿到「空」这个免死金牌', () => {
  const half = row78('2026-10-20').slice(0, 39);
  assert.throws(
    () => validatePromotionReport(HEAD_78, [half], { date: '2026-10-20' }),
    /第2行列数与表头不一致/u,
  );
});

test('空报表的日期校验不会误伤：没有行就没有「错日期的行」', () => {
  assert.doesNotThrow(() => validatePromotionReport(HEAD_78, [[]], { date: '2026-10-20' }));
});

test('表头本身有问题时仍先报表头，不被空行短路掉', () => {
  assert.throws(() => validatePromotionReport(['日期', '场景ID'], [[]]), /缺少日期\/场景ID\/计划ID表头/u);
  assert.throws(() => validatePromotionReport([...HEAD_78, '多一列'], [[]]), /不支持的商品报表列数/u);
});
