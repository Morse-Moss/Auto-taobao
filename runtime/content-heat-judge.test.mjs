import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRAND_WORDS,
  CONTENT_HEAT_FIELD,
  CONTENT_HEAT_PROMPT,
  PROMPT_DIGEST,
  assertPromptBinding,
  buildContentHeatArtifact,
  buildContentHeatCsv,
  contentHeatFeatures,
  contentHeatReason,
  judgeContentHeat,
  labelParts,
  promptDigest,
} from './content-heat-judge.mjs';

function recordOf(fields, recordId = 'rec001') {
  return { record_id: recordId, fields };
}

const TABLE = { tableId: 'tblTest', tableName: '关键词分析 V1（2026-09-19）', appToken: 'appTest' };

test('判定被钉在提示词原文上：指纹不对就不出产物', () => {
  // 判定规则是从这段文字逐句写出来的。文字一改，规则就可能不再成立 ——
  // 而「提示词改了、判定没跟着改」在结果上表现为「口径悄悄变了」，肉眼看不出来。
  const binding = assertPromptBinding();
  assert.equal(binding.ok, true, `提示词指纹变了：expected ${binding.expected} actual ${binding.actual}`);
  assert.equal(binding.actual, PROMPT_DIGEST);
  assert.equal(promptDigest(CONTENT_HEAT_PROMPT), PROMPT_DIGEST);

  const changed = assertPromptBinding(`${CONTENT_HEAT_PROMPT}新增一句规则。`);
  assert.equal(changed.ok, false);
  assert.notEqual(changed.actual, changed.expected);

  assert.throws(
    () => buildContentHeatArtifact({ ...TABLE, records: [recordOf({ 搜索词: '浴缸' })], prompt: '别的提示词' }),
    /re-pin the judge/,
  );
});

test('标签切片两种读回形态都要认：数组与已拼好的字符串', () => {
  // 只认一种就会在另一种上静默产出空标签，而「标签为空」在这个判定里直接等于「低」
  // —— 一个读回形态的差异会整批改掉结论。
  assert.deepEqual(labelParts([{ text: '场景/家用' }, { text: '场景/小户型' }]), ['场景/家用', '场景/小户型']);
  assert.deepEqual(labelParts('场景/家用、尺寸/小型'), ['场景/家用', '尺寸/小型']);
  assert.deepEqual(labelParts('场景/家用'), ['场景/家用']);
  assert.deepEqual(labelParts(''), []);
  assert.deepEqual(labelParts(null), []);
});

test('纯店铺导航与纯品牌落「低」，即使信号为高', () => {
  const navigation = contentHeatFeatures(recordOf({ 搜索词: '科勒浴缸官方旗舰店', 关键词分类: '品牌词', 搜索热度: '高', 交易热度: '高' }));
  assert.equal(judgeContentHeat(navigation), '低');
  assert.equal(contentHeatReason(navigation), '纯店铺导航');

  const brand = contentHeatFeatures(recordOf({ 搜索词: 'TOTO浴缸', 关键词分类: '品牌词', 细分标签: [{ text: '品牌/TOTO' }], 搜索热度: '高', 交易热度: '高' }));
  assert.equal(brand.brandOnly, true);
  assert.equal(judgeContentHeat(brand), '低');
  assert.equal(contentHeatReason(brand), '纯品牌');

  // 裸品牌名（不带「品牌/」前缀）也算品牌 —— 历史批次两种写法都出现过。
  // 这里把分类设成非品牌词，是为了单独验「标签这一层」的品牌识别：
  // 分类=品牌词的纯品牌判定由上面那条覆盖，两条判据不重叠。
  const bareBrand = contentHeatFeatures(recordOf({ 搜索词: '浪鲸浴缸', 关键词分类: '功能词', 细分标签: '浪鲸、功能/深泡', 搜索热度: '高', 交易热度: '中' }));
  assert.equal(bareBrand.nonBrandParts.length, 1); // 只剩「功能/深泡」
  assert.equal(bareBrand.brandParts.length, 1); // 裸品牌名被认出来了
  assert.equal(bareBrand.hasAttribute, true);
  assert.equal(judgeContentHeat(bareBrand), '高');
});

test('信号读不到时落「待核验」，不假装知道', () => {
  const blankSignal = contentHeatFeatures(recordOf({ 搜索词: '浴缸家用小户型', 关键词分类: '场景词', 细分标签: '场景/小户型', 搜索热度: '', 交易热度: '' }));
  assert.equal(blankSignal.signalUnknown, true);
  assert.equal(judgeContentHeat(blankSignal), '待核验');
  assert.equal(contentHeatReason(blankSignal), '信号未知');

  // 公式字段还没算出来时读到的是「待核验」这个值，与空值同义。
  const pending = contentHeatFeatures(recordOf({ 搜索词: '亚克力浴缸', 关键词分类: '材质词', 细分标签: '材质/亚克力', 搜索热度: '待核验', 交易热度: '低' }));
  assert.equal(judgeContentHeat(pending), '待核验');

  // 但导航词即使信号读不到仍是低 —— 这一条不依赖信号。
  const navBlank = contentHeatFeatures(recordOf({ 搜索词: '科勒旗舰店', 关键词分类: '品牌词', 搜索热度: '', 交易热度: '' }));
  assert.equal(judgeContentHeat(navBlank), '低');
});

