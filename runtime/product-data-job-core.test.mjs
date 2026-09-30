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
  // ⚠️ 这条同时是一笔资源账：`parallelShopCount` 是「一次会起多少个实例」的**名义**值 ——
  // 12 家 ＝ 12 个 Edge 实例 + 12 个代理进程同时活着（底单串行采集，但实例全起）。
  // 2026-09-30 起入口给了 `--batches`（默认 5）：**真正同时开着的**是这个数除以批次大小，
  // 由 `scripts/run-product-data-job.mjs` 的分批循环决定（切法只来自 `runtime/batch-plan.mjs`）。
  // 这条用例刻意继续钉 plan 的名义值：改口径要连它一起改，而不是让它跟着漂。
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
  // 2026-09-30：定时入口默认带上 `--batches`（跑完一批释放一批），与日报链同款批次。
  // 这条是**渲染层**的判据 —— 定时任务是用注册表里的字符串装的，命令行长什么样由这里决定，
  // 所以「分批」不落在这条断言里，就等于定时那条路仍然全量常驻。
  assert.equal(renderProductJobEntry({ nodeExe: 'C:\\Program Files\\node\\node.exe', repoRoot: 'D:\\repo' }),
    '"C:\\Program Files\\node\\node.exe" "D:\\repo\\scripts\\run-product-data-job.mjs" --date yesterday --commit --batches 5');
});

test('scheduled entry can render an explicit no-batch command (troubleshooting only)', () => {
  // `batches: null` 是**显式**要求不分批：渲染出来必须一个 `--batches` 都没有（不能退化成默认值）。
  const entry = renderProductJobEntry({ nodeExe: 'C:\\Program Files\\node\\node.exe', repoRoot: 'D:\\repo', batches: null });
  assert.equal(entry,
    '"C:\\Program Files\\node\\node.exe" "D:\\repo\\scripts\\run-product-data-job.mjs" --date yesterday --commit');
  assert.ok(!entry.includes('--batches'), '显式不分批时不得出现 --batches');
});
