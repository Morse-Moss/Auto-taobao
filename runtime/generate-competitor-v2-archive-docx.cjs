const fs = require('fs');
const path = require('path');
const {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  LevelFormat,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} = require('docx');

const output = process.argv[2];
const formulaFile = process.argv[3];
if (!output) throw new Error('Output .docx path is required');
if (!formulaFile) throw new Error('Live formula JSON path is required');

const promptsPath = path.resolve(__dirname, '../skills/xws-to-feishu-base/scripts/competitor-v2-prompts.mjs');
const promptSource = fs.readFileSync(promptsPath, 'utf8');
const prompts = {};
const promptPattern = /^\s{2}([^:]+): `([\s\S]*?)`,?$/gmu;
for (const match of promptSource.matchAll(promptPattern)) prompts[match[1]] = match[2];

const expectedPromptNames = ['材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间'];
for (const name of expectedPromptNames) {
  if (!prompts[name]) throw new Error(`Prompt not found: ${name}`);
}

const liveFormulas = JSON.parse(fs.readFileSync(formulaFile, 'utf8'));

const formulas = [
  ['是否有效竞品', '按商品标题明确证据判断。非浴缸主体、服务和配件输出“否”；明确浴缸主体输出“是”；证据不足输出“待确认”。类目不参与判断。', 'IF(标题命中非浴缸主体,"否",IF(标题命中浴缸主体,"是",IF(标题命中服务或配件,"否",IF(标题命中浴缸词,"是","待确认"))))'],
  ['排除原因', '仅对明确排除项输出原因；有效或待确认时留空。', 'IF(非浴缸主体,"非浴缸主体",IF(服务类,"服务类",IF(浴缸配件,"浴缸配件","")))'],
  ['月收货人数计算值', '仅有效竞品计算。纯数字按精确值；“数字+”取下限数字；无法计算时留空。', 'IF(非有效竞品,"",IFERROR(VALUE(SUBSTITUTE({月收货人数},"+","")),""))'],
  ['计算口径', '说明人数计算值来自精确值、下限值或不可计算。', 'IF(非有效竞品,"",IF(RIGHT({月收货人数},1)="+","下限值",IFERROR(IF(VALUE({月收货人数})>=0,"精确值","不可计算"),"不可计算")))'],
  ['月收货金额', '仅有效竞品且价格、人数可用时计算。', 'IF(OR(非有效竞品,ISBLANK({价格}),{月收货人数计算值}=""),"",{价格}*{月收货人数计算值})'],
  ['客单价带分类', '按价格分为 1000以下、1000-3000、3000-6000、6000-8000、8000以上。', 'IF(OR(非有效竞品,ISBLANK({价格})),"",IF({价格}<1000,"1000以下",IF({价格}<3000,"1000-3000",IF({价格}<6000,"3000-6000",IF({价格}<8000,"6000-8000","8000以上")))))'],
  ['竞品分类', '只输出一个分类，优先级 A > B > C > D。A：人数>=80且金额>=200000；B：人造石且人数>=10；C：价格>=8000；D：价格<1000。', 'IF(非有效竞品,"",IF(AND({月收货人数计算值}>=80,{月收货金额}>=200000),"A",IF(AND(CONTAIN({材质分类},"人造石"),{月收货人数计算值}>=10),"B",IF({价格}>=8000,"C",IF({价格}<1000,"D","")))))'],
  ['待补数据项', '仅有效竞品检查前置分析缺口：人数精确值、材质、外形、安装方式、功能、风格。', '把所有空缺项名称连接为“、”分隔文本；没有缺项时留空。'],
  ['数据状态', '仅有效竞品输出。待补数据项为空时为“可用”，否则为“部分待补”。', 'IF(非有效竞品,"",IF({待补数据项}="","可用","部分待补"))'],
];

const sourceFields = ['序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数', '类目', '同款数', '平台', '占位类型', '店铺名', '店铺旺旺', '店铺类型', '地址', '收藏人数', '卖点'];

const border = { style: BorderStyle.SINGLE, size: 1, color: 'B8C2CC' };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 90, bottom: 90, left: 120, right: 120 };
const contentWidth = 9026;

function run(text, options = {}) {
  return new TextRun({ text: String(text), font: 'Microsoft YaHei', size: 20, ...options });
}

function para(text, options = {}) {
  return new Paragraph({
    spacing: { after: 100, line: 300 },
    ...options,
    children: [run(text, options.run || {})],
  });
}

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ heading: level, children: [run(text, { bold: true })] });
}

function cell(text, width, header = false) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders,
    margins: cellMargins,
    shading: header ? { fill: 'DCE6F1', type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({ children: [run(text, { bold: header })] })],
  });
}

function table(headers, widths, rows) {
  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ children: headers.map((value, index) => cell(value, widths[index], true)) }),
      ...rows.map((row) => new TableRow({ children: row.map((value, index) => cell(value, widths[index])) })),
    ],
  });
}

