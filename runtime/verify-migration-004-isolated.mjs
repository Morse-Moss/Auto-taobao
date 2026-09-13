// 004 隔离库验证：建临时库 -> apply 001..004 -> 重复执行 -> 种子计数 -> rollback -> 清理
// 只连接 isolation 数据库和默认的 postgres 维护库，绝不修改 xws_automation。
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve('db/migrations');
const SCRATCH = process.env.SCRATCH_DB || 'xws_migcheck_004';

function adminUrl() {
  const url = new URL(process.env.PG_URL || require_env().XWS_DATABASE_URL);
  url.pathname = '/postgres';
  return url.toString();
}
function scratchUrl() {
  const url = new URL(process.env.PG_URL || require_env().XWS_DATABASE_URL);
  url.pathname = `/${SCRATCH}`;
  return url.toString();
}
function require_env() {
  const out = {};
  for (const line of fs.readFileSync('E:/小红书/.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const admin = new pg.Pool({ connectionString: adminUrl() });
const log = (...a) => console.log(...a);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

async function run(pool, label, sql) {
  try {
    await pool.query(sql);
    log(`  OK   ${label}`);
    return true;
  } catch (e) {
    log(`  FAIL ${label}: ${e.message}`);
    return false;
  }
}

let ok = true;
try {
  const exists = await admin.query('select 1 from pg_database where datname=$1', [SCRATCH]);
  if (exists.rowCount) {
    log(`清理已存在的临时库 ${SCRATCH}`);
    await admin.query(`DROP DATABASE ${SCRATCH}`);
  }
  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  log(`已创建隔离库 ${SCRATCH}（与业务库隔离）`);

  const db = new pg.Pool({ connectionString: scratchUrl() });
  try {
    log('\n--- apply 001..003（前置基线）---');
    ok = (await run(db, '001', read('001-supervisor-tables.sql'))) && ok;
    ok = (await run(db, '002', read('002-durable-run-tables.sql'))) && ok;
    ok = (await run(db, '003', read('003-durable-attempt-heartbeat.sql'))) && ok;

    const before = await db.query(
      `select table_name from information_schema.tables where table_schema='public' order by table_name`);
    const beforeSet = before.rows.map((r) => r.table_name);

    log('\n--- apply 004 第一次 ---');
    ok = (await run(db, '004', read('004-architecture-catalog.sql'))) && ok;

    const counts = async () => (await db.query(`
      select (select count(*) from architecture.reviews) reviews,
             (select count(*) from architecture.capabilities) capabilities,
             (select count(*) from architecture.modules) modules,
             (select count(*) from architecture.gaps) gaps,
             (select count(*) from architecture.phases) phases,
             (select count(*) from architecture.decisions) decisions,
             (select count(*) from architecture.evidence_refs) evidence_refs`)).rows[0];
    const c1 = await counts();
    log('  种子计数:', JSON.stringify(c1));

    log('\n--- apply 004 第二次（幂等）---');
    ok = (await run(db, '004 again', read('004-architecture-catalog.sql'))) && ok;
    const c2 = await counts();
    log('  种子计数:', JSON.stringify(c2));
    const idempotent = JSON.stringify(c1) === JSON.stringify(c2);
    log(`  幂等: ${idempotent ? 'PASS' : 'FAIL'}`);
    ok = idempotent && ok;

    const after = await db.query(
      `select table_name from information_schema.tables where table_schema='public' order by table_name`);
    const afterSet = after.rows.map((r) => r.table_name);
    const added = afterSet.filter((t) => !beforeSet.includes(t));
    const removed = beforeSet.filter((t) => !afterSet.includes(t));
    log(`  004 对 public schema 的影响: 新增 ${JSON.stringify(added)} / 删除 ${JSON.stringify(removed)}`);
    const noPublicChange = added.length === 0 && removed.length === 0;
    log(`  未修改现有业务表: ${noPublicChange ? 'PASS' : 'FAIL'}`);
    ok = noPublicChange && ok;

    log('\n--- rollback 004 ---');
    ok = (await run(db, '004 rollback', read('004-rollback.sql'))) && ok;
    const archAfter = await db.query(
      `select table_name from information_schema.tables where table_schema='architecture'`);
    log(`  architecture 剩余表: ${archAfter.rows.length === 0 ? '(0，已清空)' : archAfter.rows.map((r) => r.table_name).join(',')}`);
    const schemaStill = await db.query(`select 1 from information_schema.schemata where schema_name='architecture'`);
    log(`  architecture schema 保留: ${schemaStill.rowCount ? 'PASS' : 'FAIL'}`);
    ok = schemaStill.rowCount > 0 && ok;
    const publicAfter = await db.query(
      `select count(*)::int n from information_schema.tables where table_schema='public'`);
    log(`  public 表数量回滚后: ${publicAfter.rows[0].n}（基线 ${beforeSet.length}）`);
    if (publicAfter.rows[0].n !== beforeSet.length) ok = false;
  } finally {
    await db.end();
  }
} finally {
  log('\n--- 清理 ---');
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  log(`已删除隔离库 ${SCRATCH}`);
  await admin.end();
}

console.log(`\n004 隔离库验证结论：${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
