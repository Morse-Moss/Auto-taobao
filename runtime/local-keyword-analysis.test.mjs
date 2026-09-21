import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TARGET_FIELDS,
  analyzeKeyword,
  assertLocalAnalysisMutation,
  buildLocalAnalysisPlan,
  partitionPlanByFieldTypes,
  verifyLocalAnalysisApply,
} from './local-keyword-analysis.mjs';

test('local analysis follows the approved merge, category, label, and intent contract', () => {
  assert.deepEqual(analyzeKeyword('浴缸家用小户型'), {
    标准归并词: '小浴缸',
    关键词分类: '场景词',
    细分标签: ['场景/家用', '场景/小户型'],
    用户意图: '购买型',
  });
  assert.deepEqual(analyzeKeyword('科勒铸铁浴缸官方旗舰店'), {
    标准归并词: '浴缸',
    关键词分类: '材质词',
    细分标签: ['品牌/科勒', '材质/铸铁', '渠道/官方旗舰店'],
    用户意图: '购买型',
  });
  assert.deepEqual(analyzeKeyword('浴缸漏水怎么修'), {
    标准归并词: '浴缸',
    关键词分类: '痛点词',
    细分标签: ['痛点/漏水', '痛点/维修'],
    用户意图: '问题解决型',
  });
});

test('local analysis uses only explicit controlled labels and permits no label', () => {
  assert.deepEqual(analyzeKeyword('步入式浴缸').细分标签, ['款式/步入式']);
  assert.deepEqual(analyzeKeyword('小户型浴缸').细分标签, ['场景/小户型']);
  assert.deepEqual(analyzeKeyword('老人浴缸').细分标签, ['场景/老人']);
  assert.deepEqual(analyzeKeyword('普通浴缸').细分标签, []);
  assert.deepEqual(analyzeKeyword('1.5米亚克力浴缸').细分标签, ['材质/亚克力', '尺寸/1.5米']);
  assert.deepEqual(analyzeKeyword('60cm宽浴缸').细分标签, ['尺寸/60厘米宽']);
});

test('local labels preserve the previous batch controlled brand vocabulary', () => {
  assert.deepEqual(analyzeKeyword('toto浴缸').细分标签, ['品牌/TOTO']);
  assert.deepEqual(analyzeKeyword('浴缸科勒').细分标签, ['品牌/科勒']);
  assert.deepEqual(analyzeKeyword('arrow浴缸').细分标签, ['品牌/箭牌']);
  assert.deepEqual(analyzeKeyword('观博浴缸').细分标签, ['品牌/观博卫浴']);
  assert.deepEqual(analyzeKeyword('云涛浴缸').细分标签, []);
});

// 2026-09-21：两处「正则覆盖缺口」+ 两处「受控品牌表扩充」。
// 起因是 09-19 期那 14 个细分标签为空的词，查到底发现其中 4 个不是「本来无属性」。
test('local labels cover the 2026-09-21 vocabulary additions', () => {
  // 场景/老人 此前只认「老人|老年」，漏了「适老」这种常见写法。
  assert.deepEqual(analyzeKeyword('适老化浴缸').细分标签, ['场景/老人']);
  assert.equal(analyzeKeyword('适老化浴缸').关键词分类, '场景词');
  // 功能/新款 此前只认「新款|新型」，漏了「新式」。
  assert.deepEqual(analyzeKeyword('新式浴缸').细分标签, ['功能/新款']);
  assert.equal(analyzeKeyword('新式浴缸').关键词分类, '功能词');
  // 受控品牌表补 Bette / tw：此前它们只在 BRANDS 与 BRAND_WORDS 里。
  // 注意「品牌/Bette」的大小写与表上选项逐字一致 —— 这不是风格问题：
  // 写成小写会被 MultiSelect 的选项校验判成不存在的选项、直接 fail-closed。
  assert.deepEqual(analyzeKeyword('bette').细分标签, ['品牌/Bette']);
  assert.equal(analyzeKeyword('bette').关键词分类, '品牌词');
  assert.deepEqual(analyzeKeyword('tw浴缸').细分标签, ['品牌/tw']);
  assert.equal(analyzeKeyword('tw浴缸').关键词分类, '品牌词');
  // 受控边界没有被顺手放宽：只在 BRANDS 里、不进标签表的名字，标签依然为空。
  assert.deepEqual(analyzeKeyword('朵纳浴缸').细分标签, []);
  assert.equal(analyzeKeyword('朵纳浴缸').关键词分类, '品牌词');
  // 「无属性」这条路也必须仍然能走通（否则这条修复就把「留空」变成了「必须打标」）。
  assert.deepEqual(analyzeKeyword('浴缸').细分标签, []);
  assert.deepEqual(analyzeKeyword('高级浴缸').细分标签, []);
});

