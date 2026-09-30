import test from 'node:test';
import assert from 'node:assert/strict';
import { collectingShopKeys, shopBrowserKeys } from './browser-ports.mjs';
import { buildProductJobPlan, renderProductJobEntry } from './product-data-job-core.mjs';

test('product job defaults to yesterday and covers all shops that actually collect, in parallel waves', () => {
  const plan = buildProductJobPlan();
  assert.equal(plan.dateInput, 'yesterday');
  // 家数从**参与采集**的名单推，不写死（2026-09-30：5 → 12 家参与采集 + 1 家待收集）。
  // 默认名单是 collectingShopKeys() 而不是 shopBrowserKeys()：登记表里还有没开始收集的空店，
  // 空店算进来会让登录预检多查一家、采集多起一家、导入多写一家 —— 三项它都做不成。
  assert.deepEqual(plan.shops, collectingShopKeys());
  // ⚠️ 这条同时是一笔资源账：本任务**没有分批**，`parallelShopCount` 就是「一次起多少个实例」——
  // 12 家 ＝ 12 个 Edge 实例 + 12 个代理进程同时活着（底单串行采集，但实例全起，
  // 且 `run-product-data-job.mjs` 里没有 stop 段之前不释放）。要不要给这条链也加分批，
  // 是留给用户拍板的事，不是这里悄悄改掉的。
  assert.equal(plan.parallelShopCount, collectingShopKeys().length);
  assert.deepEqual(plan.reportOrder, ['product', 'inquiry', 'promotion']);
});

test('product job plan rejects unknown / empty / not-yet-collecting shop selection', () => {
  assert.throws(() => buildProductJobPlan({ shops: [] }), /at least one/u);
  assert.throws(() => buildProductJobPlan({ shops: ['missing'] }), /unknown shops/u);
  // 已登记但还没开始收集的店：点名也要拒，且理由要说清 —— 它的数据没有可写的落点。
  const pending = shopBrowserKeys().filter((key) => !collectingShopKeys().includes(key));
  assert.ok(pending.length > 0, '当前应当有「还没开始收集」的店；否则这条用例要改口径');
  for (const key of pending) {
    assert.throws(() => buildProductJobPlan({ shops: [key] }), /还没开始收集/u);
  }
});

test('scheduled entry targets the independent product-data job and commits yesterday by default', () => {
  assert.equal(renderProductJobEntry({ nodeExe: 'C:\\Program Files\\node\\node.exe', repoRoot: 'D:\\repo' }),
    '"C:\\Program Files\\node\\node.exe" "D:\\repo\\scripts\\run-product-data-job.mjs" --date yesterday --commit');
});
