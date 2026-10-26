// 离线预演整个导入：拿上一周表的**真实字段类型**，把每一行走一遍 buildRecordFields。
// 不连生产、不写任何东西，但能提前把「哪一行会在 commit 时炸」照出来。
// 2026-10-26 立这道门的原因：numericValue 对非数字是强校验，23 行徽标文案会让
// 1384 行的导入在第 N 条上整批失败——而失败发生在已经上传了 N 张图之后。
import fs from 'node:fs';
import { FeishuClient } from '../skills/xws-to-feishu-base/scripts/feishu-client.mjs';
import { buildRecordFields, validateTarget, XWS_HEADERS } from '../skills/xws-to-feishu-base/scripts/import-core.mjs';
import { activeProfileName, competitorBaseToken, envFilePath } from './feishu-targets.mjs';

const REFERENCE_TABLE = process.argv[2];
const manifestPath = process.argv[3];
if (!REFERENCE_TABLE || !manifestPath) {
  console.error('用法: node runtime/preflight-weekly-import.mjs <参考表id> <extract-manifest.json>');
  process.exit(2);
}

const env = {};
for (const line of fs.readFileSync(envFilePath(activeProfileName()), 'utf8').split(/\r?\n/u)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 1) continue;
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[t.slice(0, i).trim()] = v;
}
const client = new FeishuClient({
  appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET,
  appToken: competitorBaseToken(activeProfileName()), tableId: REFERENCE_TABLE,
});

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const headers = manifest.headers;
if (headers.join('|') !== XWS_HEADERS.join('|')) throw new Error(`表头不是 16 列契约：${headers.join(',')}`);

const fields = await client.listFields();
const fieldTypes = new Map(fields.map((f) => [f.fieldName, Number(f.type)]));

// 只校验「字段都在、图片字段类型对」，recordCount 用 0 代过（新表本来就是空的）
validateTarget({ recordCount: 0, fields, headers });

const failures = [];
let blankCount = 0;
const priceMin = { v: Infinity }, priceMax = { v: -Infinity };
for (let index = 0; index < manifest.rows.length; index += 1) {
  const row = manifest.rows[index];
  try {
    const built = buildRecordFields(row, 'preflight-token', headers, fieldTypes);
    if (built.月收货人数 === null || built.月收货人数 === '') blankCount += 1;
    priceMin.v = Math.min(priceMin.v, built.价格);
    priceMax.v = Math.max(priceMax.v, built.价格);
  } catch (error) {
    failures.push({ row: index + 2, 序号: row.序号, error: String(error.message) });
  }
}

const blankWithoutBadge = manifest.rows.filter((row) => {
  const value = row.月收货人数;
  return value === null || value === undefined || String(value).trim() === '';
}).length;

console.log(JSON.stringify({
  ok: failures.length === 0,
  referenceTable: REFERENCE_TABLE,
  targetFields: fields.length,
  rows: manifest.rows.length,
  images: manifest.images.length,
  failures: failures.slice(0, 10),
  failureCount: failures.length,
  monthlyBuyersNull: blankCount,
  monthlyBuyersBlankInSource: blankWithoutBadge,
  priceRange: { min: priceMin.v, max: priceMax.v },
  countFieldType: fieldTypes.get('月收货人数'),
  imageFieldType: fieldTypes.get('商品图片'),
}, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
