#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dailyReportTargets, loadFeishuCredentials } from '../../../runtime/feishu-targets.mjs';
import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import { appendAudit, describeAuditRow } from '../../../runtime/daily-report-audit.mjs';
import { reportDateEpoch } from './daily-report-core.mjs';
import { buildEnvironment, dirHasEntries, evidenceBaseDir, resolveEvidenceDir } from './daily-report-runtime.mjs';
import { assertEvidenceShopKey } from './shop-identities.mjs';
import { assertShopIdentity, sycmShopIdentityExpression } from './collect-core.mjs';
import { classifyInquiryWrite, describeFeishuRowGap, extractInquiryMetrics, findDailyStoreRow, resolveShopOptionId } from './inquiry-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const TARGET = dailyReportTargets('kcne');
const DEFAULTS = Object.freeze({
  // 端口来自 runtime/browser-ports.mjs（唯一来源）；这里是日报链的商家号代理。
  proxy: `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`,
  appToken: TARGET.baseToken,
  tableId: TARGET.inquiryTable,
});
const WRITTEN_FIELDS = Object.freeze(['询单量', '同层同行询单量']);

function parseArgs(argv) {
  const args = { ...DEFAULTS, commit: false, allowMissingPeer: false, shopKey: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--commit') args.commit = true;
    else if (key === '--allow-missing-peer') args.allowMissingPeer = true;
    else if (key === '--date') args.reportDate = argv[++index];
    else if (key === '--source-shop') args.sourceShop = argv[++index];
    else if (key === '--shop') args.shop = argv[++index];
    // 证据目录的店铺维度（运营叫法）。**不给时行为逐字不变**；多店铺必须给，
    // 而且必须与 push 那一步给同一个值 —— 否则回填会并入另一代的目录里（拆分产物）。
    else if (key === '--shop-key') args.shopKey = argv[++index];
    else if (key === '--proxy') args.proxy = argv[++index];
    else if (key === '--output-dir') args.outputDir = argv[++index];
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.reportDate ?? '')) throw new Error('missing or invalid --date');
  if (!args.sourceShop) throw new Error('missing --source-shop');
  if (!args.shop) throw new Error('missing --shop');
  // 产物落哪一代：这里用 'latest' —— 回填是**同一次运行的第二阶段**，必须并入
  // run-daily-report 刚建好的那一代；按 'fresh' 走就会把它和 plan/receipt 拆到两个目录。
  args.outputDir = args.outputDir ? path.resolve(args.outputDir) : null;
  return args;
}

async function proxyJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `proxy request failed: HTTP ${response.status}`);
  return payload;
}

async function discoverSycmTarget(args) {
  const targets = await proxyJson(`${args.proxy}/targets`);
  const matches = targets.filter(target => target.type === 'page'
    && target.url.includes('sycm.taobao.com/qos/service/frame/shop/performance'));
  if (matches.length !== 1) throw new Error(`expected one SYCM shop-performance page, got ${matches.length}`);
  return matches[0];
}

async function readSycmTable(args) {
  const target = await discoverSycmTarget(args);
  // 身份读取**复用采集段那一份**（collect-core 的 `sycmShopIdentityExpression`）。
  // 2026-09-19 改：这里原先自己写了一份 —— 硬编码类名 `.ebase-frame-header-root a`、而且只认
  // 「 主店」。那是同一件事的第二份实现，代价是「页面一改版就一个坏一个不坏」，
  // 而两处读到的店名还要拿去和同一个期望值比对（口径不同、结论却看起来一样）。
  // core 那份按**文本形状**取（以「主店/子店」结尾且最短），既抗改版也支持子店账号。
  // 内嵌成一段（而不是分两次 eval）是为了让「店名」与「表格」在同一时刻读到，中间不留窗口。
  const expression = `(() => {
    const identity = JSON.parse(${sycmShopIdentityExpression()});
    const clean = value => String(value ?? '').trim().replace(/\\s+/g, ' ');
    const tables = [...document.querySelectorAll('table')].filter(table =>
      [...table.querySelectorAll('thead th')].some(th => clean(th.innerText) === '当日询单人数'));
    if (tables.length !== 1) throw new Error('expected one 当日询单人数 table, got ' + tables.length);
    const table = tables[0];
    return JSON.stringify({
      url: location.href,
      sourceShop: identity.shopName,
      identityRaw: identity.raw,
      identityCandidates: identity.candidates,
      headers: [...table.querySelectorAll('thead th')].map(th => clean(th.innerText)),
      rows: [...table.querySelectorAll('tbody tr:not(.ant-table-measure-row), tfoot tr')]
        .map(row => [...row.querySelectorAll('th,td')].map(td => clean(td.innerText))),
    });
  })()`;
  const payload = await proxyJson(`${args.proxy}/eval?target=${encodeURIComponent(target.targetId)}`, {
    method: 'POST', body: expression,
  });
  return JSON.parse(payload.value);
}

