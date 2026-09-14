import assert from 'node:assert/strict';
import test from 'node:test';

import { STABLE_TABLE_KEYS } from './feishu-targets.mjs';
import {
  compareStructures,
  fieldSignature,
  recordCountFrom,
  render,
  shortDigest,
} from './verify-feishu-profile.mjs';

test('fieldSignature 与字段顺序无关', () => {
  const left = [
    { field_name: '商品标题', type: 1 },
    { field_name: '价格', type: 2 },
    { field_name: '商品图片', type: 17 },
  ];
  const right = [left[2], left[0], left[1]];
  assert.equal(fieldSignature(left).signature, fieldSignature(right).signature);
  assert.deepEqual(fieldSignature(left).fieldNames, ['商品标题', '价格', '商品图片']);
});

test('fieldSignature 捕捉字段增删', () => {
  const base = [{ field_name: '价格', type: 2 }];
  const added = [...base, { field_name: '月收货人数', type: 1 }];
  assert.notEqual(fieldSignature(base).signature, fieldSignature(added).signature);
  assert.equal(fieldSignature(added).fieldCount, 2);
});

test('fieldSignature 捕捉同名改类型（副本缩水的常见形态）', () => {
  const text = [{ field_name: '月收货人数', type: 1 }];
  const number = [{ field_name: '月收货人数', type: 2 }];
  assert.notEqual(fieldSignature(text).signature, fieldSignature(number).signature);
});

test('fieldSignature 对空输入与 undefined 都给得出摘要', () => {
  assert.equal(fieldSignature([]).fieldCount, 0);
  assert.equal(fieldSignature(undefined).fieldCount, 0);
  assert.equal(fieldSignature([]).signature, shortDigest(''));
});

test('recordCountFrom：真实的 0 行读成 0，不是「未知」', () => {
  assert.equal(recordCountFrom({ code: 0, data: { total: 0 } }), 0);
});

test('recordCountFrom：读不到 total 返回 null，绝不塌成 0', () => {
  assert.equal(recordCountFrom({}), null);
  assert.equal(recordCountFrom({ data: {} }), null);
  assert.equal(recordCountFrom(undefined), null);
});

test('recordCountFrom：正常行数原样返回', () => {
  assert.equal(recordCountFrom({ data: { total: 4346 } }), 4346);
});

function stableTable(overrides = {}) {
  return {
    tableId: 'tblX',
    tableName: '某表',
    fieldCount: 3,
    fieldNames: ['a', 'b', 'c'],
    signature: 'sig-1',
    recordCount: 10,
    errors: [],
    ok: true,
    ...overrides,
  };
}

function inspection(overrides = {}) {
  return {
    label: '租户 X',
    host: 'x.feishu.cn',
    envFile: 'E:/x/.env',
    baseToken: 'baseX',
    writeVerified: false,
    appId: 'cli_x',
    baseName: '示例 base',
    tableCount: STABLE_TABLE_KEYS.length,
    ok: true,
    errors: [],
    stableTables: Object.fromEntries(STABLE_TABLE_KEYS.map((key) => [key, stableTable({ tableId: `tbl-${key}` })])),
    weeklyTables: { 竞品: '竞品周_a_b', SKU: null, 问题库: null },
    weeklyTableCount: 1,
    faqMasterTable: 'tblFaq',
    shareMembers: { status: 200, count: 2 },
    ...overrides,
  };
}

test('compareStructures：不足两个 profile 时不做对比', () => {
  assert.deepEqual(compareStructures({ legacy: inspection() }), []);
  assert.deepEqual(compareStructures(undefined), []);
});

test('compareStructures：字段签名一致时给出空差异', () => {
  const diffs = compareStructures({ legacy: inspection(), kcne: inspection({ label: '租户 Y' }) });
  assert.deepEqual(diffs, []);
});

test('compareStructures：签名不同时逐表报差异与独有字段', () => {
  const legacy = inspection();
  const kcne = inspection({
    stableTables: {
      ...inspection().stableTables,
      skuDetail: stableTable({ signature: 'sig-2', fieldNames: ['a', 'b'], fieldCount: 2 }),
    },
  });
  const diffs = compareStructures({ legacy, kcne });
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].key, 'skuDetail');
  assert.equal(diffs[0].verdict, 'DIFFERENT');
  assert.deepEqual(diffs[0].onlyLeft, ['c']);
  assert.deepEqual(diffs[0].onlyRight, []);
});

test('compareStructures：一侧没查到该表时标 NOT_INSPECTED，而不是当作一致', () => {
  const legacy = inspection();
  const kcne = inspection();
  delete kcne.stableTables.history;
  const diffs = compareStructures({ legacy, kcne });
  assert.deepEqual(diffs, [{ key: 'history', verdict: 'NOT_INSPECTED' }]);
});

test('render：未知行数显示为 "-"，不冒充 0 行', () => {
  const report = {
    mode: 'READ_ONLY',
    note: 'n',
    activeProfile: null,
    defaultProfile: 'legacy',
    profiles: {
      legacy: inspection({
        stableTables: {
          ...inspection().stableTables,
          history: stableTable({ recordCount: null }),
        },
        shareMembers: { status: 403, error: '1063004 User has no share permission' },
      }),
    },
    structuralDiffs: [],
  };
  const text = render(report);
  assert.match(text, /记录 -/u);
  assert.doesNotMatch(text, /记录 0/u);
  assert.match(text, /拒绝 1063004/u);
  assert.match(text, /结构对比：跳过/u);
  assert.match(text, /mode=READ_ONLY/u);
});

test('render：两个 profile 无差异时明确说字段签名相同', () => {
  const report = {
    mode: 'READ_ONLY',
    note: 'n',
    activeProfile: 'kcne',
    defaultProfile: 'legacy',
    profiles: { legacy: inspection(), kcne: inspection() },
    structuralDiffs: [],
  };
  const text = render(report);
  assert.match(text, /4 张稳定表的字段签名逐一相同/u);
  assert.doesNotMatch(text, /跳过/u);
});
