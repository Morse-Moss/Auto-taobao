#!/usr/bin/env node
/**
 * 把竞品字段参考的 Markdown 源渲染成对客户交付的 docx。
 *
 * 设计语言沿用仓库既有的 runtime/generate-competitor-v2-business-docx.cjs：
 * 蓝色章节标题、灰底表头细边框表格、浅色 callout 色块、等宽代码块、页眉页脚页码。
 *
 * 用法：
 *   node runtime/generate-competitor-field-reference-docx.cjs
 *   node runtime/generate-competitor-field-reference-docx.cjs --src <md> --out <docx>
 */
const fs = require('fs');
const path = require('path');
const {
  AlignmentType, BorderStyle, Document, Footer, Header, LevelFormat,
  PageNumber, Packer, Paragraph, ShadingType, Table, TableCell, TableRow,
  TextRun, WidthType,
} = require('docx');

const ROOT = path.resolve(__dirname, '..');
let src = path.join(ROOT, 'docs/references/COMPETITOR-FIELD-REFERENCE-CLIENT.md');
let out = path.join(ROOT, 'docs/references/COMPETITOR-FIELD-REFERENCE-CLIENT.docx');
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--src') { src = argv[index + 1]; index += 1; }
  else if (argv[index] === '--out') { out = argv[index + 1]; index += 1; }
  else throw new Error(`Unknown argument: ${argv[index]}`);
}
if (!fs.existsSync(src)) throw new Error(`Source markdown not found: ${src}`);

const BODY = 'Microsoft YaHei';
const MONO = 'Consolas';
const INK = '333333';
const NAVY = '1F4E79';
const BLUE = '2E74B5';
const SKY = '5B9BD5';
const GREY = '595959';

const CONTENT_WIDTH = 10026;
const GRID = { style: BorderStyle.SINGLE, size: 1, color: 'D9E2F3' };
const GRID_BORDERS = { top: GRID, bottom: GRID, left: GRID, right: GRID };
const CELL_MARGINS = { top: 80, bottom: 80, left: 130, right: 130 };

function visualLen(value) {
  let total = 0;
  for (const ch of String(value)) {
    total += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return total;
}

function autoWidths(headers, rows, total) {
  const weights = headers.map((header, column) => {
    const lens = [visualLen(header), ...rows.map(row => visualLen(row[column] === undefined ? '' : row[column]))];
    return Math.min(Math.max(...lens), 52);
  });
  const floors = headers.map(header => Math.max(620, visualLen(header) * 200 + 300));
  const widthSum = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = floors.slice();
  const remaining = total - floors.reduce((a, b) => a + b, 0);
  if (remaining > 0) {
    for (let index = 0; index < widths.length; index += 1) {
      widths[index] += Math.round((remaining * weights[index]) / widthSum);
    }
    widths[widths.length - 1] += total - widths.reduce((a, b) => a + b, 0);
  }
  return widths;
}

function boldSegments(text) {
  const out = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), bold: false });
    out.push({ text: match[1], bold: true });
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

