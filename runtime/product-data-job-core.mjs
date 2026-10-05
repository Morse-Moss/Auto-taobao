import path from 'node:path';
import { collectingShopKeys, shopBrowserKeys } from './browser-ports.mjs';
// 「每批几家」的默认值从 `runtime/batch-plan.mjs` 取 —— 与日报链是**同一个旋钮、同一份口径**。
// 在这里另写一个字面量 5 就是第二处实现，而它漂了的表现是「两条链的批次大小悄悄不一样」。
import { DEFAULT_BATCH_SIZE } from './batch-plan.mjs';

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

/**
 * 「本阶段不做推广」的闸门（2026-10-05 加）。
 *
 * 为什么要有它：推广链**还在分支开发**（`feature/alimama-keyword-report`，未吸收进 main），
 * 而这条链的推广段（`import-promotion-data.mjs`）取的还是 profile 上那份**旧的单对象**目标 ——
 * 它指向 9 月的商品 base。10 月跑它会把 10 月的推广行写进**已经关账的 9 月表**，
 * 而收据上完全看不出来（同日重复行闸门也拦不住：那是另一张表的去重）。
 *
 * 做成**显式开关**、而不是先把那段代码删掉，理由有三：
 *   · 跳过是**可见的**：收据里那段记 `SKIPPED`（**不是** PENDING、更不是 FAILED），日志也点名说是有意跳过；
 *   · 不带这个开关 ⇒ 与改动前**逐字相同**的行为（推广照采照导），回滚不需要改代码；
 *   · 定时入口默认带上它 —— 无人值守那条路上有个会把数据写到错 base 的段，默认必须是「不做」。
 *
 * 推广链接上 main 之后，把 `renderProductJobEntry` 的默认值翻过来，
 * 并同步改 `product-data-job-core.test.mjs` 里那条「定时入口必须带 --skip-promotion」的断言 ——
 * 那条断言就是这条闸门的到期提醒，别让它悄悄留在生产里。
 */
export const SKIP_PROMOTION_REASON = '推广线在分支开发中（feature/alimama-keyword-report），本阶段有意跳过';

export function buildProductJobPlan({ dateInput = 'yesterday', shops = null, commit = true, skipPromotion = false,
  registered = shopBrowserKeys(), collecting = collectingShopKeys() } = {}) {
  // 默认＝**参与采集**的店铺，不是登记表全部：登记表里可能还有没开始收集的空店
  // （2026-09-30 白天有 1 家，当晚用户拍板开 13 家后那张表清空）。把空店算进来会让登录预检
  // 多查一家、采集多起一家、导入多写一家 —— 而它三项都做不成，最后表现为「一条每天都会响的假告警」。
  // 两个集合可注入、默认＝真实登记表：理由同 `batch-plan.mjs` 的 `resolveShopNames`
  // （那条「还没开始收集」分支的活体样本已随空表清空，靠「仓库里恰好有空店」覆盖它＝把守卫交给运气）。
  const selected = shops ?? collecting;
  if (!selected.length) throw new Error('shops must contain at least one shop');
  const notCollecting = selected.filter((shop) => !collecting.includes(shop) && registered.includes(shop));
  if (notCollecting.length) {
    throw new Error(`这些店铺已登记但还没开始收集数据：${notCollecting.join(', ')}`
      + '（见 runtime/browser-ports.mjs 的 SHOPS_NOT_COLLECTING_YET）');
  }
  const unknown = selected.filter((shop) => !registered.includes(shop));
  if (unknown.length) throw new Error(`unknown shops: ${unknown.join(', ')}`);
  return { dateInput, shops: selected, parallelShopCount: selected.length,
    reportOrder: ['product', 'inquiry', 'promotion'], commit, skipPromotion };
}

export function renderProductJobEntry({ nodeExe = process.execPath, repoRoot = path.resolve(import.meta.dirname, '..'), dateInput = 'yesterday', commit = true, batches = DEFAULT_BATCH_SIZE, skipPromotion = true } = {}) {
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  const args = [quote(path.join(repoRoot, 'scripts', 'run-product-data-job.mjs')), '--date', dateInput];
  if (commit) args.push('--commit');
  // 分批（2026-09-30 起，用户拍板「要分批，跟日报一样的批次」）：**跑完一批释放一批**。
  // 为什么必须落在这一处：这条链从前是一把起齐**全部**参与采集的店铺（13 家 ⇒ 13 个 Edge ＋ 13 个代理
  // 同时活着），而 13 × 约 1.7 GB 远超本机余量。定时命令是从**这里**渲染出来的，
  // 所以「分批」这件事必须出现在这里，否则定时那条路永远回到全量常驻。
  // 传 `batches: null` 可以显式渲染出「不分批」的那条命令（排查用）。
  if (batches !== null && batches !== undefined) args.push('--batches', String(batches));
  // 推广段默认跳过（2026-10-05）：理由见 `SKIP_PROMOTION_REASON`。
  // 传 `skipPromotion: false` 可以显式渲染出「照旧做推广」的那条命令（推广链接上之后就是新默认值）。
  if (skipPromotion) args.push('--skip-promotion');
  return [quote(nodeExe), ...args].join(' ');
}
