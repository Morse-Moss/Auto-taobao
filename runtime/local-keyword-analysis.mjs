const TARGET_FIELD_SET = new Set(['标准归并词', '关键词分类', '细分标签', '用户意图']);
export const TARGET_FIELDS = [...TARGET_FIELD_SET];

const LABEL_RULES = [
  ['场景/家用', /家用|家庭用|家庭/u],
  ['场景/家装', /家装/u],
  ['场景/小户型', /小户型|小空间/u],
  ['场景/公寓', /公寓/u],
  ['场景/酒店', /酒店/u],
  ['场景/民宿', /民宿/u],
  ['场景/高端改善', /高端改善/u],
  ['场景/儿童', /儿童|小孩|宝宝/u],
  ['场景/老人', /老人|老年|适老/u],
  ['场景/无障碍', /无障碍/u],
  ['场景/情侣', /情侣/u],
  ['场景/主卫', /主卫/u],
  ['场景/次卫', /次卫/u],
  ['场景/庭院', /庭院/u],
  ['场景/阳台', /阳台/u],
  ['场景/户外', /户外|室外/u],
  ['场景/商用', /商用/u],
  ['场景/美容院', /美容院/u],
  ['场景/卫生间', /卫生间/u],
  ['场景/浴室', /浴室/u],
  ['场景/成人', /成人/u],
  ['需求/尺寸咨询', /浴缸尺寸|尺寸咨询/u],
  ['需求/品牌榜单', /十大名牌|十大品牌|热销榜|品牌榜/u],
  ['渠道/官方旗舰店', /官方旗舰店/u],
  ['渠道/旗舰店', /(?<!官方)旗舰店/u],
  ['渠道/正品', /正品/u],
  ['地域/日本', /日本/u],
  ['地域/广东佛山', /广东佛山/u],
  ['外观/透明', /透明/u],
  ['颜色/彩色', /彩色/u],
  ['颜色/粉色', /粉色/u],
  ['痛点/空间受限', /空间受限|空间不足|放不下/u],
  ['痛点/舒适', /不舒服|舒适问题/u],
  ['痛点/清洁', /清洁|清洗|除垢|水垢|发霉/u],
  ['痛点/安全', /安全问题|不安全/u],
  ['痛点/保温', /不保温|保温差/u],
  ['痛点/漏水', /漏水|渗水/u],
  ['痛点/排水', /堵塞|下水慢|排水问题|异味/u],
  ['痛点/维修', /维修|修理|怎么修|坏了|故障|裂缝|开裂/u],
  ['款式/独立式', /独立式|独立浴缸/u],
  ['款式/嵌入式', /嵌入式|嵌入型|嵌入浴缸|内嵌式|内嵌浴缸|浴缸内嵌/u],
  ['款式/搁置式', /搁置式/u],
  ['款式/台上式', /台上式/u],
  ['款式/爪脚式', /爪脚式/u],
  ['款式/无脚式', /无脚式/u],
  ['款式/靠墙式', /靠墙式|靠墙浴缸|靠墙安装/u],
  ['款式/角落式', /角落式/u],
  ['款式/转角式', /转角式|转角浴缸/u],
  ['款式/步入式', /步入式/u],
  ['款式/开门式', /(?<!侧)开门(?:式)?|带门浴缸|门式浴缸/u],
  ['款式/坐式', /坐式|坐泡|坐浴/u],
  ['款式/长方形', /长方形|长方浴缸/u],
  ['款式/椭圆形', /椭圆形|椭圆浴缸/u],
  ['款式/圆形', /(?<!椭)圆形|(?<!椭)圆浴缸/u],
  ['款式/扇形', /扇形/u],
  ['款式/三角形', /三角形|三角浴缸/u],
  ['款式/蛋形', /蛋形/u],
  ['款式/鹅蛋形', /鹅蛋形/u],
  ['款式/方形', /(?<!长)(?<!正)方形/u],
  ['款式/正方形', /正方形/u],
  ['款式/一体式', /一体式|一体浴缸/u],
  ['款式/切角式', /切角/u],
  ['款式/弧形', /弧形/u],
  ['款式/异形', /异形/u],
  ['款式/悬浮式', /悬浮/u],
  ['款式/悬挂式', /悬挂/u],
  ['款式/吊床式', /吊床/u],
  ['款式/侧开门式', /侧开门/u],
  ['款式/成品', /成品/u],
  ['款式/贵妃式', /贵妃|贵妇/u],
  ['款式/自砌式', /自砌/u],
  ['材质/亚克力', /亚克力/u],
  ['材质/铸铁', /铸铁/u],
  ['材质/钢板搪瓷', /钢板搪瓷|搪瓷钢板/u],
  ['材质/人造石', /人造石|绮美石/u],
  ['材质/PMMA', /pmma/iu],
  ['材质/石英石', /石英石/u],
  ['材质/实木', /实木/u],
  ['材质/柏木', /柏木/u],
  ['材质/陶瓷', /陶瓷|全瓷/u],
  ['材质/铜', /铜浴缸|铜制浴缸/u],
  ['材质/不锈钢', /不锈钢/u],
  ['材质/搪瓷', /(?<!钢板)搪瓷/u],
  ['材质/大理石', /大理石/u],
  ['材质/玻璃', /玻璃/u],
  ['材质/树脂', /树脂/u],
  ['材质/洞石', /洞石/u],
  ['材质/帆布', /帆布/u],
  ['材质/布艺', /布艺|(?<!帆)布浴缸|布袋浴缸/u],
  ['尺寸/迷你', /迷你|mini/iu],
  ['尺寸/小型', /小型|(?<!超)(?<!特)(?<!极)小浴缸|小尺寸|浴缸小$/u],
  ['尺寸/标准型', /标准型/u],
  ['尺寸/大型', /大型|大浴缸/u],
  ['尺寸/加长型', /加长型|加长浴缸/u],
  ['尺寸/单人', /单人/u],
  ['尺寸/双人', /双人/u],
  ['尺寸/多人', /多人/u],
  ['尺寸/1米', /一米/u],
  ['尺寸/超小', /超小|特小|极小/u],
  ['尺寸/超大', /超大/u],
  ['功能/空气按摩', /空气按摩/u],
  ['功能/按摩', /按摩/u],
  ['功能/水疗', /水疗/u],
  ['功能/冲浪', /冲浪/u],
  ['功能/深泡', /深泡/u],
  ['功能/恒温', /恒温/u],
  ['功能/加热', /加热/u],
  ['功能/保温', /(?<!不)保温/u],
  ['功能/带座椅', /带座椅|座椅浴缸/u],
  ['功能/音响', /音响/u],
  ['功能/LED灯', /led灯|led光/iu],
  ['功能/触控', /触控|触摸控制/u],
  ['功能/静音', /静音/u],
  ['功能/防滑', /防滑/u],
  ['功能/淋浴组合', /浴缸淋浴组合|淋浴浴缸组合|浴缸淋浴二合一/u],
  ['功能/智能', /智能/u],
  ['功能/定制', /定制|定做/u],
  ['功能/泡澡', /泡澡|(?<!深)泡浴/u],
  ['功能/新款', /新款|新型|新式/u],
  ['功能/可移动', /可移动|移动式|移动浴缸/u],
  ['功能/免安装', /免安装/u],
  ['功能/助浴', /助浴/u],
  ['功能/洗浴', /洗浴|洗澡/u],
  ['功能/一体成型', /一体成型/u],
  ['风格/现代简约', /现代简约/u],
  ['风格/北欧', /北欧/u],
  ['风格/日式', /日式/u],
  ['风格/复古', /复古/u],
  ['风格/古典', /古典/u],
  ['风格/维多利亚式', /维多利亚式/u],
  ['风格/猫脚式', /猫脚式|猫脚浴缸/u],
  ['风格/设计款', /设计款/u],
  ['风格/法式', /法式/u],
  ['风格/欧式', /欧式/u],
  ['风格/老式', /老式/u],
  ['风格/网红', /网红/u],
  ['风格/高级感', /高级感/u],
];