function withoutInquiryFields(fields) {
  return Object.fromEntries(Object.entries(fields ?? {}).filter(([name]) => !WRITTEN_FIELDS.includes(name)));
}

// 「读选项表」与「运营店名 → 选项 id」这两件事**已抽到 `inquiry-core.mjs`**（2026-10-07 搬的）。
//
// 为什么搬走：建行骨架那个新脚本（`ensure-inquiry-rows.mjs`）要用**同一份**判据 ——
// 两份实现漂开的那天，症状是「建行时认得出这家店、回填时认不出」，而且两边都不报错。
// 本文件里那两处调用点、以及产物字段（`matchedBy` / `shopOptionId`）与从前逐字相同：
// 搬迁不许改行为（解析结果一样、抛错条件一样、返回值一样）。

// 审计：**这是补上的缺口**（2026-09-17 复盘）。
//
// 007 的 CHECK 早就允许 `push | ui-verify | inquiry-backfill` 三个动作，可 appendAudit 只被
// run-daily-report.mjs 调用（push / ui-verify 两条路），而 run-inquiry-backfill.mjs 根本没接线
// ⇒ 询单回填**从来没有留下过审计行**。这是本项目反复出现的「词表/文档比代码乐观」形态
// （同族：登录态 AUTH_EXPIRING 只写在文档里）。词表里有这个值、却没人写，等于把缺口伪装成已完成。
//
// 两条纪律照搬 run-daily-report.mjs：只有真的走到对外动作那一步才建立上下文（dry-run 什么都没发生，
// 不记）；写审计失败**绝不能**让回填链失败 —— 数据已经进飞书了，本地旁证写不进去不该把成功判成失败。
let auditContext = null;

