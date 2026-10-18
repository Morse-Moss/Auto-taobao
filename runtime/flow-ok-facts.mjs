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
 * 商品链的完成事实：三个导入器的 `receipt.json`。
 *
 * `evidence` 是**本轮运行目录**（`evidence/product-data-job-<日>/<runId>/`），
 * 逐店收据在它下面的 `<店>/product-import/receipt.json` 与 `<店>/inquiry-import/receipt-<店>.json`
 * （两个导入器各自的落名，见 import-product-data.mjs / import-inquiry-data.mjs）——
 * 这里按各自的真名读，不假设它们一致。推广段被有意跳过（`--skip-promotion`）时**没有收据**，
 * 那一行自然不出现在数字里（完成通知只说写过的表）。
 *
 * 2026-10-18 修两处（两张真实告警都踩过）：
 *
 *   ① **不再无条件带上「商品底单」**。旧实现 `tables = [{ name:'商品底单', rows: 0 }]` 是**恒**push 的，
 *      于是同日重跑（底单被去重闸门拦成 0 行、只有推广真写了 53 行）那条完成提醒读起来是
 *      「3/3 家全部收齐。写了：商品底单 0 行。」—— 收信人会以为整轮什么都没写。
 *      同一个文件里 `dailyOkFacts` 早就写明「0 行的『底单 0 行』出现在完成通知里是一句误导」，
 *      商品这一版当时没跟上。现在两张表都只在这轮真的写了行时才出现。
 *   ② **推广段补进数字**。旧实现只读底单与询单两张收据，推广写了多少完全不进通知 ——
 *      而补跑那种轮次恰恰是「底单 0、询单 0、推广 53」。数不出来就等于告诉收信人「没写东西」。
 *
 * 推广收据有**两种落点**（取决于这一批是不是齐）：整批齐 ⇒ `<部门>/receipt.json`（一份覆盖多家，
 * `sources[]` 里逐家带 `rows`）；有一家缺 ZIP ⇒ 退成逐店 `<店>/receipt.json`。所以：
 *   · 先按店读逐店收据；
 *   · 再扫 `promotion-import/` 下**不是店名**的目录（部门），按 `sources[].shop` 逐家归属；
 *     同一家只算一次（`addPromotion` 去重），避免「逐店 + 部门」两份同时存在时翻倍。
 *   · 部门收据没有 `sources`（老工件）时整份算一次，用一个不和店名冲突的键。
 */
export function productOkFacts({ evidence, shops = [] }) {
  let productRows = 0;
  let inquiryRows = 0;
  const missing = [];
  const promotionRows = new Map();
  const rowsOf = (receipt) => (Array.isArray(receipt?.recordIds)
    ? receipt.recordIds.length
    : Number(receipt?.plannedRows) || 0);
  const addPromotion = (key, rows) => {
    if (!key) return;
    if (promotionRows.has(key)) return; // 同一家（或同一份部门收据）只算一次
    promotionRows.set(key, Number(rows) || 0);
  };
  for (const shop of shops) {
    const productReceipt = readJson(path.join(evidence, shop, 'product-import', 'receipt.json'));
    if (!productReceipt) { missing.push(shop); continue; }
    productRows += rowsOf(productReceipt);
    const inquiryReceipt = readJson(path.join(evidence, shop, 'inquiry-import', `receipt-${shop}.json`));
    if (inquiryReceipt) inquiryRows += rowsOf(inquiryReceipt);
    const promotionReceipt = readJson(path.join(evidence, 'promotion-import', shop, 'receipt.json'));
    if (promotionReceipt) addPromotion(shop, rowsOf(promotionReceipt));
  }
  const promotionDir = path.join(evidence, 'promotion-import');
  if (existsSync(promotionDir)) {
    for (const entry of readdirSync(promotionDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || shops.includes(entry.name)) continue; // 店名目录已在上面按店读过
      const receipt = readJson(path.join(promotionDir, entry.name, 'receipt.json'));
      if (!receipt) continue;
      const sources = Array.isArray(receipt.sources) ? receipt.sources : [];
      if (sources.length) {
        for (const item of sources) {
          // 只认本轮名册里的店：部门收据里出现别的部门/别的店的店时不往外报
          if (item?.shop && shops.includes(item.shop)) addPromotion(item.shop, item.rows);
        }
      } else {
        addPromotion(`department:${entry.name}`, rowsOf(receipt));
      }
    }
  }
  const promotionTotal = [...promotionRows.values()].reduce((sum, rows) => sum + rows, 0);
  // 只列**真有行**的表：这一轮没写的表不出现（理由与 dailyOkFacts 同一句）。
  const tables = [];
  if (productRows > 0) tables.push({ name: '商品底单', rows: productRows });
  if (inquiryRows > 0) tables.push({ name: '商品询单', rows: inquiryRows });
  if (promotionTotal > 0) tables.push({ name: '商品推广', rows: promotionTotal });
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
