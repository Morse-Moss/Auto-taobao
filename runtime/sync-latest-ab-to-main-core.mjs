import { buildCompetitorRecord } from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';

const RAW_MAIN_FIELDS = [
  '序号', '商品标题', '商品链接', '价格', '月收货人数', '类目', '同款数', '平台',
  '店铺名', '店铺旺旺', '店铺类型', '地址', '收藏人数', '卖点', '搜索关键词',
];
const AI_FALLBACK_FIELDS = ['材质分类'];

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('');
  if (value && typeof value === 'object') return text(value.text ?? value.value ?? value.link ?? value.url ?? '');
  return String(value ?? '').trim();
}

function productId(value) {
  const source = text(value);
  return source.match(/[?&]id=(\d+)/u)?.[1] ?? '';
}

function numberOrText(value) {
  const source = text(value);
  if (!source || source === '-') return source;
  const parsed = Number(source.replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : source;
}

export function latestPeriodRows(historyRecords) {
  const dated = (historyRecords ?? []).filter((record) => Number.isFinite(Number(record.fields?.数据开始日期)));
  if (dated.length === 0) throw new Error('竞品周 source has no dated records');
  const startTimestamp = Math.max(...dated.map((record) => Number(record.fields.数据开始日期)));
  const rows = dated.filter((record) => Number(record.fields.数据开始日期) === startTimestamp);
  return { startTimestamp, rows };
}

export function selectLatestAbRows(historyRecords) {
  const { startTimestamp, rows } = latestPeriodRows(historyRecords);
  const selected = rows.filter((record) => {
    const classification = text(record.fields?.竞品分类);
    const validity = text(record.fields?.是否有效竞品);
    return /^(?:A-|B-)/u.test(classification) && validity === '是';
  });
  const byProduct = new Map();
  for (const record of selected) {
    const id = productId(record.fields?.商品链接) || text(record.fields?.商品ID);
    if (!id) throw new Error(`Latest A/B history record ${record.record_id ?? record.recordId} has no product ID`);
    if (byProduct.has(id)) throw new Error(`Latest A/B history contains duplicate product ID: ${id}`);
    byProduct.set(id, record);
  }
  return { startTimestamp, rows: [...byProduct.values()] };
}

export function mainFieldsFromHistory(record) {
  const source = record.fields ?? {};
  const link = text(source.商品链接);
  const id = productId(link) || text(source.商品ID);
  if (!id || !link) throw new Error('Latest competitor row requires a Taobao product link and ID');
  const fields = {
    商品标题: text(source.商品标题),
    商品链接: link,
    价格: numberOrText(source.价格),
    月收货人数: text(source.月收货人数),
    类目: text(source.类目),
    同款数: text(source.同款数),
    平台: text(source.平台),
    店铺名: text(source.店铺名),
    店铺旺旺: text(source.店铺旺旺),
    店铺类型: text(source.店铺类型),
    地址: text(source.地址),
    收藏人数: text(source.收藏人数),
    卖点: text(source.卖点),
    搜索关键词: text(source.搜索关键词),
  };
  if (!fields.搜索关键词) throw new Error('Latest competitor row requires a search keyword');
  const fallback = buildCompetitorRecord({
    商品标题: fields.商品标题,
    价格: fields.价格,
    月收货人数: fields.月收货人数,
    卖点: fields.卖点,
    是否有效竞品: '是',
  }, { searchKeyword: fields.搜索关键词 });
  const material = text(source.材质分类) || text(fallback.材质分类);
  if (material) fields.材质分类 = material;
  if (text(source.序号)) fields.序号 = text(source.序号);
  for (const name of RAW_MAIN_FIELDS) {
    if (name !== '序号' && fields[name] === undefined) throw new Error(`Missing raw main field: ${name}`);
  }
  return { productId: id, fields };
}

function sameValue(left, right) {
  return text(left) === text(right);
}

export function buildMainUpsertPlan({ historyRecords, mainRecords }) {
  const selected = selectLatestAbRows(historyRecords);
  const mainByProduct = new Map();
  for (const record of mainRecords ?? []) {
    const id = productId(record.fields?.商品链接);
    if (!id) continue;
    if (mainByProduct.has(id)) throw new Error(`竞品主表 contains duplicate product ID: ${id}`);
    mainByProduct.set(id, record);
  }
  const creates = [];
  const updates = [];
  const unchanged = [];
  const items = selected.rows.map((historyRecord) => {
    const source = mainFieldsFromHistory(historyRecord);
    const existing = mainByProduct.get(source.productId);
    if (!existing) {
      creates.push(source.fields);
      return { productId: source.productId, action: 'toCreate', sourceRecordId: historyRecord.record_id ?? historyRecord.recordId };
    }
    const changed = Object.keys(source.fields).some((name) => (
      [...RAW_MAIN_FIELDS, ...AI_FALLBACK_FIELDS].includes(name)
      && !sameValue(existing.fields?.[name], source.fields[name])
    ));
    if (changed) {
      updates.push({ record_id: existing.record_id ?? existing.recordId, fields: source.fields });
      return { productId: source.productId, action: 'toUpdate', mainRecordId: existing.record_id ?? existing.recordId };
    }
    unchanged.push(source.productId);
    return { productId: source.productId, action: 'unchanged', mainRecordId: existing.record_id ?? existing.recordId };
  });
  return {
    period: { startTimestamp: selected.startTimestamp, startDate: new Date(selected.startTimestamp).toISOString().slice(0, 10) },
    items,
    creates,
    updates,
    summary: { latestAbRows: selected.rows.length, toCreate: creates.length, toUpdate: updates.length, unchanged: unchanged.length },
  };
}
