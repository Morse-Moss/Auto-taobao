// 竞品周表「商品ID」这一列的补写判据层（2026-09-21 新建）。
//
// 为什么需要它：`商品ID` 是**文档化的字段**，不是可选的注释。docs/references/COMPETITOR-FIELD-REFERENCE.md
// §4.6 写着「淘宝商品 id，SKU 采集的入口参数」，`competitor-weekly-schema-core.mjs:57` 把它列进周表快照架构。
// 但 2026-09-21 实测：周表 **0/1417 全空**，而同一批商品在主表 1461/2004、SKU明细 830/830 都有值。
//
// 空的**原因不是链接缺 id** —— 实测周表 1417/1417 的商品链接都能提出 id（提不出 0 行）。
// 真正的原因是**从来没有人把链接里的 id 落到这一列**：发布路径
// （competitor-history-publish-core.mjs:41 与 :126）是「读 商品ID，读不到就从链接提，再写进历史总表」，
// 方向是从周表往外流；周表自己这一列没有写入方。所以这不是新口径，是把已有的派生值落盘。
//
// 三条约束（都由 .test.mjs 守着，缺一条都会静默出错）：
//   1) **只填空**。已有值一律不覆盖。这一列会被拿去当跨表联结键，覆盖一次就可能把某行接到
//      另一个商品上，而且完全不报错 —— 典型的静默错。
//   2) 已有值与链接 id **不一致时不写，但必须报出来**（conflict）。成因有两种（链接被换过 /
//      原来那行填错了），要人看一眼，不许脚本替它选一个。
//   3) 提不出 id 的行（noId）**单独计数**，不许并进「已填」—— 实测应为 0，非 0 就是链接形态变了。
import { extractProductId } from './fill-weekly-attribute-labels-core.mjs';

/** 归一：飞书回读的文本列可能是数组或对象，空值一律成空串。 */
export function normalizeCell(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(normalizeCell).join(',');
  if (typeof value === 'object') return normalizeCell(value.text ?? value.value ?? value.name);
  return String(value).trim();
}

/**
 * 纯函数：给定周表行，算出这一列要写什么、不写什么。
 *
 * rows: [{ recordId, existing, link }]（existing 与 link 都已由调用方经 normalizeCell 归一）
 * 返回：updates 只含**要写的**行；stats 把四种处置分开计数，别只看总数。
 */
export function planProductIdFills(rows = [], { extract = extractProductId } = {}) {
  const updates = [];
  const alreadyCorrect = [];
  const conflict = [];
  const noId = [];
  const seen = new Set();

  for (const row of rows) {
    const recordId = normalizeCell(row?.recordId);
    if (!recordId) throw new Error('planProductIdFills: 每一行都要有 recordId（没有它没法写回）');
    if (seen.has(recordId)) throw new Error(`planProductIdFills: recordId 重复 ${recordId}（会把同一行写两次）`);
    seen.add(recordId);

    const link = normalizeCell(row?.link);
    const existing = normalizeCell(row?.existing);
    const derived = normalizeCell(extract(link));

    if (!derived) { noId.push({ recordId, link }); continue; }
    if (existing === derived) { alreadyCorrect.push({ recordId, productId: derived }); continue; }
    if (existing) { conflict.push({ recordId, existing, derived }); continue; }
    updates.push({ recordId, productId: derived });
  }

  return {
    updates,
    stats: {
      rows: rows.length,
      filled: updates.length,
      alreadyCorrect: alreadyCorrect.length,
      conflictCount: conflict.length,
      noIdCount: noId.length,
      conflict,
      noId,
    },
  };
}

/**
 * 读回判据：写完之后这一列还剩几格是空的，只能等于「提不出 id 的行数」。
 *
 * 为什么要单独判一次：写入器报「写成功」和「表上真的有值」是两件事
 * （同仓已踩过 `beforeDigest === afterDigest`＝表内容一字未变却自报 APPLIED）。
 * 空白数多出来，就说明有些行算进了 updates 却没落上 —— 那必须炸，不能含糊成「基本成功」。
 */
export function judgeProductIdBackfill({ stats = {}, blanksAfter = null, rowsAfter = null } = {}) {
  if (!Number.isInteger(blanksAfter)) {
    throw new Error(`judgeProductIdBackfill 需要 blanksAfter（整数），收到 ${JSON.stringify(blanksAfter)}`);
  }
  const expected = stats.noIdCount ?? 0;
  if (rowsAfter != null && Number.isInteger(stats.rows) && rowsAfter !== stats.rows) {
    return { ok: false, expected, actual: blanksAfter,
      detail: `行数变了：写前 ${stats.rows}、写后 ${rowsAfter} —— 先查是不是有人同时在写这张表` };
  }
  return {
    ok: blanksAfter === expected,
    expected,
    actual: blanksAfter,
    detail: blanksAfter === expected
      ? `剩 ${blanksAfter} 格空，正好等于「链接提不出 id」的行数`
      : `剩 ${blanksAfter} 格空，但预期只有 ${expected} 格（提不出 id 的）—— 有行算进了写入却没落上`,
  };
}