const children = [
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
    children: [run('浴缸竞品分析 V2', { bold: true, size: 34 })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 320 },
    children: [run('公式与 AI 提示词留档', { bold: true, size: 28, color: '365F91' })],
  }),
  para('版本日期：2026-08-19'),
  para('适用表：飞书 Base“浴缸竞品分析 V2（测试）”中的“竞品主表”'),
  para('用途：说明每个字段由哪里产生、如何自动更新，以及七个 AI 字段应使用的完整提示词。'),

  heading('一、字段怎么分工'),
  table(
    ['字段类型', '字段', '处理方式'],
    [1450, 4676, 2900],
    [
      ['原始采集', sourceFields.join('、'), '小旺神导入，保持原值，不用公式或 AI 覆盖。'],
      ['导入标识', '搜索关键词', '导入时写入，用来标记采集入口。'],
      ['公式计算', formulas.map(([name]) => name).join('、'), '飞书公式自动更新，不需要每周人工重填。'],
      ['AI 分析', expectedPromptNames.join('、'), '按标题/卖点的明确证据分析；没有证据留空。'],
      ['后置采集', 'SKU 明细、问大家、评论', '本轮不采集，不在前置分析中推断。'],
    ],
  ),

  heading('二、公式字段'),
  para('说明：下面使用“{字段名}”表示飞书字段引用。“非有效竞品”等条件在实际飞书公式中由商品标题证据直接展开，以避免公式字段之间的依赖不重算。'),
];

for (const [name, rule, formula] of formulas) {
  children.push(heading(name, HeadingLevel.HEADING_2));
  children.push(para(`业务口径：${rule}`));
  children.push(new Paragraph({
    spacing: { after: 160 },
    shading: { fill: 'F3F6F8', type: ShadingType.CLEAR },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: '5B9BD5' } },
    indent: { left: 180 },
    children: [run(`口径公式：${formula}`, { font: 'Consolas', size: 18 })],
  }));
  children.push(new Paragraph({
    spacing: { after: 180 },
    shading: { fill: 'FFF7E6', type: ShadingType.CLEAR },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'ED7D31' } },
    indent: { left: 180 },
    children: [run(`飞书真实公式：${liveFormulas[name]}`, { font: 'Consolas', size: 17 })],
  }));
}

children.push(heading('三、AI 字段完整提示词'));
children.push(para('逐字段单独配置。配置提示词本身不等于运行 AI；是否批量运行由运营确认额度后另行决定。'));
for (const name of expectedPromptNames) {
  children.push(heading(name, HeadingLevel.HEADING_2));
  for (const line of prompts[name].split('\n')) {
    children.push(new Paragraph({
      spacing: { after: 70, line: 280 },
      shading: { fill: 'F7F7F7', type: ShadingType.CLEAR },
      indent: { left: 180, right: 180 },
      children: [run(line, { size: 19 })],
    }));
  }
}

children.push(heading('四、使用顺序'));
const steps = [
  '导入小旺神原始数据，先确认 16 个源字段没有被覆盖。',
  '确认 9 个公式字段已生效，并抽查有效性、金额、价格带和竞品分类。',
  '在 7 个 AI 字段中分别保存本文件对应的提示词。',
  '先抽样运行少量记录，检查分类是否符合运营口径。',
  '抽样通过后再由运营决定是否批量运行，避免无意消耗 AI 额度。',
];
for (const item of steps) {
  children.push(new Paragraph({ numbering: { reference: 'steps', level: 0 }, children: [run(item)] }));
}

children.push(heading('五、当前验收记录'));
for (const item of [
  '目标表记录数：1333 行。',
  '9 个公式字段已写入并回读确认。',
  '公式迁移没有覆盖任何记录级原始数据，recordsToUpdate=0。',
  '竞品模块自动化测试：48/48 通过。',
  '当前公式结果：有效竞品 1303、排除 24、待确认 6；A 3、B 7、C 36、D 341、未分类 946。',
  'AI 提示词保存后不自动等同于全表运行；批量运行需另行确认。',
]) {
  children.push(new Paragraph({ numbering: { reference: 'checks', level: 0 }, children: [run(item)] }));
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Microsoft YaHei', size: 20 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: 'Microsoft YaHei', size: 28, bold: true, color: '1F4E79' },
        paragraph: { spacing: { before: 260, after: 140 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: 'Microsoft YaHei', size: 23, bold: true, color: '365F91' },
        paragraph: { spacing: { before: 180, after: 90 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 520, hanging: 260 } } } }] },
      { reference: 'checks', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 520, hanging: 260 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 900, right: 940, bottom: 900, left: 940 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run('浴缸竞品分析 V2  |  第 '), new TextRun({ children: [PageNumber.CURRENT] }), run(' 页')] })] }) },
    children,
  }],
});

fs.mkdirSync(path.dirname(output), { recursive: true });
Packer.toBuffer(doc).then((buffer) => fs.writeFileSync(output, buffer));
