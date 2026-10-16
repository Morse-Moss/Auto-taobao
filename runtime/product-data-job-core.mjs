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
 * 「本阶段不做推广」的紧急开关（2026-10-05 加闸门，2026-10-16 恢复默认）。
 *
 * 历史：推广段的导入目标（import-promotion-data.mjs）曾长期读 profile 上那份**旧的单对象**
 * 目标 —— 指向 9 月的商品 base。10 月跑它会把 10 月的推广行写进**已经关账的 9 月表**，
 * 而收据上完全看不出来（同日重复行闸门也拦不住：那是另一张表的去重）。
 *
 * 2026-10-16 用户拍板恢复：导入器已改成按（店铺, 数据日期）解析 base（与底单/询单同款），
 * 批量路径也已按部门分组（修掉「一次调用跨部门写错 base」的缺陷）⇒ 闸门**默认关闭**
 * （renderProductJobEntry 不再渲染 --skip-promotion），只作为人工熔断保留：
 * 真出现导入目标异常时，手工带上它把这段停掉，收据记 SKIPPED。
 *
 * 为什么保留开关而不是删掉代码：跳过是**可见的**（收据记 `SKIPPED`，不是 PENDING 也不是
 * FAILED）；不带这个开关 ⇒ 与恢复后逐字相同的行为，回滚不需要改代码。
 */
export const SKIP_PROMOTION_REASON = '推广段人工熔断开关（默认关闭；仅当推广导入目标异常时手工传入）';

/**
 * 商品数据链的「销售2部停采」名单（2026-10-16 加）。
 *
 * 背景：2026-10-16 日报链换到别的组织的 base，用户拍板「13 家全采集」⇒
 * `browser-ports.mjs` 的 `SHOPS_NOT_COLLECTING_YET` 清空（13 家都算参与采集）。
 * 但那次拍板**只放开店铺日报链**——商品数据链的销售2部维持 2026-10-05 的停采指令
 * （「现在只动店铺日报」）。两条链共用 `collectingShopKeys()`，所以商品链的停采名单
 * 落在这里：默认名单从 `collectingShopKeys()` 里再摘掉这 5 家。
 * 要整链恢复时把这张表清空即可；要点名单跑某一家仍可走 `--shops`（会走下面的
 * notCollecting 分支 fail-closed，这是有意的：商品链没恢复前点名二部的店必须先改这里）。
 */
export const PRODUCT_DATA_STOPPED_SHOPS = Object.freeze([
  '保拉淘宝',
  '保拉天猫',
  '安比龙头店',
  '科塔龙头店',
  '安比淘宝',
]);

/** 商品数据链默认采集名单：`collectingShopKeys()` 摘掉商品链停采名单（见上）。 */
export function productDataCollectingShopKeys() {
  return collectingShopKeys().filter((shop) => !PRODUCT_DATA_STOPPED_SHOPS.includes(shop));
}

export function buildProductJobPlan({ dateInput = 'yesterday', shops = null, commit = true, skipPromotion = false,
  registered = shopBrowserKeys(), collecting = productDataCollectingShopKeys() } = {}) {
  // 默认＝**参与采集**的店铺，不是登记表全部：登记表里可能还有没开始收集的空店
  // （2026-09-30 白天有 1 家，当晚用户拍板开 13 家后那张表清空）。把空店算进来会让登录预检
  // 多查一家、采集多起一家、导入多写一家 —— 而它三项都做不成，最后表现为「一条每天都会响的假告警」。
  // 两个集合可注入、默认＝真实登记表：理由同 `batch-plan.mjs` 的 `resolveShopNames`
  // （那条「还没开始收集」分支的活体样本已随空表清空，靠「仓库里恰好有空店」覆盖它＝把守卫交给运气）。
  const selected = shops ?? collecting;
  if (!selected.length) throw new Error('shops must contain at least one shop');
  const notCollecting = selected.filter((shop) => !collecting.includes(shop) && registered.includes(shop));
  if (notCollecting.length) {
    const inProductStop = notCollecting.filter((shop) => PRODUCT_DATA_STOPPED_SHOPS.includes(shop));
    const hint = inProductStop.length === notCollecting.length
      ? '（商品数据链的销售2部停采中 —— 见 runtime/product-data-job-core.mjs 的 PRODUCT_DATA_STOPPED_SHOPS；'
        + '要让商品链也采二部，先把那张表清空）'
      : '（见 runtime/browser-ports.mjs 的 SHOPS_NOT_COLLECTING_YET）';
    throw new Error(`这些店铺已登记但还没开始收集数据：${notCollecting.join(', ')}` + hint);
  }
  const unknown = selected.filter((shop) => !registered.includes(shop));
  if (unknown.length) throw new Error(`unknown shops: ${unknown.join(', ')}`);
  return { dateInput, shops: selected, parallelShopCount: selected.length,
    reportOrder: ['product', 'inquiry', 'promotion'], commit, skipPromotion };
}

export function renderProductJobEntry({ nodeExe = process.execPath, repoRoot = path.resolve(import.meta.dirname, '..'), dateInput = 'yesterday', commit = true, batches = DEFAULT_BATCH_SIZE, skipPromotion = false } = {}) {
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  const args = [quote(path.join(repoRoot, 'scripts', 'run-product-data-job.mjs')), '--date', dateInput];
  if (commit) args.push('--commit');
  // 分批（2026-09-30 起，用户拍板「要分批，跟日报一样的批次」）：**跑完一批释放一批**。
  // 为什么必须落在这一处：这条链从前是一把起齐**全部**参与采集的店铺（13 家 ⇒ 13 个 Edge ＋ 13 个代理
  // 同时活着），而 13 × 约 1.7 GB 远超本机余量。定时命令是从**这里**渲染出来的，
  // 所以「分批」这件事必须出现在这里，否则定时那条路永远回到全量常驻。
  // 传 `batches: null` 可以显式渲染出「不分批」的那条命令（排查用）。
  if (batches !== null && batches !== undefined) args.push('--batches', String(batches));
  // 推广段默认**照旧做**（2026-10-16 恢复）：导入器已按（店铺, 数据日期）解析 base、
  // 批量路径已按部门分组，闸门只剩人工熔断一个用途 —— 见 SKIP_PROMOTION_REASON。
  // 传 `skipPromotion: true` 可显式渲染出「本阶段不做推广」的那条命令（应急用）。
  if (skipPromotion) args.push('--skip-promotion');
  return [quote(nodeExe), ...args].join(' ');
}
