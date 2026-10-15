// 推广日报对账门（2026-10-15，用户拍板「要」）——核心判据，纯函数、零 I/O。
//
// 为什么必须有：整条链此前没有任何一环拿「参与采集 8 家 × 2 种报表 × 目标日」这个分母去对
// 「飞书里实际有多少」。execution、告警文案、驻留的「缺口补上了」全是过程信号不是结果信号
// —— 2026-10-15 07:00 轮第 2 批 3 家整批没跑，却被回执 SUCCEEDED、告警「已恢复」、驻留
// RESUMED_OK 三个过程信号接力洗绿。本模块只回答一个问题：目标日的数据在飞书里到底齐不齐。
//
// 数据模型（2026-10-15 实测钉死；人群归属模型当日二次修正）：
//   · 人群导出有「主体ID」列 ⇒ 飞书人群行可按店归属，但主体ID 是**行级维度、一店多主体**
//     （2026-10-14 实测：5 家店各 5-11 个主体ID、跨店互不相交；按「店主体集合」对当日行求和，
//     逐家与回执源行数吻合：13/20/80/18/18，总和 149＝飞书当日行数）。
//     「店 → 主体ID 集合」的唯一真实来源＝导入时从该店 CSV 捕获、落在回执里的 subjectIds；
//     ⚠️ 阿里妈妈会员ID（alimamaMemberId，9-10 位）与主体ID（13 位）是**不同标识空间**，
//     用会员ID做人群归属会把全部店判成 MISMATCH（2026-10-15 实跑踩过），不可混用。
//   · 关键词导出**没有**「主体ID」列（77 列实测）⇒ 飞书关键词行按店不可归属；
//     核验走「回执 recordIds × 飞书独立回读」，外加整表当日行数与回执行数总和的轮级对账。
//   · 回执（import-promotion-daily-report.mjs 落的 receipt.json）是「写了什么」的事实源：
//     recordIds＝新建的行；plannedRows＝新写行数；skippedRows＝已存在被跳过的行数；
//     subjectIds＝该店本次 CSV 实测的主体ID 去重集合（2026-10-15 起新回执才有，旧回执回退 recordIds）。
//
// 判据纪律：
//   · 「导入成功但 0 行」（平台真实为空）单列为 ZERO_CONFIRMED——不算缺口、不算正常，
//     交人工确认一次（用户口径：真实为空就为空，不填 0）。
//   · 写入成功只认独立回读：recordIds 在飞书里逐个存在、或主体ID 当日行数与回执吻合，
//     才算 VERIFIED；回执说写了但回读对不上 ⇒ UNVERIFIED（按「收据也会假绿」纪律处理）。
//   · 读不到不冒充成功：没有回执、回读不到 ⇒ MISSING / UNVERIFIED，进缺口名单。
import { promotionDateTimestamp } from './promotion-daily-report-core.mjs';

export const PROMOTION_KINDS = Object.freeze(['keyword', 'audience']);

/** 期望分母：shops × kinds。shops 由调用方给（唯一来源＝collectingShopKeys()）。 */
export function expectedUnits({ shops = [], kinds = PROMOTION_KINDS } = {}) {
  return (Array.isArray(shops) ? shops : []).flatMap((shop) => (Array.isArray(kinds) ? kinds : []).map((kind) => ({ shop, kind })));
}

/**
 * 从一份份导入回执聚合出 per {shop,kind} 的事实。
 * 入参 receipts＝已解析的 receipt.json 对象数组（可多轮多份：重试/续跑会产生多份）。
 * 给了 `date` 就只收该业务日的回执（CLI 侧过滤过一道，纯函数层再守一道——两道都过才不靠约定）。
 * recordIds 取**并集**（任何一次写下的行都算「写进去了」）；subjectIds 同样取并集
 * （同一店同一日多份回执时主体集合应一致，并集容错）；totalSourceRows＝
 * plannedRows+skippedRows 的最大值（同一天多份回执时，后一份常是「全部已存在」的 0/0，
 * 取最大值代表这一天该单元总共见过的源行数）。
 */