test('local analysis normalizes only approved strict equivalents', () => {
  assert.equal(analyzeKeyword('toto浴缸').标准归并词, '浴缸');
  assert.equal(analyzeKeyword('浴缸亚克力').标准归并词, '亚克力浴缸');
  assert.equal(analyzeKeyword('内嵌式浴缸').标准归并词, '浴缸');
  assert.equal(analyzeKeyword('浪鲸').标准归并词, '浴缸');
  assert.equal(analyzeKeyword('小浴缸').标准归并词, '小浴缸');
});

test('standard merge follows the current Feishu seven-bucket priority exactly', () => {
  assert.equal(analyzeKeyword('小户型人造石浴缸').标准归并词, '小浴缸');
  assert.equal(analyzeKeyword('PMMA家用浴缸').标准归并词, '人造石浴缸');
  assert.equal(analyzeKeyword('亚克力家用浴缸').标准归并词, '亚克力浴缸');
  assert.equal(analyzeKeyword('家用定制浴缸').标准归并词, '家用浴缸');
  assert.equal(analyzeKeyword('方形定制浴缸').标准归并词, '方形浴缸');
  assert.equal(analyzeKeyword('定做浴缸').标准归并词, '定制浴缸');
  assert.equal(analyzeKeyword('小米浴缸').标准归并词, '浴缸');
});

test('local classification recognizes explicit attributes beyond the controlled label dictionary', () => {
  assert.equal(analyzeKeyword('智能浴缸').关键词分类, '功能词');
  assert.equal(analyzeKeyword('定制浴缸').关键词分类, '功能词');
  assert.equal(analyzeKeyword('方形浴缸').关键词分类, '款式词');
  assert.equal(analyzeKeyword('法式浴缸').关键词分类, '风格词');
  assert.equal(analyzeKeyword('不锈钢浴缸').关键词分类, '材质词');
  assert.equal(analyzeKeyword('浴缸尺寸').关键词分类, '尺寸词');
  assert.equal(analyzeKeyword('惠达浴缸').关键词分类, '品牌词');
});

test('local labels normalize explicit equivalent forms without adding inferred attributes', () => {
  assert.deepEqual(analyzeKeyword('坐浴浴缸').细分标签, ['款式/坐式']);
  assert.deepEqual(analyzeKeyword('嵌入型浴缸').细分标签, ['款式/嵌入式']);
  assert.deepEqual(analyzeKeyword('浴缸靠墙安装').细分标签, ['款式/靠墙式']);
  assert.deepEqual(analyzeKeyword('mini浴缸').细分标签, ['尺寸/迷你']);
  assert.deepEqual(analyzeKeyword('椭圆形浴缸').细分标签, ['款式/椭圆形']);
  assert.deepEqual(analyzeKeyword('椭圆浴缸').细分标签, ['款式/椭圆形']);
  assert.deepEqual(analyzeKeyword('一米浴缸').细分标签, ['尺寸/1米']);
});

test('local labels follow the current Feishu exact mappings and vocabulary', () => {
  assert.deepEqual(analyzeKeyword('酒店民宿浴缸').细分标签, ['场景/酒店', '场景/民宿']);
  assert.deepEqual(analyzeKeyword('开门浴缸').细分标签, ['款式/开门式']);
  assert.deepEqual(analyzeKeyword('帆布浴缸').细分标签, ['材质/帆布']);
  assert.deepEqual(analyzeKeyword('bathtope布浴缸').细分标签, ['品牌/Bathtope', '材质/布艺']);
  assert.deepEqual(analyzeKeyword('浴缸').细分标签, []);
  assert.deepEqual(analyzeKeyword('浴池').细分标签, ['核心/浴池']);
});

test('local labels do not create substring-derived duplicate attributes', () => {
  assert.deepEqual(analyzeKeyword('深泡浴缸').细分标签, ['功能/深泡']);
  assert.deepEqual(analyzeKeyword('1米5浴缸').细分标签, ['尺寸/1.5米']);
  assert.deepEqual(analyzeKeyword('超小浴缸').细分标签, ['尺寸/超小']);
  assert.deepEqual(analyzeKeyword('三角浴缸').细分标签, ['款式/三角形']);
  assert.deepEqual(analyzeKeyword('浴缸1米3').细分标签, ['尺寸/1.3米']);
});

