// 自采 SKU → SKU明细 记录字段的映射（2026-10-26）。
//
// 周表「尺寸 / 适用空间」是 Lookup(19)，源是 SKU明细 的 SKU尺寸 / 适用空间
// （docs/references/COMPETITOR-FIELD-REFERENCE.md §4.5，跨表按商品标题匹配）。
// 所以自采只负责把每个 SKU 落成 SKU明细 的一行，聚合交给飞书。
//
// ⚠️ 空间判定**不在这里重写**。第一版我自己按标题词判（小户型|小空间→小户型、
// 常规卫生间→常规卫生间），方向是错的：线上生效的是
// `competitor-v2-core.classifySkuSpace()`，它按 **SKU 尺寸的数值区间**判
// （0.8–1.2m→小户型，1.3–1.8m→常规卫生间），标题词不参与。
// 实测把 30 个商品按两套规则各跑一遍：标题词版全判「小户型」，
// 真规则版是小户型 433 / 常规卫生间 1096 / 需人工核验 191 —— 差异不是小数。
// 所以这里 import 线上那一份，一处不复制，杜绝两套口径漂移。
//
// 字段装配照抄 runtime/xws-sku-payload-parser.mjs 的 parseXwsSkuPayload：
//   SKU名称   ← 规格文本的第一段
//   SKU规格   ← 属性组合全文
//   SKU尺寸   ← 尺寸属性的**原始值**（不是标准化值）
//   尺寸汇总  ← summarizeSkuDimensions(整个商品所有 SKU 的尺寸) 的区间
//   空间判定状态 / 依据 / 采集状态 / 待补数据项 ← applicableSpaceFields 同口径
//
// 「需人工核验」的行**允许 适用空间 为空**，这是契约内的表示，
// 不是缺数据：SKU明细 的 空间判定状态 闭集就是 ['已判定','需人工核验']，
// 待补数据项 里也有 '空间判定' 这一项。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  SKU_APPLICABLE_SPACES,
  classifySkuSpace,
  summarizeSkuDimensions,
} from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';

// 尺寸维度属性的优先级。实测 1720 行 SKU 里只出现过「长度」。
export const DIMENSION_ATTRS = Object.freeze(['长度', '宽度', '高度', '深度', '直径', '尺寸']);

const text = (value) => String(value ?? '').trim();

// 单个 SKU 的尺寸原始值。取第一个命中的维度属性；都没有就返回空串。
// 注意这是**原始值**（可能是 1700mm），标准化由 classifySkuSpace 负责。
export function skuSizeOf(attrs) {
  if (!attrs || typeof attrs !== 'object') return '';
  for (const name of DIMENSION_ATTRS) {
    const value = text(attrs[name]);
    if (value) return value;
  }
  return '';
}

// 规格文本的第一段，作为 SKU名称。照 parseSpecification 的 name 语义：
// 有分隔符取第一段，没有就用全文。
export function skuNameOf(combo) {
  const source = text(combo);
  if (!source) return '';
  const first = source.split(/[+;；]/u).map((part) => part.trim()).filter(Boolean)[0];
  return first || source;
}

// 空间判定相关字段。与 xws-sku-payload-parser 的 applicableSpaceFields 同口径，
// 两个细节必须一致：需人工核验时适用空间留空且待补数据项=[空间判定]；
// 采集状态跟着判定状态走，不允许出现「已采集但没判定」。
export function spaceFields(space) {
  const fields = {
    空间判定状态: space.status,
    空间判定依据: space.evidence,
    采集状态: space.status === '已判定' ? '已采集' : '需人工核验',
  };
  if (space.applicableSpace) fields.适用空间 = space.applicableSpace;
  if (space.status !== '已判定') fields.待补数据项 = ['空间判定'];
  return fields;
}