export function receiptFacts(receipts = [], { date = null } = {}) {
  const facts = new Map();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    const shop = receipt?.shop;
    if (!shop || (date && receipt?.date !== date)) continue;
    for (const kind of PROMOTION_KINDS) {
      const table = receipt?.tables?.[kind];
      if (!table) continue;
      const key = JSON.stringify([shop, kind]);
      const prior = facts.get(key) ?? { shop, kind, receipts: 0, recordIds: new Set(), subjectIds: new Set(), totalSourceRows: 0, apply: false };
      prior.receipts += 1;
      prior.apply = prior.apply || receipt?.mode === 'apply';
      for (const id of Array.isArray(table.recordIds) ? table.recordIds : []) prior.recordIds.add(id);
      for (const id of Array.isArray(table.subjectIds) ? table.subjectIds : []) prior.subjectIds.add(String(id));
      prior.totalSourceRows = Math.max(prior.totalSourceRows, Number(table.plannedRows ?? 0) + Number(table.skippedRows ?? 0));
      facts.set(key, prior);
    }
  }
  return [...facts.values()].map((fact) => ({ ...fact, recordIds: [...fact.recordIds], subjectIds: [...fact.subjectIds].sort() }));
}

/**
 * 店 → 主体ID 集合（跨回执、**不按日期过滤**）：主体ID 是店铺结构属性，别的业务日的回执
 * 里捕获的集合也能用来归属本日的人群行。这是「无本日回执但飞书有行」场景下唯一的真实映射来源。
 */
export function shopSubjectSets(receipts = []) {
  const sets = new Map();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    const shop = receipt?.shop;
    const subjectIds = receipt?.tables?.audience?.subjectIds;
    if (!shop || !Array.isArray(subjectIds)) continue;
    const set = sets.get(shop) ?? new Set();
    for (const id of subjectIds) set.add(String(id));
    sets.set(shop, set);
  }
  return Object.fromEntries([...sets].map(([shop, set]) => [shop, [...set].sort()]));
}

/**
 * 对账主判据：分母 × 回执事实 × 飞书实况 → 逐单元结论。
 *
 * @param {object} o
 * @param {string} o.date               目标日（YYYY-MM-DD；飞书侧按 promotionDateTimestamp 对齐）
 * @param {Array<{shop:string, kind:string}>} o.units   分母（expectedUnits 的输出）
 * @param {Array} o.facts                receiptFacts 的输出
 * @param {{keyword:Array, audience:Array}} o.feishuRecords
 *   每种表的记录数组，形状＝FeishuClient.listRecords() 的返回：[{record_id, fields}]。
 * @param {Object<string,string[]>} [o.subjectSetsByShop]  店 → 主体ID 集合（shopSubjectSets 的输出）。
 *   人群行归属优先用本日回执捕获的 subjectIds，缺（旧回执）再并入这里的跨日集合；都缺则回退
 *   recordIds 独立回读——不再接受会员ID：会员ID 与主体ID 是不同标识空间（2026-10-15 实测）。
 * @returns {object} {date, ok, units:[…], gaps:[…], zeroRows:[…]}
 *   verdict 闭合集：VERIFIED｜VERIFIED_BY_ROUND_COUNT｜ZERO_CONFIRMED｜MISSING｜UNVERIFIED｜MISMATCH
 */