test('local labels cover explicit extended attributes already supported by the table', () => {
  assert.deepEqual(analyzeKeyword('智能定制浴缸').细分标签, ['功能/智能', '功能/定制']);
  assert.deepEqual(analyzeKeyword('方形浴缸').细分标签, ['款式/方形']);
  assert.deepEqual(analyzeKeyword('正方形浴缸').细分标签, ['款式/正方形']);
  assert.deepEqual(analyzeKeyword('不锈钢浴缸').细分标签, ['材质/不锈钢']);
  assert.deepEqual(analyzeKeyword('法式浴缸').细分标签, ['风格/法式']);
  assert.deepEqual(analyzeKeyword('美容院可移动浴缸').细分标签, ['场景/美容院', '功能/可移动']);
  assert.deepEqual(analyzeKeyword('透明浴缸').细分标签, ['外观/透明']);
});

test('local labels retain explicit table-supported demand, channel, region, and appearance signals', () => {
  assert.deepEqual(analyzeKeyword('浴缸尺寸').细分标签, ['需求/尺寸咨询']);
  assert.deepEqual(analyzeKeyword('十大名牌浴缸').细分标签, ['需求/品牌榜单']);
  assert.deepEqual(analyzeKeyword('科勒浴缸官方旗舰店').细分标签, ['品牌/科勒', '渠道/官方旗舰店']);
  assert.deepEqual(analyzeKeyword('日本透明彩色浴缸').细分标签, ['地域/日本', '颜色/彩色', '外观/透明']);
  assert.deepEqual(analyzeKeyword('全瓷浴缸').细分标签, ['材质/陶瓷']);
});

test('local intent uses Taobao product-search context without overriding explicit intent signals', () => {
  assert.equal(analyzeKeyword('浴缸').用户意图, '了解型');
  assert.equal(analyzeKeyword('浴缸家用小户型').用户意图, '购买型');
  assert.equal(analyzeKeyword('TOTO浴缸').用户意图, '购买型');
  assert.equal(analyzeKeyword('亚克力浴缸').用户意图, '购买型');
  assert.equal(analyzeKeyword('浴缸尺寸').用户意图, '了解型');
  assert.equal(analyzeKeyword('十大名牌浴缸').用户意图, '对比型');
  assert.equal(analyzeKeyword('浴缸效果图').用户意图, '灵感型');
  assert.equal(analyzeKeyword('浴缸漏水怎么修').用户意图, '问题解决型');
});

test('local intent follows the current Feishu priority and explicit examples', () => {
  assert.equal(analyzeKeyword('浴缸怎么选').用户意图, '了解型');
  assert.equal(analyzeKeyword('免安装浴缸').用户意图, '问题解决型');
  assert.equal(analyzeKeyword('小空间能放浴缸吗').用户意图, '问题解决型');
  assert.equal(analyzeKeyword('独立式和嵌入式哪个好').用户意图, '对比型');
  assert.equal(analyzeKeyword('法式浴缸').用户意图, '灵感型');
  assert.equal(analyzeKeyword('小户型浴缸').用户意图, '购买型');
});

test('local intent uses the attributes extracted by the current Feishu prompt', () => {
  assert.equal(analyzeKeyword('圆形浴缸').用户意图, '购买型');
  assert.equal(analyzeKeyword('铸铁浴缸').用户意图, '购买型');
  assert.equal(analyzeKeyword('双人浴缸').用户意图, '购买型');
  assert.equal(analyzeKeyword('泡澡浴缸').用户意图, '购买型');
  assert.equal(analyzeKeyword('家用浴缸').用户意图, '灵感型');
  assert.equal(analyzeKeyword('酒店浴缸').用户意图, '灵感型');
  assert.equal(analyzeKeyword('浴缸国家补贴').用户意图, '购买型');
  assert.equal(analyzeKeyword('浴缸小尺寸').用户意图, '购买型');
  assert.equal(analyzeKeyword('浴缸定制定做尺寸').用户意图, '购买型');
  assert.equal(analyzeKeyword('浴缸十大品牌').用户意图, '对比型');
  assert.equal(analyzeKeyword('tw浴缸').用户意图, '购买型');
  assert.equal(analyzeKeyword('窄浴缸').用户意图, '购买型');
  assert.equal(analyzeKeyword('中古风浴缸').用户意图, '灵感型');
});

