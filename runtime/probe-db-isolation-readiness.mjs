// 只读探针：判断本机 PostgreSQL 是否具备「建隔离库做迁移验证」的能力。
// 只做连接与 SELECT，不创建/修改/删除任何对象。
// 用法：node runtime/probe-db-isolation-readiness.mjs [--env-file <path>]
import fs from 'node:fs';
import pg from 'pg';

function parseArgs(argv) {
  const args = { envFile: process.env.PG_ENV_FILE || 'E:/小红书/.env.local' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env-file') args.envFile = argv[++i];
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

// 候选连接身份：先业务身份，再常见本地 superuser 身份。密码只从环境读取，不落盘不打印。
const env = { ...loadEnv(parseArgs(process.argv.slice(2)).envFile), ...process.env };
const mask = (url) => String(url).replace(/\/\/[^@]*@/, '//***@');

const candidates = [
  { label: '业务身份(XWS_DATABASE_URL)', url: process.env.PG_URL || env.XWS_DATABASE_URL || env.DATABASE_URL },
  { label: 'postgres 本地免密', url: 'postgresql://postgres@127.0.0.1:5432/postgres' },
  { label: 'postgres:postgres', url: env.PG_SUPERUSER_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' },
  { label: 'OS 用户 Administrator', url: 'postgresql://Administrator@127.0.0.1:5432/postgres' },
].filter((c) => c.url);

const results = [];

for (const candidate of candidates) {
  const pool = new pg.Pool({ connectionString: candidate.url, connectionTimeoutMillis: 6000, max: 1 });
  try {
    const who = await pool.query(
      `select current_user as role, current_database() as db,
              (select rolsuper from pg_roles where rolname = current_user) as is_super,
              (select rolcreatedb from pg_roles where rolname = current_user) as can_createdb,
              current_setting('server_version') as version`);
    const row = who.rows[0];
    const dbs = await pool.query(
      `select datname from pg_database where datistemplate = false and datallowconn order by datname`);
    results.push({
      label: candidate.label,
      url: mask(candidate.url),
      ok: true,
      role: row.role,
      isSuper: row.is_super,
      canCreatedb: row.can_createdb,
      version: row.version,
      databases: dbs.rows.map((r) => r.datname),
    });
  } catch (error) {
    results.push({ label: candidate.label, url: mask(candidate.url), ok: false, error: String(error?.message ?? error) });
  } finally {
    await pool.end().catch(() => {});
  }
}

console.log('=== PostgreSQL 隔离库能力探测（只读）===\n');
for (const r of results) {
  if (!r.ok) {
    console.log(`[连接失败] ${r.label}  ${r.url}\n    ${r.error}\n`);
    continue;
  }
  console.log(`[连接成功] ${r.label}  ${r.url}`);
  console.log(`    角色: ${r.role}   superuser=${r.isSuper}   createdb=${r.canCreatedb}   版本=${r.version}`);
  console.log(`    可建隔离库: ${r.canCreatedb || r.isSuper ? '是' : '否'}`);
  console.log(`    现有数据库: ${r.databases.join(', ')}\n`);
}

const capable = results.find((r) => r.ok && (r.canCreatedb || r.isSuper));
console.log('结论:', capable
  ? `可用身份「${capable.label}」建隔离库，004/005 可以在此做语法/重复执行/rollback 验证。`
  : '没有任何可用身份具备 CREATEDB/superuser，隔离库验证在本机无法完成；需要 CREATEDB 授权或独立 PG endpoint。');
process.exit(0);
