import { classifyPriceBand } from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';

const PRICE_BANDS = ['1000以下', '1000-3000', '3000-6000', '6000-8000', '8000以上'];
const REAL_MATERIALS = ['亚克力', '人造石', '塑料', '陶瓷', '钢瓷', '铸铁', '木', '搪瓷'];
const HUMAN_MADE_STONE_ALIASES = ['人造石', 'PMMA', '高分子', '绮美石', '可丽耐', '杜邦石', '亚克力人造石'];

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

export function selectFirstMaterial(title) {
  const source = text(title).toLowerCase();
  const candidates = [
    ...HUMAN_MADE_STONE_ALIASES.map((alias) => ({ alias, material: '人造石' })),
    ...REAL_MATERIALS.filter((material) => material !== '人造石')
      .map((material) => ({ alias: material, material })),
  ].flatMap(({ alias, material }) => {
    const index = source.indexOf(alias.toLowerCase());
    return index < 0 ? [] : [{ index, material, length: alias.length }];
  });
  candidates.sort((left, right) => left.index - right.index || right.length - left.length);
  return candidates[0]?.material ?? '无注明';
}

function field(record, name) {
  return record?.fields?.[name];
}

function productId(record) {
  return text(field(record, '商品ID')) || text(field(record, '商品链接')).match(/[?&]id=(\d+)/u)?.[1] || '';
}

function periodMatches(record, startDate, endDate) {
  const start = text(field(record, '数据开始日期'));
  const end = text(field(record, '数据结束日期'));
  if (!start && !end) return true;
  const normalize = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return value;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(parsed));
  };
  return normalize(start) === startDate && normalize(end) === endDate;
}

function amount(record) {
  const price = numeric(field(record, '价格'));
  const count = numeric(field(record, '月收货人数计算值'));
  if (price === null || count === null || price < 0 || count < 0) return null;
  const value = price * count;
  return Number.isFinite(value) ? value : null;
}

function addShare(rows, total) {
  return rows.map((item) => ({ ...item, share: total > 0 ? item.amount / total : 0 }));
}

function topNWithOther(rows, topN, total) {
  const limit = Number.isInteger(topN) && topN > 0 ? topN : 5;
  const sorted = [...rows].sort((left, right) => right.amount - left.amount || left.name.localeCompare(right.name, 'zh-CN'));
  const visible = sorted.slice(0, limit);
  const remainder = sorted.slice(limit).reduce((sum, item) => sum + item.amount, 0);
  if (remainder > 0) visible.push({ name: '其他', amount: remainder });
  return addShare(visible, total);
}

function buildBuckets(names) {
  return new Map(names.map((name) => [name, 0]));
}

export function buildCompetitorVisualization({ records, startDate, endDate, topN = 5 }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(endDate)) {
    throw new Error('Visualization period must use YYYY-MM-DD');
  }
  const current = (records ?? []).filter((record) => (
    periodMatches(record, startDate, endDate)
    && text(field(record, '批次有效性')) === '有效'
    && text(field(record, '是否有效竞品')) === '是'
  ));
  const unique = new Map();
  for (const record of current) {
    const id = productId(record);
    if (!id) throw new Error(`Visualization row ${record.record_id ?? '<unknown>'} has no product ID`);
    if (unique.has(id)) throw new Error(`Visualization period contains duplicate product ID: ${id}`);
    unique.set(id, record);
  }

  const materialAmounts = new Map();
  const priceBandAmounts = buildBuckets(PRICE_BANDS);
  const storeAmounts = new Map();
  const bHighValueRanking = [];
  let coveredAmount = 0;
  let unknownAmountRows = 0;
  let lowerBoundRows = 0;

  for (const record of unique.values()) {
    const value = amount(record);
    if (value === null) {
      unknownAmountRows += 1;
      continue;
    }
    coveredAmount += value;
    if (text(field(record, '计算口径')) === '下限值' || text(field(record, '月收货人数')).endsWith('+')) lowerBoundRows += 1;
    const material = selectFirstMaterial(field(record, '商品标题'));
    materialAmounts.set(material, (materialAmounts.get(material) ?? 0) + value);
    const price = numeric(field(record, '价格'));
    const band = price === null ? '' : classifyPriceBand(price);
    if (priceBandAmounts.has(band)) priceBandAmounts.set(band, priceBandAmounts.get(band) + value);
    const store = text(field(record, '店铺名')) || '店铺未知';
    storeAmounts.set(store, (storeAmounts.get(store) ?? 0) + value);
    if (text(field(record, '竞品分类')) === 'B-高价值竞品') {
      bHighValueRanking.push({
        productId: productId(record),
        title: text(field(record, '商品标题')),
        link: text(field(record, '商品链接')),
        store,
        amount: value,
      });
    }
  }

  const toRows = (map, compare) => addShare([...map.entries()]
    .sort(compare ?? (([left], [right]) => left.localeCompare(right, 'zh-CN')))
    .map(([name, value]) => ({ name, amount: value })), coveredAmount);
  bHighValueRanking.sort((left, right) => right.amount - left.amount || left.productId.localeCompare(right.productId));
  const materialAmountShare = toRows(materialAmounts, ([leftName, leftAmount], [rightName, rightAmount]) => (
    rightAmount - leftAmount || leftName.localeCompare(rightName, 'zh-CN')
  ));
  const priceBandAmountShare = addShare([...priceBandAmounts.entries()].map(([name, value]) => ({ name, amount: value })), coveredAmount);
  const storeAmountShare = toRows(storeAmounts, ([leftName], [rightName]) => {
    if (leftName === '店铺未知') return 1;
    if (rightName === '店铺未知') return -1;
    return leftName.localeCompare(rightName, 'zh-CN');
  });
  const includedRows = unique.size;
  const presentation = {
    materialAmountShare: topNWithOther(materialAmountShare, topN, coveredAmount),
    priceBandAmountShare,
    storeAmountShare: topNWithOther(storeAmountShare.filter((item) => item.name !== '店铺未知'), topN, coveredAmount)
      .concat(storeAmountShare.filter((item) => item.name === '店铺未知')),
    bHighValueRanking: bHighValueRanking.slice(0, 10).map((item, index) => ({ ...item, rank: index + 1, share: coveredAmount > 0 ? item.amount / coveredAmount : 0 })),
    summary: {
      includedRows,
      coveredAmount,
      unknownAmountRows,
      lowerBoundRows,
      coverage: includedRows > 0 ? (includedRows - unknownAmountRows) / includedRows : 0,
      period: { startDate, endDate },
    },
  };
  return {
    period: { startDate, endDate },
    filters: { batchValidity: '有效', validity: '是' },
    materialAmountShare,
    priceBandAmountShare,
    storeAmountShare,
    bHighValueRanking,
    presentation,
    money: { coveredAmount, unknownAmountRows, lowerBoundRows },
  };
}
