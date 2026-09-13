// 批次 7 手动分析生成器：与批次 6 人工口径一致（规则引擎 + 批6同款词精确覆写）。
// 输出 runtime/weekly-local-analysis/2026-09-12-batch-7-batched/manual-output-batch7.json
// 校验：七字段枚举 + 细分标签尽量复用批次 6 词汇表（新标签单独列出待回写前补选项）。
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('runtime/weekly-local-analysis/2026-09-12-batch-7-batched');
const tasks = JSON.parse(fs.readFileSync(path.join(DIR, 'tasks.json'), 'utf8'));
const batch6Labels = new Set(fs.readFileSync(path.join(DIR, 'batch6-labels.txt'), 'utf8').split(/\r?\n/).filter(Boolean));

const CATEGORY = new Set(['大词', '材质词', '场景词', '痛点词', '款式词', '风格词', '尺寸词', '功能词', '无匹配类别']);
const CLASSIFICATION = new Set(['核心大词', '安装方式词', '材质词', '形状与风格词', '功能与特点词', '尺寸词', '适用人群与场景词', '品牌词', '地域词', '颜色词', '通用词', '无匹配类别']);
const INTENT = new Set(['了解型', '购买决策型', '对比选择型', '场景需求型', '问题解决型']);
const CONTENT = new Set(['AI预测-高', 'AI预测-中', 'AI预测-低']);
const PRODUCT = new Set(['小户型深泡款', '人造石高端款', '方形独立式', '靠墙式小浴缸', '']);

// —— 批次 6 已实判的同款词 / 歧义词精确覆写（keyword 精确匹配原始关键词）——
const SPECIAL = new Map([
  ['浴缸', ['大词', '浴缸', '核心大词', '', '了解型', 'AI预测-低', '']],
  ['浴缸国家补贴', ['无匹配类别', '浴缸国家补贴', '无匹配类别', '', '了解型', 'AI预测-低', '']],
  ['小米智能浴缸', ['无匹配类别', '小米智能浴缸', '品牌词', '小米、智能', '了解型', 'AI预测-低', '']],
  ['浴缸智能恒温加热', ['功能词', '智能恒温加热浴缸', '功能与特点词', '智能、恒温、加热', '了解型', 'AI预测-高', '']],
  ['全自动浴缸智能恒温加热', ['功能词', '智能恒温浴缸', '功能与特点词', '智能、恒温、加热', '了解型', 'AI预测-中', '']],
  ['浴缸十大品牌', ['无匹配类别', '浴缸品牌', '通用词', '', '对比选择型', 'AI预测-中', '']],
  ['九牧人造石浴缸', ['材质词', '九牧人造石浴缸', '品牌词', '九牧、人造石', '了解型', 'AI预测-中', '人造石高端款']],
  ['科勒官方旗舰店', ['无匹配类别', '科勒', '品牌词', '科勒', '购买决策型', 'AI预测-低', '']],
  ['浪鲸卫浴官方旗舰店正品', ['无匹配类别', '浪鲸卫浴', '品牌词', '浪鲸卫浴', '购买决策型', 'AI预测-低', '']],
  ['浴缸官方旗舰店', ['无匹配类别', '官方旗舰店浴缸', '通用词', '官方旗舰店', '购买决策型', 'AI预测-低', '']],
]);