const BRAND_LABEL_RULES = [
  ['品牌/TOTO', /toto/iu],
  ['品牌/科勒', /科勒|kohler/iu],
  ['品牌/九牧', /九牧|jomoo/iu],
  ['品牌/箭牌', /箭牌|arrow/iu],
  ['品牌/浪鲸', /浪鲸|ssww/iu],
  ['品牌/果敢', /果敢/u],
  ['品牌/杜拉维特', /杜拉维特|duravit/iu],
  ['品牌/卡德维', /卡德维|kaldewei/iu],
  ['品牌/特拉维尔', /特拉维尔/u],
  ['品牌/小米', /小米/u],
  ['品牌/东鹏', /东鹏/u],
  ['品牌/恒洁', /恒洁/u],
  ['品牌/法恩莎', /法恩莎/u],
  ['品牌/Bathtope', /bathtope/iu],
  ['品牌/日丰', /日丰/u],
  ['品牌/唯宝', /唯宝/u],
  ['品牌/埃飞灵', /埃飞灵/u],
  ['品牌/米希尔', /米希尔/u],
  ['品牌/劳芬', /劳芬/u],
  ['品牌/碧澜', /碧澜/u],
  ['品牌/汉斯格雅', /汉斯格雅|hansgrohe/iu],
  ['品牌/范尔德', /范尔德/u],
  ['品牌/骊住', /骊住/u],
  ['品牌/观博卫浴', /观博/u],
  ['品牌/美标', /美标/u],
  ['品牌/惠达', /惠达|慧达/u],
  ['品牌/乐溢', /乐溢/u],
  ['品牌/安华', /安华/u],
  ['品牌/恩仕', /恩仕/u],
  // 2026-09-21 补 bette 与 tw。
  // 事实：这两个名字在 BRANDS（分类用）与 content-heat-judge.mjs 的 BRAND_WORDS
  // （内容热度判「纯品牌」用）里都已被认定为品牌，唯独标签表没有
  // ⇒ 同一个词在「关键词分类」与「细分标签」两个字段上给出不一致的结论
  //   （tw浴缸 分类=品牌词、标签却是空）。
  //
  // 但要写清楚性质：这**不是修 bug，是受控词汇的扩充**。标签表刻意比分类表窄 ——
  // 分类表里还有 朵纳/云涛/摩恩/欧凯伦/乐家/vnlfrio 这些只在 BRANDS 里、不进标签表的名字，
  // 测试 `local labels preserve the previous batch controlled brand vocabulary`
  // 里「云涛浴缸 → 标签为空」就是在钉这件事。本次只补这两个有外部依据的，其余保持受控。
  // 大小写必须与表上选项**逐字**一致：表上是「品牌/Bette」（首字母大写），
  // 写成小写 bette 会被写入器判成「不存在的选项」而 fail-closed（2026-09-21 实际被拦过一次）。
  // MultiSelect 的选项是表上的一等公民，本地不能凭空发明名字。
  ['品牌/Bette', /bette/iu],
  ['品牌/tw', /tw浴缸|tw卫浴|\btw\b/iu],
];