function runsFor(text, base = {}) {
  const size = base.size || 21;
  const color = base.color || INK;
  const bold = base.bold || false;
  const runs = [];
  const pushPlain = (value, isBold) => {
    if (value) runs.push(new TextRun({ text: value, font: BODY, size, color, bold: isBold }));
  };
  for (const segment of boldSegments(text)) {
    const isBold = bold || segment.bold;
    const pattern = /`([^`]+)`/g;
    let last = 0;
    let match = pattern.exec(segment.text);
    while (match !== null) {
      pushPlain(segment.text.slice(last, match.index), isBold);
      runs.push(new TextRun({ text: match[1], font: MONO, size: size - 2, color: NAVY, bold: isBold }));
      last = match.index + match[0].length;
      match = pattern.exec(segment.text);
    }
    pushPlain(segment.text.slice(last), isBold);
  }
  if (runs.length === 0) runs.push(new TextRun({ text: '', font: BODY, size, color, bold }));
  return runs;
}

function paragraph(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after === undefined ? 120 : opts.after, line: 320 },
    alignment: opts.align,
    children: runsFor(text, opts),
  });
}

function kicker() {
  return new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text: '飞书多维表格配置参考 · 浴缸竞品分析', font: BODY, size: 18, bold: true, color: SKY })],
  });
}

function subtitle() {
  return new Paragraph({
    spacing: { after: 260 },
    children: [new TextRun({ text: '竞品主表与竞品周表的字段口径、飞书公式与 AI 提示词', font: BODY, size: 22, color: GREY })],
  });
}

function heading1(text) {
  return new Paragraph({
    spacing: { before: 0, after: 200 },
    children: [new TextRun({ text, font: BODY, size: 44, bold: true, color: NAVY })],
  });
}

function heading2(text) {
  return new Paragraph({
    spacing: { before: 340, after: 150 },
    indent: { left: 170 },
    border: { left: { style: BorderStyle.SINGLE, size: 24, color: BLUE, space: 10 } },
    children: [new TextRun({ text, font: BODY, size: 30, bold: true, color: NAVY })],
  });
}

function heading3(text) {
  return new Paragraph({
    spacing: { before: 250, after: 100 },
    children: [new TextRun({ text, font: BODY, size: 24, bold: true, color: BLUE })],
  });
}

function ruleLine() {
  return new Paragraph({
    spacing: { before: 100, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D9E2F3', space: 1 } },
    children: [],
  });
}

function buildTable(headers, rows) {
  const widths = autoWidths(headers, rows, CONTENT_WIDTH);
  const cellOf = (value, width, isHeader) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: GRID_BORDERS,
    margins: CELL_MARGINS,
    shading: isHeader ? { fill: 'EAF2F8', type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({
      spacing: { after: 0, line: 280 },
      children: runsFor(value, { size: 19, bold: isHeader, color: isHeader ? NAVY : INK }),
    })],
  });
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((header, column) => cellOf(header, widths[column], true)) }),
      ...rows.map(row => new TableRow({
        children: headers.map((header, column) => cellOf(row[column] === undefined ? '' : row[column], widths[column], false)),
      })),
    ],
  });
}

function codeBlock(lines) {
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'E4E4E4' };
  const body = (lines.length ? lines : ['']).map(line => new Paragraph({
    spacing: { after: 0, line: 240 },
    children: [new TextRun({ text: line === '' ? ' ' : line, font: MONO, size: 17, color: '24292E' })],
  }));
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH],
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        borders: { top: border, bottom: border, left: border, right: border },
        margins: { top: 140, bottom: 140, left: 200, right: 200 },
        shading: { fill: 'F7F7F7', type: ShadingType.CLEAR },
        children: body,
      })],
    })],
  });
}

function callout(lines) {
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'F0D9A8' };
  const body = (lines.length ? lines : ['']).map(line => new Paragraph({
    spacing: { after: 60, line: 300 },
    children: runsFor(line === '' ? ' ' : line, { size: 19, color: '4A3B12' }),
  }));
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH],
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT_WIDTH, type: WidthType.DXA },
        borders: { top: border, bottom: border, left: border, right: border },
        margins: { top: 140, bottom: 140, left: 200, right: 200 },
        shading: { fill: 'FFF7E6', type: ShadingType.CLEAR },
        children: body,
      })],
    })],
  });
}

function listItem(text, reference) {
  return new Paragraph({
    numbering: { reference, level: 0 },
    spacing: { after: 80, line: 310 },
    children: runsFor(text),
  });
}

/**
 * 有序列表用显式编号文本，不用 Word 自动编号：
 * 自动编号在多张列表之间会续号（曾把第五节的列表顶成 4..11），
 * 交付后客户编辑时编号也会自动跳。显式编号所见即所得。
 */
function numberedItem(num, text) {
  return new Paragraph({
    spacing: { after: 80, line: 310 },
    indent: { left: 540, hanging: 280 },
    children: [new TextRun({ text: `${num}. `, font: BODY, size: 21, color: INK }), ...runsFor(text)],
  });
}

function parseBlocks(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  const isSpecial = line => /^\s*$/.test(line) || /^[|>#`]/.test(line) || /^[-*]\s/.test(line) || /^\d+[.)]\s/.test(line) || line.trim() === '---';
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*$/.test(line)) { index += 1; continue; }
    if (line.startsWith('```')) {
      index += 1;
      const buffer = [];
      while (index < lines.length && !lines[index].startsWith('```')) { buffer.push(lines[index]); index += 1; }
      index += 1;
      blocks.push({ type: 'code', lines: buffer });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (line.trim() === '---') { blocks.push({ type: 'rule' }); index += 1; continue; }
    if (line.startsWith('|')) {
      const raw = [];
      while (index < lines.length && lines[index].startsWith('|')) {
        raw.push(lines[index].replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()));
        index += 1;
      }
      const separator = raw[1] !== undefined && raw[1].every(cell => /^:?-+:?$/.test(cell));
      blocks.push({ type: 'table', headers: raw[0], rows: separator ? raw.slice(2) : raw.slice(1) });
      continue;
    }
    if (line.startsWith('>')) {
      const buffer = [];
      while (index < lines.length && lines[index].startsWith('>')) {
        buffer.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', lines: buffer });
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items = [];
      while (index < lines.length) {
        const item = /^[-*]\s+(.*)$/.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (/^\d+[.)]\s/.test(line)) {
      const items = [];
      while (index < lines.length) {
        const item = /^(\d+)[.)]\s+(.*)$/.exec(lines[index]);
        if (!item) break;
        items.push({ num: item[1], text: item[2] });
        index += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    const buffer = [];
    while (index < lines.length && !isSpecial(lines[index])) { buffer.push(lines[index]); index += 1; }
    if (buffer.length === 0) {
      // 兜底：这一行被判为特殊，却没有任何分支接住它（例如段落行以行内代码开头，
      // 或「#」后不带空格的伪标题）。此处必须消费掉这一行，否则 index 不前进，
      // 本分支原地空转、无限 push 空段落，最终堆耗尽 OOM。
      blocks.push({ type: 'p', text: lines[index] });
      index += 1;
      continue;
    }
    blocks.push({ type: 'p', text: buffer.join(' ') });
  }
  return blocks;
}

const blocks = parseBlocks(fs.readFileSync(src, 'utf8'));
const children = [];
let titleRendered = false;

function push(node) {
  if (node instanceof Table && children.length > 0 && children[children.length - 1] instanceof Table) {
    children.push(new Paragraph({ spacing: { after: 0 }, children: [] }));
  }
  children.push(node);
}

for (const block of blocks) {
  if (block.type === 'h' && block.level === 1 && !titleRendered) {
    push(kicker());
    push(heading1(block.text));
    push(subtitle());
    titleRendered = true;
    continue;
  }
  if (block.type === 'h' && block.level === 1) { push(heading1(block.text)); continue; }
  if (block.type === 'h' && block.level === 2) { push(heading2(block.text)); continue; }
  if (block.type === 'h') { push(heading3(block.text)); continue; }
  if (block.type === 'rule') { push(ruleLine()); continue; }
  if (block.type === 'table') { push(buildTable(block.headers, block.rows)); push(new Paragraph({ spacing: { after: 0 }, children: [] })); continue; }
  if (block.type === 'code') { push(codeBlock(block.lines)); continue; }
  if (block.type === 'quote') { push(callout(block.lines)); continue; }
  if (block.type === 'ul') { block.items.forEach(item => push(listItem(item, 'bullet-list'))); continue; }
  if (block.type === 'ol') { block.items.forEach(item => push(numberedItem(item.num, item.text))); continue; }
  push(paragraph(block.text));
}

if (!titleRendered) throw new Error('Source markdown has no level-1 heading to use as the document title.');

const stamp = new Date().toLocaleDateString('sv-SE');
const greyRun = text => new TextRun({ text, font: BODY, size: 16, color: '8C8C8C' });

const doc = new Document({
  styles: {
    default: { document: { run: { font: BODY, size: 21, color: INK }, paragraph: { spacing: { line: 320 } } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: BODY, size: 30, bold: true, color: NAVY }, paragraph: { spacing: { before: 340, after: 150 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: BODY, size: 24, bold: true, color: BLUE }, paragraph: { spacing: { before: 250, after: 100 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullet-list', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 540, hanging: 280 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 940, bottom: 1134, left: 940 } } },
    headers: {
      default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [greyRun('浴缸竞品分析 · 字段与配置参考')] })] }),
    },
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
        greyRun(`${stamp}  |  第 `),
        new TextRun({ children: [PageNumber.CURRENT], font: BODY, size: 16, color: '8C8C8C' }),
        greyRun(' 页'),
      ] })] }),
    },
    children,
  }],
});

fs.mkdirSync(path.dirname(out), { recursive: true });
Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(out, buffer);
  console.log(`rendered ${blocks.length} blocks -> ${out} (${buffer.length} bytes)`);
});
