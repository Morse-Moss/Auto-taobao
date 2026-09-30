import path from 'node:path';
import { collectingShopKeys, shopBrowserKeys } from './browser-ports.mjs';

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
  // 默认＝**参与采集**的店铺，不是登记表全部：登记表里可能还有没开始收集的空店
  // （2026-09-30 起 1 家），把空店算进来会让登录预检多查一家、采集多起一家、导入多写一家 ——
  // 而它三项都做不成，最后表现为「一条每天都会响的假告警」。
  const selected = shops ?? collectingShopKeys();
  if (!selected.length) throw new Error('shops must contain at least one shop');
  const notCollecting = selected.filter((shop) => !collectingShopKeys().includes(shop)
    && shopBrowserKeys().includes(shop));
  if (notCollecting.length) {
    throw new Error(`这些店铺已登记但还没开始收集数据：${notCollecting.join(', ')}`
      + '（见 runtime/browser-ports.mjs 的 SHOPS_NOT_COLLECTING_YET）');
  }
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
