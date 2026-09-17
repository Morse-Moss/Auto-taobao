import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  AUDIT_TABLE,
  appendAudit,
  describeAuditRow,
  resolveDatabaseUrl,
} from '../../../runtime/daily-report-audit.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const MIGRATION = 'db/migrations/007-daily-report-push-audit.sql';
const ROLLBACK = 'db/migrations/007-rollback.sql';
const RUNTIME_MODULE = 'runtime/daily-report-audit.mjs';
const THIS_TEST = 'skills/sycm-alimama-daily-report/scripts/daily-report-audit.test.mjs';
// 隔离预演脚本也必然要念出表名（它要在临时库里建表、写一行、再回滚）。
// 它**不是**第二个读者/写者：它只对 throwaway 库跑，从不碰业务库，也没有被生产链路调用。
// 实测教训：这条白名单一开始漏了它，而我又是在「改完预演脚本之后忘了重跑本套件」，
// 于是 ce14392 提交里带着一条红用例 —— 守卫本身没错，是白名单不全 ＋ 我没重跑。
const ISOLATED_PREVIEW = 'runtime/verify-migrations-isolated.mjs';

// 收据里 environment 的真实形状（见 run-daily-report.mjs 的 buildEnvironment）：
// 端口与身份都包了一层 {port|id, source, registryDefault}。这里用真的形状，
// 不用「更好看」的形状 —— 否则摊平函数在真实收据上仍然会挂。
const RECEIPT_LIKE = {
  action: 'push',
  reportDate: '2026-09-16',
  shopName: '盖文天猫',
  mode: 'api-commit',
  source: {
    shopFile: 'C:/Users/Administrator/Downloads/日报_20260917_adc987ef.xlsx',
    shopSha256: 'a'.repeat(64),
    promotionFile: 'C:/Users/Administrator/Downloads/营销场景报表_20260916_121308.zip',
    promotionSha256: 'b'.repeat(64),
  },
  environment: {
    computedAt: '2026-09-17T01:20:00.000Z',
    node: 'v22.22.2',
    proxyUrl: 'http://127.0.0.1:19191',
    browserPort: { port: 9223, source: 'env', registryDefault: 19022 },
    proxyPort: { port: 19023, source: 'registry-default', registryDefault: 19023 },
    browserId: { id: 'edge-daily-report', source: 'registry-default' },
    browserLabel: { id: 'Microsoft Edge (daily report)', source: 'registry-default' },
  },
};

test('摊平收据：带出处的端口/身份被取出裸值，源文件与哈希逐项保留', () => {
  const row = describeAuditRow({ ...RECEIPT_LIKE, outcome: 'ok', recordId: 'recvvqPBEP0cMe',
    recordCountBefore: 6, recordCountAfter: 7, verifiedFields: 239, receiptPath: 'evidence/x/receipt.json' });
  assert.equal(row.action, 'push');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.reportDate, '2026-09-16');
  assert.equal(row.shopName, '盖文天猫');
  assert.equal(row.recordId, 'recvvqPBEP0cMe');
  assert.equal(row.recordCountBefore, 6);
  assert.equal(row.recordCountAfter, 7);
  assert.equal(row.verifiedFields, 239);
  // 关键：包了一层也要取出来，否则这条审计永远记不到「跑在退役端口 9223 上」这件事。
  assert.equal(row.browserPort, 9223);
  assert.equal(row.proxyPort, 19023);
  assert.equal(row.browserId, 'edge-daily-report');
  assert.equal(row.computedAt, '2026-09-17T01:20:00.000Z');
  assert.equal(row.nodeVersion, 'v22.22.2');
  assert.equal(row.sourcePromotionSha256, 'b'.repeat(64));
  assert.equal(row.receiptPath, 'evidence/x/receipt.json');
});

test('摊平是宽容的：缺字段记 null，不抛错（审计不该因为收据少个字段就炸）', () => {
  const row = describeAuditRow({ action: 'push', outcome: 'failed' });
  assert.equal(row.reportDate, null);
  assert.equal(row.shopName, null);
  assert.equal(row.recordId, null);
  assert.equal(row.recordCountBefore, null);
  assert.equal(row.browserPort, null);
  assert.equal(row.browserId, null);
  assert.deepEqual(row.detail, {});
  // 直接给裸值也要接受（不许只在「收据形状」下可用）。
  const bare = describeAuditRow({ action: 'push', outcome: 'ok', browserPort: 19022, browserId: 'edge-daily-report' });
  assert.equal(bare.browserPort, 19022);
  assert.equal(bare.browserId, 'edge-daily-report');
  // 非对象 detail 不许原样写进去（jsonb 列会收到乱七八糟的东西）。
  assert.deepEqual(describeAuditRow({ detail: ['nope'] }).detail, {});
});

