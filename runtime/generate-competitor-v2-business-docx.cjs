const fs = require('fs');
const path = require('path');
const {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, LevelFormat,
  PageNumber, Packer, Paragraph, ShadingType, Table, TableCell, TableRow,
  TextRun, WidthType,
} = require('docx');

const output = process.argv[2] || 'C:/Users/Administrator/Desktop/浴缸竞品分析V2_业务说明与留档.docx';
const formulaFile = process.argv[3] || path.resolve(__dirname, 'competitor-v2-live-formulas.json');
const promptFile = path.resolve(__dirname, '../skills/xws-to-feishu-base/scripts/competitor-v2-prompts.mjs');
const promptSource = fs.readFileSync(promptFile, 'utf8');
const prompts = {};
for (const match of promptSource.matchAll(/^\s{2}([^:]+): `([\s\S]*?)`,?$/gmu)) prompts[match[1]] = match[2];
const formulas = fs.existsSync(formulaFile) ? JSON.parse(fs.readFileSync(formulaFile, 'utf8')) : {};

const W = 9026;
const widths = { a: 1550, b: 3600, c: 3876 };
const border = { style: BorderStyle.SINGLE, size: 1, color: 'D9E2F3' };
const borders = { top: border, bottom: border, left: border, right: border };
const margins = { top: 100, bottom: 100, left: 130, right: 130 };
function text(value, opts = {}) { return new TextRun({ text: String(value), font: 'Microsoft YaHei', size: 21, ...opts }); }
function p(value, opts = {}) { return new Paragraph({ spacing: { after: 120, line: 320 }, children: [text(value, opts)] }); }
function h(value, level = HeadingLevel.HEADING_1) { return new Paragraph({ heading: level, children: [text(value, { bold: true })] }); }
function cell(value, width, header = false) {
  return new TableCell({ width: { size: width, type: WidthType.DXA }, borders, margins,
    shading: header ? { fill: 'EAF2F8', type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({ spacing: { after: 0 }, children: [text(value, { bold: header })] })] });
}
function table(headers, rows) {
  const ws = [widths.a, widths.b, widths.c];
  return new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: ws,
    rows: [new TableRow({ children: headers.map((x, i) => cell(x, ws[i], true)) }),
      ...rows.map(row => new TableRow({ children: row.map((x, i) => cell(x, ws[i])) }))] });
}
function callout(label, value, color = 'F5F9FC') {
  return new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: [W], rows: [new TableRow({ children: [
    new TableCell({ width: { size: W, type: WidthType.DXA }, borders, margins, shading: { fill: color, type: ShadingType.CLEAR },
      children: [new Paragraph({ spacing: { after: 50 }, children: [text(label, { bold: true, color: '1F4E79' })] }),
        new Paragraph({ spacing: { after: 0, line: 300 }, children: [text(value)] })] })] })] });
}
function bullets(items, ref = 'bullets') { return items.map(item => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 70, line: 300 }, children: [text(item)] })); }

const source = '序号、商品图片、商品标题、商品链接、价格、月收货人数、类目、同款数、平台、占位类型、店铺名、店铺旺旺、店铺类型、地址、收藏人数、卖点';
const aiNames = ['材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间'];
const formulaRules = [
  ['是否有效竞品', '先判断是不是浴缸主体。配件、服务、洗脚池/泡脚盆等标为“否”；明确是浴缸标为“是”；看不清标为“待确认”。'],
  ['排除原因', '解释为什么不是有效竞品：非浴缸主体、服务类或浴缸配件。'],
  ['月收货人数计算值', '把“100+”按 100 作为下限；纯数字按原值；不能计算就留空。'],
  ['计算口径', '标明人数是精确值、下限值，还是不可计算。'],
  ['月收货金额', '价格 × 月收货人数计算值；缺任一项就留空。'],
  ['客单价带分类', '1000 以下、1000-3000、3000-6000、6000-8000、8000 以上。'],
  ['竞品分类', '只给一个等级，优先级 A > B > C > D。A：人数≥80且金额≥20万；B：人造石且人数≥10；C：价格≥8000；D：价格<1000。'],
  ['待补数据项', '列出有效竞品还缺哪些前置分析信息。'],
  ['数据状态', '缺项为空就是“可用”，还有缺项就是“部分待补”。'],
];

