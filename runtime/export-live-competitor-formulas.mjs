// Export the live formula expressions of the competitor main table to JSON.
//
// 2026-09-15 fix: the original version hard-coded the RETIRED tenant
// (OWebbPUcBa7B8JseYLccQCy9nkf / tblJ9LHFN6pMVjPv) plus the legacy credential
// file. Once the active base moved to kcne618basvj, running this script would
// have silently captured the wrong tenant's formulas — a stale-evidence hazard
// that looks like a successful run. Target and credentials now come from
// feishu-targets.mjs (the single source of truth), and the table is
// overridable so the same check can run against a weekly table.
//
// Read-only: GET /fields only.
//
// Usage:
//   node runtime/export-live-competitor-formulas.mjs --out evidence/competitor-live-formulas.json
//   node runtime/export-live-competitor-formulas.mjs --out <file> --table-id <tbl...>
//   node runtime/export-live-competitor-formulas.mjs --out <file> --profile legacy
import fs from 'node:fs';
import path from 'node:path';

import { buildCompetitorFieldMigrationPlan } from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';
import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import {
  activeProfileName,
  competitorBaseToken,
  loadFeishuCredentials,
  tableId as stableTableId,
} from './feishu-targets.mjs';

function parseArgs(argv) {
  const options = { out: '', tableId: '', profile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--out', '--table-id', '--profile'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.out) throw new Error('--out is required');
  return options;
}

const options = parseArgs(process.argv.slice(2));
const profile = activeProfileName({ SYCM_FEISHU_PROFILE: options.profile || undefined });
const appToken = competitorBaseToken(profile);
const targetTableId = options.tableId || stableTableId('competitorMain', profile);
const { appId, appSecret, file: credentialFile } = loadFeishuCredentials(profile);

const client = new CompetitorV2FeishuClient({ appId, appSecret, appToken });
await client.authenticate();
const fields = await client.listFields(targetTableId);
const live = Object.fromEntries(fields.filter((field) => field.type === 20).map((field) => [
  field.field_name ?? field.fieldName,
  field.property?.formula_expression ?? field.property?.formulaExpression ?? '',
]));

fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(live, null, 2)}\n`, 'utf8');

// Source comparison only works when the live table still carries every field the
// generator refers to; a weekly table is missing some by design, so a mismatch
// there is expected rather than alarming.
let differences = null;
try {
  const plan = buildCompetitorFieldMigrationPlan({ tableId: targetTableId, fields });
  const expected = Object.fromEntries(plan.formulas.map((item) => [item.fieldName, item.body.property.formula_expression]));
  const compared = Object.keys(expected).filter((name) => live[name] !== undefined);
  differences = compared
    .filter((name) => live[name] !== expected[name])
    .map((name) => ({ name, live: live[name], expected: expected[name] }));
  console.log(JSON.stringify({
    profile,
    appToken,
    tableId: targetTableId,
    credentialFile,
    formulaFields: Object.keys(live).length,
    comparableAgainstSource: compared.length,
    liveMatchesSource: differences.length === 0,
    differingFields: differences.map((item) => item.name),
    out: path.resolve(options.out),
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    profile,
    appToken,
    tableId: targetTableId,
    credentialFile,
    formulaFields: Object.keys(live).length,
    sourceComparison: `skipped: ${error.message}`,
    out: path.resolve(options.out),
  }, null, 2));
}
