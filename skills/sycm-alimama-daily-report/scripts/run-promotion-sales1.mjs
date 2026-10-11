#!/usr/bin/env node
// 销售一部推广日报编排器。
// 复用 run-promotion-daily-report.mjs 的页面/下载实现；这里只负责逐店、分批、导入和失败隔离。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectingShopKeys, shopInstance } from '../../../runtime/browser-ports.mjs';
import { readAlertThrottleEntry, resolveAlertDedup, writeAlertThrottle } from '../../../runtime/alert-throttle.mjs';
import { validateSummary, UNIFIED_SUMMARY_VERSION } from '../../../runtime/unified-summary-schema.mjs';
import { expectArgs, shopIdentity } from './shop-identities.mjs';
import { pendingForKind, readLedger } from './promotion-task-ledger.mjs';
import { resolveTargetDate } from './run-multi-shop-day.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DRIVER = path.join(HERE, 'run-promotion-daily-report.mjs');
const IMPORTER = path.join(HERE, 'import-promotion-daily-report.mjs');
const NOTIFY_CLI = path.resolve('runtime/notify-feishu.mjs');
const SALES1 = Object.freeze(['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝', '网林淘宝', '里可林天猫', '网林家居']);

// 推广链的飞书告警（P0-2，2026-10-11）：失败才投递、投递前去重、成功才记账——手法逐字对齐
// 日报链 run-multi-shop-day.mjs 的 sendRoundAlert（--alert-file 走文件不走 stdin 管道、stdio
// 显式 ['ignore','pipe','pipe'] 防 EBUSY、throttle 只认「真送出去」）。告警纪律同源：文案不带
// 机器名、盘符路径与内部代号；收信人要的下一步（去哪看、怎么拉起现场）写成可照做的动作。
export function buildPromotionRoundAlert({ date, results, now = () => new Date() } = {}) {
  const records = Array.isArray(results) ? results : [];
  const failed = records.filter((record) => record?.status !== 'ok');
  if (!failed.length) return null;
  return {
    type: 'PROMOTION_ROUND_FAILED',
    severity: 'ERROR',
    title: `推广日报没收完（业务日 ${date}）`,
    // 同一天同一轮共用一条锚；是否重复投递由 resolveAlertDedup 判（指纹变＝停的地方变了＝再发）。
    alertId: `promotion-round-${String(date ?? '').replace(/-/gu, '')}`,
    fingerprint: failed.map((record) => `${record.shop}@${record.stages?.at(-1) ?? 'start'}`).join('|'),
    createdAt: now().toISOString(),
    reason: failed.map((record) => `${record.shop}：${String(record.error ?? '未知失败').slice(0, 200)}`).join('\n').slice(0, 2000),
    action: '看运行日志里的逐店失败详情；窗口若已释放，用 start-all --only <店> 拉起后到阿里妈妈「下载任务管理」人工核对同业务日任务状态。',
    source: {
      targetLabel: `推广日报一轮 · ${records.length} 家店`,
      period: `业务日 ${date}`,
      capability: '推广日报',
      shopName: failed.map((record) => record.shop).join('、'),
    },
  };
}

