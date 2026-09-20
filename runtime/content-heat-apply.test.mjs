import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONTENT_HEAT_FIELD,
  assertContentHeatMutation,
  buildContentHeatPlan,
  contentHeatDistribution,
  contentHeatPlannedDistribution,
  validateContentHeatContract,
  verifyContentHeatApply,
} from './content-heat-apply.mjs';
import { parseOptions } from './apply-content-heat.mjs';
import { readbackText } from './feishu-readback.mjs';

const FIELD_TEXT = { field_name: CONTENT_HEAT_FIELD, type: 1 };

function recordsOf(values) {
  return values.map((value, index) => ({
    record_id: `rec${String(index + 1).padStart(3, '0')}`,
    fields: { [CONTENT_HEAT_FIELD]: value, 搜索词: `词${index + 1}`, 排名: String(index + 1) },
  }));
}

function artifactOf(pairs) {
  return { status: 'CONTENT_HEAT_ANALYSIS_READY', tableId: 'tbl1', values: pairs.map(([index, value]) => ({ record_id: `rec${String(index).padStart(3, '0')}`, [CONTENT_HEAT_FIELD]: value })) };
}

test('content heat contract rejects the legacy AI预测- prefix instead of silently mixing generations', () => {
  // 老口径要求输出 AI预测-高，而写回层会剥掉它 ⇒ 落库值从来不带前缀（实测 7 张批次表）。
  // 带前缀的值混进来，同一列就会出现两代口径，而且肉眼几乎看不出来。
  assert.doesNotThrow(() => validateContentHeatContract([FIELD_TEXT], ['低', '中', '高', '待核验']));
  assert.throws(
    () => validateContentHeatContract([FIELD_TEXT], ['低', 'AI预测-高']),
    /AI预测-/,
  );
  assert.throws(() => validateContentHeatContract([FIELD_TEXT], ['很高']), /illegal values/);
});

test('content heat contract requires exactly one writable field of an accepted type', () => {
  assert.throws(() => validateContentHeatContract([], ['低']), /exactly one/);
  assert.throws(
    () => validateContentHeatContract([FIELD_TEXT, { field_name: CONTENT_HEAT_FIELD, type: 1 }], ['低']),
    /exactly one/,
  );
  // 公式字段（type=20）不可写 —— 必须被拒，否则真写时才发现就晚了。
  assert.throws(
    () => validateContentHeatContract([{ field_name: CONTENT_HEAT_FIELD, type: 20 }], ['低']),
    /expected type 1 \(text\) or 3/,
  );
  assert.doesNotThrow(() => validateContentHeatContract([{ field_name: CONTENT_HEAT_FIELD, type: 3, property: { options: [{ name: '低' }, { name: '中' }, { name: '高' }, { name: '待核验' }] } }], ['低']));
  assert.throws(
    () => validateContentHeatContract([{ field_name: CONTENT_HEAT_FIELD, type: 3, property: { options: [{ name: '低' }] } }], ['低', '待核验']),
    /missing option/,
  );
});

test('content heat mutation guard allows only one field on the confirmed table', () => {
  const scope = { appToken: 'app1', tableId: 'tbl1' };
  const path = '/bitable/v1/apps/app1/tables/tbl1/records/batch_update';
  assert.doesNotThrow(() => assertContentHeatMutation({ method: 'GET', path: '/anything' }, scope));
  assert.doesNotThrow(() => assertContentHeatMutation(
    { method: 'POST', path, body: { records: [{ record_id: 'rec1', fields: { 内容热度: '中' } }] } },
    scope,
  ));
  // 多带一个字段就拒 —— 白名单是精确匹配，不是"包含"。
  assert.throws(() => assertContentHeatMutation(
    { method: 'POST', path, body: { records: [{ record_id: 'rec1', fields: { 内容热度: '中', 优先级: 'A' } }] } },
    scope,
  ), /Blocked unauthorized/);
  // 换表、换 base、空批次、超过 500 条，全部拒。
  assert.throws(() => assertContentHeatMutation(
    { method: 'POST', path: '/bitable/v1/apps/app1/tables/tbl2/records/batch_update', body: { records: [{ record_id: 'rec1', fields: { 内容热度: '中' } }] } },
    scope,
  ), /Blocked unauthorized/);
  assert.throws(() => assertContentHeatMutation({ method: 'POST', path, body: { records: [] } }, scope), /Blocked unauthorized/);
  assert.throws(() => assertContentHeatMutation({ method: 'DELETE', path, body: { records: [{ record_id: 'rec1', fields: { 内容热度: '中' } }] } }, scope), /Blocked unauthorized/);
});

