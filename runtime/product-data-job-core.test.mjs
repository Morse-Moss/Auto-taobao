import test from 'node:test';
import assert from 'node:assert/strict';
import { collectingShopKeys } from './browser-ports.mjs';
import {
  PRODUCT_DATA_STOPPED_SHOPS,
  buildProductJobPlan,
  productDataCollectingShopKeys,
  renderProductJobEntry,
} from './product-data-job-core.mjs';

test('product job defaults to yesterday and covers all shops that actually collect, in parallel waves', () => {
  const plan = buildProductJobPlan();
  assert.equal(plan.dateInput, 'yesterday');
  // 家数从**参与采集**的名单推，不写死。
  // 默认名单是商品链自己的 productDataCollectingShopKeys()：
  // 2026-10-16 日报链换外组织 base 时用户拍板「13 家全采」，但那只放开**店铺日报链**——
  // 商品数据链的销售2部维持 2026-10-05 的停采（PRODUCT_DATA_STOPPED_SHOPS）。
  // 2026-10-26 用户指令「恢复采集，加入到日常的采集链中」⇒ 两张停采表同一批清空，
  // 商品链默认＝参与采集的全部 13 家 ＝ 登记表全量。
  assert.deepEqual(plan.shops, productDataCollectingShopKeys());
  assert.deepEqual(plan.shops, collectingShopKeys().filter((shop) => !PRODUCT_DATA_STOPPED_SHOPS.includes(shop)));
  for (const shop of PRODUCT_DATA_STOPPED_SHOPS) {
    assert.equal(plan.shops.includes(shop), false, `商品链停采名单里的「${shop}」不该出现在默认名单`);
  }
  // ⚠️ 这条同时是一笔资源账：`parallelShopCount` 是「一次会起多少个实例」的**名义**值 ——
  // 13 家 ＝ 13 个 Edge 实例 + 13 个代理进程同时活着（底单串行采集，但实例全起）。
  // 入口给了 `--batches`（默认 5）：**真正同时开着的**是这个数除以批次大小，
  // 由 `scripts/run-product-data-job.mjs` 的分批循环决定（切法只来自 `runtime/batch-plan.mjs`）。
  // 这条用例刻意继续钉 plan 的名义值：改口径要连它一起改，而不是让它跟着漂。
  assert.equal(plan.parallelShopCount, productDataCollectingShopKeys().length);
  assert.deepEqual(plan.reportOrder, ['product', 'inquiry', 'promotion']);
});

test('product job plan rejects unknown / empty / not-yet-collecting shop selection', () => {
  assert.throws(() => buildProductJobPlan({ shops: [] }), /at least one/u);
  assert.throws(() => buildProductJobPlan({ shops: ['missing'] }), /unknown shops/u);
  // 已登记但还没开始收集的店：点名也要拒，且理由要说清 —— 它的数据没有可写的落点。
  // 2026-09-30 晚用户拍板开 13 家 ⇒ 登记表里的空店清零，这条分支现实中取不到活体样本，
  // 所以用**显式注入**构造现场（靠「仓库里恰好有空店」覆盖它＝把一年只响几次的守卫交给运气）。
  const registered = ['甲店', '乙店', '丙店'];
  const collecting = ['甲店', '乙店'];
  assert.throws(() => buildProductJobPlan({ shops: ['丙店'], registered, collecting }), /还没开始收集/u,
    '已登记但没开始收集的店必须被拒，且理由不能混成 unknown shops');
  // 未登记走的是另一条报错 —— 两件事不许混。
  assert.throws(() => buildProductJobPlan({ shops: ['丁店'], registered, collecting }), /unknown shops/u);
  // 注入口的默认值必须仍是真实登记表（本条防止注入口把生产路径改掉）：
  // 2026-10-26 起两张停采表都清空 ⇒ 商品链默认名单＝参与采集的全部 13 家。
  assert.deepEqual(buildProductJobPlan().shops, productDataCollectingShopKeys());
  // 点名商品链停采名单里的店（已登记）也要被拒，且理由要指到那张表，别让人去翻 browser-ports。
  // 2026-10-26 恢复二部后生产表已清空，**活体样本没了** —— 与上面 registered/collecting 同一个理由：
  // 用显式注入 `productStopped` 构造现场，而不是把「报错指向哪张表」这条守卫交给运气。
  assert.throws(() => buildProductJobPlan({ shops: ['丙店'], registered, collecting, productStopped: ['丙店'] }),
    /PRODUCT_DATA_STOPPED_SHOPS/u, '商品链停采的店被点名时，报错要说清停在哪张表');
  // 反面：注入表里没有它时，同一家店必须走「还没开始收集」那句（指向 browser-ports）——
  // 两张表混成一句会让人去翻错文件，那正是这条报错最不该做的事。
  assert.throws(() => buildProductJobPlan({ shops: ['丙店'], registered, collecting, productStopped: ['丁店'] }),
    (error) => {
      assert.match(error.message, /SHOPS_NOT_COLLECTING_YET/u, '不在商品链停采表里时，报错要指向整链停采表');
      assert.doesNotMatch(error.message, /PRODUCT_DATA_STOPPED_SHOPS/u, '两张表的报错不许混成一句');
      return true;
    });
});

test('scheduled entry targets the independent product-data job, commits yesterday, batches, and runs promotion', () => {
  // 2026-09-30：定时入口默认带上 `--batches`（跑完一批释放一批），与日报链同款批次。
  // 这条是**渲染层**的判据 —— 定时任务是用注册表里的字符串装的，命令行长什么样由这里决定，
  // 所以「分批」不落在这条断言里，就等于定时那条路仍然全量常驻。
  // 2026-10-16：`--skip-promotion` 的默认值翻回「不跳」。历史：2026-10-05 推广导入目标还指向
  // 9 月 base，默认带上它是为了防止无人值守路径把 10 月数据写进关账表；现在导入器已按
  // （店铺, 数据日期）解析 base、批量路径已按部门分组，熔断闸门只剩手工传入一个用途。
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

test('plan 默认不跳过推广，只有显式要跳时才跳（回滚不需要改代码）', () => {
  assert.equal(buildProductJobPlan().skipPromotion, false,
    '默认必须是「照旧做推广」—— 跳过是一个决定，不该是不写参数时的副作用');
  assert.equal(buildProductJobPlan({ skipPromotion: true }).skipPromotion, true);
  // 跳过的只是**跑不跑**，不是把这一段从收据里删掉：收据要能记下 SKIPPED，
  // 就得先有这个阶段格子（删掉格子会让「有意跳过」退化成「收据里没有这一段」）。
  assert.deepEqual(buildProductJobPlan({ skipPromotion: true }).reportOrder, ['product', 'inquiry', 'promotion']);
  // 渲染层也一样：显式 false 时一个 --skip-promotion 都不许出现。
  const entry = renderProductJobEntry({ nodeExe: 'node', repoRoot: 'D:\\repo', skipPromotion: false });
  assert.ok(!entry.includes('--skip-promotion'), '显式要求做推广时不得出现 --skip-promotion');
});
