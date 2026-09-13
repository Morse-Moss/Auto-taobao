import { basename } from 'node:path';
import { readFile as readFileDefault } from 'node:fs/promises';

import { buildRecordFields, validateSourceHeaders, validateTarget } from './import-core.mjs';

function shanghaiMidnight(dateText) {
  const value = Date.parse(`${dateText}T00:00:00+08:00`);
  if (!Number.isFinite(value)) throw new Error(`Invalid date (expected YYYY-MM-DD): ${dateText}`);
  return value;
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function validateManifest(manifest) {
  const countField = validateSourceHeaders(manifest.headers);
  if (!Array.isArray(manifest.rows) || manifest.rows.length === 0) {
    throw new Error('XLSX contains no data rows');
  }
  const imagesByRow = new Map();
  for (const image of manifest.images ?? []) {
    const list = imagesByRow.get(image.row) ?? [];
    list.push(image);
    imagesByRow.set(image.row, list);
  }
  const entries = manifest.rows.map((row, index) => {
    const worksheetRow = index + 2;
    const images = imagesByRow.get(worksheetRow) ?? [];
    if (images.length > 1) {
      throw new Error(`Worksheet row ${worksheetRow} must have at most one embedded image; found ${images.length}`);
    }
    // Rows without an embedded image are allowed (e.g. merged workbooks rebuilt
    // from CSV after partial xlsx export failures); 商品图片 stays empty.
    return { row, image: images[0] ?? null };
  });
  return { entries, headers: manifest.headers, countField };
}

export async function runImport({
  manifest,
  client,
  commit = false,
  prepareTarget = false,
  period = null,
  readFile = readFileDefault,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const { entries, headers, countField } = validateManifest(manifest);
  if (!commit) {
    return {
      dryRun: true,
      sourceRows: entries.length,
      sourceImages: entries.filter((entry) => entry.image).length,
      numericTransform: countField === '付款人数'
        ? '付款人数 is preserved as the displayed source text'
        : `${countField} strips a trailing + for the numeric target field`,
    };
  }
  if (!client) throw new Error('A Feishu client is required for commit mode');

  const recordCount = await client.getRecordCount();
  let fields = await client.listFields();
  const imageField = fields.find((field) => field.fieldName === '商品图片');
  if (imageField?.type !== 17 && prepareTarget) {
    if (recordCount !== 0) throw new Error(`Target table must be empty; found ${recordCount} records`);
    if (!imageField) throw new Error('Target table is missing 商品图片');
    await client.updateFieldType(imageField.fieldId, 17);
    fields = await client.listFields();
  }
  validateTarget({ recordCount, fields, headers });

  const fieldTypes = new Map(fields.map((field) => [field.fieldName, field.type]));

  // 周表固有的三个日期字段：目标表存在就必须盖戳（仪表盘"竞品周期"筛选依赖它们）。
  // 缺周期参数直接失败（fail-closed），不允许再产出无日期的周期表。
  const periodDateFields = ['数据开始日期', '数据结束日期', '采集时间'].filter((name) => fieldTypes.get(name) === 5);
  let periodStamp = null;
  if (periodDateFields.length > 0) {
    if (!period?.startDate || !period?.endDate) {
      throw new Error(`Target table has date fields (${periodDateFields.join(', ')}) but no --period-start/--period-end given; refusing to create an undated period table`);
    }
    periodStamp = {
      数据开始日期: shanghaiMidnight(period.startDate),
      数据结束日期: shanghaiMidnight(period.endDate),
      采集时间: shanghaiMidnight(period.collectedAt ?? todayShanghai()),
    };
  }

  const records = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    let imageToken = null;
    if (entry.image) {
      const bytes = await readFile(entry.image.path);
      imageToken = await client.uploadFile({ name: basename(entry.image.path), bytes });
    }
    records.push(buildRecordFields(entry.row, imageToken, headers, fieldTypes));
    if (periodStamp) Object.assign(records[records.length - 1], periodStamp);
    if (index + 1 < entries.length) await sleep(250);
  }

  const recordIds = [];
  for (let start = 0; start < records.length; start += 500) {
    recordIds.push(...await client.batchCreateRecords(records.slice(start, start + 500)));
    if (start + 500 < records.length) await sleep(250);
  }
  if (recordIds.length !== entries.length) {
    throw new Error(`Feishu created ${recordIds.length} records for ${entries.length} source rows`);
  }
  const expectedAttachments = entries.filter((entry) => entry.image).length;
  const saved = await client.listRecords();
  const attachmentCount = saved.reduce((total, record) => {
    const value = record.fields?.商品图片;
    return total + (Array.isArray(value) ? value.length : 0);
  }, 0);
  if (saved.length !== entries.length || attachmentCount !== expectedAttachments) {
    throw new Error(`Feishu verification failed: records=${saved.length}, attachments=${attachmentCount}, expected=${expectedAttachments}`);
  }
  return {
    dryRun: false,
    sourceRows: entries.length,
    importedRows: saved.length,
    attachmentCount,
    periodStamped: periodStamp ? { startDate: period.startDate, endDate: period.endDate, collectedAt: period.collectedAt ?? todayShanghai() } : null,
    recordIds,
  };
}
