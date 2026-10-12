#!/usr/bin/env node
// 商品底单采集 CLI —— 只做「解析参数 + 接线」，编排与判据都在 `collect-product-core.mjs`。
//
// 接线图（改之前先看 `collect-product-core.mjs` 顶部那段「为什么」）：
//   · 代理端口 → `shopInstance(shop).proxyPort`（登记表是唯一来源，不许在这里写第二份）
//   · 店铺身份的期望值 → `SHOP_IDENTITIES[].sycmHeader`（页头显示名与来源表全称可能不同，用实测值）
//   · 下载目录 → 由浏览器 profile 的 `download.default_directory` 决定，即 `%USERPROFILE%\Downloads`。
//     别再传 `--downloads <证据目录>`：2026-09-27 就是这么传的，结果「下载其实成功了、脚本盯错目录」
//     ⇒ 五家全部报「下载超时」。
//   · 失败现场 → `--evidence`（默认 `<repo>/evidence/product-collect-failures/`，按 `日期-店铺` 命名）。
//     留默认值是因为上层 `scripts/run-product-data-job.mjs` 目前不传这个参数；等它有位置时把逐店
//     证据目录透传进来即可，这里一个字都不用改。
import path from 'node:path';
import { shopInstance } from '../../../runtime/browser-ports.mjs';
import { SHOP_IDENTITIES } from '../../sycm-alimama-daily-report/scripts/shop-identities.mjs';
import { collectProductReport, DEFAULT_ATTEMPTS, DEFAULT_DOWNLOAD_TIMEOUT_MS } from './collect-product-core.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function parseArgs(argv) {
  const out = {
    shop: null,
    date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    downloads: path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads'),
    evidence: path.join(REPO_ROOT, 'evidence/product-collect-failures'),
    attempts: DEFAULT_ATTEMPTS,
    downloadTimeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--shop') out.shop = argv[++i];
    else if (flag === '--date') out.date = argv[++i];
    else if (flag === '--downloads') out.downloads = path.resolve(argv[++i]);
    else if (flag === '--evidence') out.evidence = path.resolve(argv[++i]);
    else if (flag === '--attempts') out.attempts = Number(argv[++i]);
    else if (flag === '--download-timeout-ms') out.downloadTimeoutMs = Number(argv[++i]);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!out.shop) throw new Error('--shop is required');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const expectedIdentity = SHOP_IDENTITIES.find((entry) => entry.key === args.shop)?.sycmHeader;

collectProductReport({
  proxy: `http://127.0.0.1:${shopInstance(args.shop).proxyPort}`,
  shop: args.shop,
  date: args.date,
  downloads: args.downloads,
  expectedIdentity,
  evidenceDir: args.evidence,
  attempts: args.attempts,
  downloadTimeoutMs: args.downloadTimeoutMs,
  log: (line) => console.error(line),
}).then((result) => {
  console.log(JSON.stringify({ shop: result.shop, date: result.date, file: result.file, bytes: result.bytes }));
}).catch((error) => {
  console.error(`采集失败：${error.message}`);
  process.exitCode = 1;
});