function failingPool(error) {
  return { calls: [], async query(sql, params) { this.calls.push({ sql, params }); throw error; } };
}

function recordingPool() {
  return { calls: [], async query(sql, params) { this.calls.push({ sql, params }); return { rows: [{ id: 42 }] }; } };
}

test('写入成功：参数顺序与列一一对应，detail 序列化成 JSON，返回 id', async () => {
  const pool = recordingPool();
  const result = await appendAudit(describeAuditRow({ ...RECEIPT_LIKE, outcome: 'ok', recordId: 'rec1' }), { pool });
  assert.equal(result.written, true);
  assert.equal(result.id, 42);
  assert.equal(pool.calls.length, 1);
  const [call] = pool.calls;
  assert.match(call.sql, /INSERT INTO daily_report_push_audit/u);
  assert.equal(call.params.length, 20, '参数个数必须与列个数一致');
  // 前五列：action/outcome/report_date/shop_name/record_id
  assert.deepEqual(call.params.slice(0, 5), ['push', 'ok', '2026-09-16', '盖文天猫', 'rec1']);
  assert.equal(typeof call.params[19], 'string', 'detail 必须是 JSON 字符串');
  assert.equal(JSON.parse(call.params[19]).status, undefined);
});

test('写不进去绝不抛错：返回 written:false 与原因（成功的数据不该被本地旁证拖下水）', async () => {
  const pool = failingPool(new Error('ECONNREFUSED 127.0.0.1:5432'));
  const result = await appendAudit(describeAuditRow({ ...RECEIPT_LIKE, outcome: 'ok' }), { pool });
  assert.equal(result.written, false);
  assert.match(result.reason, /ECONNREFUSED/u);
});

test('词表之外的动作/结果一律拒写，而且不碰数据库', async () => {
  const pool = recordingPool();
  const bad = await appendAudit(describeAuditRow({ action: 'dry-run', outcome: 'ok' }), { pool });
  assert.equal(bad.written, false);
  assert.match(bad.reason, /invalid action/u);
  const badOutcome = await appendAudit(describeAuditRow({ action: 'push', outcome: 'maybe' }), { pool });
  assert.equal(badOutcome.written, false);
  assert.match(badOutcome.reason, /invalid outcome/u);
  assert.equal(pool.calls.length, 0, '被拒的写入不该发出任何 SQL');
});

