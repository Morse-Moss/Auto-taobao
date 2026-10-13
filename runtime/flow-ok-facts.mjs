// 完成通知的「数字从哪来」—— **独立回读 / 写后回读的工件**，不是链的自报成功计数。
//
// 为什么单独一层（2026-10-13 用户定稿第 5 条）：「8/8 家、底单 8 行、询单表 8 行」
// 这几个数字是收信人判断「今天是不是真的收全了」的唯一依据，所以它们必须来自
// **另一条通路读到的事实**：
//   · 日报链 ⇒ 每一步最后的 `readback` 落盘的 `independent-readback.json`
//     （换一条通路读同一个事实，见 readback-daily-report.mjs 文件头）；
//   · 推广链 ⇒ 导入器写后**重新 listRecords** 数出来的 `receipt.json`；
//   · 商品链 ⇒ 两个导入器的 `receipt.json`（同样带写后回读）。
// 从 summary.json 读「status=ok 的家数」只能证明「链自己觉得成了」，证明不了「表里真有行」。
//
// 本模块只做 IO 与聚合，不判要不要发、不构造告警（那是 alert-copy 的职责）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // 读不到 = 没有结论，**不猜**：缺文件的店不计入数字，也不补 0。
    return null;
  }
}

/** 目录里最新的那个 `independent-readback.json`（含 -rerunN 世代，按 mtime 取新）。 */
function latestReadback(baseDir) {
  const candidates = [baseDir];
  for (let generation = 2; generation <= 9; generation += 1) {
    candidates.push(`${baseDir}-rerun${generation}`);
  }
  let best = null;
  for (const dir of candidates) {
    const file = path.join(dir, 'independent-readback.json');
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best ? readJson(best.file) : null;
}

/** 一份回读里该日的行 ⇒ recordId 集合（没有 recordId 的老工件返回空集）。 */
function onDateIds(rows) {
  const ids = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && typeof row.recordId === 'string' && row.recordId) ids.add(row.recordId);
  }
  return ids;
}

/**
 * 日报链的完成事实：底单行数与询单表行数。
 *
 * 两张表都是**全店共一张**（底单 = 「总数据来源底单」tblIuAX4nPc1zDOO；询单表按
 * 日期 × 店铺一行）：一家店的回读读到的是**整张表在该日的行**，不是「我自己写的
 * 那一行」。2026-10-12 实测：8 家店的底单 onDateCount 是 1/3/4/8/7/6/2/5（求和 36），
 * 而盖文淘宝那份的 3 行里躺着的是里可林家居 / 盖文全卫定制 / 网林家居旗舰店 ——
 * 各家回读时页面模型加载进度不同（loadedRows 不同），**同一个事实被数了 8 遍**，
 * 每遍数量还不一样。求和（1.8.11 的口径）于是把「底单 8 行」说成了「36 行」。
 *
 * 所以口径是**跨店按 recordId 去重取并集**（不是求和、也不是取任一份）：
 *   ① 并集 = 真的行数（2026-10-12 实测并集 8，与「一家一日一行」一致）；
 *      询单表同理（它也是共表，8 家的读数都是 8、行是同一批 recordId）；
 *   ② 老工件没有 onDateRows ⇒ 退回 onDateCount 取**最大值**（不求和）；
 *   ③ 任一回读的行集不齐（`onDateCountIsLowerBound`）⇒ 那个数字只是下界，
 *      **整家不计入**（宁少说一行，不把一个下界说成结论）；
 *   ④ 缺文件的店不计入：读不到 = 没有结论，不补 0。
 */
