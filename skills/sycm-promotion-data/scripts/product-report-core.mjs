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
  for (const required of ['关键词推广', '人群推广', '30天累计数据', '昨日', '分天']) if (!triggers.includes(required)) throw new Error(`商品报表筛选缺少${required}`);
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
