#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { shopBrowserKeys, shopInstance } from '../runtime/browser-ports.mjs';
import { buildProductJobPlan, PRODUCT_JOB_FILES } from '../runtime/product-data-job-core.mjs';
import { resolveTargetDate } from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';
import { acquireWorkflowLock, WORKFLOW_LOCK_NAME } from '../runtime/workflow-lock.mjs';
import crypto from 'node:crypto';
import os from 'node:os';
import { classifyWorkflowError, createWorkflowReceipt, writeWorkflowReceipt } from '../runtime/workflow-receipt.mjs';
import { runEnvironmentPreflight } from '../runtime/environment-preflight.mjs';
import { readAlertThrottleEntry, resolveAlertDedup, writeAlertThrottle } from '../runtime/alert-throttle.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function parseArgs(argv) { const o = { date: 'yesterday', shops: null, commit: false, notify: false }; for (let i = 0; i < argv.length; i += 1) { const a = argv[i]; if (a === '--date') o.date = argv[++i]; else if (a === '--shops') o.shops = String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean); else if (a === '--commit') o.commit = true; else if (a === '--notify') o.notify = true; else if (a === '--help' || a === '-h') o.help = true; else throw new Error(`unknown argument ${a}`); } return o; }
function run(file, args, { capture = false } = {}) { return new Promise((resolve) => { const child = spawn(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] }); let out = ''; let err = ''; if (capture) { child.stdout.on('data', (x) => { out += x; }); child.stderr.on('data', (x) => { err += x; }); } child.on('close', (code) => resolve({ code: code ?? -1, out, err })); child.on('error', (error) => resolve({ code: -1, out, err: String(error.message) })); }); }
function jsonTail(text) { const i = text.lastIndexOf('{'); if (i < 0) return null; try { return JSON.parse(text.slice(i)); } catch { return null; } }
// 子 CLI 的收据（notify-feishu / 释放包装）是**缩进过的** JSON，jsonTail 那种「从最后一个 `{` 开始解析」
// 会切到内层对象上、解析失败 —— 那时会被误读成「没送到」。所以先整体解析，再退回 jsonTail（兼容一行式 JSON）。
function parseJsonOutput(text) { const raw = String(text ?? '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch { return jsonTail(raw); } }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

// 收据里阶段状态只用三个词：PENDING（没轮到）/ COMPLETED / FAILED。
// 「停在哪一段」另记 `failedStage` —— 否则 PENDING 会同时表示「没轮到」和「跑失败了」。
// 阶段＝采集＋导入：导入失败时要把已经记成 COMPLETED 的那一段改回 FAILED（见下面的信息映射）。
function markStage(receipt, name, status) { const stage = receipt.stages?.find((entry) => entry.name === name); if (stage) stage.status = status; }

// 从失败信息归因到「停在哪一段」。采集与导入两类信息用的是同一组词（商品底单/询单/推广），
// 所以一张表就够；前三段（预检/启动/登录）不是阶段名，只用来写日志、不改进度表。
const STAGE_OF_MESSAGE = [
  [/商品底单/u, 'product'],
  [/商品询单/u, 'inquiry'],
  [/商品推广/u, 'promotion'],
  [/环境预检/u, 'preflight'],
  [/浏览器启动/u, 'start'],
  [/登录预检/u, 'login'],
];
function stageFromMessage(message) { return STAGE_OF_MESSAGE.find(([pattern]) => pattern.test(String(message)))?.[1] ?? null; }

/**
 * 失败时叫人（只在给了 `--notify` 时；成功不叫 —— 与日报链同一口径）。
 *
 * 三个不能省的点：
 *   ① 去重走公共模块 `runtime/alert-throttle.mjs`（别再各自抄一份）；指纹里含「停在哪一段」，
 *      同一编号但停的地方变了算新信息，不该被挡掉。
 *   ② 投递结论以 CLI 收据为准（SENT / DEDUPED / FAILED / NOT_CONFIGURED），**只真送出去了才记账** ——
 *      送失败还记账，会让下一次重跑被自己的记录挡掉。
 *   ③ 告警载荷同时落盘成 `alert.json`，收信人照着能自己去看证据目录。
 */
async function notifyFailure({ date, runId, evidence, failure, failedStage, log }) {
  const alertId = `product-data-${date}`;
  const fingerprint = `${failure?.class ?? 'FAILED'}|${failure?.reason ?? 'UNKNOWN'}|${failedStage ?? '-'}`;
  const decision = resolveAlertDedup({ previous: readAlertThrottleEntry({ alertId }), alertId, fingerprint });
  if (!decision.send) { log(`告警未发（去重）：${decision.reason}`); return { status: 'DEDUPED', reason: decision.reason }; }
  const alertFile = path.join(evidence, 'alert.json');
  fs.writeFileSync(alertFile, `${JSON.stringify({
    severity: 'ERROR',
    title: `商品数据采集未完成（${date}）`,
    targetLabel: `${date} 五家店铺商品数据`,
    period: date,
    capability: '商品数据采集与导入',
    machine: os.hostname(),
    reason: `${failure?.class ?? 'FAILED'}/${failure?.reason ?? 'UNKNOWN'}：${failure?.message ?? '未知原因'}`,
    action: `打开 ${evidence} 看 job.log 与 collection.json，确认停在哪家店哪一段；证据齐了再决定是否重跑该日`,
    evidence: { runReceipt: path.join(evidence, 'run-receipt.json'), collection: path.join(evidence, 'collection.json'), jobLog: path.join(evidence, 'job.log') },
    createdAt: new Date().toISOString(),
    alertId,
    runId,
  }, null, 2)}\n`);
  const sent = await run('runtime/notify-feishu.mjs', ['--alert-file', alertFile], { capture: true });
  // 送成功时收据在 stdout；送失败时 CLI 把收据打到 stderr 并以非零退出码收场。
  const receipt = parseJsonOutput(sent.code === 0 ? sent.out : sent.err) ?? parseJsonOutput(sent.out) ?? { status: 'FAILED', error: (sent.err || sent.out || '').trim().slice(0, 300) };
  if (sent.code === 0 && receipt?.status === 'SENT') writeAlertThrottle({ alertId, fingerprint, sentAt: new Date().toISOString() });
  log(`告警投递：${receipt?.status ?? 'FAILED'}（exit ${sent.code}）`);
  return receipt;
}

async function main(argv) {
  let options; try { options = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (options.help) { console.log('node scripts/run-product-data-job.mjs [--date yesterday] [--shops a,b] [--commit] [--notify]'); return 0; }
  const date = resolveTargetDate(options.date); const plan = buildProductJobPlan({ dateInput: options.date, shops: options.shops, commit: options.commit });
  const runId = `${date}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
  const evidence = path.join(ROOT, 'evidence', `product-data-job-${date}`, runId); ensureDir(evidence);
  const receiptPath = path.join(evidence, 'run-receipt.json');
  const receipt = createWorkflowReceipt({ workflow: 'product-data', runId, date, shops: plan.shops, stages: plan.reportOrder.map((name) => ({ name, status: 'PENDING' })) });
  const logPath = path.join(evidence, 'job.log'); const log = (line) => { const text = `[${new Date().toISOString()}] ${line}\n`; fs.appendFileSync(logPath, text); process.stdout.write(text); };
  const shopArg = plan.shops.join(','); let status = 0; let lock = null; let failure = null; let failedStage = null;
  try {
    lock = acquireWorkflowLock(WORKFLOW_LOCK_NAME, 'product-data', { directory: path.join(ROOT, 'runtime', '.workflow-locks') });
    if (lock.staleReclaimed) log(`回收过期锁：原持有者=${lock.reclaimedFrom?.owner ?? '未知'}、pid=${lock.reclaimedFrom?.pid ?? '未知'}（该进程已不在）`);
    writeWorkflowReceipt(receiptPath, receipt);
    const preflight = runEnvironmentPreflight({ root: ROOT, workflow: 'product-data' });
    fs.writeFileSync(path.join(evidence, 'environment-preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`);
    if (!preflight.ok) throw new Error(`环境预检失败：${preflight.checks.filter(check => !check.ok).map(check => check.name).join(', ')}`);
    log(`商品数据自动采集开始：${options.date} → ${date}；${plan.shops.length} 店；底单串行、询单/推广并行；模式 ${options.commit ? 'commit' : 'dry-run'}`);
    const started = await run(PRODUCT_JOB_FILES.start, ['--only', shopArg]); if (started.code !== 0) throw new Error(`浏览器启动失败（${started.code}）`);
    const login = await run(PRODUCT_JOB_FILES.login, ['--shops', shopArg, '--json', '--login'], { capture: true }); fs.writeFileSync(path.join(evidence, 'login-preflight.json'), login.out); if (login.code !== 0) throw new Error(`登录预检未通过（${login.code}），已停止采集并保留告警收据`);
    // 采集脚本一律**用它们自己的默认下载目录**（`%USERPROFILE%\Downloads`）—— 那是浏览器真的会写进去的地方，
    // 由 profile 的 `download.default_directory` 决定，脚本侧改不了。别再传 `--downloads <证据目录>`：
    // 上一版就是这么传的，结果是「下载其实成功了、采集脚本盯错目录」⇒ 五家全部报「下载超时」。
    const results = plan.shops.map((shop) => ({ shop }));
    // 阶段一：商品底单 —— **必须串行**（不是偷懒，是判据）。
    // 五个店铺浏览器共用同一个真实下载目录，而 SYCM 导出的文件名里**不含店铺标识**
    // （`【生意参谋平台】商品_全部_<日>_<日>.xls`）。并行点击时每个进程都在取「目录里新出现的那份」，
    // 两家会抢到同一份文件、把别家的商品写进自己店铺的底单 —— 静默串数据，比直接失败更糟。
    // 串行之后，每家的 before 快照已经包含前面几家的产物，只可能取到自己那一份。
    // （阶段二不必串行：询单走显式 `--out`，脚本自己把内容写进指定路径；推广按任务名唯一匹配
    //   `商品报表_YYYYMMDD_HHMMSS`，含时间戳、跨店不重复。）
    for (const item of results) {
      const shop = item.shop; ensureDir(path.join(evidence, shop));
      const product = await run(PRODUCT_JOB_FILES.productCollect, ['--shop', shop, '--date', date], { capture: true });
      item.product = product; item.productFile = jsonTail(product.out)?.file ?? null;
      if (product.code !== 0 || !item.productFile) { item.stoppedAt = 'product-collect'; item.error = (product.err || product.out || '').trim(); log(`[底单] ${shop} 失败：${item.error || '未返回文件'}（exit ${product.code}）`); }
      else log(`[底单] ${shop} 已采集 ${item.productFile}`);
    }
    markStage(receipt, 'product', results.every((item) => item.productFile) ? 'COMPLETED' : 'FAILED');
    // 阶段二：询单 + 推广 —— 也串行，理由与阶段一同源：推广的任务名只精确到秒
    // （`商品报表_YYYYMMDD_HHMMSS`），五家在同一秒提交会拿到**同名任务** ⇒ ZIP 文件名相同、
    // 只差 ` (n)` 后缀，并行时各家会在共享下载目录里抢到别人的 ZIP（静默串数据）。
    // 询单本身写显式 `--out`、不受共享目录影响，它在这条循环里跟着走，代价只有几秒。
    for (const item of results.filter((entry) => entry.productFile)) {
      const shop = item.shop; const inst = shopInstance(shop); const dir = path.join(evidence, shop);
      const inquiryFile = path.join(dir, 'inquiry.xls'); const inquiry = await run(PRODUCT_JOB_FILES.inquiryCollect, ['--proxy', `http://127.0.0.1:${inst.proxyPort}`, '--shop', shop, '--date', date, '--out', inquiryFile], { capture: true });
      item.inquiry = inquiry; item.inquiryFile = inquiryFile;
      if (inquiry.code !== 0 || !fs.existsSync(inquiryFile)) { item.stoppedAt = 'inquiry-collect'; item.error = (inquiry.err || inquiry.out || '').trim(); log(`[询单] ${shop} 失败：${item.error || '未落盘'}（exit ${inquiry.code}）`); continue; }
      log(`[询单] ${shop} 已落盘 ${inquiryFile}`);
      const promotion = await run(PRODUCT_JOB_FILES.promotionCollect, ['--shop', shop, '--date', date], { capture: true });
      item.promotion = promotion; item.promotionFile = jsonTail(promotion.out)?.file ?? null;
      if (promotion.code !== 0 || !item.promotionFile) { item.stoppedAt = 'promotion-collect'; item.error = (promotion.err || promotion.out || '').trim(); log(`[推广] ${shop} 失败：${item.error || '未返回文件'}（exit ${promotion.code}）`); }
      else log(`[推广] ${shop} 已采集 ${item.promotionFile}`);
    }
    markStage(receipt, 'inquiry', results.every((item) => item.inquiryFile && fs.existsSync(item.inquiryFile)) ? 'COMPLETED' : 'FAILED');
    markStage(receipt, 'promotion', results.every((item) => item.promotionFile) ? 'COMPLETED' : 'FAILED');
    fs.writeFileSync(path.join(evidence, 'collection.json'), JSON.stringify(results, null, 2));
    // 导入阶段：**逐店独立推进** —— 一家失败不再把另外几家已经采好的数据一起丢掉。
    // 为什么改（2026-09-27 实测三次）：旧版是「先把五家三段全验一遍，任一处不合格就 throw」，
    // 于是「底单 5/5、询单 5/5、推广 4/5」这样的一轮，飞书一个字都没写、整晚白跑。
    // 导入本身按 `统计日期+店铺+商品ID` 去重（09-25 审计：重跑新增 0 行）⇒ 先写没有副作用。
    // **成功口径不变**：任何一家/一段没采到或没导成，整轮照样以失败收场（退出码 1 + 告警），
    // 逐条缺口写进 `gaps`，不静默降级。
    const common = options.commit ? ['--apply'] : [];
    const gaps = [];
    const gapFor = (keyword) => gaps.some((gap) => gap.includes(keyword));
    for (const item of results) {
      if (!item.productFile) { gaps.push(`${item.shop}/底单 未采集`); continue; }
      const r = await run(PRODUCT_JOB_FILES.productImport, ['--file', item.productFile, '--shop', item.shop, ...common, '--evidence', path.join(evidence, item.shop, 'product-import')]);
      if (r.code !== 0) { gaps.push(`${item.shop}/底单 导入失败`); log(`[导入] ${item.shop} 底单失败（exit ${r.code}）`); } else log(`[导入] ${item.shop} 底单已写入`);
      if (!item.inquiryFile || !fs.existsSync(item.inquiryFile)) gaps.push(`${item.shop}/询单 未采集`);
      else { const q = await run(PRODUCT_JOB_FILES.inquiryImport, ['--file', item.inquiryFile, '--date', date, '--shop', item.shop, ...common, '--evidence', path.join(evidence, item.shop, 'inquiry-import')]); if (q.code !== 0) { gaps.push(`${item.shop}/询单 导入失败`); log(`[导入] ${item.shop} 询单失败（exit ${q.code}）`); } else log(`[导入] ${item.shop} 询单已写入`); }
      if (!item.promotionFile) gaps.push(`${item.shop}/推广 未采集`);
    }
    // 推广：五家齐时按小手册的形状做一次批量调用（收据落 `promotion-import/receipt.json`）；
    // 有人缺 ZIP 或批量失败时退成逐店导入（收据落 `promotion-import/<店>/`），把能写的先写掉。
    const importPromotionPerShop = async (items) => { for (const item of items) { const r = await run(PRODUCT_JOB_FILES.promotionImport, ['--file', item.promotionFile, '--shop', item.shop, ...common, '--evidence', path.join(evidence, 'promotion-import', item.shop)]); if (r.code !== 0) { gaps.push(`${item.shop}/推广 导入失败`); log(`[导入] ${item.shop} 推广失败（exit ${r.code}）`); } else log(`[导入] ${item.shop} 推广已写入`); } };
    const promoReady = results.filter((item) => item.promotionFile);
    if (promoReady.length === results.length) {
      const promotionArgs = promoReady.flatMap((item) => ['--file', item.promotionFile, '--shop', item.shop]);
      const promo = await run(PRODUCT_JOB_FILES.promotionImport, [...promotionArgs, ...common, '--evidence', path.join(evidence, 'promotion-import')]);
      if (promo.code === 0) log('[导入] 推广五家已批量写入');
      else { gaps.push('推广 批量导入失败'); await importPromotionPerShop(promoReady); }
    } else if (promoReady.length) {
      log(`[导入] 推广有 ${results.length - promoReady.length} 家未采到，改为逐店导入已采到的 ${promoReady.length} 家`);
      await importPromotionPerShop(promoReady);
    }
    markStage(receipt, 'product', gapFor('底单') ? 'FAILED' : 'COMPLETED');
    markStage(receipt, 'inquiry', gapFor('询单') ? 'FAILED' : 'COMPLETED');
    markStage(receipt, 'promotion', gapFor('推广') ? 'FAILED' : 'COMPLETED');
    if (gaps.length) { failedStage = gapFor('底单') ? 'product-import' : gapFor('询单') ? 'inquiry-import' : 'promotion-import'; throw new Error(`本轮不完整（${gaps.length} 处）：${gaps.join('；')}`); }
    log('商品三类数据采集与导入完成');
  } catch (error) { status = 1; failure = classifyWorkflowError(error); failedStage = failedStage ?? stageFromMessage(error.message); if (failedStage && receipt.stages.some((stage) => stage.name === failedStage)) markStage(receipt, failedStage, 'FAILED'); log(`失败：${error.message}（${failure.class}/${failure.reason}；停在哪一段=${failedStage ?? '未知'}）`); } finally {
    if (lock) {
      const released = await run(PRODUCT_JOB_FILES.release, ['--shops', shopArg], { capture: true });
      fs.writeFileSync(path.join(evidence, 'release.json'), released.out || released.err);
      // 不能只看退出码：既有的释放路径出过「假绿」（见 AGENTS.md）。这里再要求收据别自称没释放。
      const releaseReceipt = parseJsonOutput(released.out) ?? parseJsonOutput(released.err);
      if (released.code !== 0 || releaseReceipt?.released === false) { status = 1; failure = failure ?? { class: 'FAILED', reason: 'RELEASE_FAILED', message: 'browser release failed' }; failedStage = failedStage ?? 'release'; log(`浏览器释放未确认（exit ${released.code}${releaseReceipt?.released === false ? '、released=false' : ''}）`); }
      else log('浏览器已释放并完成端口二次回读');
      lock.release();
    } else log('未获得运行锁，跳过浏览器释放以保护其他流程');
    receipt.status = status === 0 ? 'COMPLETED' : 'FAILED';
    receipt.failure = failure; receipt.failedStage = failedStage; receipt.finishedAt = new Date().toISOString();
    writeWorkflowReceipt(receiptPath, receipt);
    if (options.notify && status !== 0) { try { await notifyFailure({ date, runId, evidence, failure, failedStage, log }); } catch (error) { log(`告警投递自身出错：${error.message}`); } }
  }
  log(`商品数据自动采集结束：退出码 ${status}`); return status;
}
if (pathToFileURL(process.argv[1]).href === import.meta.url) process.exit(await main(process.argv.slice(2)));
export { main, parseArgs };
