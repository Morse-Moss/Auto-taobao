const SCENES = ['onebpSearch', 'onebpDisplay'];

export const KEYWORD_REPORT_BASE = 'https://one.alimama.com/index.html#!/report/keyword_promotion';
export const KEYWORD_TASK_RE = /^关键词报表_\d{8}_\d{6}$/u;
export const KEYWORD_ZIP_RE = /^关键词报表_\d{8}_\d{6}(?: \(\d+\))?\.zip$/u;
export const AUDIENCE_REPORT_BASE = 'https://one.alimama.com/index.html#!/report/crowd_promotion';
export const AUDIENCE_TASK_RE = /^人群报表_\d{8}_\d{6}$/u;
export const AUDIENCE_ZIP_RE = /^人群报表_\d{8}_\d{6}(?: \(\d+\))?\.zip$/u;

export function buildKeywordReportUrl(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) throw new Error(`invalid date: ${date}`);
  const params = new URLSearchParams({
    rptType: 'keyword_promotion', startTime: date, endTime: date,
    effectEqual: '30', bizCodeIn: JSON.stringify(SCENES), granularity: 'day',
  });
  return `${KEYWORD_REPORT_BASE}?${params}`;
}

export function validateKeywordReportState(state, date) {
  const href = String(state?.href ?? '');
  if (!href.includes('#!/report/keyword_promotion') || !href.includes('rptType=keyword_promotion')) {
    throw new Error('页面不是阿里妈妈关键词报表');
  }
  if (!href.includes(`startTime=${date}`) || !href.includes(`endTime=${date}`) || !href.includes('effectEqual=30')) {
    throw new Error('关键词报表日期或30天周期不匹配');
  }
  const triggers = (state?.triggers ?? []).join(' | ');
  for (const required of ['关键词推广', '人群推广', '30天累计数据', '昨日', '分天']) {
    if (!triggers.includes(required)) throw new Error(`关键词报表筛选缺少${required}`);
  }
  if (!String(state?.text ?? '').includes('关键词数据明细')) throw new Error('关键词数据明细区域未出现');
  const dimensions = state?.dimensions ?? [];
  if (dimensions.length > 0 && !dimensions.every((item) => item.checked)) {
    throw new Error('关键词数据明细维度未全选');
  }
  return { ok: true, date, dimensions: dimensions.length || 'all' };
}

export function uniqueNewKeywordTask(before = [], after = []) {
  const prior = new Set(before);
  const added = [...new Set(after)].filter((name) => KEYWORD_TASK_RE.test(name) && !prior.has(name));
  if (added.length !== 1) throw new Error(`关键词报表提交任务无法唯一确认: ${JSON.stringify({ before, after, added })}`);
  return added[0];
}

export function buildAudienceReportUrl(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) throw new Error(`invalid date: ${date}`);
  const params = new URLSearchParams({
    rptType: 'crowd_promotion', startTime: date, endTime: date,
    effectEqual: '30', bizCodeIn: JSON.stringify(SCENES), granularity: 'day',
  });
  return `${AUDIENCE_REPORT_BASE}?${params}`;
}

export function uniqueNewAudienceTask(before = [], after = []) {
  const prior = new Set(before);
  const added = [...new Set(after)].filter((name) => AUDIENCE_TASK_RE.test(name) && !prior.has(name));
  if (added.length !== 1) throw new Error(`人群报表提交任务无法唯一确认: ${JSON.stringify({ before, after, added })}`);
  return added[0];
}

export function validateExportRows(headers, rows, { kind, expectedColumns, date }) {
  if (!Array.isArray(headers) || headers.length !== expectedColumns) {
    throw new Error(`${kind}报表列数不符: expected=${expectedColumns}, got=${headers?.length}`);
  }
  if (headers.some((header) => typeof header !== 'string' || header.trim() === '')) {
    throw new Error(`${kind}报表存在空表头`);
  }
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicates.length) throw new Error(`${kind}报表存在重复表头: ${[...new Set(duplicates)].join(', ')}`);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${kind}报表没有数据行`);
  const bad = rows.findIndex((row) => !Array.isArray(row) || row.length !== headers.length);
  if (bad >= 0) throw new Error(`${kind}报表第${bad + 2}行列数与表头不一致`);
  const dateIndex = headers.indexOf('日期');
  if (dateIndex < 0 || rows.some((row) => row[dateIndex] !== date)) throw new Error(`${kind}报表日期不是${date}`);
  const sceneIndex = headers.indexOf('场景ID');
  if (sceneIndex >= 0) {
    const expectedScene = kind === '关键词' ? '371' : kind === '人群' ? '372' : null;
    if (expectedScene && rows.some((row) => String(row[sceneIndex]).trim() !== expectedScene)) {
      throw new Error(`${kind}报表场景ID不是${expectedScene}`);
    }
  }
  return { kind, columns: headers.length, rows: rows.length, date };
}

export function validateAudienceReportState(state, date) {
  const href = String(state?.href ?? '');
  if (!href.includes('#!/report/crowd_promotion') || !href.includes('rptType=crowd_promotion')) {
    throw new Error('页面不是阿里妈妈人群报表');
  }
  if (!href.includes(`startTime=${date}`) || !href.includes(`endTime=${date}`) || !href.includes('effectEqual=30')) {
    throw new Error('人群报表日期或30天周期不匹配');
  }
  const triggers = (state?.triggers ?? []).join(' | ');
  for (const required of ['30天累计数据', '昨日', '分天']) {
    if (!triggers.includes(required)) throw new Error(`人群报表筛选缺少${required}`);
  }
  if (!String(state?.text ?? '').includes('人群数据明细')) throw new Error('人群数据明细区域未出现');
  const dimensions = state?.dimensions ?? [];
  const required = ['主题', '时间', '计划'];
  if (dimensions.length && !required.every((name) => dimensions.some((item) => item.checked && String(item.label ?? item.value ?? '').includes(name)))) {
    throw new Error('人群数据明细维度未按主题、时间、计划选中');
  }
  return { ok: true, date, dimensions: dimensions.length || required };
}

export function promotionIdempotencyKey(fields, { shop = null, kind = null } = {}) {
  return JSON.stringify([
    shop,
    kind,
    ...['日期', '场景ID', '计划ID', '主体ID', '宝贝ID', '单元ID', '词ID/词包ID', '人群名字']
      .map((name) => fields?.[name] ?? null),
  ]);
}

export function buildFeishuFields(headers, values, targetFields) {
  const fields = {};
  for (const [index, sourceName] of headers.entries()) {
    if (!targetFields.has(sourceName) || ['空列', '店铺', '主图'].includes(sourceName)) continue;
    const value = values[index];
    if (value === '' || value === null || value === undefined) continue;
    const type = targetFields.get(sourceName);
    if (sourceName === '日期') {
      const [year, month, day] = String(value).split('-').map(Number);
      fields[sourceName] = Date.UTC(year, month - 1, day) - 8 * 3600 * 1000;
    } else if (type === 2 && /^-?\d+(?:\.\d+)?$/u.test(String(value).trim())) {
      fields[sourceName] = Number(value);
    } else fields[sourceName] = value;
  }
  return fields;
}