test('content heat plan is fail-closed on coverage gaps and on foreign record ids', () => {
  const records = recordsOf(['', '', '']);
  // 少判一行：默认必须抛错，否则会写出一个"看起来成功、实际一半是空"的列。
  assert.throws(() => buildContentHeatPlan(records, artifactOf([[1, '低'], [2, '中']])), /missing a judgement/);
  // 显式 allowPartial 才接受子集，并且调用方能在 coveredAllRecords 上看到这是子集。
  const partial = buildContentHeatPlan(records, artifactOf([[1, '低'], [2, '中']]), { allowPartial: true });
  assert.equal(partial.updates.length, 2);
  assert.equal(partial.coveredAllRecords, false);
  const full = buildContentHeatPlan(records, artifactOf([[1, '低'], [2, '中'], [3, '高']]));
  assert.equal(full.coveredAllRecords, true);
  // 表里没有的 record_id：拒（指向别的表或上一周的产物）。
  assert.throws(() => buildContentHeatPlan(records, artifactOf([[1, '低'], [2, '中'], [3, '高'], [9, '低']])), /absent from the table/);
  // 重复 record_id：拒（无法判断哪条为准）。
  const duplicated = { status: 'CONTENT_HEAT_ANALYSIS_READY', values: [
    { record_id: 'rec001', [CONTENT_HEAT_FIELD]: '低' },
    { record_id: 'rec001', [CONTENT_HEAT_FIELD]: '高' },
  ] };
  assert.throws(() => buildContentHeatPlan(records, duplicated), /duplicate record_id/);
});

test('content heat plan fills blanks only unless the field is explicitly replaceable', () => {
  const records = recordsOf(['低', '', '']);
  const artifact = artifactOf([[1, '高'], [2, '中'], [3, '中']]);
  const preserved = buildContentHeatPlan(records, artifact);
  assert.equal(preserved.updates.length, 2);
  assert.equal(preserved.preservedExisting, 1);
  assert.equal(preserved.updates[0].record_id, 'rec002');
  const replaced = buildContentHeatPlan(records, artifact, { replaceFields: [CONTENT_HEAT_FIELD] });
  assert.equal(replaced.updates.length, 3);
  assert.equal(replaced.preservedExisting, 0);
});

test('content heat readback verification proves what changed and what did not', () => {
  const before = recordsOf(['', '']);
  const updates = [{ record_id: 'rec001', fields: { [CONTENT_HEAT_FIELD]: '中' } }];
  const after = recordsOf(['中', '']);
  const result = verifyContentHeatApply({ before, after, updates });
  assert.equal(result.recordsVerified, 2);
  assert.equal(result.fieldsWritten, 1);
  assert.equal(result.unjudgedRecords, 1);

  // 该写的没写进去：必须抛，否则收据会给出一个假的成功。
  assert.throws(
    () => verifyContentHeatApply({ before, after: recordsOf(['', '']), updates }),
    /did not persist/,
  );
  // 碰了无关字段：必须抛。这是「不该动的没动」那一半。
  const tampered = recordsOf(['中', '']);
  tampered[1].fields.搜索词 = '被改了';
  assert.throws(
    () => verifyContentHeatApply({ before, after: tampered, updates }),
    /modified unrelated field/,
  );
  // 公式字段跟着变：允许（内容热度是 优先级/是否重点词/对应产品方向 的输入）。
  const derived = recordsOf(['中', '']);
  derived[0].fields.优先级 = 'B-持续观察';
  assert.doesNotThrow(() => verifyContentHeatApply({
    before, after: derived, updates, derivedFields: ['优先级'],
  }));
});

