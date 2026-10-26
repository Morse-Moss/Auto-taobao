// 周表「尺寸 / 适用空间」两个 Lookup 的自采数据侧映射（2026-10-26）。
//
// 为什么单独一个文件：这两个字段在周表上是 Lookup(19)，不是可写字段。
// 周表侧的定义（docs/references/COMPETITOR-FIELD-REFERENCE.md §4.5）：
//   尺寸    ← SKU明细.SKU尺寸  的 LISTCOMBINE().UNIQUE()
//   适用空间 ← SKU明细.适用空间
// 跨表条件是 `SKU明细.商品标题 = 周表.商品标题`（注意是按标题匹配，不是按商品ID）。
// 所以自采要做的事只有一件：**为每个 SKU 产出 SKU尺寸 与 适用空间**，聚合交给飞书。
//
// 两条口径都照抄线上已生效的规则，不新造：
//   1) 尺寸：`长度`。这是全部 928 行已采 SKU 里唯一出现的尺寸维度属性
//      （实测属性名只有 颜色分类 928 / 长度 879 / 颜色 91）。没有 长度 的记空，
//      由「需人工核验」承接 —— skills/xws-sku-collection/SKILL.md 1.8.0 明确：
//      SKU尺寸 是唯一的尺寸来源，不得把 SKU规格 里的厚度之类混进空间判定。
//   2) 适用空间：只认标题里的明确空间词，与 competitor-v2-core.mjs 第 438-439 行
//      已上线的实现同一口径（小户型|小空间 → 小户型；常规卫生间 → 常规卫生间）。
//      没有明确词就留空。`大户型` 永远不产出 —— SKU明细 的契约只允许
//      小户型 / 常规卫生间（adapter.sku-collection.mjs 的 APPROVED_SPACES）。
//
// 注意两层别搞混（2026-10-26 核过）：
//   周表.适用空间   是 Lookup(19)，多选，选项含 大户型/无注明/不适用，只读不可写；
//   SKU明细.适用空间 是真正要我们写的源字段，单值，只接受 小户型/常规卫生间 或空。
//   docs/references/COMPETITOR-FIELD-REFERENCE.md §6.6/6.7 那版允许 大户型、顿号多值、
//   无证据写「无注明」的 AI 口径，文档已标明「线上无处生效」（那个字段现在是 Lookup）。
//   所以这里写 大户型 会被 adapter 直接判 ITEM_INVALID，绝不能为了「看起来更全」加上。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 尺寸维度属性的优先级。当前实测只有「长度」出现，其余是给别的类目留的位置。
export const DIMENSION_ATTRS = Object.freeze(['长度', '宽度', '高度', '深度', '直径', '尺寸']);

// SKU明细.适用空间 的闭集。大户型不在里面，且不许产出。
export const APPROVED_SPACES = Object.freeze(['小户型', '常规卫生间']);

const SPACE_KEYWORDS = Object.freeze([
  ['小户型', ['小户型', '小空间']],
  ['常规卫生间', ['常规卫生间']],
]);

const text = (value) => String(value ?? '').trim();

// 单个 SKU 的尺寸值。取第一个命中的维度属性；都没有就返回空串。
export function skuSizeOf(attrs) {
  if (!attrs || typeof attrs !== 'object') return '';
  for (const name of DIMENSION_ATTRS) {
    const value = text(attrs[name]);
    if (value) return value;
  }
  return '';
}

// 单个 SKU 的适用空间。返回数组（多选字段），按 APPROVED_SPACES 的顺序。
// `sizeText` 参与但不参与数值计算：只在维度缺失时用来记「为什么判不出来」。
export function spacesOf({ title = '', attrs = {} } = {}) {
  const source = text(title);
  const hit = SPACE_KEYWORDS
    .filter(([, words]) => words.some((word) => source.includes(word)))
    .map(([space]) => space);
  // 去过重并保持闭集顺序，杜绝任何越界值溜出去。
  return APPROVED_SPACES.filter((space) => hit.includes(space));
}

// 一个商品所有 SKU 的尺寸值（去重、保留出现顺序）。
export function uniqueSizes(rows) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const size = skuSizeOf(row?.attrs ?? {});
    if (!size || seen.has(size)) continue;
    seen.add(size);
    out.push(size);
  }
  return out;
}