const BRANDS = [
  ...BRAND_LABEL_RULES.map(([, pattern]) => pattern),
  /朵纳|云涛|摩恩|欧凯伦|乐家/u,
  /vnlfrio/iu,
];

const EXTENDED_CATEGORY_RULES = [
  ['痛点', /怎么办|怎么处理|怎么修|漏水|堵塞|下水慢|异味|发霉|清洁|清洗|维修|修理|坏了|故障|除垢|水垢|裂缝|开裂/u],
  ['场景', /美容院|卫生间|浴室/u],
  ['材质', /不锈钢|搪瓷|全瓷|大理石|玻璃|树脂|洞石|木质|木桶|布艺|布浴缸|布袋浴缸|帆布/u],
  ['款式', /三角|方形|正方形|一体式|一体浴缸|切角|弧形|异形|贵妃|贵妇|悬浮|悬挂|落地|侧开门|自砌|成品/u],
  ['风格', /法式|欧式|中古风|高端|老式|网红|高级感/u],
  ['尺寸', /尺寸|窄|超大|mini|\d+米\d+|浴缸小$/iu],
  ['功能', /智能|定制|定做|泡澡|新款|二合一|可移动|免安装|助浴|洗浴|带龙头/u],
];

function classifyLocalIntent(keyword, labels = []) {
  const value = String(keyword ?? '').normalize('NFKC').trim();
  if (/怎么选|如何选|推荐$/u.test(value)) return '了解型';
  if (/怎么办|怎么处理|怎么修|怎么安装|能不能|能.+吗|是否|好不好|防不防|漏水|堵塞|下水慢|异味|发霉|清洁|清洗|维修|修理|坏了|故障|除垢|水垢|裂缝|开裂|免安装|省空间/u.test(value)) return '问题解决型';
  if (/哪个好|哪种好|哪个品牌好|对比|比较|区别|差别|还是|\bvs\b|评测|测评|十大名牌|十大品牌|热销榜|排行榜|品牌榜/iu.test(value)) return '对比型';
  if (/官方旗舰店|旗舰店|正品|哪里买|在哪买|怎么买|购买|多少钱|价格|价位|报价|优惠|促销|国家补贴/u.test(value)) return '购买型';
  if (value.replace(/\s+/gu, '') === '浴缸尺寸' || /大全|研究所|是什么|什么意思|百科/u.test(value)) return '了解型';
  if (/^(?:浴缸|浴池|浴盆|泡池|bathtub)$/iu.test(value)) return '了解型';
  if (/效果图|装修|案例|搭配|图片|样板间|实景|奶油风|极简|酒店|欧式|法式|中古风|高级/u.test(value)) return '灵感型';
  if (/人造石|绮美石|pmma|亚克力|铸铁|搪瓷|石英石|树脂|陶瓷|实木|柏木|铜|不锈钢|大理石|玻璃|洞石|帆布|布艺|\d+(?:\.\d+)?\s*(?:米|m|厘米|cm)|\d+米\d+|一米|单人|双人|多人|小户型|小空间|小型|小尺寸|迷你|窄|独立式?|嵌入式?|按摩|水疗|冲浪|深泡|恒温|加热|保温|智能|泡澡|定制|定做|可移动/iu.test(value) ||
      BRANDS.some((pattern) => pattern.test(value)) ||
      (/^[a-z0-9]+(?:浴缸|卫浴)$/iu.test(value) && !/^bathtub$/iu.test(value))) return '购买型';
  const dimensions = new Set(labels.map((label) => label.split('/')[0]));
  if (['品牌', '材质', '款式', '尺寸', '功能', '渠道'].some((name) => dimensions.has(name))) return '购买型';
  if (['场景', '风格', '颜色', '外观'].some((name) => dimensions.has(name))) return '灵感型';
  return '了解型';
}