// —— 品牌表：token -> 标准品牌名（归并词与标签用）——
const BRANDS = [
  ['toto', 'TOTO'], ['TOTO', 'TOTO'], ['kohler', 'Kohler'], ['KOHLER', 'Kohler'],
  ['九牧', '九牧'], ['箭牌', '箭牌'], ['浪鲸', '浪鲸'], ['恒洁', '恒洁'], ['东鹏', '东鹏'],
  ['法恩莎', '法恩莎'], ['惠达', '惠达'], ['美标', '美标'], ['恩仕', '恩仕'], ['唯宝', '唯宝'],
  ['汉斯格雅', '汉斯格雅'], ['杜拉维特', '杜拉维特'], ['劳芬', '劳芬'], ['埃飞灵', '埃飞灵'],
  ['日丰', '日丰'], ['小米', '小米'], ['卡德维', '卡德维'], ['特拉维尔', '特拉维尔'],
  ['杜菲尼', '杜菲尼'], ['观博', '观博'], ['勒示', '勒示'], ['碧澜', '碧澜'], ['乐溢', '乐溢'],
  ['范尔德', '范尔德'], ['米希尔', '米希尔'], ['果敢', '果敢'], ['ssww', 'SSWW'], ['SSWW', 'SSWW'],
  ['bette', 'Bette'], ['Bette', 'Bette'], ['tw', 'TW'],
];

// —— 属性 token 表：正则 -> {tag 标签, cat 归类, cls 分类, order 归并词排序}——
const ATTRS = [
  { re: /人造石/, tag: '人造石', cat: '材质词', cls: '材质词', order: 1 },
  { re: /亚克力/, tag: '亚克力', cat: '材质词', cls: '材质词', order: 1 },
  { re: /陶瓷/, tag: '陶瓷', cat: '材质词', cls: '材质词', order: 1 },
  { re: /铸铁/, tag: '铸铁', cat: '材质词', cls: '材质词', order: 1 },
  { re: /搪瓷/, tag: '搪瓷', cat: '材质词', cls: '材质词', order: 1 },
  { re: /树脂/, tag: '树脂', cat: '材质词', cls: '材质词', order: 1 },
  { re: /玻璃/, tag: '玻璃', cat: '材质词', cls: '材质词', order: 1 },
  { re: /不锈钢/, tag: '不锈钢', cat: '材质词', cls: '材质词', order: 1 },
  { re: /大理石/, tag: '大理石', cat: '材质词', cls: '材质词', order: 1 },
  { re: /洞石/, tag: '洞石', cat: '材质词', cls: '材质词', order: 1 },
  { re: /透明/, tag: '透明', cat: '材质词', cls: '材质词', order: 1 },
  { re: /pmma/i, tag: 'PMMA', cat: '材质词', cls: '材质词', order: 1 },
  { re: /小户型/, tag: '小户型、小空间', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /老人|老年人/, tag: '老人', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /无障碍/, tag: '无障碍', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /成人/, tag: '成人', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /家用/, tag: '家用', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /酒店/, tag: '酒店', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /民宿/, tag: '民宿', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /美容院/, tag: '美容院', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /户外/, tag: '户外', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /卫生间/, tag: '卫生间', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /洗浴|洗澡/, tag: '浴室', cat: '场景词', cls: '适用人群与场景词', order: 2 },
  { re: /1\.2米/, tag: '1.2米', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /1\.3米|1米3/, tag: '1.3米', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /1\.4米/, tag: '1.4米', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /1\.5米/, tag: '1.5米', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /2米/, tag: '2米', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /1米|一米/, tag: '1米', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /60cm/, tag: '60cm', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /70cm/, tag: '70cm', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /50cm/, tag: '50cm', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /小尺寸/, tag: '小尺寸', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /尺寸/, tag: '尺寸', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /迷你|超小|特小|小型|小浴缸/, tag: '小型', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /大浴缸/, tag: '大型', cat: '尺寸词', cls: '尺寸词', order: 3 },
  { re: /圆形|圆浴缸/, tag: '圆形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /椭圆/, tag: '椭圆形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /长方形/, tag: '长方形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /正方形/, tag: '正方形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /方形/, tag: '方形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /三角扇形|扇形三角/, tag: '三角形、扇形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /三角形/, tag: '三角形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /扇形/, tag: '扇形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /切角/, tag: '切角', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /蛋形/, tag: '蛋形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /弧形/, tag: '弧形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /转角/, tag: '角落式', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /异形/, tag: '异形', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /贵妃/, tag: '贵妃', cat: '款式词', cls: '形状与风格词', order: 4 },
  { re: /网红/, tag: '网红', cat: '风格词', cls: '形状与风格词', order: 5 },
  { re: /中古风|复古/, tag: '复古', cat: '风格词', cls: '形状与风格词', order: 5 },
  { re: /法式/, tag: '法式', cat: '风格词', cls: '形状与风格词', order: 5 },
  { re: /日本|日式/, tag: '日式', cat: '风格词', cls: '形状与风格词', order: 5 },
  { re: /老式|新式|新型/, tag: '老式', cat: '款式词', cls: '形状与风格词', order: 5 },
  { re: /高级感|高级/, tag: '高级感', cat: '款式词', cls: '形状与风格词', order: 5 },
  { re: /新款|2026/, tag: '新款、2026', cat: '款式词', cls: '通用词', order: 6 },
  { re: /深泡/, tag: '深泡', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /坐式|坐浴|坐泡|坐浴缸/, tag: '坐式', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /泡澡/, tag: '泡澡', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /按摩/, tag: '按摩', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /冲浪/, tag: '冲浪', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /水疗/, tag: '水疗', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /恒温/, tag: '恒温', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /加热/, tag: '加热', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /智能/, tag: '智能', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /免安装/, tag: '免安装', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /定制|定做/, tag: '定制', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /淋浴二合一|二合一/, tag: '淋浴二合一', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /开门/, tag: '开门式', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /步入式/, tag: '步入式', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /加厚/, tag: '加厚', cat: '功能词', cls: '功能与特点词', order: 7 },
  { re: /嵌入式|内嵌/, tag: '嵌入式', cat: '款式词', cls: '安装方式词', order: 8 },
  { re: /独立/, tag: '独立式', cat: '款式词', cls: '安装方式词', order: 8 },
  { re: /一体式|一体/, tag: '一体式', cat: '款式词', cls: '安装方式词', order: 8 },
  { re: /靠墙/, tag: '靠墙式', cat: '款式词', cls: '安装方式词', order: 8 },
  { re: /自砌/, tag: '自砌', cat: '功能词', cls: '安装方式词', order: 8 },
  { re: /立式|落地/, tag: '立式', cat: '款式词', cls: '安装方式词', order: 8 },
  { re: /可移动/, tag: '可移动', cat: '场景词', cls: '功能与特点词', order: 9 },
  { re: /双人/, tag: '双人', cat: '款式词', cls: '功能与特点词', order: 9 },
  { re: /情侣/, tag: '情侣', cat: '款式词', cls: '功能与特点词', order: 9 },
  { re: /情趣/, tag: '情趣', cat: '款式词', cls: '功能与特点词', order: 9 },
  { re: /成品/, tag: '成品', cat: '款式词', cls: '通用词', order: 9 },
  { re: /粉色/, tag: '粉色', cat: '款式词', cls: '颜色词', order: 9 },
  { re: /单人/, tag: '单人', cat: '尺寸词', cls: '功能与特点词', order: 9 },
];