async function recordAudit(entry) {
  const row = describeAuditRow(entry);
  const result = await appendAudit(row);
  if (result.written) console.log(`[audit] 已记 ${row.action}/${row.outcome} id=${result.id}`);
  else console.error(`[audit] 未写入（不影响本次结论）：${result.reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseDir = evidenceBaseDir({ evidenceRoot: path.join(REPO_ROOT, 'evidence'),
    reportDate: args.reportDate, shopKey: args.shopKey });
  const resolved = resolveEvidenceDir({ baseDir, explicit: args.outputDir, isOccupied: dirHasEntries, policy: 'latest' });
  args.outputDir = resolved.dir;
  mkdirSync(args.outputDir, { recursive: true });
  const source = await readSycmTable(args);
  // 身份判据：**fail-closed**，并与采集段共用同一套措辞与理由（`assertShopIdentity`）。
  // 「读不到」也算失败 —— 身份未知就等于没核对过。原先这里自己抛一句
  // `unexpected SYCM shop: …`，读不到时的表现与采集段不一样，排查时得多想一层。
  const identityCheck = assertShopIdentity({ expected: args.sourceShop, observed: source.sourceShop,
    label: '生意参谋店铺' });
  console.log(`[身份] 生意参谋页头 = ${JSON.stringify(source.sourceShop)}`
    + `（原始 ${JSON.stringify(source.identityRaw)}）｜期望 ${JSON.stringify(args.sourceShop)}`
    + `${identityCheck.checked ? ' ✓' : '（未核对）'}`);
  // 目录名里的店铺键必须与飞书那一行的店铺叫法一致（两者都是运营叫法，本来就该同一个值）。
  // 不核的话会出现「目录叫 A 店、写进去的是 B 店那一行」——从文件名上完全看不出来。
  if (args.shopKey) assertEvidenceShopKey(args.shopKey, { shopKey: args.shop });
  const metrics = extractInquiryMetrics(source, args.reportDate,
    { peerBenchmarkRequired: !args.allowMissingPeer });

  const clientModule = await import(pathToFileURL(path.join(REPO_ROOT,
    'skills', 'xws-to-feishu-base', 'scripts', 'feishu-client.mjs')));
  const credentials = loadFeishuCredentials('kcne');
  const client = new clientModule.FeishuClient({ appId: credentials.appId, appSecret: credentials.appSecret,
    appToken: args.appToken, tableId: args.tableId });
  const [tables, fields, beforeRecords] = await Promise.all([
    client.listTables(), client.listFields(), client.listRecords(),
  ]);
  const table = tables.find(item => item.tableId === args.tableId);
  if (table?.name !== '各店铺数据日报') throw new Error(`unexpected Feishu table: ${table?.name ?? 'missing'}`);
  for (const [name, type] of [['日期', 5], ['店铺', 3], ['询单量', 2], ['同层同行询单量', 2]]) {
    const field = fields.find(item => item.fieldName === name);
    if (!field || field.type !== type) throw new Error(`unexpected Feishu field ${name}: ${JSON.stringify(field)}`);
  }

  // 「店铺」是 SingleSelect：OpenAPI 在这个字段上**会回店名、也会回选项 id**（2026-09-29 实测，
  // 09-28 那天整批 12 行是 id 形态）。id 只在字段自己的选项表里唯一，所以必须**从 API 读**这张表，
  // 而不是在代码里抄一份——抄一份的代价是「选项改名/加店」时判据静默失效。
  // 读不到就退回只认店名（与修复前逐字相同），不猜。
  const shopOptionId = await resolveShopOptionId(client, args.shop);
  console.log(`[店铺] ${JSON.stringify(args.shop)} → 选项 id ${JSON.stringify(shopOptionId)}`
    + `${shopOptionId ? '' : '（字段选项里没有这个店名；只按店名匹配）'}`);

  const epoch = reportDateEpoch(args.reportDate);
  const picked = findDailyStoreRow(beforeRecords, epoch, args.shop, { optionId: shopOptionId });
  if (!picked.record) {
    // 报错里要带「候选几个」：0 个＝这一天没有我方的行（**行骨架缺失**，2026-10-07 起单列一类，
    // 并带上处置）；>1 个＝同日同店出现多行（更该炸，且要人核对）。
    // 措辞由 `inquiry-core.describeFeishuRowGap` 给：链的分类器按那个标记认这一类，
    // 两处各写一句就会漂 —— 漂开那天这一档又落回兜底，去浏览器里找一堆不存在的原因。
    throw new Error(describeFeishuRowGap({
      shop: args.shop, reportDate: args.reportDate, reportDateEpoch: epoch,
      candidateCount: picked.candidateCount,
    }));
  }
  const before = picked.record;
  const disposition = classifyInquiryWrite(before.fields, metrics);
  // 降级时只写「询单量」，不碰「同层同行询单量」——让那一格保持空白，而不是写 0 或占位值。
  const values = metrics.peerBenchmark === 'PEER_UNAVAILABLE'
    ? { 询单量: metrics.inquiry }
    : { 询单量: metrics.inquiry, 同层同行询单量: metrics.peerInquiry };
  const plan = {
    mode: args.commit ? 'commit' : 'dry-run', reportDate: args.reportDate, shop: args.shop,
    environment: buildEnvironment({
      proxyUrl: args.proxy,
      ports: { browser: PROJECT_PORTS.dailyReportBrowser, proxy: PROJECT_PORTS.dailyReportProxy },
      identities: { id: BROWSER_IDS.dailyReport, label: BROWSER_LABELS.dailyReport },
    }),
    evidence: { outputDir: args.outputDir, generation: resolved.generation, reason: resolved.reason },
    target: { appToken: args.appToken, tableId: args.tableId, tableName: table.name, recordId: before.record_id,
      // 认的是店名还是选项 id —— 写进产物。2026-09-29 之前没人记这个，
      // 于是「表里那行店铺存的是 optXXX」这件事只能靠人肉重读全表才发现。
      matchedBy: picked.matchedBy, shopOptionId },
    source: { url: source.url, shop: source.sourceShop, column: '当日询单人数',
      dateRow: args.reportDate, benchmarkRow: metrics.peerBenchmark === 'PEER_UNAVAILABLE' ? null : '同行同层均值',
      peerBenchmark: metrics.peerBenchmark, rows: (source.rows ?? []).length },
    degraded: metrics.peerBenchmark === 'PEER_UNAVAILABLE'
      // 历史日（自定义日期）实测只剩 3 行，数据源不返回同行同层对比行。
      // 这是显式降级：单据里写清缺什么、为什么缺，而不是静默留空或写 0。
      ? { code: 'PEER_UNAVAILABLE',
        reason: 'SYCM 自定义日期模式下表格不含「同行同层均值」行（预设「1天」才有）',
        omittedFields: ['同层同行询单量'], sourceRowCount: (source.rows ?? []).length }
      : null,
    values,
    prewrite: { disposition, 询单量: before.fields?.['询单量'] ?? null,
      同层同行询单量: before.fields?.['同层同行询单量'] ?? null },
  };
  const planPath = path.join(args.outputDir, 'inquiry-backfill-plan.json');
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  if (!args.commit) {
    const status = disposition === 'WRITE_REQUIRED' ? 'DRY_RUN_READY' : 'ALREADY_VERIFIED';
    console.log(JSON.stringify({ status, planPath, recordId: before.record_id, values: plan.values,
      degraded: plan.degraded }, null, 2));
    return;
  }

  // 走到这里就意味着「一定会碰一次远端表」：写回填值，或至少回读一次做结论。
  // 所以审计上下文从这里开始有意义，而 dry-run 那条分支已经 return 掉了。
  auditContext = {
    action: 'inquiry-backfill', reportDate: args.reportDate, shopName: args.shop,
    mode: plan.mode, environment: plan.environment,
    detail: { sourceShop: source.sourceShop, sourceUrl: source.url, disposition,
      values: plan.values, peerBenchmark: metrics.peerBenchmark, evidenceGeneration: resolved.generation },
  };

  let writeResponseError;
  const attemptPath = path.join(args.outputDir, `inquiry-attempt-${Date.now()}.json`);
  if (disposition === 'WRITE_REQUIRED') {
    writeFileSync(attemptPath, `${JSON.stringify({ status: 'WRITE_OUTCOME_UNKNOWN', plan, before, source }, null, 2)}\n`, 'utf8');
    try {
      const updated = await client.batchUpdateRecords([{ record_id: before.record_id, fields: plan.values }]);
      assert.deepEqual(updated, [before.record_id]);
    } catch (error) {
      writeResponseError = error.message;
    }
  }
  const afterRecords = await client.listRecords();
  // 回读用**同一个匹配器**（含选项 id 形态）。这里若退回只认店名，
  // 就会出现「写成功了、回读报 got 0」这种最难查的假红 —— 匹配口径两边必须同一份。
  const afterPicked = findDailyStoreRow(afterRecords, epoch, args.shop, { optionId: shopOptionId });
  if (!afterPicked.record) {
    throw new Error(`回读时找不到那一行 ${args.shop} / ${epoch}，got ${afterPicked.candidateCount}`);
  }
  const after = afterPicked.record;
  assert.equal(classifyInquiryWrite(after.fields, metrics), 'ALREADY_VERIFIED');
  assert.equal(after.record_id, before.record_id);
  assert.deepEqual(withoutInquiryFields(after.fields), withoutInquiryFields(before.fields));

  if (disposition === 'ALREADY_VERIFIED') {
    // 没写值，但**回读过了**——也是「我做过的动作」的一种，照记（重复本身是事实）。
    await recordAudit({ ...auditContext, outcome: 'ok', recordId: after.record_id,
      detail: { ...auditContext.detail, status: disposition, wrote: false, unchangedOtherFields: true } });
    console.log(JSON.stringify({ status: disposition, recordId: after.record_id, outputDir: args.outputDir,
      values: plan.values, unchangedOtherFields: true }, null, 2));
    return;
  }
  const receipt = { ...plan, status: 'COMMITTED_AND_VERIFIED',
    writeResponseError,
    verified: { recordId: after.record_id, unchangedOtherFields: true, values: plan.values,
      matchedBy: afterPicked.matchedBy } };
  const receiptPath = path.join(args.outputDir, 'inquiry-backfill-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  writeFileSync(attemptPath, `${JSON.stringify({ ...receipt, before, source }, null, 2)}\n`, 'utf8');
  await recordAudit({ ...auditContext, outcome: 'ok', recordId: after.record_id, receiptPath,
    detail: { ...auditContext.detail, status: receipt.status, wrote: true, unchangedOtherFields: true } });
  console.log(JSON.stringify({ status: receipt.status, receiptPath, recordId: after.record_id,
    outputDir: args.outputDir, values: plan.values, unchangedOtherFields: true }, null, 2));
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  // 失败同样是一次「我做过的动作」，而且是最需要留下痕迹的那种。
  // 只在已经建立上下文（真的走到过对外动作那一步）时才记。
  if (auditContext) {
    await recordAudit({ ...auditContext, outcome: 'failed',
      detail: { ...auditContext.detail, error: String(error?.message ?? error).slice(0, 2000) } });
  }
  process.exitCode = 1;
});