export function deliverPromotionAlert({ alert, throttleFile, exec = spawnSync, node = process.execPath, now = () => new Date() } = {}) {
  if (!alert) return { delivered: false, suppressed: false, reason: 'no-failure' };
  const verdict = resolveAlertDedup({
    previous: readAlertThrottleEntry({ file: throttleFile, alertId: alert.alertId }),
    alertId: alert.alertId, fingerprint: alert.fingerprint, now: now(),
  });
  if (!verdict.send) return { delivered: false, suppressed: true, reason: verdict.reason };
  // 告警 JSON 走文件不走 stdin（EBUSY 教训，同日报链 2026-09-25 修）。
  const alertPath = path.join(os.tmpdir(), `promotion-round-alert-${process.pid}.json`);
  fs.writeFileSync(alertPath, JSON.stringify(alert), 'utf8');
  let result;
  try {
    result = exec(node, [NOTIFY_CLI, '--alert-file', alertPath], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    try { fs.unlinkSync(alertPath); } catch { /* 临时文件删不掉不影响投递结论 */ }
  }
  if (result.status !== 0) {
    // 失败已有记录，但「没人知道」比失败本身更要紧（同日报链口径）。
    console.error('[推广] 告警没送出去 —— 现在只有日志知道这一轮失败了，必须有人接手。');
    return { delivered: false, suppressed: false, reason: `notify-exit-${result.status}` };
  }
  // 只有真送出去才记账：送失败还记账，会让下一次重跑被自己的记录挡掉。
  writeAlertThrottle({ alertId: alert.alertId, fingerprint: alert.fingerprint, sentAt: now().toISOString() }, throttleFile);
  return { delivered: true, suppressed: false };
}

export function promotionSales1Plan({ shops = SALES1 } = {}) {
  const allowed = new Set(collectingShopKeys());
  const unknown = shops.filter((shop) => !allowed.has(shop) || !SALES1.includes(shop));
  if (unknown.length) throw new Error(`推广日报店铺不在销售一部采集范围：${unknown.join('、')}`);
  return shops.length ? [shops] : [];
}

export function parsePromotionSales1Args(argv) {
  const out = { date: null, shops: SALES1, apply: false, downloads: null, evidence: 'evidence/promotion-sales1', notify: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--date') out.date = argv[++i];
    else if (key === '--shops') out.shops = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--downloads') out.downloads = path.resolve(argv[++i]);
    else if (key === '--evidence' || key === '--logs') out.evidence = path.resolve(argv[++i]);
    else if (key === '--ledger') out.ledger = path.resolve(argv[++i]);
    else if (key === '--commit') out.apply = true;
    else if (key === '--notify') out.notify = true;
    else if (key === '--plan') out.plan = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  out.date = resolveTargetDate(out.date);
  return out;
}

function run(args, extra) {
  const result = spawnSync(process.execPath, [DRIVER, '--date', args.date, '--shop', extra.shop,
    '--proxy', `http://127.0.0.1:${shopInstance(extra.shop).proxyPort}`, '--kind', extra.kind,
    '--phase', extra.phase, '--expect-member', extra.identity.alimamaMemberName,
    '--expect-member-id', extra.identity.alimamaMemberId, ...(args.downloads ? ['--downloads', args.downloads] : []),
    '--ledger', args.ledger ?? path.resolve('runtime/promotion-task-ledger.json'),
    ...(extra.task ? ['--task', extra.task] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `阶段失败：${extra.kind}/${extra.phase}`);
  return result.stdout;
}

function taskFrom(output, kind) {
  const match = output.match(new RegExp(`\\[提交\\] ${kind}TaskName = (.+)`));
  if (!match) throw new Error(`未从提交输出读到 ${kind} 任务名`);
  return match[1].trim();
}
function zipFrom(output, kind) {
  const match = output.match(new RegExp(`\\[下载\\] ${kind}ZipPath = (.+)`));
  if (!match) throw new Error(`未从下载输出读到 ${kind} ZIP 路径`);
  return match[1].trim();
}

// 链级 summary（P0-3，2026-10-11）：run-batches 的释放判定与驻留判据（unfixableShopsOf /
// failedShopsOf）读的都是 `--logs` 目录下的 summary.json——推广链原先只往 stdout 打逐店 JSON、
// 从不落这个文件 ⇒ 下游判据全瞎 ⇒ 失败轮恒判「没有需要人看现场的失败」⇒ 照旧释放、现场被清
// （2026-10-11 07:00 轮 8 家全败后两批窗口被全放的直接成因）。
//
// 失败店带 `repairRequest: { candidates: [] }`：推广链**没有脚本自修能力**，任何失败都满足
// 「脚本修不动 ⇒ 需要人看现场」的判据语义（unfixableShopsOf 的空候选分支），这正是现状事实——
// 到 P1 统一 summary schema、接入修复内核后，这里换成真实的候选清单。
//
// 统一字段并写（三链对齐 P1 迁移第 3 步，2026-10-11，拍板七项全按推荐；同款做法见日报链第 2 步
// run-multi-shop-day.mjs 的 applyUnifiedSummaryFields）：**旧字段一个不动**（batch/shop/status/
// stages/error/recovery/repairRequest.candidates 原样保留），只新增——
//   · 顶层：version 换统一串（拍板 6.4-A 三链同串，常量 import 自校验器）、workflow='promotion-daily'；
//   · 逐店：evidence＝该店证据目录相对仓库根（与下面 importer 落盘用的 `<--evidence 根>/<店>`
//     同一款拼法；ok 店也补——agent 到场第一件事靠它指路，成功店现状没有任何字段指路）；
//   · 失败店：failureClass 恒 'STAGE_FAILED'（**最小档分类器**，草案 6.1 允许「先全部落
//     STAGE_FAILED 档，字段不能缺」——推广链尚无逐店分诊判据，细化留给后续，不发明新业务判据）、
//     noActionRequired:false（空菜单＝需要人看现场，失败店恒要人看）、autoRepair:null
//     （显式落 null：没跑过修复就是 null，不许 {} 也不许缺——unfixableShopsOf 的 gaveUp
//     判据靠 typeof 区分「没跑」与「跑过」）。
// 推广链没有 pending 形态（初值即 'failed'，fail-closed），无 pending 豁免问题。
export function buildPromotionSummary({ date, results, evidenceRoot, repoRoot = REPO_ROOT } = {}) {
  const records = Array.isArray(results) ? results : [];
  const evidenceOf = (shop) => path.relative(repoRoot, path.join(evidenceRoot, shop));
  return {
    version: UNIFIED_SUMMARY_VERSION,
    workflow: 'promotion-daily',
    date,
    shops: Object.fromEntries(records.map((record) => {
      // ok 店：只补 evidence，失败信号字段（failureClass/noActionRequired/autoRepair）不落。
      if (record?.status === 'ok') return [record.shop, { ...record, evidence: evidenceOf(record.shop) }];
      // 失败店：P0-3 的空菜单形态保留，统一字段按上面注记补齐。
      return [record.shop, {
        ...record,
        evidence: evidenceOf(record.shop),
        failureClass: 'STAGE_FAILED',
        noActionRequired: false,
        autoRepair: null,
        repairRequest: { candidates: [] },
      }];
    })),
  };
}

// 写入时校验（拍板 6.7-A，随迁移第 3 步一起上）：落盘前调 validateSummary，不过 ⇒ **照样落盘**
// （证据优先——格式问题不许升级成丢整轮结论，草案 5.2）＋ stderr 醒目警告（path/rule 摘要），
// 守卫测试随后会咬住同一批错。与日报链第 2 步 warnSummarySchemaViolations 同款（本地复制，
// 不 import skills 侧——skills 文件之间非必需不互相 import）。
function warnSummarySchemaViolations(summary, where) {
  const { ok, errors } = validateSummary(summary);
  if (ok) return;
  console.error(`[推广] ⚠️ summary 未过统一 schema 校验（${where}）—— 证据优先，照样落盘：`);
  for (const { path: at, rule, message } of errors) {
    console.error(`[推广]   ⚠️ ${at || '(顶层)'}［${rule}］${message}`);
  }
}

export function runPromotionSales1(argv = process.argv.slice(2)) {
  const args = parsePromotionSales1Args(argv);
  const batches = promotionSales1Plan({ shops: args.shops });
  if (args.plan) {
    console.log(JSON.stringify({ date: args.date, batches, mode: 'plan', apply: args.apply }, null, 2));
    return 0;
  }
  const results = [];
  for (const [batchIndex, batch] of batches.entries()) {
    for (const shop of batch) {
      const identity = shopIdentity(shop);
      const identityArgs = expectArgs(shop, { require: ['member'] });
      if (!identity.alimamaMemberId || identityArgs.missing.includes('member')) throw new Error(`${shop} 缺少阿里妈妈身份登记`);
      const record = { batch: batchIndex + 1, shop, status: 'failed', stages: [] };
      try {
        const ledgerPath = args.ledger ?? path.resolve('runtime/promotion-task-ledger.json');
        const ledger = readLedger(ledgerPath);
        const keywordPending = pendingForKind(ledger, { date: args.date, shop, kind: 'keyword' });
        const audiencePending = pendingForKind(ledger, { date: args.date, shop, kind: 'audience' });
        if (keywordPending.length || audiencePending.length) record.recovery = { keywordPending: keywordPending.map((r) => r.taskName), audiencePending: audiencePending.map((r) => r.taskName) };
        const keywordSubmit = run(args, { shop, kind: 'keyword', phase: 'submit', identity });
        const keywordTask = taskFrom(keywordSubmit, 'keyword'); record.stages.push('keyword-submit');
        const audienceSubmit = run(args, { shop, kind: 'audience', phase: 'submit', identity });
        const audienceTask = taskFrom(audienceSubmit, 'audience'); record.stages.push('audience-submit');
        const keywordZip = zipFrom(run(args, { shop, kind: 'keyword', phase: 'fetch', task: keywordTask, identity }), 'keyword'); record.stages.push('keyword-fetch');
        const audienceZip = zipFrom(run(args, { shop, kind: 'audience', phase: 'fetch', task: audienceTask, identity }), 'audience'); record.stages.push('audience-fetch');
        const shopEvidence = path.join(args.evidence, shop);
        const importer = spawnSync(process.execPath, [IMPORTER, '--date', args.date, '--shop', shop, '--keyword', keywordZip, '--audience', audienceZip, '--evidence', shopEvidence, ...(args.apply ? ['--apply'] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (importer.status !== 0) throw new Error(importer.stderr || importer.stdout || '导入失败');
        record.status = 'ok'; record.stages.push('import');
      } catch (error) { record.error = error.message; }
      results.push(record);
      console.log(JSON.stringify(record, null, 2));
    }
  }
  // 链级 summary 落盘（P0-3）：判据构造在 buildPromotionSummary（纯函数，有用例钉），
  // 这里只负责写文件——路径与 run-batches 释放判定读的 `--logs 根/summary.json` 对齐。
  // 并写→校验→落盘（迁移第 3 步）：统一字段在 buildPromotionSummary 构造期并写，
  // 落盘前过 validateSummary（不过⇒照样落盘＋stderr 警告），再写文件。
  fs.mkdirSync(args.evidence, { recursive: true });
  const summary = buildPromotionSummary({ date: args.date, results, evidenceRoot: args.evidence });
  warnSummarySchemaViolations(summary, '推广链收尾');
  const summaryPath = path.join(args.evidence, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[summary] 已落 ${summaryPath}`);
  // 失败出口（P0-2）：apply 且 --notify 时，失败才投递飞书告警（去重、成功才记账）。
  // dry-run 不投：没写数据就不该惊动人。全成功也不投。
  if (args.notify && args.apply) {
    const alert = buildPromotionRoundAlert({ date: args.date, results });
    const delivery = deliverPromotionAlert({ alert, throttleFile: path.resolve('runtime/alert-throttle.json') });
    console.log(JSON.stringify({ notify: delivery }, null, 2));
  }
  return results.every((record) => record.status === 'ok') ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runPromotionSales1();
