// 日报链的审计写入方（表结构见 db/migrations/007-daily-report-push-audit.sql）。
//
// 定位（2026-09-17 与用户确认后写死）：**只追加的审计日志，不是台账，不是权威。**
//   - 它回答的是「我做过什么动作、结果如何」，不是「现在事实是什么」。
//   - 事实只有一个来源：飞书底单里有没有那一行。所以本模块**不导出任何读接口** ——
//     没有查询函数，就没有第二个能对「这天推过没有」下断言的地方。
//   - 重复本身是事实：同一天同一店推十次就写十行，没有业务唯一键。
//   - 因此它允许与飞书不一致：不一致正是它要暴露的现象，而不是需要消除的噪声。
//
// 第二条纪律：**写审计失败绝不能让日报链失败。** 这只是旁证，数据已经进飞书了。
// 所以 appendAudit 把一切异常收成返回值，调用方只负责打印一行警告。
//
// 表名/动作词表导出给测试与守卫用；守卫断言全仓库只有本文件、迁移文件与测试提到这张表。
import { readFileSync } from 'node:fs';

import { parseEnvFile } from './feishu-targets.mjs';

export const AUDIT_TABLE = 'daily_report_push_audit';

// 动作词表。加值时必须同步迁移文件里的 CHECK，否则写入会被 PG 的约束拒掉
// （本项目在 supervisor_commit_records 上吃过一次同样的亏，见 006 的说明）。
export const AUDIT_ACTIONS = Object.freeze(['push', 'ui-verify', 'inquiry-backfill']);

export const AUDIT_OUTCOMES = Object.freeze(['ok', 'failed']);

// 数据库连接串的存放处（与 runtime/sop-runtime 的探针同源）。
const DEFAULT_DATABASE_ENV_FILE = 'E:/小红书/.env.local';

const INSERT_SQL = `INSERT INTO ${AUDIT_TABLE} (
  action, outcome, report_date, shop_name, record_id,
  record_count_before, record_count_after, verified_fields, mode,
  source_shop_file, source_shop_sha256, source_promotion_file, source_promotion_sha256,
  browser_port, browser_id, proxy_port, computed_at, node_version, receipt_path, detail
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
RETURNING id`;

function asText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

// 收据里的端口/身份是 `{port, source, registryDefault}` / `{id, source}` 这种带出处的形状
// （见 run-daily-report.mjs 的 describeObservedPort）。这里两种形状都接受：
// 直接给数字，或给收据里那个包了一层对象的值。
function unwrap(value, key) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value[key];
  return value;
}

// 连接串的取值顺序：进程环境变量 → env 文件。取不到返回 null（调用方据此跳过写入，
// 而不是抛错 —— 缺一个环境变量不该让一次已经成功的数据导入变成失败）。
// readFile / envFile 可注入：离线测试要能摆出「读不到也不炸」的场景，
// 否则单测会去连真实库（那是往审计表里灌测试数据，比不测更糟）。
export function resolveDatabaseUrl(options = {}) {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? readFileSync;
  const envFile = options.envFile ?? DEFAULT_DATABASE_ENV_FILE;
  const fromEnv = asText(env.XWS_DATABASE_URL) ?? asText(env.PG_URL) ?? asText(env.DATABASE_URL);
  if (fromEnv) return fromEnv;
  try {
    const values = parseEnvFile(readFile(envFile, 'utf8'));
    return asText(values.XWS_DATABASE_URL) ?? asText(values.PG_URL) ?? asText(values.DATABASE_URL);
  } catch {
    return null;
  }
}

// 纯函数：把「收据的一部分 + 环境」摊平成一行。摊平逻辑单独可测，不需要数据库。
export function describeAuditRow(input = {}) {
  const source = input.source ?? {};
  const environment = input.environment ?? {};
  return {
    action: asText(input.action),
    outcome: asText(input.outcome),
    reportDate: asText(input.reportDate),
    shopName: asText(input.shopName),
    recordId: asText(input.recordId),
    recordCountBefore: asInt(input.recordCountBefore),
    recordCountAfter: asInt(input.recordCountAfter),
    verifiedFields: asInt(input.verifiedFields),
    mode: asText(input.mode),
    sourceShopFile: asText(source.shopFile),
    sourceShopSha256: asText(source.shopSha256),
    sourcePromotionFile: asText(source.promotionFile),
    sourcePromotionSha256: asText(source.promotionSha256),
    browserPort: asInt(unwrap(environment.browserPort ?? input.browserPort, 'port')),
    browserId: asText(unwrap(environment.browserId ?? input.browserId, 'id')),
    proxyPort: asInt(unwrap(environment.proxyPort ?? input.proxyPort, 'port')),
    computedAt: asText(environment.computedAt),
    nodeVersion: asText(environment.node),
    receiptPath: asText(input.receiptPath),
    detail: input.detail && typeof input.detail === 'object' && !Array.isArray(input.detail) ? input.detail : {},
  };
}

function toParams(row) {
  return [
    row.action, row.outcome, row.reportDate, row.shopName, row.recordId,
    row.recordCountBefore, row.recordCountAfter, row.verifiedFields, row.mode,
    row.sourceShopFile, row.sourceShopSha256, row.sourcePromotionFile, row.sourcePromotionSha256,
    row.browserPort, row.browserId, row.proxyPort, row.computedAt, row.nodeVersion, row.receiptPath,
    JSON.stringify(row.detail),
  ];
}

// 写一行审计。**永不抛错**：返回 {written:true, id} 或 {written:false, reason}。
// 可注入 pool（离线测试用），未注入时按 databaseUrl 自建并自行关闭。
export async function appendAudit(row, options = {}) {
  const action = asText(row?.action);
  const outcome = asText(row?.outcome);
  if (!AUDIT_ACTIONS.includes(action)) return { written: false, reason: `invalid action: ${String(action)}` };
  if (!AUDIT_OUTCOMES.includes(outcome)) return { written: false, reason: `invalid outcome: ${String(outcome)}` };

  let owned = null;
  try {
    let pool = options.pool ?? null;
    if (!pool) {
      const databaseUrl = options.databaseUrl ?? resolveDatabaseUrl({
        env: options.env, readFile: options.readFile, envFile: options.envFile,
      });
      if (!databaseUrl) return { written: false, reason: 'database url unavailable' };
      const pg = (await import('pg')).default;
      owned = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
      // 空闲连接被服务端中断时 pg 会在 Pool 上抛 'error'；没有监听器会直接终止进程。
      owned.on('error', () => {});
      pool = owned;
    }
    const { rows } = await pool.query(INSERT_SQL, toParams(row));
    // 注意：主键 id 是 bigserial，node-pg 把它当**字符串**返回（实测 '1' 而不是 1）。
    // 这里原样透出，不 Number() 转换 —— 调用方只用它做日志标记，不做数值运算；
    // 而悄悄换类型会让「返回了什么」与「数据库里是什么」对不上。
    return { written: true, id: rows?.[0]?.id ?? null };
  } catch (error) {
    return { written: false, reason: `append failed: ${error?.message ?? String(error)}` };
  } finally {
    if (owned) {
      try { await owned.end(); } catch { /* 关不掉不影响结论 */ }
    }
  }
}
