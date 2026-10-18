const SCENES = ['onebpSearch', 'onebpDisplay'];

export function buildProductReportUrl(date) {
  const params = new URLSearchParams({
    rptType: 'item_promotion', startTime: date, endTime: date,
    effectEqual: '30', bizCodeIn: JSON.stringify(SCENES), granularity: 'day',
  });
  return `https://one.alimama.com/index.html#!/report/item_promotion?${params}`;
}

export function validateProductReportState(state, date) {
  const href = String(state?.href ?? '');
  if (!href.includes('#!/report/item_promotion') || !href.includes('rptType=item_promotion')) throw new Error('页面不是阿里妈妈商品报表');
  if (!href.includes(`startTime=${date}`) || !href.includes(`endTime=${date}`) || !href.includes('effectEqual=30')) throw new Error('商品报表日期或30天周期不匹配');
  const triggers = (state?.triggers ?? []).join(' | ');
  for (const required of ['关键词推广', '人群推广', '30天累计数据', '分天']) if (!triggers.includes(required)) throw new Error(`商品报表筛选缺少${required}`);
  // 数据汇总周期：目标日等于昨日时页面回显「昨日」，回填历史日时回显具体日期
  // （SOP §回填历史日：`URL 构造，回显 2026-09-14`；date-picker 探针判据同样是
  // `/\d{4}-\d{2}-\d{2}|昨日|今日/`）。URL 里的 startTime/endTime 已把日期钉死，
  // 这一条只验「UI 真的反映了那个日期」——两种回显都认，缺一不可地都要有其一。
  if (!triggers.includes('昨日') && !triggers.includes(date)) throw new Error(`商品报表筛选日期未落定（期望「昨日」或 ${date}）`);
  if (!triggers.includes('维度 商品')) throw new Error('商品数据明细未选择商品维度');
  const dimensions = state?.dimensions ?? [];
  if (!dimensions.some(x => x.value === 'promotion' && x.checked) || !dimensions.some(x => x.value === 'campaign' && x.checked)) throw new Error('商品数据明细未同时勾选商品和计划');
  if (!String(state?.text ?? '').includes(`商品数据明细`) || !String(state?.text ?? '').includes(date)) throw new Error('商品数据明细日期未落定');
  return { ok: true, date, dimension: '商品+计划' };
}

export const PRODUCT_TASK_PREFIX = '商品报表_';
export const PRODUCT_TASK_RE = /^商品报表_\d{8}_\d{6}$/u;
export const PRODUCT_ZIP_RE = /^商品报表_\d{8}_\d{6}(?: \(\d+\))?\.zip$/u;

export function uniqueNewProductTask(before = [], after = []) {
  const prior = new Set(before);
  const added = [...new Set(after)].filter(name => PRODUCT_TASK_RE.test(name) && !prior.has(name));
  if (added.length !== 1) throw new Error(`商品报表提交任务无法唯一确认: ${JSON.stringify({ before, after, added })}`);
  return added[0];
}

/**
 * 同业务日重跑的自愈：平台对**相同参数**的重复提交不会再生成新任务
 * （2026-10-17 实测：10:13 已经交过一次「10-16 / 商品+计划」，11:09 再交，
 *  任务列表 after 与 before 逐项相同、added=[]），于是 `uniqueNewProductTask` 判「无法唯一确认」。
 * 这种情况不是采集失败，而是「平台已经把这份报表交过了」——正确的处置是**复用那份任务**。
 *
 * 判据只用可核对的事实：任务名里的日期前缀等于**提交当天**（名字里的时间是提交时刻，不是数据日）。
 * 复用**不保证**数据就是目标日（名字里看不出参数），所以调用方必须在导入前用
 * `validatePromotionReport(..., { date })` 把数据日期钉死 —— 那是这条自愈的安全网。
 *
 * 有多个候选时取**最晚**那个（同一天里最后一次提交最接近本次参数）。
 */