// 一个 SKU → SKU明细 的一行。缺 source 字段直接抛，不猜。
export function buildSkuFields({ source, skuId, combo, attrs, dimensionSummary }) {
  const itemId = text(source?.itemId);
  const sku = text(skuId);
  if (!/^\d{1,30}$/u.test(itemId)) throw new Error(`商品 ID 不合法：${source?.itemId}`);
  if (!sku) throw new Error(`SKU ID 为空：${itemId}`);
  const link = text(source?.link);
  if (!link) throw new Error(`商品链接为空：${itemId}`);
  const competitorClass = text(source?.competitorClass);
  if (!competitorClass) throw new Error(`竞品分类为空：${itemId}`);
  const mainRecordId = text(source?.mainRecordId);
  if (!mainRecordId) throw new Error(`主表 recordId 为空：${itemId}`);

  const dimension = skuSizeOf(attrs ?? {});
  const specification = text(combo);
  const name = skuNameOf(specification);
  const space = classifySkuSpace({ skuSize: dimension, skuSpec: specification, skuName: name });

  return {
    商品链接: link,
    商品标题: text(source.title),
    竞品分类: competitorClass,
    SKU名称: name,
    SKU规格: specification,
    SKU尺寸: dimension,
    尺寸汇总: text(dimensionSummary),
    ...spaceFields(space),
    商品ID: itemId,
    SKU唯一键: `${itemId}|${sku}`,
    // 关系字段在 batch_create 里必须是 recordId 数组。
    所属竞品: [mainRecordId],
  };
}

// 一个商品的全部 SKU → 行数组。尺寸汇总按商品算一次，回填到每一行。
export function buildItemRows({ source, skus = [] }) {
  const sizes = skus.map((sku) => skuSizeOf(sku?.attrs ?? {}));
  const dimensionSummary = summarizeSkuDimensions(sizes);
  return skus.map((sku) => buildSkuFields({
    source,
    skuId: sku?.skuId,
    combo: sku?.combo,
    attrs: sku?.attrs ?? {},
    dimensionSummary,
  }));
}

