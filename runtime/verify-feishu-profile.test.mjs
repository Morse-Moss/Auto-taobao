import assert from 'node:assert/strict';
import test from 'node:test';

import { STABLE_TABLE_KEYS } from './feishu-targets.mjs';
import {
  compareKeywordBases,
  compareStructures,
  danglingTableRefs,
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

test('danglingTableRefs：表达式引用本 base 的表不算悬空', () => {
  const fields = [
    { field_name: '月收货金额', type: 20, property: { formula_expression: 'SUM(CurrentValue.[价格],tblSS5bxyIeXgngI)' } },
    { field_name: '竞品分类', type: 20, property: { formula_expression: 'IF(OR(tblOIPXlFVk91laj,tblSS5bxyIeXgngI),"A","D")' } },
    { field_name: '商品标题', type: 1 },
  ];
  assert.deepEqual(danglingTableRefs(fields, ['tblSS5bxyIeXgngI', 'tblOIPXlFVk91laj']), []);
});

test('danglingTableRefs：引用别处的表就报悬空（复制 base 后最常见的事故）', () => {
  const fields = [
    { field_name: '月收货金额', type: 20, property: { formula_expression: 'SUM(tblOldBaseTable1)' } },
    { field_name: '商品标题', type: 1 },
  ];
  const dangling = danglingTableRefs(fields, ['tblNewBaseTable1']);
  assert.equal(dangling.length, 1);
  assert.deepEqual(dangling[0], { field: '月收货金额', type: 20, ref: 'tblOldBaseTable1' });
});

test('danglingTableRefs：同一字段重复引用只报一次，且不误报 field_id', () => {
  const fields = [
    { field_id: 'fldAbcDefGhi', field_name: '同款数', type: 19, property: { table_id: 'tblGhost0001', link: ['tblGhost0001'], back: 'tblGhost0001' } },
  ];
  const dangling = danglingTableRefs(fields, ['tblReal00001']);
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].ref, 'tblGhost0001');
});

test('danglingTableRefs：没有 property 的字段不参与判定', () => {
  assert.deepEqual(danglingTableRefs([{ field_name: '文本', type: 1 }, { field_name: 'x', type: 20, property: null }], []), []);
  assert.deepEqual(danglingTableRefs(undefined, ['tblA']), []);
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

// 词库副本的检查结果形状（8 张表在真实 base 里，这里只要形状对即可）。
function keywordTables(overrides = {}) {
  return {
    baseToken: 'kwBase',
    baseName: '词库 最新 副本',
    tableCount: 2,
    danglingRefCount: 0,
    errors: [],
    tables: [
      { tableId: 'tblKw1', name: '关键词历史总表 V1', fieldCount: 27, fieldNames: ['a'], signature: 'kw-1', recordCount: 2067, errors: [], ok: true, danglingRefs: [] },
      { tableId: 'tblKw2', name: '关键词编号库 V1', fieldCount: 5, fieldNames: ['a'], signature: 'kw-2', recordCount: 475, errors: [], ok: true, danglingRefs: [] },
    ],
    ...overrides,
  };
}

test('compareKeywordBases：不足两个 profile 时不做对比', () => {
  assert.deepEqual(compareKeywordBases({ legacy: inspection() }), []);
  assert.deepEqual(compareKeywordBases(undefined), []);
});

test('compareKeywordBases：逐表签名相同（行数不同不算差异）', () => {
  const legacy = inspection({ keywordTables: keywordTables() });
  const kcne = inspection({
    keywordTables: keywordTables({
      tables: keywordTables().tables.map((table) => ({ ...table, recordCount: table.recordCount + 5 })),
    }),
  });
  assert.deepEqual(compareKeywordBases({ legacy, kcne }), []);
});

test('compareKeywordBases：一侧缺表就报 ONLY_ONE_SIDE，不当作一致', () => {
  const legacy = inspection({ keywordTables: keywordTables() });
  const kcne = inspection({ keywordTables: keywordTables({ tables: [keywordTables().tables[0]] }) });
  const diffs = compareKeywordBases({ legacy, kcne });
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].name, '关键词编号库 V1');
  assert.equal(diffs[0].verdict, 'ONLY_ONE_SIDE');
});

test('compareKeywordBases：签名不同时给出双方签名与独有字段', () => {
  const legacy = inspection({ keywordTables: keywordTables() });
  const shrunk = keywordTables().tables.map((table) => (table.name === '关键词编号库 V1'
    ? { ...table, signature: 'kw-2b', fieldNames: ['a', 'b'], fieldCount: 6 }
    : table));
  const kcne = inspection({ keywordTables: keywordTables({ tables: shrunk }) });
  const diffs = compareKeywordBases({ legacy, kcne });
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].verdict, 'DIFFERENT');
  assert.deepEqual(diffs[0].onlyRight, ['b']);
  assert.deepEqual(diffs[0].onlyLeft, []);
});

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
  // 只断言「竞品侧」没跳过：词库侧这次确实没数据，它会如实说跳过（见下一条用例）。
  assert.doesNotMatch(text, /结构对比：跳过/u);
});

test('render：没查词库时不冒称「词库两侧一致」', () => {
  const report = {
    mode: 'READ_ONLY',
    note: 'n',
    activeProfile: 'kcne',
    defaultProfile: 'legacy',
    profiles: { legacy: inspection(), kcne: inspection() },
    structuralDiffs: [],
    keywordDiffs: [],
  };
  const text = render(report);
  assert.match(text, /词库对比：跳过（至少一侧没查到词库的表）/u);
  assert.doesNotMatch(text, /词库对比：两侧副本逐表字段签名相同/u);
});

test('render：词库查到表且两侧一致时才说相同', () => {
  const report = {
    mode: 'READ_ONLY',
    note: 'n',
    activeProfile: 'kcne',
    defaultProfile: 'legacy',
    profiles: {
      legacy: inspection({ keywordTables: keywordTables() }),
      kcne: inspection({ keywordTables: keywordTables() }),
    },
    structuralDiffs: [],
    keywordDiffs: [],
  };
  const text = render(report);
  assert.match(text, /词库对比：两侧副本逐表字段签名相同（各 2 张表）/u);
  assert.match(text, /keyword base   kwBase   词库 最新 副本   2 张表/u);
  assert.match(text, /· 词库 关键词历史总表 V1/u);
  assert.match(text, /记录 2067/u);
});

test('render：词库悬空引用逐条列出来', () => {
  const withDangling = keywordTables({
    danglingRefCount: 1,
    tables: [{
      ...keywordTables().tables[0],
      danglingRefs: [{ field: '浏览量排名', type: 20, ref: 'tblGhost0001' }],
    }, keywordTables().tables[1]],
  });
  const report = {
    mode: 'READ_ONLY',
    note: 'n',
    activeProfile: null,
    defaultProfile: 'kcne',
    profiles: { legacy: inspection({ keywordTables: withDangling }) },
    structuralDiffs: [],
  };
  const text = render(report);
  assert.match(text, /词库悬空引用   1/u);
  assert.match(text, /悬空引用: 字段「浏览量排名」\(type=20\) → tblGhost0001/u);
});
