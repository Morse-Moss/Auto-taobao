import fs from 'node:fs';
import path from 'node:path';

import { buildCompetitorFieldMigrationPlan } from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';
import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';

const [outputFile, envFile = 'E:/小红书/.env.local'] = process.argv.slice(2);
if (!outputFile) throw new Error('Output JSON path is required');

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, index).trim()] = value;
  }
  return values;
}

const appToken = 'OWebbPUcBa7B8JseYLccQCy9nkf';
const tableId = 'tblJ9LHFN6pMVjPv';
const env = readEnv(path.resolve(envFile));
if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');

const client = new CompetitorV2FeishuClient({
  appId: env.FEISHU_APP_ID,
  appSecret: env.FEISHU_APP_SECRET,
  appToken,
});
await client.authenticate();
const fields = await client.listFields(tableId);
const plan = buildCompetitorFieldMigrationPlan({ tableId, fields });
const live = Object.fromEntries(fields.filter((field) => field.type === 20).map((field) => [
  field.field_name ?? field.fieldName,
  field.property?.formula_expression ?? field.property?.formulaExpression ?? '',
]));
const expected = Object.fromEntries(plan.formulas.map((item) => [
  item.fieldName,
  item.body.property.formula_expression,
]));
const differences = Object.entries(expected).filter(([name, expression]) => live[name] !== expression)
  .map(([name, expression]) => ({ name, live: live[name] ?? '', expected: expression }));

fs.writeFileSync(path.resolve(outputFile), `${JSON.stringify(live, null, 2)}\n`, 'utf8');
const diffFile = path.resolve(`${outputFile}.diff.json`);
if (differences.length) fs.writeFileSync(diffFile, `${JSON.stringify(differences, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  formulaCount: Object.keys(expected).length,
  liveMatchesSource: differences.length === 0,
  differingFields: differences.map((item) => item.name),
  ...(differences.length ? { diffFile } : {}),
}));
