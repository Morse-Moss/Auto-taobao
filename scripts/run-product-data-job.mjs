#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { shopBrowserKeys, shopInstance } from '../runtime/browser-ports.mjs';
import { buildProductJobPlan, PRODUCT_JOB_FILES } from '../runtime/product-data-job-core.mjs';
import { resolveTargetDate } from '../skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function parseArgs(argv) { const o = { date: 'yesterday', shops: null, commit: false }; for (let i = 0; i < argv.length; i += 1) { const a = argv[i]; if (a === '--date') o.date = argv[++i]; else if (a === '--shops') o.shops = String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean); else if (a === '--commit') o.commit = true; else if (a === '--help' || a === '-h') o.help = true; else throw new Error(`unknown argument ${a}`); } return o; }
function run(file, args, { capture = false } = {}) { return new Promise((resolve) => { const child = spawn(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] }); let out = ''; let err = ''; if (capture) { child.stdout.on('data', (x) => { out += x; }); child.stderr.on('data', (x) => { err += x; }); } child.on('close', (code) => resolve({ code: code ?? -1, out, err })); child.on('error', (error) => resolve({ code: -1, out, err: String(error.message) })); }); }
function jsonTail(text) { const i = text.lastIndexOf('{'); if (i < 0) return null; try { return JSON.parse(text.slice(i)); } catch { return null; } }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function latestFile(dir, predicate) { const files = fs.readdirSync(dir).filter(predicate).map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs })); files.sort((a, b) => b.mtime - a.mtime); return files[0] ? path.join(dir, files[0].name) : null; }
async function main(argv) {
  let options; try { options = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (options.help) { console.log('node scripts/run-product-data-job.mjs [--date yesterday] [--shops a,b] [--commit] [--notify]'); return 0; }
  const date = resolveTargetDate(options.date); const plan = buildProductJobPlan({ dateInput: options.date, shops: options.shops, commit: options.commit });
  const evidence = path.join(ROOT, 'evidence', `product-data-job-${date}`); ensureDir(evidence);
  const logPath = path.join(evidence, 'job.log'); const log = (line) => { const text = `[${new Date().toISOString()}] ${line}\n`; fs.appendFileSync(logPath, text); process.stdout.write(text); };
  const shopArg = plan.shops.join(','); let status = 0;
  try {
    log(`商品数据自动采集开始：${options.date} → ${date}；${plan.shops.length} 店并行；模式 ${options.commit ? 'commit' : 'dry-run'}`);
    const started = await run(PRODUCT_JOB_FILES.start, ['--only', shopArg]); if (started.code !== 0) throw new Error(`浏览器启动失败（${started.code}）`);
    const login = await run(PRODUCT_JOB_FILES.login, ['--shops', shopArg, '--json', '--login']); fs.writeFileSync(path.join(evidence, 'login-preflight.json'), login.out); if (login.code !== 0) throw new Error(`登录预检未通过（${login.code}），已停止采集并保留告警收据`);
    const results = await Promise.all(plan.shops.map(async (shop) => {
      const inst = shopInstance(shop); const dir = path.join(evidence, shop); const downloads = path.join(dir, 'downloads'); ensureDir(downloads);
      const product = await run(PRODUCT_JOB_FILES.productCollect, ['--shop', shop, '--date', date, '--downloads', downloads], { capture: true }); const pjson = jsonTail(product.out); const productFile = pjson?.file ?? latestFile(downloads, (n) => n.startsWith('【生意参谋平台】商品_全部_'));
      if (product.code !== 0 || !productFile) return { shop, product, productFile, stoppedAt: 'product-collect' };
      const inquiryFile = path.join(dir, 'inquiry.xls'); const inquiry = await run(PRODUCT_JOB_FILES.inquiryCollect, ['--proxy', `http://127.0.0.1:${inst.proxyPort}`, '--shop', shop, '--date', date, '--out', inquiryFile], { capture: true });
      if (inquiry.code !== 0 || !fs.existsSync(inquiryFile)) return { shop, product, productFile, inquiry, inquiryFile, stoppedAt: 'inquiry-collect' };
      const promotion = await run(PRODUCT_JOB_FILES.promotionCollect, ['--shop', shop, '--date', date, '--downloads', downloads], { capture: true }); const promotionFile = latestFile(downloads, (n) => n.endsWith('.zip'));
      return { shop, product, productFile, inquiry, inquiryFile, promotion, promotionFile };
    }));
    fs.writeFileSync(path.join(evidence, 'collection.json'), JSON.stringify(results, null, 2));
    for (const item of results) { if (item.product?.code !== 0 || !item.productFile) throw new Error(`${item.shop} 商品底单采集失败：${item.product?.err || item.product?.out || ''}`); if (item.inquiry?.code !== 0 || !fs.existsSync(item.inquiryFile)) throw new Error(`${item.shop} 商品询单采集失败：${item.inquiry?.err || item.inquiry?.out || ''}`); if (item.promotion?.code !== 0 || !item.promotionFile) throw new Error(`${item.shop} 商品推广采集失败：${item.promotion?.err || item.promotion?.out || ''}`); }
    const common = options.commit ? ['--apply'] : [];
    for (const item of results) { const r = await run(PRODUCT_JOB_FILES.productImport, ['--file', item.productFile, '--shop', item.shop, ...common, '--evidence', path.join(evidence, item.shop, 'product-import')]); if (r.code !== 0) throw new Error(`${item.shop} 商品底单导入失败`); const q = await run(PRODUCT_JOB_FILES.inquiryImport, ['--file', item.inquiryFile, '--date', date, '--shop', item.shop, ...common, '--evidence', path.join(evidence, item.shop, 'inquiry-import')]); if (q.code !== 0) throw new Error(`${item.shop} 商品询单导入失败`); }
    const promotionArgs = results.flatMap((item) => ['--file', item.promotionFile, '--shop', item.shop]); const promo = await run(PRODUCT_JOB_FILES.promotionImport, [...promotionArgs, ...common, '--evidence', path.join(evidence, 'promotion-import')]); if (promo.code !== 0) throw new Error('商品推广导入失败');
    log('商品三类数据采集与导入完成');
  } catch (error) { status = 1; log(`失败：${error.message}`); } finally { const released = await run(PRODUCT_JOB_FILES.release, ['--shops', shopArg]); fs.writeFileSync(path.join(evidence, 'release.json'), released.out || released.err); if (released.code !== 0) { status = 1; log(`浏览器释放未确认（${released.code}）`); } else log('浏览器已释放并完成端口二次回读'); }
  log(`商品数据自动采集结束：退出码 ${status}`); return status;
}
if (pathToFileURL(process.argv[1]).href === import.meta.url) process.exit(await main(process.argv.slice(2)));
export { main, parseArgs };