export function dailyOkFacts({ root, date, shops = [] }) {
  const sourceIds = new Set();
  const inquiryIds = new Set();
  let sourceFallback = 0;
  let inquiryFallback = 0;
  const missing = [];
  for (const shop of shops) {
    const readback = latestReadback(path.join(root, 'evidence', `daily-report-${date}-${shop}`));
    const tables = readback?.tables ?? null;
    const sourceTable = tables?.source ?? null;
    const inquiryTable = tables?.inquiry ?? null;
    if (!sourceTable || sourceTable.onDateCountIsLowerBound) { missing.push(shop); continue; }
    const ids = onDateIds(sourceTable.onDateRows);
    if (ids.size > 0) {
      for (const id of ids) sourceIds.add(id);
    } else {
      sourceFallback = Math.max(sourceFallback, Number(sourceTable.onDateCount) || 0);
    }
    if (inquiryTable && !inquiryTable.onDateCountIsLowerBound) {
      const inquiryShopIds = onDateIds(inquiryTable.onDateRows);
      if (inquiryShopIds.size > 0) {
        for (const id of inquiryShopIds) inquiryIds.add(id);
      } else {
        inquiryFallback = Math.max(inquiryFallback, Number(inquiryTable.onDateCount) || 0);
      }
    }
  }
  const sourceRows = sourceIds.size > 0 ? sourceIds.size : sourceFallback;
  const inquiryRows = inquiryIds.size > 0 ? inquiryIds.size : inquiryFallback;
  // 只列**真有行**的表：0 行的「底单 0 行」出现在完成通知里是一句误导
  // （收信人会以为表建了、只是空的）。一家都没读到时 tables 就是空数组。
  const tables = [];
  if (sourceRows > 0) tables.push({ name: '底单', rows: sourceRows });
  if (inquiryRows > 0) tables.push({ name: '询单表', rows: inquiryRows });
  return { tables, missing };
}

/**
 * 推广链的完成事实：从各批 summary 里逐店读导入器的 `receipt.json`。
 *
 * `receipt.tables[keyword|audience].recordIds` 是**这一次真的建出来的行**（写后还重新
 * listRecords 核对过数量）；没有 recordIds（dry-run 或老版本收据）时退回 plannedRows。
 */
export function promotionOkFacts({ root, summaries = [] }) {
  const rows = { keyword: 0, audience: 0 };
  const missing = [];
  for (const summary of summaries) {
    for (const [shop, record] of Object.entries(summary?.shops ?? {})) {
      if (record?.status !== 'ok') continue;
      const dir = path.join(root, String(record.evidence ?? ''));
      const receipt = readJson(path.join(dir, 'receipt.json'));
      const tables = receipt?.tables ?? null;
      if (!tables) { missing.push(shop); continue; }
      for (const kind of ['keyword', 'audience']) {
        const entry = tables[kind];
        if (!entry) continue;
        const written = Array.isArray(entry.recordIds) ? entry.recordIds.length : Number(entry.plannedRows) || 0;
        rows[kind] += written;
      }
    }
  }
  const tables = [];
  if (rows.keyword > 0) tables.push({ name: '关键词推广', rows: rows.keyword });
  if (rows.audience > 0) tables.push({ name: '人群推广', rows: rows.audience });
  return { tables, missing };
}

/**
 * 商品链的完成事实：两个导入器的 `receipt.json`。
 *
 * `evidence` 是**本轮运行目录**（`evidence/product-data-job-<日>/<runId>/`），
 * 逐店收据在它下面的 `<店>/product-import/receipt.json` 与 `<店>/inquiry-import/receipt-<店>.json`
 * （两个导入器各自的落名，见 import-product-data.mjs / import-inquiry-data.mjs）——
 * 这里按各自的真名读，不假设它们一致。推广段被有意跳过（`--skip-promotion`）时**没有收据**，
 * 那一行自然不出现在数字里（完成通知只说写过的表）。
 */
export function productOkFacts({ evidence, shops = [] }) {
  let productRows = 0;
  let inquiryRows = 0;
  const missing = [];
  for (const shop of shops) {
    const productReceipt = readJson(path.join(evidence, shop, 'product-import', 'receipt.json'));
    if (!productReceipt) { missing.push(shop); continue; }
    productRows += Array.isArray(productReceipt.recordIds)
      ? productReceipt.recordIds.length
      : Number(productReceipt.plannedRows) || 0;
    const inquiryReceipt = readJson(path.join(evidence, shop, 'inquiry-import', `receipt-${shop}.json`));
    if (inquiryReceipt) {
      inquiryRows += Array.isArray(inquiryReceipt.recordIds)
        ? inquiryReceipt.recordIds.length
        : Number(inquiryReceipt.plannedRows) || 0;
    }
  }
  const tables = [{ name: '商品底单', rows: productRows }];
  if (inquiryRows > 0) tables.push({ name: '商品询单', rows: inquiryRows });
  return { tables, missing };
}

/** 批量读一批 summary.json（读不到/解析不了 ⇒ 空数组，不猜）。 */
export function readSummaries(files = []) {
  const out = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const parsed = readJson(file);
    if (parsed && typeof parsed === 'object') out.push(parsed);
  }
  return out;
}

/** 证据根下有哪些批次目录（`b1` / `b2` / …）。用于调用方自己拼 summary 路径。 */
export function batchDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^b\d+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}
