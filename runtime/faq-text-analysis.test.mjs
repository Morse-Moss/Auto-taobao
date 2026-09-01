import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAQ_ANALYSIS_VERSION,
  FAQ_ANALYSIS_FIELDS,
  classifyFaqText,
  buildAnalysisRecords,
  isExplicitDefaultReview,
} from './faq-text-analysis.mjs';

test('classifyFaqText returns independent topic judgments', () => {
  const result = classifyFaqText('不包安装，浴缸很重很难搬，但是外观很好看，质感不错');
  assert.deepEqual(result.labels, ['重量大/搬运困难', '不包安装/安装费贵', '好评-外观颜值', '好评-质感材质']);
  assert.deepEqual(result.painLabels, ['重量大/搬运困难', '不包安装/安装费贵']);
  assert.equal(result.judgmentByLabel['好评-质感材质'], '否');
  assert.equal(result.isPain, true);
});

test('negative positive signals do not create false pain labels', () => {
  const result = classifyFaqText('没有一点味道，排水顺畅，好清洁，尺寸刚刚好');
  assert.deepEqual(result.labels, ['异味问题', '尺寸不符/偏大偏小', '排水/漏水问题', '清洁困难', '好评-无异味', '好评-易清洁']);
  assert.equal(result.judgmentByLabel['异味问题'], '否');
  assert.equal(result.judgmentByLabel['排水/漏水问题'], '否');
  assert.equal(result.judgmentByLabel['尺寸不符/偏大偏小'], '否');
  assert.equal(result.isPain, false);
});

test('positive installation service does not create an installation pain label', () => {
  const result = classifyFaqText('外观材质：质感好，安装师傅很到位。');
  assert.deepEqual(result.labels, ['不包安装/安装费贵', '好评-外观颜值', '好评-质感材质']);
  assert.equal(result.judgmentByLabel['不包安装/安装费贵'], '否');
  assert.equal(result.painLabels.length, 0);
});

test('confirmed installation and weight policy requires actual negative impact', () => {
  const selfInstalled = classifyFaqText('自己找的安装师傅，安装貌似也不难。');
  assert.equal(selfInstalled.judgmentByLabel['不包安装/安装费贵'], '是');

  const weightOnly = classifyFaqText('浴缸很重，质量很好，安装后很漂亮。');
  assert.equal(weightOnly.judgmentByLabel['重量大/搬运困难'], '否');

  const difficultMove = classifyFaqText('浴缸很重，四位搬运师傅费了老大劲才搬进家里。');
  assert.equal(difficultMove.judgmentByLabel['重量大/搬运困难'], '是');
});

test('positive customer service in natural review wording is not ambiguous after-sales pain', () => {
  const result = classifyFaqText('收到了质量非常好客服也耐心热情 非常满意');
  assert.deepEqual(result.labels, ['品质瑕疵(划痕/裂纹/破损)', '售后差/不处理', '好评-客服服务']);
  assert.equal(result.judgmentByLabel['售后差/不处理'], '否');
  assert.equal(result.judgmentByLabel['好评-客服服务'], '否');
});

test('explicit positive issue mentions materialize as non-pain source-topic rows', () => {
  const result = classifyFaqText('从买之前的咨询，到安装过程的沟通，客服都很好！浴缸选购的哑光白色，高级感满满！手感温润，给水与排水都很流畅。送货，安装师傅也很专业。很满意的一次家装网购，值得推荐！');
  for (const label of ['不包安装/安装费贵', '排水/漏水问题', '物流/运输问题', '售后差/不处理']) {
    assert.equal(result.labels.includes(label), true);
    assert.equal(result.judgmentByLabel[label], '否');
    assert.equal(result.painLabels.includes(label), false);
  }
  const records = buildAnalysisRecords([{ recordId: 'positive', fields: { 来源记录唯一键: 'positive-1', 来源类型: '评论', 原始内容: '从买之前的咨询，到安装过程的沟通，客服都很好！浴缸选购的哑光白色，高级感满满！手感温润，给水与排水都很流畅。送货，安装师傅也很专业。很满意的一次家装网购，值得推荐！' } }]);
  assert.equal(records.filter((record) => ['不包安装/安装费贵', '排水/漏水问题', '物流/运输问题', '售后差/不处理'].includes(record.fields.分类标签)).every((record) => record.fields.是否痛点 === '否'), true);
});