// 把一个商品的多行 SKU 汇总成「周表 Lookup 会算出什么」。
//
// 返回值里的 status 说明这一行的可信度，不要只看值：
//   ready       尺寸和空间都有值，可以直接落 SKU明细
//   needs-size  有 SKU 但没有任何尺寸属性 → 尺寸会空，周表「待补数据项」会报出来
//   needs-space 尺寸有，但标题里没有明确空间词 → 适用空间留空，需人工核验
// dirtyAttrs 单独计数：属性JSON 解析失败的行会被当成「无属性」继续跑，
// 不单独报出来就等于把脏数据洗成正常缺失，那种错误最难发现。
export function summarizeItem({ itemId, title, skus = [] }) {
  const sizes = uniqueSizes(skus);
  const spaces = spacesOf({ title });
  const missingSize = skus.filter((row) => !skuSizeOf(row?.attrs ?? {})).length;
  const dirtyAttrs = skus.filter((row) => row?.dirty === true).length;
  let status = 'ready';
  if (!sizes.length) status = 'needs-size';
  else if (!spaces.length) status = 'needs-space';
  return {
    itemId: text(itemId),
    title: text(title),
    skuCount: skus.length,
    sizes,
    sizeText: sizes.join('、'),      // 对应 尺寸 Lookup 的 LISTCOMBINE().UNIQUE()
    spaces,
    spaceText: spaces.join('、'),
    // 写入侧要的是单值：SKU明细.适用空间 只接受 APPROVED_SPACES 里的一个值或空。
    // 两个词同时命中时按闭集顺序取第一个，并把 spaceAmbiguous 打开，交给人决定。
    space: spaces[0] ?? '',
    spaceAmbiguous: spaces.length > 1,
    // 尺寸为空时的取证：把 颜色分类 的原值抄几行出来。
    // 只做「展示」不做「推导」——SKU尺寸 是唯一尺寸来源，从 颜色分类 里抠尺寸
    // 不在契约内，抠了就等于让周表看起来像采到了，实际没有。
    sizeHints: sizes.length ? [] : distinctValues(skus, '颜色分类', 3),
    missingSize,
    dirtyAttrs,
    status,
  };
}

// 取某个属性的若干个不同值，只用于展示取证，不参与任何判定。
function distinctValues(skus, attrName, limit) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(skus) ? skus : []) {
    const value = text(row?.attrs?.[attrName]);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (out.length < limit) out.push(value);
  }
  return out;
}

// 解析 属性JSON 一列。三种情况必须区分开，不能混成一种：
//   空单元格   → {}    说明这个 SKU 没有属性，属正常
//   解析失败   → null  数据脏了，要能被统计出来
//   合法但非对象（"abc" / null / [1,2]）→ null，同样是脏数据：
//     这一列按契约只存属性对象，出现标量或数组说明上游写错了，
//     当成 {} 会让脏行伪装成「无属性」，这正是最难查的那种静默错误。
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

// 从若干份 sku.csv 汇总出「每个商品 → 尺寸 / 适用空间」。同商品多轮出现时以先出现者为准。
export function summarizeCsvFiles(files) {
  const byItem = new Map();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    if (!rows.length) continue;
    const header = rows[0];
    const idAt = header.indexOf('商品ID');
    const titleAt = header.indexOf('商品标题');
    const attrsAt = header.indexOf('属性JSON');
    if (idAt < 0 || titleAt < 0) throw new Error(`${file} 缺少 商品ID / 商品标题 列`);
    for (const line of rows.slice(1)) {
      const itemId = text(line[idAt]);
      if (!itemId) continue;
      const bucket = byItem.get(itemId) || { itemId, title: text(line[titleAt]), skus: [] };
      // 没有这一列时按「全部无属性」处理，与空单元格同义；有这一列但解析失败时标 dirty。
      const parsed = attrsAt >= 0 ? parseAttrsCell(line[attrsAt]) : {};
      bucket.skus.push({ attrs: parsed ?? {}, dirty: parsed === null });
      byItem.set(itemId, bucket);
    }
  }
  return [...byItem.values()].map(summarizeItem);
}

// CLI：node runtime/taobao-sku-dimension-core.mjs --sku a.csv --sku b.csv [--out report.json]
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
  const items = summarizeCsvFiles(files);
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFiles: files,
    itemCount: items.length,
    skuCount: items.reduce((sum, item) => sum + item.skuCount, 0),
    // 非 0 就是上游写过脏行，要回到源头看，别只看 statusCounts。
    dirtyAttrsCount: items.reduce((sum, item) => sum + item.dirtyAttrs, 0),
    statusCounts: items.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {}),
    // 直接给出要人看的那几条，别让人去 items 里翻 status。
    needsReview: items
      .filter((item) => item.status !== 'ready' || item.spaceAmbiguous)
      .map((item) => ({
        itemId: item.itemId,
        title: item.title,
        status: item.status,
        spaceAmbiguous: item.spaceAmbiguous,
        sizeHints: item.sizeHints,
      })),
    items,
  };
  const json = `${JSON.stringify(payload, null, 1)}\n`;
  if (out) { fs.writeFileSync(out, json, 'utf8'); console.log(`[尺寸] 写出 ${out}`); }
  else process.stdout.write(json);
  console.error(`[尺寸] ${payload.itemCount} 个商品 / ${payload.skuCount} 个 SKU；状态 ${JSON.stringify(payload.statusCounts)}`);
}