test('有属性且信号为高落「高」，有属性但信号一般落「中」，无属性落「低」', () => {
  const high = contentHeatFeatures(recordOf({ 搜索词: '浴缸家用成人', 关键词分类: '场景词', 细分标签: '场景/家用、场景/成人', 搜索热度: '中', 交易热度: '高' }));
  assert.equal(judgeContentHeat(high), '高');

  const middle = contentHeatFeatures(recordOf({ 搜索词: '亚克力浴缸', 关键词分类: '材质词', 细分标签: '材质/亚克力', 搜索热度: '低', 交易热度: '低' }));
  assert.equal(judgeContentHeat(middle), '中');

  // 分类本身是属性类词 ⇒ 标签为空也算有属性（规则段的标签漏标不该连带把内容热度也压成低）。
  const attributeCategory = contentHeatFeatures(recordOf({ 搜索词: '深泡浴缸', 关键词分类: '功能词', 细分标签: '', 搜索热度: '高', 交易热度: '低' }));
  assert.equal(attributeCategory.hasAttribute, true);
  assert.equal(judgeContentHeat(attributeCategory), '高');

  const none = contentHeatFeatures(recordOf({ 搜索词: '浴缸', 关键词分类: '大词', 细分标签: '', 搜索热度: '低', 交易热度: '低' }));
  assert.equal(judgeContentHeat(none), '低');
  assert.equal(contentHeatReason(none), '无属性可依（信息不足/过度宽泛/信号双弱）');
});

test('品牌词表覆盖历史出现过的写法（大小写两种都在）', () => {
  // 只留一种大小写会让另一批词静默落到「有属性」，进而从低变高。
  for (const name of ['TOTO', 'toto', 'bette', 'BETTE', 'SSWW', 'ssww']) {
    assert.ok(BRAND_WORDS.includes(name), `品牌词表缺少 ${name}`);
  }
});

test('产物按「出现次数」统计分布，不是按「出现过几种值」', () => {
  // 2026-09-20 第一次 dry-run 的收据就把 30 条判定的分布写成了 {"低":1,"中":1,"高":1}
  // —— 因为先去重再统计。收据里有数、但那个数在说假话，比缺字段更坏。
  const records = [
    recordOf({ 搜索词: '浴缸', 关键词分类: '大词', 搜索热度: '低', 交易热度: '低' }, 'rec001'),
    recordOf({ 搜索词: '浴缸', 关键词分类: '大词', 搜索热度: '低', 交易热度: '低' }, 'rec002'),
    recordOf({ 搜索词: '亚克力浴缸', 关键词分类: '材质词', 搜索热度: '低', 交易热度: '低' }, 'rec003'),
  ];
  const artifact = buildContentHeatArtifact({ ...TABLE, records });
  assert.deepEqual(artifact.distribution, { 低: 2, 中: 1 });
  assert.equal(artifact.recordCount, 3);
  assert.equal(artifact.values.length, 3);
  assert.equal(artifact.status, 'CONTENT_HEAT_ANALYSIS_READY');
  assert.equal(artifact.promptDigest, PROMPT_DIGEST);
  assert.ok(artifact.values.every((item) => artifact.valueDomain.includes(item[CONTENT_HEAT_FIELD])));
});

test('产物 fail-closed：缺 record_id / 缺关键词 / 缺表身份都抛错', () => {
  assert.throws(() => buildContentHeatArtifact({ ...TABLE, records: [{ fields: { 搜索词: '浴缸' } }] }), /no record_id/);
  assert.throws(() => buildContentHeatArtifact({ ...TABLE, records: [recordOf({ 搜索热度: '高' })] }), /no keyword/);
  assert.throws(() => buildContentHeatArtifact({ tableId: '', tableName: '', appToken: '', records: [recordOf({ 搜索词: '浴缸' })] }), /table identity/);
  assert.throws(() => buildContentHeatArtifact({ ...TABLE, records: [] }), /requires records/);
});

test('CSV 带出判定原因，且对逗号/引号做转义', () => {
  const csv = buildContentHeatCsv([
    { record_id: 'rec001', 搜索词: '浴缸,大号', [CONTENT_HEAT_FIELD]: '低', reason: '纯品牌' },
    { record_id: 'rec002', 搜索词: '带"引号"的词', [CONTENT_HEAT_FIELD]: '高', reason: '有属性且信号为高' },
  ]);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], '关键词编号,搜索词,内容热度,判定原因');
  assert.equal(lines[1], 'rec001,"浴缸,大号",低,纯品牌');
  assert.equal(lines[2], 'rec002,"带""引号""的词",高,有属性且信号为高');
});