function normalize(raw) {
  return raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function contentHeat({ search, trade, isBrand, isShop, isCoreWord }) {
  if (isShop) return 'AI预测-低';
  if (isCoreWord) return 'AI预测-低';
  if (isBrand) {
    if (trade === '高') return 'AI预测-中';
    if (trade === '中') return 'AI预测-中';
    return 'AI预测-低';
  }
  if (trade === '高') return 'AI预测-高';
  if (trade === '中') return 'AI预测-中';
  if (search === '高') return 'AI预测-中';
  return 'AI预测-中';
}

function analyze(task) {
  const raw = task.keyword;
  if (SPECIAL.has(raw)) {
    const [cat, merge, cls, tags, intent, heat, product] = SPECIAL.get(raw);
    return { cat, merge, cls, tags, intent, heat, product };
  }
  const norm = normalize(raw);
  const search = task.inputs['搜索热度'] || '';
  const trade = task.inputs['交易热度'] || '';

  const brandHit = BRANDS.find(([re]) => norm.toLowerCase().includes(re.toLowerCase()));
  const brandName = brandHit ? brandHit[1] : null;
  const isShop = /旗舰店|官方旗舰店|官方店/.test(norm);
  const isCoreWord = norm === '浴缸' || norm === '浴';

  // 提取属性 token（去重）
  const seen = new Set();
  const attrs = [];
  for (const a of ATTRS) {
    if (!a.re.test(norm)) continue;
    const key = a.tag;
    if (seen.has(key)) continue;
    seen.add(key);
    attrs.push(a);
  }
  // 品牌词的单字 tw/bette 等避免把 'tw浴缸' 里的 tw 误吞 —— 属性表不含品牌，无冲突
  const isBrand = Boolean(brandName);
  const isQuestion = /怎么|如何|测量/.test(norm);
  const isRanking = /十大|名牌|热销榜/.test(norm);
  const isSubsidy = /补贴/.test(norm);

  // 关键词归类
  let cat = '无匹配类别';
  const ordered = [...attrs].sort((a, b) => a.order - b.order);
  const firstMaterial = attrs.find((a) => a.cls === '材质词');
  const firstScene = attrs.find((a) => a.cls === '适用人群与场景词');
  const firstSize = attrs.find((a) => a.cls === '尺寸词');
  const firstShape = attrs.find((a) => a.cls === '形状与风格词');
  const firstFunc = attrs.find((a) => a.cls === '功能与特点词');
  const firstInstall = attrs.find((a) => a.cls === '安装方式词');
  if (isQuestion) cat = '痛点词';
  else if (isBrand && firstMaterial) cat = '材质词';
  else if (isBrand && firstInstall) cat = '款式词';
  else if (isBrand && firstShape) cat = firstShape.cat;
  else if (isBrand && firstSize) cat = '尺寸词';
  else if (isBrand && firstFunc) cat = '功能词';
  else if (isBrand) cat = '无匹配类别';
  else if (firstMaterial) cat = '材质词';
  else if (firstScene) cat = '场景词';
  else if (firstSize) cat = '尺寸词';
  else if (firstShape && firstShape.cat === '风格词') cat = '风格词';
  else if (firstShape) cat = '款式词';
  else if (firstInstall) cat = '款式词';
  else if (firstFunc) cat = '功能词';
  else if (isRanking || /大全|高级/.test(norm)) cat = '大词';
  else if (isSubsidy) cat = '无匹配类别';
  else if (isCoreWord) cat = '大词';

  // 关键词分类
  let cls = '无匹配类别';
  if (isBrand) cls = '品牌词';
  else if (isCoreWord) cls = '核心大词';
  else if (isQuestion) cls = '无匹配类别';
  else if (firstMaterial) cls = '材质词';
  else if (firstScene) cls = '适用人群与场景词';
  else if (firstSize) cls = '尺寸词';
  else if (firstShape) cls = '形状与风格词';
  else if (firstInstall) cls = '安装方式词';
  else if (firstFunc) cls = '功能与特点词';
  else if (isRanking || /大全|新款|2026|成品|高级|官方旗舰店/.test(norm)) cls = '通用词';
  else if (/粉色/.test(norm)) cls = '颜色词';

  // 标准归并词：品牌 + 属性（按 order 排序）+ 浴缸；纯品牌 → 品牌名
  let merge;
  if (isBrand) {
    const attrTags = ordered.map((a) => a.tag.split('、')).flat().filter((t) => !BRANDS.some(([re, name]) => name === t));
    const body = attrTags.length ? attrTags.join('') + '浴缸' : '浴缸';
    merge = brandName + (norm === brandName.toLowerCase() || norm === brandName ? '' : body === '浴缸' && /浴缸|浴盆/.test(norm) ? '' : body);
    if (attrTags.length === 0 && !/浴缸|浴盆/.test(norm)) merge = brandName;
    if (norm.replace(new RegExp(brandName, 'iu'), '').replace(/浴缸|浴盆|-|／/gu, '').trim() === '') merge = brandName + '浴缸';
    if (!/浴缸|浴盆/.test(norm) && attrTags.length === 0) merge = brandName;
  } else if (isCoreWord) {
    merge = norm === '浴' ? '浴缸' : '浴缸';
  } else {
    const attrTags = ordered.map((a) => a.tag.split('、')).flat();
    const tail = /浴盆/.test(norm) && !/浴缸/.test(norm) ? '浴盆' : '浴缸';
    merge = attrTags.length ? attrTags.join('') + tail : norm.replace(/\s+/gu, '');
    if (isQuestion) merge = norm.replace(/\s+/gu, '');
    if (isSubsidy) merge = attrTags.length ? '国家补贴' + attrTags.join('') + tail : norm.replace(/\s+/gu, '');
  }

  // 细分标签
  let tags = ordered.map((a) => a.tag).filter(Boolean).join('、');
  if (isShop && !brandName) tags = '官方旗舰店';
  if (isBrand && isShop && !tags.includes(brandName)) tags = brandName + (tags ? '、' + tags : '');
  if (isBrand && !isShop) {
    const brandTags = ordered.map((a) => a.tag.split('、')).flat().filter(Boolean);
    tags = [brandName, ...brandTags].join('、');
  }
  if (norm === '浴') tags = '';

  // 用户意图
  let intent = '了解型';
  if (isShop) intent = '购买决策型';
  else if (/定制|定做/.test(norm)) intent = '购买决策型';
  else if (isRanking) intent = '对比选择型';
  else if (isQuestion) intent = '问题解决型';
  else if (firstScene) intent = '场景需求型';

  const heat = contentHeat({ search, trade, isBrand, isShop, isCoreWord });

  // 对应产品方向
  let product = '';
  if (attrs.some((a) => a.tag === '人造石')) product = '人造石高端款';
  else if (/靠墙/.test(norm)) product = '靠墙式小浴缸';
  else {
    const small = /小户型|小空间|迷你|超小|特小|小型|小浴缸|小尺寸|深泡|坐式|坐浴|坐泡|1米|1\.2米|50cm|60cm|70cm|可移动/.test(norm);
    const big = /1\.3米|1\.4米|1\.5米|2米|1米3|大型|大浴缸/.test(norm);
    if (small && !big) product = '小户型深泡款';
  }

  return { cat, merge, cls, tags, intent, heat, product };
}

const results = tasks.map((task) => {
  const r = analyze(task);
  for (const [v, set, name] of [[r.cat, CATEGORY, '关键词归类'], [r.cls, CLASSIFICATION, '关键词分类'], [r.intent, INTENT, '用户意图'], [r.heat, CONTENT, '内容热度'], [r.product, PRODUCT, '对应产品方向']]) {
    if (!set.has(v)) throw new Error(`${task.keywordId} ${task.keyword} ${name} invalid: ${v}`);
  }
  if (!r.merge) throw new Error(`${task.keywordId} ${task.keyword} 标准归并词 empty`);
  const newLabels = r.tags.split(/[、]/).filter((l) => l && !batch6Labels.has(l));
  if (newLabels.length) console.error(`NEW-LABEL ${task.keywordId} ${task.keyword}: ${newLabels.join('、')}`);
  return { taskId: task.taskId, '关键词归类': r.cat, '标准归并词': r.merge, '关键词分类': r.cls, '细分标签': r.tags, '用户意图': r.intent, '内容热度': r.heat, '对应产品方向': r.product };
});

fs.writeFileSync(path.join(DIR, 'manual-output-batch7.json'), JSON.stringify(results, null, 2) + '\n');
console.log(`written ${results.length} results -> manual-output-batch7.json`);