const CATEGORY_BY_DIMENSION = {
  场景: '场景词', 痛点: '痛点词', 款式: '款式词', 材质: '材质词',
  尺寸: '尺寸词', 功能: '功能词', 风格: '风格词',
};
const CATEGORY_PRECEDENCE = ['痛点', '场景', '材质', '款式', '风格', '尺寸', '功能'];

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => item?.text ?? item?.name ?? item ?? '').join('');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
}

function isBlank(value) {
  if (value == null || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}

function normalizeStandardMerge(keyword) {
  const value = String(keyword ?? '').normalize('NFKC').trim().replace(/\s+/gu, '');
  if (/小浴缸|小户型|迷你|小空间|小型|超小|小尺寸|mini(?:款)?|短款|小号|特小|极小|浴缸小$/iu.test(value)) return '小浴缸';
  if (/人造石|绮美石|pmma/iu.test(value)) return '人造石浴缸';
  if (/亚克力/u.test(value)) return '亚克力浴缸';
  if (/家用|家庭用|家庭浴缸|家用式/u.test(value)) return '家用浴缸';
  if (/方形|正方形|长方形|矩形/u.test(value) || /方浴缸/u.test(value)) return '方形浴缸';
  if (/定制|定做/u.test(value)) return '定制浴缸';
  return '浴缸';
}

const CORE_LABEL_RULES = [
  ['核心/浴盆', /浴盆/u],
  ['核心/浴池', /浴池/u],
  ['核心/泡池', /泡池/u],
  ['核心/助浴设备', /助浴设备/u],
];

const LABEL_DIMENSION_ORDER = new Map([
  ['核心', 0], ['品牌', 1], ['材质', 2], ['场景', 3], ['痛点', 4], ['款式', 5],
  ['风格', 6], ['尺寸', 7], ['功能', 8], ['需求', 9], ['渠道', 10], ['地域', 11],
  ['颜色', 12], ['外观', 13],
]);

function extractLabels(keyword) {
  const value = String(keyword ?? '').normalize('NFKC');
  const labels = [
    ...CORE_LABEL_RULES.filter(([, pattern]) => pattern.test(value)).map(([label]) => label),
    ...BRAND_LABEL_RULES.filter(([, pattern]) => pattern.test(value)).map(([label]) => label),
    ...LABEL_RULES.filter(([, pattern]) => pattern.test(value)).map(([label]) => label),
  ];
  for (const match of value.matchAll(/\d+(?:\.\d+)?\s*(?:米|m|厘米|cm)/giu)) {
    if (/米$/u.test(match[0]) && /\d/u.test(value[(match.index ?? 0) + match[0].length] ?? '')) continue;
    const qualifier = value.slice((match.index ?? 0) + match[0].length).startsWith('宽') ? '宽' : '';
    const normalized = `${match[0].replace(/\s+/gu, '').replace(/cm$/iu, '厘米').replace(/m$/iu, '米')}${qualifier}`;
    labels.push(`尺寸/${normalized}`);
  }
  for (const match of value.matchAll(/(\d+)米(\d+)/gu)) labels.push(`尺寸/${match[1]}.${match[2]}米`);
  return [...new Set(labels)].sort((left, right) =>
    (LABEL_DIMENSION_ORDER.get(left.split('/')[0]) ?? 99) -
    (LABEL_DIMENSION_ORDER.get(right.split('/')[0]) ?? 99));
}

function classify(keyword, labels) {
  const value = String(keyword ?? '').normalize('NFKC');
  const dimensions = new Set(labels.map((label) => label.split('/')[0]));
  for (const [dimension, pattern] of EXTENDED_CATEGORY_RULES) {
    if (pattern.test(value)) dimensions.add(dimension);
  }
  for (const dimension of CATEGORY_PRECEDENCE) {
    if (dimensions.has(dimension)) return CATEGORY_BY_DIMENSION[dimension];
  }
  if (BRANDS.some((pattern) => pattern.test(value)) ||
      (/^[a-z0-9]+(?:浴缸|卫浴)/iu.test(value) && !/^bathtub$/iu.test(value))) return '品牌词';
  return '大词';
}

export function analyzeKeyword(keyword) {
  const labels = extractLabels(keyword);
  return {
    标准归并词: normalizeStandardMerge(keyword),
    关键词分类: classify(keyword, labels),
    细分标签: labels,
    用户意图: classifyLocalIntent(keyword, labels),
  };
}

export function buildLocalAnalysisPlan(records, { replaceFields = [] } = {}) {
  const replace = new Set(replaceFields);
  if ([...replace].some((name) => !TARGET_FIELD_SET.has(name))) {
    throw new Error('Replacement fields must be local analysis target fields');
  }
  const preservedExisting = Object.fromEntries(TARGET_FIELDS.map((name) => [name, 0]));
  const updates = [];
  for (const record of records) {
    const keyword = plain(record.fields?.原始关键词) || plain(record.fields?.搜索词);
    if (!keyword) throw new Error(`Record ${record.record_id} has no source keyword`);
    const analysis = analyzeKeyword(keyword);
    const fields = {};
    for (const name of TARGET_FIELDS) {
      if (replace.has(name) || isBlank(record.fields?.[name])) fields[name] = analysis[name];
      else preservedExisting[name] += 1;
    }
    if (Object.keys(fields).length > 0) updates.push({ record_id: record.record_id, fields });
  }
  return { updates, preservedExisting };
}

export function partitionPlanByFieldTypes(plan, fieldDefinitions) {
  const typeByName = new Map(fieldDefinitions.map((field) => [field.field_name, field.type]));
  const apiUpdates = [];
  const frontendUpdates = [];
  for (const update of plan.updates) {
    const apiFields = {};
    const frontendFields = {};
    for (const [name, value] of Object.entries(update.fields)) {
      if (typeByName.get(name) === 25) frontendFields[name] = value;
      else apiFields[name] = value;
    }
    if (Object.keys(apiFields).length) apiUpdates.push({ record_id: update.record_id, fields: apiFields });
    if (Object.keys(frontendFields).length) frontendUpdates.push({ record_id: update.record_id, fields: frontendFields });
  }
  return { apiUpdates, frontendUpdates };
}

function exactAllowedKeys(fields) {
  const keys = Object.keys(fields ?? {});
  return keys.length > 0 && keys.every((key) => TARGET_FIELD_SET.has(key));
}

export function assertLocalAnalysisMutation({ method, path, body }, scope) {
  if (method === 'GET') return;
  const expected = `/bitable/v1/apps/${scope.appToken}/tables/${scope.tableId}/records/batch_update`;
  const records = body?.records;
  if (method === 'POST' && path === expected && Array.isArray(records) && records.length > 0 && records.length <= 500 &&
      records.every((record) => record.record_id && exactAllowedKeys(record.fields))) return;
  throw new Error(`Blocked unauthorized local analysis mutation: ${method} ${path}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function verifyLocalAnalysisApply({ before, after, updates, derivedFields = [] }) {
  if (before.length !== after.length) throw new Error('Local analysis changed the table record count');
  const afterById = new Map(after.map((record) => [record.record_id, record]));
  const updatesById = new Map(updates.map((record) => [record.record_id, record.fields]));
  const ignored = new Set([...TARGET_FIELDS, ...derivedFields]);
  let fieldsWritten = 0;
  for (const prior of before) {
    const next = afterById.get(prior.record_id);
    if (!next) throw new Error(`Local analysis lost record ${prior.record_id}`);
    const priorOther = Object.fromEntries(Object.entries(prior.fields ?? {}).filter(([key]) => !ignored.has(key)));
    const nextOther = Object.fromEntries(Object.entries(next.fields ?? {}).filter(([key]) => !ignored.has(key)));
    if (!same(priorOther, nextOther)) throw new Error(`Local analysis changed an unrelated field on ${prior.record_id}`);
    const planned = updatesById.get(prior.record_id) ?? {};
    for (const name of TARGET_FIELDS) {
      if (name in planned) {
        const actual = next.fields?.[name] ?? (Array.isArray(planned[name]) ? [] : '');
        if (!same(actual, planned[name])) throw new Error(`Local analysis verification failed for ${name} on ${prior.record_id}`);
        fieldsWritten += 1;
      } else if (!same(prior.fields?.[name], next.fields?.[name])) {
        throw new Error(`Local analysis overwrote existing ${name} on ${prior.record_id}`);
      }
    }
  }
  return { recordsVerified: before.length, fieldsWritten };
}