export function reuseCandidateTask({ after = [], submittedOn } = {}) {
  const today = String(submittedOn ?? '').replace(/-/gu, '');
  if (!/^\d{8}$/u.test(today)) throw new Error(`reuseCandidateTask 需要提交当天日期（YYYY-MM-DD），收到 ${JSON.stringify(submittedOn)}`);
  const sameDay = [...new Set(after)].filter((name) => PRODUCT_TASK_RE.test(name) && name.startsWith(`商品报表_${today}_`)).sort();
  return sameDay.at(-1) ?? null;
}

/** 任务行里「日期范围」列的形态（`2026-10-17至2026-10-17`）。读不到就返回 null，**不猜**。 */
export const TASK_DATE_RANGE_RE = /(\d{4}-\d{2}-\d{2})\s*(?:至|~|～)\s*(\d{4}-\d{2}-\d{2})/u;

export function taskDateRangeOf(rowText) {
  const match = String(rowText ?? '').match(TASK_DATE_RANGE_RE);
  return match ? { start: match[1], end: match[2] } : null;
}

/**
 * 取件候选集（2026-10-18 加）：**任务只是通道**，业务要的是「目标日那份数据」。
 *
 * 背景（业务方 2026-10-05 口径，日报推广链早已落地，商品链这次才搬过来）：
 * 平台存在「最新那条点了不落盘、紧挨着另一条能下、两条数据等价」的形态，所以通道坏了要能换
 * 一条，而不是和某一条任务绑死。之前商品链只认 `uniqueNewProductTask` 那**一条**，
 * 一条坏了整家就判死（2026-10-18 三家店就是这么缺的）。
 *
 * 判据优先级（只有这两条，绝不「取列表里最新那条」）：
 *   ① `date-range`：行里读得到日期范围且**等于目标日** ⇒ 认这些行；
 *   ② `submitted-day`：读不到日期范围（列没渲染）⇒ 退回「任务名的提交日＝提交当天」。
 *      ⚠️ 这一条只保证「今天交的」，**不保证**参数是目标日 —— 所以下载回来仍必须由导入器
 *      的 `validatePromotionReport(..., { date })` 逐行核日期。判据弱在哪，安全网就必须在哪。
 *
 * `submittedTask` 无论哪种判据都排在最前：它是本次提交**当场确认过**的任务名，最可信。
 * 排序一律「新的在前」—— 补提交出来的那条比老的更可能正常渲染。
 */
export function pickFetchCandidates({ rows = [], date, submittedOn, submittedTask = null } = {}) {
  const seed = submittedTask && PRODUCT_TASK_RE.test(String(submittedTask)) ? [submittedTask] : [];
  const named = [...new Set(rows.map((row) => row?.name).filter((name) => PRODUCT_TASK_RE.test(String(name ?? ''))))];
  const ranged = rows
    .map((row) => ({ name: row?.name, range: taskDateRangeOf(row?.text) }))
    .filter((entry) => entry.range && PRODUCT_TASK_RE.test(String(entry.name ?? '')));
  // 只要**有任意一行**读得到日期范围，就说明这张列表暴露了这一列 ⇒ 一律按日期范围判，
  // 哪怕一条都不等于目标日（那说明目标日那份根本不在列表里，该走补提交，而不是退回「今天交的」去猜）。
  if (ranged.length) {
    const byRange = [...new Set(ranged
      .filter((entry) => entry.range.start === date && entry.range.end === date)
      .map((entry) => entry.name))].sort().reverse();
    return {
      basis: 'date-range',
      candidates: [...new Set([...seed, ...byRange])],
      ignoredCount: named.filter((name) => !byRange.includes(name)).length,
    };
  }
  const today = String(submittedOn ?? '').replace(/-/gu, '');
  if (!/^\d{8}$/u.test(today)) {
    throw new Error(`pickFetchCandidates 需要提交当天日期（YYYY-MM-DD），收到 ${JSON.stringify(submittedOn)}`);
  }
  const sameDay = named.filter((name) => name.startsWith(`商品报表_${today}_`)).sort().reverse();
  return {
    basis: 'submitted-day',
    candidates: [...new Set([...seed, ...sameDay])],
    ignoredCount: named.filter((name) => !sameDay.includes(name)).length,
  };
}
