function cell(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

function exactIndex(values, expected, label) {
  const matches = values.flatMap((value, index) => (cell(value) === expected ? [index] : []));
  if (matches.length !== 1) throw new Error(`expected one ${label} ${expected}, got ${matches.length}`);
  return matches[0];
}

function exactRow(rows, keyIndex, expected, label) {
  const matches = rows.filter(row => cell(row[keyIndex]) === expected);
  if (matches.length !== 1) throw new Error(`expected one ${label} row ${expected}, got ${matches.length}`);
  return matches[0];
}

function integer(value, label) {
  const raw = cell(value).replaceAll(',', '');
  if (!/^\d+$/u.test(raw)) throw new Error(`invalid ${label}: ${value}`);
  return Number(raw);
}

export function extractInquiryMetrics(table, reportDate, options = {}) {
  const peerBenchmarkRequired = options.peerBenchmarkRequired !== false;
  const headers = table?.headers ?? [];
  const rows = table?.rows ?? [];
  const dateIndex = exactIndex(headers, '日期', 'header');
  const inquiryIndex = exactIndex(headers, '当日询单人数', 'header');
  const datedRows = rows.filter(row => /^\d{4}-\d{2}-\d{2}$/u.test(cell(row[dateIndex])));
  if (datedRows.length !== 1) throw new Error('inquiry source must contain exactly one daily date row');
  const dateRow = exactRow(rows, dateIndex, reportDate, 'date');
  const peerRows = rows.filter(row => cell(row[dateIndex]) === '同行同层均值');
  if (peerRows.length > 1) throw new Error(`expected one benchmark row 同行同层均值, got ${peerRows.length}`);
  // 实测（2026-09-16）：预设「1天」（昨日）给 7 行、含同行同层对比行；
  // 自定义日期给 3 行、同行同层优秀/均值两行都不返回。
  // 这是数据源的限制，不是解析失败 —— 但默认仍然 fail-closed，
  // 只有调用方显式传 peerBenchmarkRequired:false 才降级成「只写询单量」。
  // 顺序上先校验结构再解析数值：否则「表里没有基准行」会被数值错误掩盖。
  if (peerRows.length === 0 && peerBenchmarkRequired) {
    throw new Error('expected one benchmark row 同行同层均值, got 0');
  }
  const inquiry = integer(dateRow[inquiryIndex], '当日询单人数');
  if (peerRows.length === 0) return { inquiry, peerInquiry: null, peerBenchmark: 'PEER_UNAVAILABLE' };
  return {
    inquiry,
    peerInquiry: integer(peerRows[0][inquiryIndex], '同行同层均值/当日询单人数'),
    peerBenchmark: 'PEER_AVAILABLE',
  };
}

export function selectDailyStoreRecord(records, reportDateEpoch, shop) {
  const matches = records.filter(record => Number(record.fields?.['日期']) === reportDateEpoch
    && cell(record.fields?.['店铺']) === shop);
  if (matches.length !== 1) {
    throw new Error(`expected one Feishu row for ${shop} / ${reportDateEpoch}, got ${matches.length}`);
  }
  return matches[0];
}

export function classifyInquiryWrite(fields, metrics) {
  const inquiry = fields?.['询单量'] ?? null;
  const peerInquiry = fields?.['同层同行询单量'] ?? null;
  const blank = (value) => value === null || value === undefined || cell(value) === '';

  // 降级写入：同行基准不可得时，这一格必须保持空白；只有「询单量」参与判定。
  // 这样重复运行仍然返回 ALREADY_VERIFIED，而不是每次都抛错。
  if (metrics.peerInquiry === null || metrics.peerInquiry === undefined) {
    if (!blank(peerInquiry)) {
      throw new Error(`peer benchmark is PEER_UNAVAILABLE but 同层同行询单量 is not blank: ${JSON.stringify(peerInquiry)}`);
    }
    if (blank(inquiry)) return 'WRITE_REQUIRED';
    if (Number(inquiry) === metrics.inquiry) return 'ALREADY_VERIFIED';
    throw new Error(`询单量 ${JSON.stringify(inquiry)} does not match source ${metrics.inquiry}`);
  }

  if (blank(inquiry) && blank(peerInquiry)) return 'WRITE_REQUIRED';
  if (!blank(inquiry) && !blank(peerInquiry)
    && Number(inquiry) === metrics.inquiry && Number(peerInquiry) === metrics.peerInquiry) {
    return 'ALREADY_VERIFIED';
  }
  throw new Error(`inquiry fields are not jointly blank or equal to source: ${JSON.stringify({ inquiry, peerInquiry })}`);
}
