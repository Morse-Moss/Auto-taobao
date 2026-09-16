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

export function extractInquiryMetrics(table, reportDate) {
  const headers = table?.headers ?? [];
  const rows = table?.rows ?? [];
  const dateIndex = exactIndex(headers, '日期', 'header');
  const inquiryIndex = exactIndex(headers, '当日询单人数', 'header');
  const datedRows = rows.filter(row => /^\d{4}-\d{2}-\d{2}$/u.test(cell(row[dateIndex])));
  if (datedRows.length !== 1) throw new Error('inquiry source must contain exactly one daily date row');
  const dateRow = exactRow(rows, dateIndex, reportDate, 'date');
  const peerRow = exactRow(rows, dateIndex, '同行同层均值', 'benchmark');
  return {
    inquiry: integer(dateRow[inquiryIndex], '当日询单人数'),
    peerInquiry: integer(peerRow[inquiryIndex], '同行同层均值/当日询单人数'),
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
  const current = {
    inquiry: fields?.['询单量'] ?? null,
    peerInquiry: fields?.['同层同行询单量'] ?? null,
  };
  if (current.inquiry === null && current.peerInquiry === null) return 'WRITE_REQUIRED';
  if (current.inquiry !== null && current.peerInquiry !== null
    && cell(current.inquiry) !== '' && cell(current.peerInquiry) !== ''
    && Number(current.inquiry) === metrics.inquiry && Number(current.peerInquiry) === metrics.peerInquiry) {
    return 'ALREADY_VERIFIED';
  }
  throw new Error(`inquiry fields are not jointly blank or equal to source: ${JSON.stringify(current)}`);
}
