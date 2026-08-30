import { createHash } from 'node:crypto';

import { classifyPriceBand } from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';
import { selectFirstMaterial } from './competitor-visualization-core.mjs';

const ORIGINAL_FIELDS = [
  '序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数', '类目', '同款数',
  '平台', '占位类型', '店铺名', '店铺旺旺', '店铺类型', '地址', '收藏人数', '卖点',
];

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object') return text(value.text ?? value.value ?? value.name ?? '');
  return String(value ?? '').trim();
}

function numeric(value) {
  const source = text(value).replaceAll(',', '');
  if (!source) return null;
  const parsed = Number(source);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function field(record, name) {
  return record?.fields?.[name];
}

function productId(record) {
  return text(field(record, '商品ID')) || text(field(record, '商品链接')).match(/[?&]id=(\d+)/u)?.[1] || '';
}

function dateText(value) {
  const source = text(value);
  if (!source) return '';
  if (/^\d{4}-\d{2}-\d{2}$/u.test(source)) return source;
  const parsed = Number(source);
  if (!Number.isFinite(parsed)) return source;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(parsed));
}

function identity(period, id) {
  return `${period.startDate}_${period.endDate}${id}`;
}

function amountFor(record) {
  const price = numeric(field(record, '价格'));
  const count = numeric(field(record, '月收货人数计算值'));
  if (price === null || count === null) return null;
  const amount = price * count;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function storeDisplayCategories(records) {
  const totals = new Map();
  for (const record of records ?? []) {
    const store = text(field(record, '店铺名'));
    const amount = amountFor(record);
    const valid = text(field(record, '是否有效竞品')) === '是'
      && text(field(record, '批次有效性') || '有效') === '有效';
    if (!valid || !store || amount === null) continue;
    totals.set(store, (totals.get(store) ?? 0) + amount);
  }
  const topStores = new Set([...totals.entries()]
    .sort(([leftName, leftAmount], [rightName, rightAmount]) => rightAmount - leftAmount || leftName.localeCompare(rightName, 'zh-CN'))
    .slice(0, 5)
    .map(([name]) => name));
  return (record) => {
    const store = text(field(record, '店铺名'));
    if (!store) return '店铺未知';
    const valid = text(field(record, '是否有效竞品')) === '是'
      && text(field(record, '批次有效性') || '有效') === '有效'
      && amountFor(record) !== null;
    return valid && topStores.has(store) ? store : '其他';
  };
}

export function buildHistoryRows({ records, period, sourceTable, sourceHash = '', isCurrentPeriod = true }) {
  if (!period || !/^\d{4}-\d{2}-\d{2}$/u.test(period.startDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(period.endDate)) {
    throw new Error('History period must use YYYY-MM-DD');
  }
  if (!sourceTable) throw new Error('History source table is required');
  const seen = new Set();
  const storeCategory = storeDisplayCategories(records);
  return (records ?? []).map((record) => {
    const id = productId(record);
    if (!id) throw new Error(`History row ${record?.record_id ?? '<unknown>'} has no product ID`);
    const key = identity(period, id);
    if (seen.has(key)) throw new Error(`Duplicate history identity: ${key}`);
    seen.add(key);
    const source = record.fields ?? {};
    const amount = amountFor(record);
    const price = numeric(source.价格);
    const store = text(source.店铺名) || '店铺未知';
    const valid = text(source.是否有效竞品) === '是' && text(source.批次有效性 || '有效') === '有效';
    const fields = Object.fromEntries(ORIGINAL_FIELDS.map((name) => [name, source[name] ?? '']));
    if (price === null) delete fields.价格;
    else fields.价格 = price;
    if (!text(source.来源时间)) delete fields.来源时间;
    Object.assign(fields, {
      商品ID: id,
      商品周期唯一键: key,
      快照唯一键: text(source.快照唯一键) || key,
      周期开始日期: period.startDate,
      周期结束日期: period.endDate,
      批次ID: text(source.批次ID),
      搜索关键词: text(source.搜索关键词),
      来源周表: sourceTable,
      是否有效竞品: text(source.是否有效竞品),
      竞品分类: text(source.竞品分类),
      计算口径: text(source.计算口径),
      客单价带分类: price === null ? '' : classifyPriceBand(price),
      材质分类: selectFirstMaterial(source.商品标题),
      店铺名: store,
      店铺展示分类: storeCategory(record),
      金额可计算标记: amount === null ? '否' : '是',
      金额质量状态: amount === null ? '金额不可计算' : '可计算',
      批次有效性: text(source.批次有效性 || '有效'),
      可视化资格: valid && amount !== null ? '是' : '否',
      本期标记: isCurrentPeriod ? '是' : '否',
      来源哈希: sourceHash,
      规则版本: 'competitor-visualization-v1',
      数据状态: amount === null ? '金额不可计算' : text(source.数据状态),
    });
    if (text(source.来源时间)) fields.来源时间 = source.来源时间;
    else delete fields.来源时间;
    if (amount !== null) {
      fields.月收货人数计算值 = source.月收货人数计算值;
      fields.月收货金额 = amount;
      fields.材质金额分摊值 = amount;
    }
    return { fields, sourceRecordId: record.record_id };
  });
}

export function assessCompetitorWeeklyGate({ records, period, expectedRows }) {
  const failures = [];
  if (!period || !/^\d{4}-\d{2}-\d{2}$/u.test(period.startDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(period.endDate)) failures.push('invalid_period');
  if (Number.isInteger(expectedRows) && (records ?? []).length !== expectedRows) failures.push('row_count_mismatch');
  const ids = new Set();
  for (const record of records ?? []) {
    const id = productId(record);
    if (!id || ids.has(id)) failures.push('duplicate_or_missing_product_id');
    ids.add(id);
    if (text(field(record, '快照类型')) === 'mixed_snapshot') failures.push('mixed_snapshot');
    if (text(field(record, '批次有效性')) && text(field(record, '批次有效性')) !== '有效') failures.push('batch_not_valid');
    const start = field(record, '数据开始日期') ?? field(record, '周期开始日期');
    const end = field(record, '数据结束日期') ?? field(record, '周期结束日期');
    if (start && dateText(start) !== period.startDate) failures.push('period_start_mismatch');
    if (end && dateText(end) !== period.endDate) failures.push('period_end_mismatch');
  }
  return { status: failures.length ? '失败' : '通过', failures: [...new Set(failures)], recordCount: (records ?? []).length };
}

export function buildHistoryPlan({ desiredRows, existingRecords }) {
  const existing = new Map();
  for (const record of existingRecords ?? []) {
    const key = text(record.fields?.商品周期唯一键);
    if (!key) throw new Error(`Existing history record ${record.recordId ?? record.record_id ?? '<unknown>'} has no 商品周期唯一键`);
    if (existing.has(key)) throw new Error(`Duplicate existing history identity: ${key}`);
    existing.set(key, { ...record, record_id: record.recordId ?? record.record_id });
  }
  const desired = new Map();
  for (const row of desiredRows ?? []) {
    const key = text(row.fields?.商品周期唯一键);
    if (!key || desired.has(key)) throw new Error(`Duplicate desired history identity: ${key || '<empty>'}`);
    desired.set(key, row);
  }
  const creates = [];
  const updates = [];
  for (const [key, row] of desired) {
    const prior = existing.get(key);
    if (!prior) {
      creates.push(row.fields);
      continue;
    }
    const changed = Object.fromEntries(Object.entries(row.fields).filter(([name, value]) => digest(prior.fields?.[name] ?? '') !== digest(value)));
    if (Object.keys(changed).length) updates.push({ record_id: prior.record_id, fields: changed });
  }
  return { creates, updates, deletes: [], desiredCount: desired.size, existingCount: existing.size };
}

export { ORIGINAL_FIELDS };