// 解析 属性JSON 一列。三种情况必须分开，不能混：
//   空单元格 → {}    这个 SKU 没有属性，属正常
//   解析失败 → null  数据脏了
//   合法但非对象（"abc" / null / [1,2]）→ null，同样是脏数据
// 当成 {} 会让脏行伪装成「无属性」，那是最难查的一类静默错误。
export function parseAttrsCell(cell) {
  const raw = text(cell);
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

// 极简 CSV 解析（只处理本项目 toCsv 产出的形状：BOM、CRLF、引号转义）。
export function parseCsv(textValue) {
  const source = text(textValue).replace(/^\ufeff/u, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((line) => line.some((cell) => text(cell) !== ''));
}

// 读若干份 sku.csv，按商品聚合成 { itemId, title, skus: [{skuId, combo, attrs}] }。
// 同商品多轮出现时以先出现的标题为准，SKU 按 SKU ID 去重（重跑同一轮不会翻倍）。
export function collectSkuItems(files) {
  const byItem = new Map();
  let dirtyAttrs = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    if (!rows.length) continue;
    const header = rows[0];
    const at = (name) => header.indexOf(name);
    const [idAt, titleAt, skuAt, comboAt, attrsAt] = ['商品ID', '商品标题', 'SKU ID', '属性组合', '属性JSON'].map(at);
    if (idAt < 0 || titleAt < 0 || skuAt < 0) throw new Error(`${file} 缺少 商品ID / 商品标题 / SKU ID 列`);
    for (const line of rows.slice(1)) {
      const itemId = text(line[idAt]);
      const skuId = text(line[skuAt]);
      if (!itemId || !skuId) continue;
      const bucket = byItem.get(itemId) || { itemId, title: text(line[titleAt]), skus: new Map() };
      if (bucket.skus.has(skuId)) continue;
      const parsed = attrsAt >= 0 ? parseAttrsCell(line[attrsAt]) : {};
      if (parsed === null) dirtyAttrs += 1;
      bucket.skus.set(skuId, { skuId, combo: comboAt >= 0 ? text(line[comboAt]) : '', attrs: parsed ?? {} });
      byItem.set(itemId, bucket);
    }
  }
  return {
    items: [...byItem.values()].map((bucket) => ({ ...bucket, skus: [...bucket.skus.values()] })),
    dirtyAttrs,
  };
}

// 商品级汇总，只用来判断「这家能不能整批落」和「落完大概长什么样」。
export function summarizeItem({ item, rows }) {
  const judged = rows.filter((row) => row.空间判定状态 === '已判定').length;
  const withSize = rows.filter((row) => text(row.SKU尺寸) !== '').length;
  const spaces = rows.reduce((acc, row) => {
    const space = text(row.适用空间);
    if (space) acc[space] = (acc[space] || 0) + 1;
    return acc;
  }, {});
  return {
    itemId: item.itemId,
    title: item.title,
    skuCount: rows.length,
    judged,
    review: rows.length - judged,
    withSize,
    withoutSize: rows.length - withSize,
    spaces,
    dimensionSummary: rows[0]?.尺寸汇总 ?? '',
    // ready 的判定标准放在一处：整家都能判定且每行都有原始尺寸，
    // 才会让周表两个 Lookup 同时有值。否则如实报 partial。
    status: judged === rows.length && withSize === rows.length
      ? 'ready'
      : (judged === 0 && withSize === 0 ? 'unusable' : 'partial'),
  };
}

// 校验：任何越界的空间值都不许出现在待写数据里。
export function assertApprovedSpaces(rows) {
  for (const row of rows) {
    const space = text(row.适用空间);
    if (space && !SKU_APPLICABLE_SPACES.includes(space)) {
      throw new Error(`适用空间 越界：${space}（唯一键 ${row.SKU唯一键}）`);
    }
  }
  return rows;
}

// CLI：只出报告，不写飞书。
// node runtime/taobao-sku-dimension-core.mjs --sku a.csv [--sku b.csv] [--out report.json]
function parseCliArgs(argv) {
  const files = [];
  let out = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sku') { files.push(argv[i + 1]); i += 1; continue; }
    if (argv[i] === '--out') { out = argv[i + 1]; i += 1; continue; }
    throw new Error(`未知参数：${argv[i]}`);
  }
  if (!files.length) throw new Error('至少给一个 --sku <csv>');
  return { files, out };
}

// 与仓库其余 runtime 脚本同一判法。不能用 endsWith(文件名)：同名文件会误判。
const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const { files, out } = parseCliArgs(process.argv.slice(2));
  const { items, dirtyAttrs } = collectSkuItems(files);

  // 占位 source：CLI 只做口径预览，不写飞书，所以主表字段留空；
  // 缺链接/分类时 buildSkuFields 会抛，这里补成显式占位并标注。
  const summaries = items.map((item) => {
    const source = {
      itemId: item.itemId, title: item.title, link: 'about:report-only',
      competitorClass: '无分类', mainRecordId: 'report-only',
    };
    const rows = buildItemRows({ source, skus: item.skus });
    return summarizeItem({ item, rows });
  });
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFiles: files,
    itemCount: summaries.length,
    skuCount: summaries.reduce((sum, item) => sum + item.skuCount, 0),
    dirtyAttrs,
    statusCounts: summaries.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {}),
    spaceCounts: summaries.reduce((acc, item) => {
      for (const [space, n] of Object.entries(item.spaces)) acc[space] = (acc[space] || 0) + n;
      return acc;
    }, {}),
    reviewSkuCount: summaries.reduce((sum, item) => sum + item.review, 0),
    items: summaries,
  };
  const json = `${JSON.stringify(payload, null, 1)}\n`;
  if (out) { fs.writeFileSync(out, json, 'utf8'); console.log(`[尺寸] 写出 ${out}`); }
  else process.stdout.write(json);
  console.error(`[尺寸] ${payload.itemCount} 个商品 / ${payload.skuCount} 个 SKU；状态 ${JSON.stringify(payload.statusCounts)}；空间 ${JSON.stringify(payload.spaceCounts)}；需人工核验 SKU ${payload.reviewSkuCount}`);
}
