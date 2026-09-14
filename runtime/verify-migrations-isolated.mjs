// 隔离库验证：004 / 005 的语法、重复执行（幂等）与 rollback。
// 规则：
//  - 只在临时库操作，库名 sop_verify_<时间戳>，结束即 DROP DATABASE ... WITH (FORCE)；
//  - 绝不连接、绝不修改业务库 xws_automation；
//  - 不打印任何口令。
// 用法：
//   node runtime/verify-migrations-isolated.mjs [--env-file <path>] [--keep] [--db <name>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MIG_DIR = path.join(REPO, 'db', 'migrations');
const FORBIDDEN_DB = 'xws_automation';

function parseArgs(argv) {
  const args = { envFile: process.env.PG_ENV_FILE || 'E:/小红书/.env.local', keep: false, db: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--env-file') args.envFile = argv[++i];
    else if (t === '--keep') args.keep = true;
    else if (t === '--db') args.db = argv[++i];
    else if (t === '--json') args.json = true;
  }
  return args;
}

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function withDatabase(url, db) {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
}

function mask(url) {
  return String(url).replace(/\/\/[^@]*@/, '//***@');
}

const STEPS = [];
function record(name, ok, detail, extra = {}) {
  STEPS.push({ name, ok, detail, ...extra });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...loadEnv(args.envFile), ...process.env };
  const url = process.env.PG_URL || env.XWS_DATABASE_URL || env.DATABASE_URL;
  if (!url) throw new Error('未找到数据库连接串（XWS_DATABASE_URL / PG_URL / DATABASE_URL）');

  const baseDb = new URL(url).pathname.replace(/^\//, '');
  if (baseDb === FORBIDDEN_DB) {
    console.log(`基础连接指向业务库 ${FORBIDDEN_DB}，本脚本只用它取连接凭据，所有 DDL 都在临时库执行。`);
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const tempDb = args.db ?? `sop_verify_${stamp}`;
  if (tempDb === FORBIDDEN_DB) throw new Error('拒绝把业务库当作隔离库');

  const admin = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await admin.connect();

  // 谁在跑、能不能建库，必须在结果里写清楚：
  // 本脚本用 process.env 覆盖 env 文件，因此「项目配置里的受限角色」和「会话里导出的特权角色」
  // 可能不是同一个身份。不打印这一行，就无法判断这次验证到底是用什么权限做的。
  const me = (await admin.query(
    `select current_user as role, r.rolsuper as superuser, r.rolcreatedb as createdb
     from pg_roles r where r.rolname = current_user`)).rows[0];
  console.log(`实际生效角色: ${me.role}  superuser=${me.superuser}  createdb=${me.createdb}`);
  console.log(`角色来源: ${process.env.XWS_DATABASE_URL || process.env.PG_URL ? '进程环境变量（覆盖 env 文件）' : `env 文件 ${args.envFile}`}`);
  if (!me.createdb && !me.superuser) {
    throw new Error(
      `角色 ${me.role} 没有 CREATEDB 权限，无法创建隔离库。` +
      '请改用有 CREATEDB 的角色，或由有权限者先建好隔离库再用 --db 指定。',
    );
  }

  const sql = (name) => fs.readFileSync(path.join(MIG_DIR, name), 'utf8');
  const verify = { tables: null, seed: null, columns: null, constraints: null, indexes: null };

  // 执行整个迁移文件；失败时给出文件、位置与上下文窗口，便于定位具体语句。
  const LAST = { file: null };
  async function applyFile(c, file) {
    LAST.file = file;
    const text = sql(file);
    try {
      await c.query(text);
    } catch (error) {
      const pos = Number(error.position ?? 0);
      if (pos > 0) {
        const start = Math.max(0, pos - 180);
        error.message += `\n      文件 ${file} 位置 ${pos} 附近: …${text.slice(start, pos + 80).replace(/\s+/g, ' ')}…`;
      } else {
        error.message += `\n      文件 ${file}`;
      }
      if (error.detail) error.message += `\n      DETAIL: ${error.detail}`;
      throw error;
    }
  }

  const countQuery = async (c, q) => Number((await c.query(q)).rows[0].n);

  const archTables = (c) => c.query(
    `select table_name from information_schema.tables where table_schema = 'architecture' order by table_name`);
  const seedCounts = async (c) => ({
    reviews: await countQuery(c, 'select count(*)::int as n from architecture.reviews'),
    capabilities: await countQuery(c, 'select count(*)::int as n from architecture.capabilities'),
    modules: await countQuery(c, 'select count(*)::int as n from architecture.modules'),
    gaps: await countQuery(c, 'select count(*)::int as n from architecture.gaps'),
    phases: await countQuery(c, 'select count(*)::int as n from architecture.phases'),
    decisions: await countQuery(c, 'select count(*)::int as n from architecture.decisions'),
    evidence_refs: await countQuery(c, 'select count(*)::int as n from architecture.evidence_refs'),
  });
  const colQuery = (c) => c.query(
    `select table_name, column_name from information_schema.columns
     where table_schema='public' and (
       (table_name='durable_runs' and column_name in ('task_id','workflow','capability','stage','step_id','lane','context','context_version','evidence_status','human_gate_status','publication_status','blocker','next_action','retry_used'))
       or (table_name='durable_attempts' and column_name in ('stage','step_id','failure_class','result'))
       or (table_name='supervisor_commit_records' and column_name in ('business_key','provider_ref'))
     ) order by table_name, column_name`);
  const conQuery = (c) => c.query(
    `select conname from pg_constraint where conname in (
       'durable_runs_evidence_status_check','durable_runs_human_gate_status_check',
       'durable_runs_publication_status_check','durable_attempts_failure_class_check') order by conname`);
  const idxQuery = (c) => c.query(
    `select indexname from pg_indexes where schemaname='public' and indexname in (
       'idx_durable_runs_lane_active','idx_durable_runs_status','idx_commit_records_unknown') order by indexname`);

  let client = null;
  try {
    console.log(`隔离库: ${tempDb}\n基础凭据: ${mask(url)}\n`);

    await admin.query(`DROP DATABASE IF EXISTS "${tempDb}"`);
    await admin.query(`CREATE DATABASE "${tempDb}"`);
    record('创建临时隔离库', true, tempDb);

    client = new pg.Client({ connectionString: withDatabase(url, tempDb) });
    await client.connect();

    // --- 依赖前置：005 需要 001/002/003 的表 ---
    console.log('\n[1] 前置依赖（001/002/003）');
    for (const f of ['001-supervisor-tables.sql', '002-durable-run-tables.sql', '003-durable-attempt-heartbeat.sql']) {
      await applyFile(client, f);
    }
    const baseTables = await countQuery(client,
      `select count(*)::int as n from information_schema.tables
       where table_schema='public' and table_name in
       ('supervisor_proposals','supervisor_action_intents','supervisor_approvals','supervisor_commit_records','supervisor_experience','durable_runs','durable_attempts')`);
    record('001/002/003 建表', baseTables === 7, `${baseTables}/7 张基础表`);

    // --- 顺序反例：005 在缺少 002 表时应当失败（文档化依赖顺序）---
    console.log('\n[2] 依赖顺序反例');
    const probe = await admin.query(`CREATE DATABASE "${tempDb}_nodep"`);
    const nodep = new pg.Client({ connectionString: withDatabase(url, `${tempDb}_nodep`) });
    await nodep.connect();
    let orderFailed = false;
    let orderError = '';
    try {
      await applyFile(nodep, '005-sop-runtime-context.sql');
    } catch (error) {
      orderFailed = true;
      orderError = String(error.message).split('\n')[0];
    } finally {
      await nodep.end();
      await admin.query(`DROP DATABASE IF EXISTS "${tempDb}_nodep" WITH (FORCE)`);
    }
    record('005 缺前置表时按预期失败（依赖顺序）', orderFailed, orderError || '竟然成功了，说明 005 未真正依赖 001/002');

    // --- 004 ---
    console.log('\n[3] 004 语法与幂等');
    await applyFile(client, '004-architecture-catalog.sql');
    const t1 = (await archTables(client)).rows.map((r) => r.table_name);
    const s1 = await seedCounts(client);
    record('004 首次执行', t1.length === 7, `表 ${t1.length}/7：${t1.join(', ')}`);
    record('004 种子数据落库', s1.reviews === 1 && s1.gaps === 9 && s1.decisions === 7,
      `reviews=${s1.reviews} caps=${s1.capabilities} modules=${s1.modules} gaps=${s1.gaps} phases=${s1.phases} decisions=${s1.decisions} evidence=${s1.evidence_refs}`);

    await applyFile(client, '004-architecture-catalog.sql');
    const s2 = await seedCounts(client);
    record('004 重复执行幂等', JSON.stringify(s1) === JSON.stringify(s2), `二次执行后计数不变`);

    await applyFile(client, '004-rollback.sql');
    const t2 = (await archTables(client)).rows.map((r) => r.table_name);
    const schemaKept = Number((await client.query(
      `select count(*)::int as n from information_schema.schemata where schema_name='architecture'`)).rows[0].n) === 1;
    record('004 rollback 清除 7 张表', t2.length === 0, `剩余表 ${t2.length}`);
    record('004 rollback 保留 schema（按设计）', schemaKept, 'architecture schema 保留，便于后续架构迁移');

    await applyFile(client, '004-architecture-catalog.sql');
    const s3 = await seedCounts(client);
    record('004 rollback 后重放', s3.reviews === 1 && s3.gaps === 9, `种子重建 reviews=${s3.reviews} gaps=${s3.gaps}`);
    verify.tables = (await archTables(client)).rows.map((r) => r.table_name);
    verify.seed = s3;

    // --- 005 ---
    console.log('\n[4] 005 语法与幂等');
    await applyFile(client, '005-sop-runtime-context.sql');
    const c1 = (await colQuery(client)).rows.length;
    const k1 = (await conQuery(client)).rows.length;
    const i1 = (await idxQuery(client)).rows.length;
    record('005 首次执行', c1 === 20 && k1 === 4 && i1 === 3, `新增列 ${c1}/20，约束 ${k1}/4，索引 ${i1}/3`);

    await applyFile(client, '005-sop-runtime-context.sql');
    const c2 = (await colQuery(client)).rows.length;
    const k2 = (await conQuery(client)).rows.length;
    const i2 = (await idxQuery(client)).rows.length;
    record('005 重复执行幂等', c1 === c2 && k1 === k2 && i1 === i2, `二次执行后 列${c2} 约束${k2} 索引${i2} 不变`);

    // 约束真的生效：写入非法 evidence_status 必须被拒
    let checkWorks = false;
    try {
      await client.query(
        `insert into durable_runs (run_id, identity, target_end, evidence_status)
         values (gen_random_uuid(), '{}'::jsonb, 1, 'NOT_A_STATUS')`);
    } catch {
      checkWorks = true;
    }
    record('005 CHECK 约束生效', checkWorks, '非法 evidence_status 被拒绝');

    // 合法写入 + 默认值
    await client.query(
      `insert into durable_runs (run_id, identity, target_end) values
       ('11111111-1111-4111-8111-111111111111', '{"tenantId":"t"}'::jsonb, 10)`);
    const row = (await client.query(
      `select evidence_status, human_gate_status, publication_status, context, context_version, retry_used
       from durable_runs where run_id='11111111-1111-4111-8111-111111111111'`)).rows[0];
    record('005 默认值与 jsonb 可用',
      row.evidence_status === 'NONE' && row.human_gate_status === 'NONE'
      && row.publication_status === 'NOT_REQUESTED' && row.context_version === '0' && row.context && row.retry_used,
      `evidence=${row.evidence_status} gate=${row.human_gate_status} pub=${row.publication_status} ver=${row.context_version}`);

    await applyFile(client, '005-rollback.sql');
    const c3 = (await colQuery(client)).rows.length;
    const k3 = (await conQuery(client)).rows.length;
    const i3 = (await idxQuery(client)).rows.length;
    record('005 rollback 清除新增对象', c3 === 0 && k3 === 0 && i3 === 0, `剩余 列${c3} 约束${k3} 索引${i3}`);
    const survivors = await countQuery(client,
      `select count(*)::int as n from information_schema.tables
       where table_schema='public' and table_name in ('durable_runs','durable_attempts','supervisor_commit_records')`);
    record('005 rollback 不删表', survivors === 3, `保留 ${survivors}/3 张表`);

    await applyFile(client, '005-sop-runtime-context.sql');
    const c4 = (await colQuery(client)).rows.length;
    record('005 rollback 后重放', c4 === 20, `列 ${c4}/20`);
    verify.columns = c4;
    verify.constraints = (await conQuery(client)).rows.length;
    verify.indexes = (await idxQuery(client)).rows.length;

    console.log('\n[5] 收尾');
  } catch (error) {
    const full = String(error?.message ?? error);
    record('执行异常', false, full);
    process.stderr.write(`${full}\n${error?.stack ? `${error.stack}\n` : ''}`);
  } finally {
    if (client) await client.end().catch(() => {});
    if (!args.keep) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${tempDb}" WITH (FORCE)`);
        record('清理临时库', true, tempDb);
      } catch (error) {
        record('清理临时库', false, String(error?.message ?? error).split('\n')[0]);
      }
    } else {
      record('保留临时库（--keep）', true, tempDb);
    }
    await admin.end().catch(() => {});
  }

  const passed = STEPS.filter((s) => s.ok).length;
  const failed = STEPS.filter((s) => !s.ok);
  console.log(`\n=== 结果：${passed}/${STEPS.length} 通过 ===`);
  if (failed.length) {
    for (const f of failed) console.log(`  未通过: ${f.name} — ${f.detail}`);
  }
  if (args.json) {
    console.log(`\n${JSON.stringify({ tempDb, steps: STEPS, verify, passed, total: STEPS.length }, null, 2)}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`致命错误: ${error?.stack ?? error}`);
  process.exit(2);
});