const children = [
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [text('浴缸竞品分析 V2', { bold: true, size: 38, color: '1F4E79' })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 260 }, children: [text('业务说明与配置留档', { bold: true, size: 28, color: '5B9BD5' })] }),
  p('给业务人员看的版本｜更新时间：2026-08-19'),
  callout('先看结论', '这张表不是所有字段都靠 AI。原始数据由小旺神导入；金额、价格带和竞品等级由公式自动更新；材质、外形等文字属性由 AI 按标题和卖点提取。', 'EAF4EA'),

  h('一、这张表是怎么工作的'),
  table(['步骤', '谁来做', '结果'], [
    ['1. 导入', '小旺神 / 采集流程', '保留商品原始信息和真实图片'],
    ['2. 自动判断', '飞书公式', '有效性、金额、价格带、A/B/C/D 等级自动更新'],
    ['3. 属性提取', '飞书 AI', '材质、外形、安装、功能、风格、尺寸、空间'],
    ['4. 运营使用', '业务人员', '筛选有效竞品，优先看 A/B，再补后续数据'],
  ]),
  p('最重要的一点：原始字段不覆盖。公式和 AI 都是在原始数据后面增加分析结果。'),

  h('二、业务人员平时看哪些字段'),
  table(['先看什么', '字段', '怎么理解'], [
    ['先排除', '是否有效竞品、排除原因', '只分析“是”；“否”保留但不进入后续分析；“待确认”留给人工复核'],
    ['看强弱', '竞品分类', 'A 最强，B 次之，C 是高价，D 是低价；空白表示暂未满足四类条件'],
    ['看价格和规模', '价格、月收货人数、月收货金额、客单价带分类', '都是公式结果，源数据变化后自动重算'],
    ['看产品特征', '材质分类、外形、安装方式、功能、风格、尺寸、适用空间', 'AI 只提取标题/卖点明确写出的内容，没写就留空'],
    ['看是否完整', '待补数据项、数据状态', '告诉你哪些有效竞品还缺分析信息'],
  ]),

  h('三、公式规则（业务版）'),
  p('这些字段已经配置为飞书公式。每周导入新数据后，公式会自动计算，不需要人工逐行填写。'),
  table(['字段', '业务口径', '是否需要人工填'], formulaRules.map(([name, rule]) => [name, rule, '不需要'])),

  h('四、AI 字段怎么用'),
  callout('AI 的边界', 'AI 只根据商品标题和卖点里的明确文字提取标签，不凭图片猜、不凭常识补、不确定就留空。配置提示词不会自动消耗额度；是否批量运行由运营确认。', 'FFF7E6'),
  table(['AI 字段', '输出内容', '示例'], [
    ['材质分类', '亚克力、人造石等受控选项', '标题写 PMMA → 人造石'],
    ['外形', '椭圆、方形、蛋形、异形、正圆', '标题写长方形 → 方形'],
    ['安装方式', '独立、嵌入、靠墙、台上/搁置', '标题写靠墙式 → 靠墙'],
    ['功能', '普通、按摩、智能、恒温', '标题写冲浪 → 按摩'],
    ['风格', '极简、奶油、日式、轻奢', '标题写现代简约 → 极简'],
    ['尺寸', '原样保留尺寸文字', '标题写 1.5m → 1.5m'],
    ['适用空间', '小户型、常规卫生间、大户型', '明确写小户型才填小户型'],
  ]),

  h('五、每周操作清单'),
  ...bullets([
    '导入小旺神数据，检查 16 个原始字段和商品图片是否完整。',
    '确认“是否有效竞品”和“竞品分类”已经自动出结果。',
    '保存七个 AI 字段的提示词后，先抽样运行少量记录。',
    '抽样符合运营口径，再决定是否批量运行 AI。',
    '优先处理 A、B 类；对“待确认”和“待补数据项”进行复核。',
  ], 'steps'),
  callout('当前状态', '目标表 1333 行；9 个公式已回读确认；没有覆盖记录级数据；竞品模块测试 48/48 通过。', 'EAF4EA'),

  new Paragraph({ pageBreakBefore: true, children: [text('附录 A：给飞书 AI 字段的完整提示词', { bold: true, size: 30, color: '1F4E79' })] }),
  p('下面内容按字段分别粘贴。不要把多个字段的提示词合并。'),
];
for (const name of aiNames) {
  children.push(h(name, HeadingLevel.HEADING_2));
  children.push(callout('提示词', prompts[name] || '未找到提示词', 'F8F8F8'));
}

children.push(new Paragraph({ pageBreakBefore: true, children: [text('附录 B：飞书真实公式留档', { bold: true, size: 30, color: '1F4E79' })] }));
p('公式很长，业务使用时不需要阅读；此处用于技术核对。{字段名}表示对应的飞书字段。');
for (const [name, rule] of formulaRules) {
  children.push(h(name, HeadingLevel.HEADING_2));
  children.push(p(`业务解释：${rule}`));
  children.push(callout('线上公式', formulas[name] || '未回读到公式', 'F8F8F8'));
}

const doc = new Document({
  styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 21 } } }, paragraphStyles: [
    { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Microsoft YaHei', size: 28, bold: true, color: '1F4E79' }, paragraph: { spacing: { before: 300, after: 150 }, outlineLevel: 0 } },
    { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Microsoft YaHei', size: 24, bold: true, color: '365F91' }, paragraph: { spacing: { before: 220, after: 100 }, outlineLevel: 1 } },
  ] },
  numbering: { config: [
    { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 520, hanging: 260 } } } }] },
    { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 520, hanging: 260 } } } }] },
  ] },
  sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 900, right: 940, bottom: 900, left: 940 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [text('浴缸竞品分析 V2  |  第 '), new TextRun({ children: [PageNumber.CURRENT] }), text(' 页')] })] }) },
    children }],
});
fs.mkdirSync(path.dirname(output), { recursive: true });
Packer.toBuffer(doc).then(buffer => fs.writeFileSync(output, buffer));