test('explicit positive review language does not enter unrelated manual pain queues', () => {
  const result = classifyFaqText('价格公道，客服服务周到，木箱防护严实完好，安装说明详细，验货完全无损。');
  assert.equal(result.judgmentByLabel['价格/保价问题'], '否');
  assert.equal(result.judgmentByLabel['售后差/不处理'], '否');
  assert.equal(result.judgmentByLabel['物流/运输问题'], '否');
  assert.equal(result.judgmentByLabel['不包安装/安装费贵'], '否');
  assert.equal(result.judgmentByLabel['品质瑕疵(划痕/裂纹/破损)'], '否');
  assert.equal(result.isPain, false);
});

test('neutral product names and advice do not become price or moving pain', () => {
  const result = classifyFaqText('贵妃缸包装很结实，搬运可以底下铺个毯子往前拉，这样省力。');
  assert.equal(result.judgmentByLabel['价格/保价问题'], undefined);
  assert.equal(result.judgmentByLabel['重量大/搬运困难'], '否');
  assert.equal(result.judgmentByLabel['物流/运输问题'], '否');
  assert.equal(result.isPain, false);
});

test('ambiguous topic mention requires manual review', () => {
  const result = classifyFaqText('味道');
  assert.deepEqual(result.labels, ['异味问题']);
  assert.equal(result.judgmentByLabel['异味问题'], '需人工核验');
  assert.equal(result.confidenceByLabel['异味问题'], '低');
});

test('future state without actual experience is not a current pain', () => {
  const result = classifyFaqText('还没安装，安装后再反馈，暂时没用');
  assert.equal(result.judgmentByLabel['不包安装/安装费贵'], '否');
  assert.equal(result.judgmentByLabel['安装后再反馈'], undefined);
  assert.equal(result.judgmentByLabel['异味问题'], undefined);
  assert.equal(result.judgmentByLabel['好评-保温/舒适'], undefined);
});

test('future state with an actual pain stays for manual review', () => {
  const result = classifyFaqText('安装费贵，安装后再反馈');
  assert.equal(result.judgmentByLabel['不包安装/安装费贵'], '需人工核验');
  assert.equal(result.confidenceByLabel['不包安装/安装费贵'], '低');
});

test('泡澡 alone does not imply insufficient depth', () => {
  const result = classifyFaqText('泡澡很舒服');
  assert.equal(result.judgmentByLabel['深度不够/太浅'], undefined);
  assert.equal(result.labels.includes('好评-保温/舒适'), true);
});

test('default review detection is explicit and blank content is invalid', () => {
  assert.equal(isExplicitDefaultReview('该用户觉得商品非常好，给出好评'), true);
  assert.deepEqual(classifyFaqText('该用户觉得商品非常好，给出好评').labels, ['系统默认/无内容']);
  assert.equal(classifyFaqText('   ').isValid, false);
});

test('buildAnalysisRecords preserves raw fields and emits versioned labels', () => {
  const records = buildAnalysisRecords([
    { recordId: 'rec1', fields: { 商品ID: 'p1', 原始内容: '长度尺寸正合适', 来源类型: '评论', 来源记录唯一键: 'k1' } },
    { recordId: 'rec2', fields: { 商品ID: 'p2', 原始内容: '尺寸有差距，质量一般', 来源类型: '评论', 来源记录唯一键: 'k2' } },
  ]);
  assert.equal(records.length, 3);
  assert.equal(records[0].fields.原始内容, '长度尺寸正合适');
  assert.equal(records[0].fields.分类标签, '尺寸不符/偏大偏小');
  assert.equal(records[0].fields.是否痛点, '需人工核验');
  assert.equal(records[0].fields.痛点判定置信度, '低');
  assert.equal(records[0].fields.分析版本, FAQ_ANALYSIS_VERSION);
  assert.deepEqual(records.slice(1).map((record) => record.fields.分类标签), ['尺寸不符/偏大偏小', '品质瑕疵(划痕/裂纹/破损)']);
  assert.equal(records[1].fields.出现次数, undefined);
  assert.deepEqual(FAQ_ANALYSIS_FIELDS.map((field) => field.name), [
    '商品ID', '主表记录ID', '竞品周记录ID', '商品链接', '商品标题', '竞品分类',
    '来源类型', '原始内容', '分类标签', '是否痛点', '出现次数', '采集状态',
    '来源记录唯一键', '采集时间', '分析版本', '痛点判定依据', '痛点判定置信度',
  ]);
  assert.equal(FAQ_ANALYSIS_FIELDS.find((field) => field.name === '出现次数').type, 2);
});