export function judgePromotionCompleteness({
  date, units = [], facts = [], feishuRecords = { keyword: [], audience: [] }, subjectSetsByShop = null,
} = {}) {
  const ts = promotionDateTimestamp(date);
  const factOf = (shop, kind) => facts.find((fact) => fact.shop === shop && fact.kind === kind) ?? null;
  const recordsOf = (kind) => (Array.isArray(feishuRecords?.[kind]) ? feishuRecords[kind] : []);
  // recordIds 回读必须查**各自**的表：人群回执的 recordIds 拿去关键词表查恒不命中（接线坑，
  // 2026-10-15 用例点名抓红过）——按单元的 kind 各建各的 ID 集。
  const idsInTableOf = (kind) => new Set(recordsOf(kind).map((record) => record?.record_id));
  const dateKeywordRows = recordsOf('keyword').filter((record) => Number(record?.fields?.日期) === ts);
  const dateAudienceRows = recordsOf('audience').filter((record) => Number(record?.fields?.日期) === ts);
  const subjectSetOf = (shop) => {
    const own = factOf(shop, 'audience')?.subjectIds ?? [];
    const cross = subjectSetsByShop?.[shop] ?? [];
    return new Set([...(Array.isArray(own) ? own : []), ...(Array.isArray(cross) ? cross : [])].map(String));
  };
  // 店级人群行数：主体ID ∈ 该店主体集合的当日行数；集合未知 ⇒ null（无法归属，别拿 0 冒充）。
  const audienceRowsOfShop = (shop) => {
    const set = subjectSetOf(shop);
    if (set.size === 0) return null;
    return dateAudienceRows.filter((record) => set.has(String(record?.fields?.主体ID ?? ''))).length;
  };
  // 轮级对账的「应然总数」：有回执的那些单元见过的源行数总和（无回执单元不算进来）。
  const keywordReceiptSum = facts.filter((fact) => fact.kind === 'keyword' && fact.totalSourceRows > 0)
    .reduce((sum, fact) => sum + fact.totalSourceRows, 0);
  const audienceReceiptSum = facts.filter((fact) => fact.kind === 'audience' && fact.totalSourceRows > 0)
    .reduce((sum, fact) => sum + fact.totalSourceRows, 0);

  const judged = units.map(({ shop, kind }) => {
    const fact = factOf(shop, kind);
    const note = { shop, kind, verdict: null, plannedRows: fact?.totalSourceRows ?? null, receipts: fact?.receipts ?? 0, verifiedRows: 0, why: '' };
    if (!fact || fact.receipts === 0) {
      // 无回执：人群还能靠主体集合数出来；关键词按店不可归属 ⇒ 只能报「缺回执」。
      if (kind === 'audience') {
        const count = audienceRowsOfShop(shop);
        if (count !== null && count > 0) {
          note.verdict = 'VERIFIED'; note.verifiedRows = count;
          note.why = '无回执但飞书当日已有该店主体集合内的人群行（主体集合来自别日回执捕获）';
          return note;
        }
      }
      note.verdict = 'MISSING';
      note.why = kind === 'keyword'
        ? '没有导入回执，且关键词行按店不可归属——无法区分「没跑」与「平台为空」，按缺口报'
        : '没有导入回执，也没有该店的主体ID集合可归属飞书人群行';
      return note;
    }
    if (fact.totalSourceRows === 0) {
      note.verdict = 'ZERO_CONFIRMED';
      note.why = '回执实证平台当日为空（plannedRows=skippedRows=0）——真实为空，交人工确认一次';
      return note;
    }
    if (kind === 'audience') {
      const count = audienceRowsOfShop(shop);
      if (count !== null) {
        note.verifiedRows = count;
        if (count === fact.totalSourceRows) {
          note.verdict = 'VERIFIED';
          note.why = '该店主体ID集合当日行数与回执源行数吻合（独立回读；主体集合来自回执捕获）';
        } else {
          note.verdict = 'MISMATCH';
          note.why = `该店主体ID集合当日行数 ${count} ≠ 回执源行数 ${fact.totalSourceRows}`;
        }
        return note;
      }
      // 集合未知（旧回执没捕获 subjectIds）⇒ 落到下方 recordIds 独立回读（同一纪律：只认独立回读）。
    }
    const present = fact.recordIds.filter((id) => idsInTableOf(kind).has(id));
    note.verifiedRows = present.length;
    if (present.length === fact.recordIds.length && fact.recordIds.length > 0) {
      note.verdict = 'VERIFIED'; note.why = `recordIds ${present.length} 条在飞书独立回读全部命中`;
      return note;
    }
    if (fact.recordIds.length === 0) {
      // 行全来自更早一轮（本轮全 skipped）⇒ recordIds 为空；退到轮级行数对账（两表各自对）。
      const dateRows = kind === 'keyword' ? dateKeywordRows.length : dateAudienceRows.length;
      const receiptSum = kind === 'keyword' ? keywordReceiptSum : audienceReceiptSum;
      if (dateRows === receiptSum) {
        note.verdict = 'VERIFIED_BY_ROUND_COUNT';
        note.why = `本轮全为已存在行（无新 recordIds）；整表当日 ${dateRows} 行＝各店回执源行数总和（轮级对账吻合）`;
        return note;
      }
    }
    note.verdict = 'UNVERIFIED';
    note.why = fact.recordIds.length === 0
      ? `回执说有 ${fact.totalSourceRows} 行但全无 recordIds 可回读，轮级对账也对不上`
      : `recordIds 回读缺失：${fact.recordIds.length - present.length}/${fact.recordIds.length} 条在飞书不存在`;
    return note;
  });

  const gaps = judged.filter((unit) => ['MISSING', 'UNVERIFIED', 'MISMATCH'].includes(unit.verdict));
  const zeroRows = judged.filter((unit) => unit.verdict === 'ZERO_CONFIRMED');
  return {
    date,
    ok: gaps.length === 0,
    units: judged,
    gaps,
    zeroRows,
    roundCounts: { keywordDateRows: dateKeywordRows.length, keywordReceiptSum, audienceDateRows: dateAudienceRows.length, audienceReceiptSum },
  };
}
