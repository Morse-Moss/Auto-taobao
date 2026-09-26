const PROMOTION_IDENTITY_FIELDS = Object.freeze(['日期', '场景ID', '原二级场景ID', '计划ID', '主体ID']);
export function promotionKey(row, headers) {
  const values = Array.isArray(row) ? Object.fromEntries(headers.map((name, index) => [name, row[index]])) : row;
  return JSON.stringify(PROMOTION_IDENTITY_FIELDS.map((name) => [
    name,
    name === '日期' && values[name] !== null && values[name] !== undefined
      ? (Number.isFinite(Number(values[name])) ? Number(values[name]) : values[name])
      : (values[name] === null || values[name] === undefined ? null : String(values[name])),
  ]));
}

export function validatePromotionReport(headers, rows) {
  if (!Array.isArray(headers) || !headers.includes('日期') || !headers.includes('场景ID') || !headers.includes('计划ID')) {
    throw new Error('商品报表缺少日期/场景ID/计划ID表头');
  }
  if (![76, 78].includes(headers.length)) throw new Error(`不支持的商品报表列数: ${headers.length}`);
  const bad = rows.findIndex((row) => !Array.isArray(row) || row.length !== headers.length);
  if (bad >= 0) throw new Error(`商品报表第${bad + 2}行列数与表头不一致`);
  return { columns: headers.length, rows: rows.length };
}
export function buildPromotionFields(headers, values, targetNames) {
  const fields = {};
  headers.forEach((name, i) => {
    const target = targetNames.includes(name) ? name : null; const value = values[i];
    if (!target || target.startsWith('字段 ')) return;
    if (target === '日期') { const [y,m,d] = String(value).split('-').map(Number); fields[target] = Date.UTC(y, m - 1, d); return; }
    if (value === '' || value === null || value === undefined) return;
    if (typeof value === 'number') fields[target] = value;
    else if (/^-?\d+(?:\.\d+)?$/u.test(String(value).trim()) && !['场景名字','原二级场景名字','计划名字','主体ID','主体类型','主体名称'].includes(target)) fields[target] = Number(value);
    else fields[target] = value;
  });
  return fields;
}
export function planPromotionImport({ rows, existing, headers, targetNames }) {
  const existingKeys = new Set(existing.map((r) => promotionKey(r.fields ?? {}, headers))); const seen = new Set(); const records=[]; const manifest=[];
  for (const row of rows) { const fields=buildPromotionFields(headers,row,targetNames); const key=promotionKey(fields, headers); if(existingKeys.has(key)||seen.has(key)) continue; seen.add(key); records.push(fields); manifest.push({key, date:fields['日期'], sceneId:fields['场景ID'], sourceFields:headers.length}); }
  return {records,manifest};
}
