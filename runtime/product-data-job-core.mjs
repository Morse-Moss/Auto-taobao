import path from 'node:path';
import { shopBrowserKeys } from './browser-ports.mjs';

export const PRODUCT_JOB_FILES = Object.freeze({
  start: 'scripts/start-all.mjs',
  login: 'skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs',
  productCollect: 'skills/sycm-product-data/scripts/collect-product-report.mjs',
  productImport: 'skills/sycm-product-data/scripts/import-product-data.mjs',
  inquiryCollect: 'skills/sycm-inquiry-data/scripts/collect-inquiry-report.mjs',
  inquiryImport: 'skills/sycm-inquiry-data/scripts/import-inquiry-data.mjs',
  promotionCollect: 'skills/sycm-promotion-data/scripts/collect-product-report.mjs',
  promotionImport: 'skills/sycm-promotion-data/scripts/import-promotion-data.mjs',
  release: 'scripts/release-product-data-browsers.mjs',
});

export function buildProductJobPlan({ dateInput = 'yesterday', shops = null, commit = true } = {}) {
  const selected = shops ?? shopBrowserKeys();
  if (!selected.length) throw new Error('shops must contain at least one shop');
  const unknown = selected.filter((shop) => !shopBrowserKeys().includes(shop));
  if (unknown.length) throw new Error(`unknown shops: ${unknown.join(', ')}`);
  return { dateInput, shops: selected, parallelShopCount: selected.length,
    reportOrder: ['product', 'inquiry', 'promotion'], commit };
}

export function renderProductJobEntry({ nodeExe = process.execPath, repoRoot = path.resolve(import.meta.dirname, '..'), dateInput = 'yesterday', commit = true } = {}) {
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  const args = [quote(path.join(repoRoot, 'scripts', 'run-product-data-job.mjs')), '--date', dateInput];
  if (commit) args.push('--commit');
  return [quote(nodeExe), ...args].join(' ');
}
