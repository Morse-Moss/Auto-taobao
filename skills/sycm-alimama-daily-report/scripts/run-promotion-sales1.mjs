#!/usr/bin/env node
// 销售一部推广日报编排器。
// 复用 run-promotion-daily-report.mjs 的页面/下载实现；这里只负责逐店、分批、导入和失败隔离。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectingShopKeys, shopInstance } from '../../../runtime/browser-ports.mjs';
import { expectArgs, shopIdentity } from './shop-identities.mjs';
import { resolveTargetDate } from './run-multi-shop-day.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, 'run-promotion-daily-report.mjs');
const IMPORTER = path.join(HERE, 'import-promotion-daily-report.mjs');
const SALES1 = Object.freeze(['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝', '网林淘宝', '里可林天猫', '网林家居']);

export function promotionSales1Plan({ shops = SALES1 } = {}) {
  const allowed = new Set(collectingShopKeys());
  const unknown = shops.filter((shop) => !allowed.has(shop) || !SALES1.includes(shop));
  if (unknown.length) throw new Error(`推广日报店铺不在销售一部采集范围：${unknown.join('、')}`);
  return shops.length ? [shops] : [];
}

function parse(argv) {
  const out = { date: null, shops: SALES1, apply: false, downloads: null, evidence: 'evidence/promotion-sales1' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--date') out.date = argv[++i];
    else if (key === '--shops') out.shops = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--downloads') out.downloads = path.resolve(argv[++i]);
    else if (key === '--evidence' || key === '--logs') out.evidence = path.resolve(argv[++i]);
    else if (key === '--commit') out.apply = true;
    else if (key === '--plan') out.plan = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(out.date ?? '')) throw new Error('--date 必须是 YYYY-MM-DD');
  return out;
}

function run(args, extra) {
  const result = spawnSync(process.execPath, [DRIVER, '--date', args.date, '--shop', extra.shop,
    '--proxy', `http://127.0.0.1:${shopInstance(extra.shop).proxyPort}`, '--kind', extra.kind,
    '--phase', extra.phase, '--expect-member', extra.identity.alimamaMemberName,
    '--expect-member-id', extra.identity.alimamaMemberId, ...(args.downloads ? ['--downloads', args.downloads] : []),
    ...(extra.task ? ['--task', extra.task] : [])], { encoding: 'utf8' });
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

export function runPromotionSales1(argv = process.argv.slice(2)) {
  const args = parse(argv);
  args.date = resolveTargetDate(args.date);
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
        const keywordSubmit = run(args, { shop, kind: 'keyword', phase: 'submit', identity });
        const keywordTask = taskFrom(keywordSubmit, 'keyword'); record.stages.push('keyword-submit');
        const audienceSubmit = run(args, { shop, kind: 'audience', phase: 'submit', identity });
        const audienceTask = taskFrom(audienceSubmit, 'audience'); record.stages.push('audience-submit');
        const keywordZip = zipFrom(run(args, { shop, kind: 'keyword', phase: 'fetch', task: keywordTask, identity }), 'keyword'); record.stages.push('keyword-fetch');
        const audienceZip = zipFrom(run(args, { shop, kind: 'audience', phase: 'fetch', task: audienceTask, identity }), 'audience'); record.stages.push('audience-fetch');
        const shopEvidence = path.join(args.evidence, shop);
        const importer = spawnSync(process.execPath, [IMPORTER, '--date', args.date, '--shop', shop, '--keyword', keywordZip, '--audience', audienceZip, '--evidence', shopEvidence, ...(args.apply ? ['--apply'] : [])], { encoding: 'utf8' });
        if (importer.status !== 0) throw new Error(importer.stderr || importer.stdout || '导入失败');
        record.status = 'ok'; record.stages.push('import');
      } catch (error) { record.error = error.message; }
      results.push(record);
      console.log(JSON.stringify(record, null, 2));
    }
  }
  return results.every((record) => record.status === 'ok') ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runPromotionSales1();