test('拿不到连接串时跳过写入，而不是抛错（也不去连真实库）', async () => {
  // 显式把 env 文件读到的东西掐掉：否则这个单测会真的去连本机库，
  // 那是往审计表里灌测试数据 —— 比不测更糟。
  const result = await appendAudit(describeAuditRow({ action: 'push', outcome: 'ok' }),
    { env: {}, readFile: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(result, { written: false, reason: 'database url unavailable' });
});

test('连接串解析：进程环境变量优先，其次才是 env 文件；都取不到返回 null', () => {
  const read = () => 'XWS_DATABASE_URL=postgres://from-file/db\n';
  assert.equal(resolveDatabaseUrl({ env: { XWS_DATABASE_URL: 'postgres://from-env/db' }, readFile: read }),
    'postgres://from-env/db');
  assert.equal(resolveDatabaseUrl({ env: {}, readFile: read }), 'postgres://from-file/db');
  assert.equal(resolveDatabaseUrl({ env: {}, readFile: () => { throw new Error('ENOENT'); } }), null);
  // 空串不是「一个连接串」：shell 里 `XWS_DATABASE_URL=` 很常见，必须回落到文件。
  assert.equal(resolveDatabaseUrl({ env: { XWS_DATABASE_URL: '   ' }, readFile: read }), 'postgres://from-file/db');
});

// 这张表存在的理由就是「只记动作，不记事实」。如果哪天有人给它加一个查询接口，
// 它就变成了第二个能对「这天推过没有」下断言的地方 —— 失同步风险随即出现。
// 所以这条守卫盯的是**导出形状**：任何读语义的名字都不许出现。
test('写入方模块不许导出任何读接口（它只能是审计，不能变成台账）', () => {
  const forbidden = /^(find|get|list|has|exists|count|select|query|read|load|fetch|is|was|did|latest|recent)/iu;
  const exported = Object.keys({ AUDIT_ACTIONS, AUDIT_OUTCOMES, AUDIT_TABLE, appendAudit, describeAuditRow, resolveDatabaseUrl });
  for (const name of exported) {
    assert.ok(!forbidden.test(name), `导出了读语义的名字：${name} —— 审计表不许有读接口`);
  }
  // 反向自证：这条守卫真的在判东西，而不是因为正则写废了才全绿。
  assert.ok(exported.length >= 5, '导出面扫描没扫到东西，守卫本身可能坏了');
  assert.ok(forbidden.test('findRecordsByDate') && forbidden.test('listRecentPushes') && forbidden.test('existsPush'),
    '读语义判据的正则自身失效了');
  assert.ok(!forbidden.test('appendAudit'), 'appendAudit 是写接口，不该被误判');
});

// 表名只许出现在「写入方 / 迁移 / 回滚 / 隔离预演 / 本测试」五处。多一处就说明有人在别处读它或写它。
test('全仓库只有写入方与迁移提到这张表（没有第二个读者或写者）', () => {
  const allowed = new Set([RUNTIME_MODULE, MIGRATION, ROLLBACK, ISOLATED_PREVIEW, THIS_TEST]);
  // 扫的是「工作区里真实存在的代码」＝ 已跟踪 ＋ 未跟踪但未被 .gitignore 忽略。
  // 只用 `git ls-files`（默认仅已跟踪）会让**新写的文件不受守卫约束** ——
  // 而「新加一个读者」恰恰是这条守卫最该在发生的时刻发现的事。
  // （实测踩到：本测试与 runtime/daily-report-audit.mjs 都是新文件，只扫已跟踪时
  //   守卫会反过来判「白名单里的文件不存在」，两次都是错的方向。）
  const tracked = execSync('git ls-files --cached --others --exclude-standard', { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim()).filter(Boolean)
    .filter((file) => /\.(mjs|cjs|js|ts|py|sql)$/u.test(file));
  // 空结果不许被读成「没问题」（本项目坑 33 的通用形态）。
  assert.ok(tracked.length > 50, `扫描只找到 ${tracked.length} 个代码文件，守卫本身可能坏了`);

  const hits = tracked.filter((file) => readFileSync(path.join(REPO_ROOT, file), 'utf8').includes(AUDIT_TABLE));
  const unexpected = hits.filter((file) => !allowed.has(file));
  assert.deepEqual(unexpected, [], '这些文件提到了审计表，但它们既不是写入方也不是迁移');
  // 双向：白名单里的每一项都必须真的还在说这张表（路径写错/文件被改名也要红）。
  for (const file of allowed) {
    assert.ok(hits.includes(file), `${file} 在白名单里，但它没有提到 ${AUDIT_TABLE}`);
  }
});

// 动作词表同时存在于代码常量与 PG 的 CHECK 里 —— 这是本项目已经踩过一次的坑
// （supervisor_commit_records 的 status 少一个 FAILED，见 006 的说明）。
// 判据从**迁移文件**推导，而不是让人再抄一份值域进来。
test('迁移文件的 CHECK 词表与代码常数完全一致', () => {
  const sql = readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
  const actionMatch = sql.match(/action\s+text\s+NOT NULL\s*\n?\s*CHECK \(action IN \(([^)]*)\)\)/u);
  const outcomeMatch = sql.match(/outcome\s+text\s+NOT NULL CHECK \(outcome IN \(([^)]*)\)\)/u);
  assert.ok(actionMatch, '没能在迁移文件里解析出 action 的 CHECK —— 解析器过期了，别当成通过');
  assert.ok(outcomeMatch, '没能在迁移文件里解析出 outcome 的 CHECK');
  const parse = (group) => group.split(',').map((item) => item.trim().replace(/^'|'$/gu, ''));
  assert.deepEqual(parse(actionMatch[1]).sort(), [...AUDIT_ACTIONS].sort());
  assert.deepEqual(parse(outcomeMatch[1]).sort(), [...AUDIT_OUTCOMES].sort());
  // 回滚必须 fail-closed：有审计行时拒绝删除。
  const rollback = readFileSync(path.join(REPO_ROOT, ROLLBACK), 'utf8');
  assert.match(rollback, /RAISE EXCEPTION/u, '回滚脚本必须对「表里已有审计行」fail-closed');
});