test('content heat distribution never degenerates to [object Object]', () => {
  const records = [
    { record_id: 'rec1', fields: { [CONTENT_HEAT_FIELD]: { type: 'text', value: [{ text: '中' }] } } },
    { record_id: 'rec2', fields: { [CONTENT_HEAT_FIELD]: '中' } },
    { record_id: 'rec3', fields: {} },
  ];
  const distribution = contentHeatDistribution(records, readbackText);
  assert.deepEqual(distribution, { 中: 2, '(空)': 1 });
});

test('content heat distributions count occurrences, not distinct values', () => {
  // 第一次 dry-run 时收据里的 planned 分布是 {"低":1,"中":1,"高":1}：
  // 调用方先去重再统计，数出来的是「有几种值」。30 条判定实际是 低4/中23/高3，
  // 但收据长得像每档各一条 —— 与 [object Object] 同一类错误：有数，但那个数在说假话。
  const artifact = { values: [
    ...Array.from({ length: 4 }, (_, i) => ({ record_id: `rec${i + 10}`, [CONTENT_HEAT_FIELD]: '低' })),
    ...Array.from({ length: 23 }, (_, i) => ({ record_id: `rec${i + 20}`, [CONTENT_HEAT_FIELD]: '中' })),
    ...Array.from({ length: 3 }, (_, i) => ({ record_id: `rec${i + 50}`, [CONTENT_HEAT_FIELD]: '高' })),
  ] };
  assert.deepEqual(contentHeatPlannedDistribution(artifact, readbackText), { 中: 23, 低: 4, 高: 3 });
  // 直方图总数必须等于输入条数 —— 这条把「按出现次数计」钉死。
  const total = Object.values(contentHeatPlannedDistribution(artifact, readbackText)).reduce((sum, n) => sum + n, 0);
  assert.equal(total, 30);
});

test('content heat writer reports planned distribution from the raw artifact, not the deduped domain', () => {
  // 只测函数不够：出问题的是调用方。如果哪天有人把它换回对 `generated`（去重集合）计数，
  // 函数测试依然全绿而收据又开始产假信息。
  const source = fs.readFileSync(fileURLToPath(new URL('./apply-content-heat.mjs', import.meta.url)), 'utf8');
  assert.ok(
    source.includes('contentHeatPlannedDistribution(artifact, readbackText)'),
    'planned 分布必须走 contentHeatPlannedDistribution(artifact, readbackText)',
  );
  assert.ok(
    !/planned:\s*Object\.fromEntries/u.test(source),
    '不得在调用点就地用去重后的集合统计 planned 分布',
  );
});

test('content heat writer refuses to run without exact write confirmations', () => {
  const base = ['--artifact', 'a.json', '--table-id', 'tbl1', '--table-name', 'Current'];
  const defaults = { envFile: 'secret.env', appToken: 'app1' };
  assert.equal(parseOptions(base, defaults).apply, false);
  assert.equal(parseOptions([...base, '--replace-content-heat'], defaults).replaceContentHeat, true);
  assert.throws(() => parseOptions([...base, '--apply'], defaults), /confirm-base/);
  assert.throws(
    () => parseOptions([...base, '--apply', '--confirm-base', 'app1'], defaults),
    /confirm-table/,
  );
  assert.equal(parseOptions(
    [...base, '--apply', '--confirm-base', 'app1', '--confirm-table', 'tbl1'], defaults,
  ).apply, true);
  // 解析不出凭据文件时必须停 —— 不许退回一个写死的默认路径。
  assert.throws(() => parseOptions(base, { appToken: 'app1' }), /No Feishu credential file resolved/);
});

test('content heat writer resolves tenant scope instead of hardcoding it', () => {
  // 4 个入口脚本曾把旧租户 `E:/小红书/.env.local` 写死，base 搬家后表现为 91403 Forbidden
  // （看着像"应用没被加为协作者"）。这条断言把「默认值必须来自访问器」钉在源码上。
  const source = fs.readFileSync(fileURLToPath(new URL('./apply-content-heat.mjs', import.meta.url)), 'utf8');
  assert.ok(source.includes('envFilePath(activeProfileName())'), 'env-file 默认值必须来自 envFilePath(activeProfileName())');
  assert.ok(source.includes('keywordBaseToken(activeProfileName())'), 'app-token 默认值必须来自 keywordBaseToken(activeProfileName())');
  assert.ok(!/['"`]E:\//u.test(source), '源码里不得出现写死的 E:/ 凭据路径');
});
