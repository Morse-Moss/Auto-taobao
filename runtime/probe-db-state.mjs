// 只读探针：核验 001-003 迁移与实际表状态
import fs from 'node:fs';
import pg from 'pg';

function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const env = { ...loadEnv(process.env.PG_ENV_FILE || 'E:/小红书/.env.local'), ...process.env };
const url = process.env.PG_URL || env.XWS_DATABASE_URL || env.DATABASE_URL;
if (!url) throw new Error('no database url');

const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 8000 });
const safeUrl = String(url).replace(/\/\/[^@]*@/, '//***@');

const EXPECTED = [
  'supervisor_proposals', 'supervisor_action_intents', 'supervisor_approvals',
  'supervisor_commit_records', 'supervisor_experience',
  'durable_runs', 'durable_attempts',
];

try {
  const ver = await pool.query('select version()');
  console.log('连接:', safeUrl);
  console.log('版本:', ver.rows[0].version.split(',')[0]);

  const sch = await pool.query(
    `select schema_name from information_schema.schemata
     where schema_name in ('public','architecture') order by schema_name`);
  console.log('schema:', sch.rows.map((r) => r.schema_name).join(', '));

  const tbl = await pool.query(
    `select table_schema, table_name from information_schema.tables
     where table_schema in ('public','architecture') order by table_schema, table_name`);
  const present = new Map(tbl.rows.map((r) => [r.table_name, r.table_schema]));

  console.log('\n=== 001-003 预期表 ===');
  for (const t of EXPECTED) {
    console.log(`  ${present.has(t) ? 'EXISTS' : 'MISSING'}  ${t}${present.has(t) ? ` (${present.get(t)})` : ''}`);
  }

  console.log('\n=== durable_runs 列 ===');
  if (present.has('durable_runs')) {
    const c = await pool.query(
      `select column_name, data_type, column_default from information_schema.columns
       where table_name='durable_runs' order by ordinal_position`);
    for (const r of c.rows) console.log(`  ${r.column_name.padEnd(20)} ${r.data_type}`);
    const n = await pool.query('select count(*)::int as n from durable_runs');
    console.log('  行数:', n.rows[0].n);
  }
  console.log('\n=== durable_attempts 列 ===');
  if (present.has('durable_attempts')) {
    const c = await pool.query(
      `select column_name, data_type from information_schema.columns
       where table_name='durable_attempts' order by ordinal_position`);
    for (const r of c.rows) console.log(`  ${r.column_name.padEnd(20)} ${r.data_type}`);
    const n = await pool.query('select count(*)::int as n from durable_attempts');
    console.log('  行数:', n.rows[0].n);
  }
  console.log('\n=== architecture schema 表 ===');
  const arch = tbl.rows.filter((r) => r.table_schema === 'architecture');
  console.log(arch.length ? arch.map((r) => r.table_name).join(', ') : '(不存在)');
} finally {
  await pool.end();
}