test('classification recognizes explicit current-table signals even without a controlled label', () => {
  assert.equal(analyzeKeyword('窄浴缸').关键词分类, '尺寸词');
  assert.equal(analyzeKeyword('浴缸1米3').关键词分类, '尺寸词');
  assert.equal(analyzeKeyword('中古风浴缸').关键词分类, '风格词');
  assert.equal(analyzeKeyword('乐家浴缸').关键词分类, '品牌词');
});

test('plan fills only blank target fields and reports existing values as preserved', () => {
  const records = [
    { record_id: 'rec1', fields: { 原始关键词: '小户型浴缸' } },
    { record_id: 'rec2', fields: {
      原始关键词: '浴缸', 标准归并词: '人工归并', 关键词分类: '大词',
      细分标签: ['场景/家用'], 用户意图: '了解型',
    } },
  ];
  const plan = buildLocalAnalysisPlan(records);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].record_id, 'rec1');
  assert.deepEqual(Object.keys(plan.updates[0].fields).sort(), [...TARGET_FIELDS].sort());
  assert.deepEqual(plan.preservedExisting, { 标准归并词: 1, 关键词分类: 1, 细分标签: 1, 用户意图: 1 });
});

test('plan can replace only an explicitly named field while preserving other existing values', () => {
  const records = [{ record_id: 'rec1', fields: {
    原始关键词: '亚克力浴缸', 标准归并词: '人工归并', 关键词分类: '材质词',
    细分标签: ['材质/亚克力'], 用户意图: '了解型',
  } }];
  const plan = buildLocalAnalysisPlan(records, { replaceFields: ['用户意图'] });
  assert.deepEqual(plan.updates, [{ record_id: 'rec1', fields: { 用户意图: '购买型' } }]);
  assert.deepEqual(plan.preservedExisting, { 标准归并词: 1, 关键词分类: 1, 细分标签: 1, 用户意图: 0 });
});

test('plan partitions AI field type 25 away from API-writable values', () => {
  const plan = { updates: [{ record_id: 'rec1', fields: {
    标准归并词: '浴缸', 关键词分类: '大词', 细分标签: [], 用户意图: '了解型',
  } }] };
  const result = partitionPlanByFieldTypes(plan, [
    { field_name: '标准归并词', type: 25 },
    { field_name: '关键词分类', type: 3 },
    { field_name: '细分标签', type: 4 },
    { field_name: '用户意图', type: 3 },
  ]);
  assert.deepEqual(result.apiUpdates, [{ record_id: 'rec1', fields: {
    关键词分类: '大词', 细分标签: [], 用户意图: '了解型',
  } }]);
  assert.deepEqual(result.frontendUpdates, [{ record_id: 'rec1', fields: { 标准归并词: '浴缸' } }]);
});

test('mutation guard allows only target-field updates on the confirmed table', () => {
  const scope = { appToken: 'app1', tableId: 'tbl1' };
  assert.doesNotThrow(() => assertLocalAnalysisMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app1/tables/tbl1/records/batch_update',
    body: { records: [{ record_id: 'rec1', fields: { 关键词分类: '大词' } }] },
  }, scope));
  assert.throws(() => assertLocalAnalysisMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app1/tables/tbl1/records/batch_update',
    body: { records: [{ record_id: 'rec1', fields: { 排名: 1 } }] },
  }, scope), /Blocked unauthorized/);
  assert.throws(() => assertLocalAnalysisMutation({
    method: 'POST',
    path: '/bitable/v1/apps/app1/tables/other/records/batch_update',
    body: { records: [{ record_id: 'rec1', fields: { 关键词分类: '大词' } }] },
  }, scope), /Blocked unauthorized/);
});

test('verification rejects unrelated changes and verifies planned blank fills', () => {
  const before = [{ record_id: 'rec1', fields: { 原始关键词: '浴缸', 排名: 1 } }];
  const updates = [{ record_id: 'rec1', fields: {
    标准归并词: '浴缸', 关键词分类: '大词', 细分标签: [], 用户意图: '了解型',
  } }];
  const after = [{ record_id: 'rec1', fields: {
    原始关键词: '浴缸', 排名: 1, 标准归并词: '浴缸', 关键词分类: '大词', 用户意图: '了解型',
  } }];
  assert.deepEqual(verifyLocalAnalysisApply({ before, after, updates }), { recordsVerified: 1, fieldsWritten: 4 });
  assert.throws(() => verifyLocalAnalysisApply({
    before,
    after: [{ ...after[0], fields: { ...after[0].fields, 排名: 2 } }],
    updates,
  }), /unrelated field/);
});
