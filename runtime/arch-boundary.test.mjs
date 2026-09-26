// 跨目录依赖的边界守卫（2026-09-19 建）。
//
// 为什么需要它：`skills/` 与 `runtime/` 之间是**双向**依赖，实测规模远超此前笔记里的估计 ——
//   skills → runtime：35 个文件（18 个生产）
//   runtime → skills：37 个文件（**32 个生产**）   ← 笔记里曾写「约 10 处」，是错的
// 后果不是「不好看」，而是**交付形态被锁死**：任何一条链都不能靠「只拷 skills/」跑起来，
// 整仓复制是当前唯一成立的方式（见 docs/architecture/EXTENSIBILITY-AND-DEPLOYMENT-PROPOSAL.md D3）。
//
// 这条守卫能做的事只有一件，但很关键：**让依赖关系的变化必须显式登记**。
//   · 新增一条跨目录依赖 → 红（你得来这里加一行，并说明为什么）
//   · 依赖消失了但白名单没删 → 也红（防白名单腐烂成一份不实清单）
// 「只红不报数」是没用的：所以两边的差集都会打出来。
//
// 它**不**做「反向依赖 = 0」这件事 —— 那是 M6 的目标，不是今天的事实。
// 今天要守的是「事实与记录一致」，而不是「事实好看」。
//
// 扫描口径**不在这里实现**：唯一实现是 runtime/arch-boundary-scan.mjs。
// 之所以抽出去：这份守卫与一次性盘点脚本都要报同一个数，各写一份迟早给出两个数 ——
// 而「同一个事实两处实现」正是这套系统一直在治的病，守卫自己先犯就没说服力了。
// 附带的好处：扫描器改了（例如补上副作用 import 的形态）两处会一起生效，不会一处新一处旧。
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffAgainstWhitelist, findCrossDirDeps, walkMjs } from './arch-boundary-scan.mjs';

// 白名单：与 2026-09-19 的实测逐字一致。**要改就一起改**（新增或消失都算变化）。
const SKILLS_TO_RUNTIME = Object.freeze([
  // 2026-09-26 商品数据三链共享 runtime 端口/Feishu 目标配置；保留在能力目录，避免把业务逻辑倒灌 runtime。
  'skills/sycm-inquiry-data/scripts/collect-inquiry-report.mjs',
  'skills/sycm-inquiry-data/scripts/import-inquiry-data.mjs',
  'skills/sycm-product-data/scripts/collect-product-report.mjs',
  'skills/sycm-product-data/scripts/import-product-data.mjs',
  'skills/sycm-promotion-data/scripts/collect-product-report.mjs',
  'skills/sycm-promotion-data/scripts/import-promotion-data.mjs',
  'skills/huitun-to-feishu-keyword-heat/scripts/flow.mjs',
  'skills/huitun-to-feishu-keyword-heat/tests/adapter-huitun-keyword-heat.test.mjs',
  'skills/huitun-to-feishu-keyword-heat/tests/flow.test.mjs',
  'skills/huitun-to-feishu-keyword-heat/tests/queue-probe.test.mjs',
  // 2026-09-23 新增两条：**跑前登录态体检**（`check-login-shops.mjs` 是 IO 那一半，
  // `check-login-shops-core.test.mjs` 是它的离线用例）。两个都要 import
  // `runtime/browser-ports.mjs`：一个为拿「哪家店用哪个代理端口」（切实例只能靠 --proxy），
  // 一个为拿真实店铺登记表当断言输入。方向是干净的 skills → runtime（登记表是叶子），
  // 而且它们**刻意不重复实现探测** —— 那件事仍在同目录的 `login-merchant.mjs` 里，
  // 本层只按登记表逐店调用它、把回执翻成人话。
  // 2026-09-24 新增一条：`check-login-shops-core.mjs` 为生成**整轮**登录告警，
  // import 了 `runtime/notify-feishu-core.mjs` 的 `READABLE_SOURCE_KEYS`（它是「渲染器认哪些键」
  // 的唯一来源，另抄一份就是第二个事实）。方向是干净的 skills → runtime（白名单是叶子常量），
  // 而且这条登记本身换来了一个会抛错的判据：source 里出现白名单之外的键时当场拦下，
  // 而不是让渲染器**静默丢掉那一行**（告警照发、收信人看不到「哪几家、哪个后台」）。
  'skills/sycm-alimama-daily-report/scripts/check-login-shops-core.mjs',
  'skills/sycm-alimama-daily-report/scripts/check-login-shops-core.test.mjs',
  'skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs',
  'skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs',
  'skills/sycm-alimama-daily-report/scripts/collect-shop-report.mjs',
  'skills/sycm-alimama-daily-report/scripts/daily-report-audit.test.mjs',
  'skills/sycm-alimama-daily-report/scripts/date-picker.mjs',
  // 2026-09-21 新增：**期望页面清单的唯一来源**。它必须留在能力目录里，不能抽到 runtime/ ——
  // 抽过去就让它自己变成 runtime → skills（就是下面那条「业务倒灌机制层」），而 shop-pages.mjs
  // 与驱动都要用它，留在任何一侧的另一侧都会成环。它本身只依赖 date-picker 与 runtime/feishu-targets，
  // 是一条干净的 skills → runtime，不扩大交付形态的锁定面。
  'skills/sycm-alimama-daily-report/scripts/expected-pages.mjs',
  'skills/sycm-alimama-daily-report/scripts/login-merchant-core.test.mjs',
  'skills/sycm-alimama-daily-report/scripts/login-merchant.mjs',
  'skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs',
  'skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs',
  'skills/sycm-alimama-daily-report/scripts/run-inquiry-backfill.mjs',
  'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs',
  'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs',
  'skills/sycm-export-search-rank/scripts/adapter.search-rank.test.mjs',
  'skills/sycm-export-search-rank/scripts/export-search-rank.mjs',
  'skills/sycm-to-feishu-base/scripts/adapter.feishu-weekly.mjs',
  'skills/sycm-to-feishu-base/scripts/copy-weekly-table.mjs',
  'skills/sycm-to-feishu-base/scripts/inspect-feishu-fields.mjs',
  'skills/sycm-to-feishu-base/scripts/run-weekly-post-ai.mjs',
  'skills/sycm-to-feishu-base/scripts/run-weekly-pre-ai.mjs',
  // 2026-09-20 新增下面三条，同一个理由：周更链的**凭据文件默认值**原先在脚本里写死成
  // 旧租户的 E:/小红书/.env.local，而 base 已经搬到 kcne618basvj —— 拿旧租户凭据读新租户
  // base 得到 91403 Forbidden，看起来像「应用没被加为协作者」的假故障。改成从
  // feishu-targets 的 envFilePath(activeProfileName()) 取（与同一条周更链的
  // huitun-to-feishu-keyword-heat/scripts/flow.mjs 同源），于是 update-weekly-base.mjs
  // 与它的两个测试各自多了一条 skills → runtime 依赖。理由要留在代码里，
  // 不是为了过守卫才登记。
  // 2026-09-20 新增下面两条，与上一批同因（凭据文件默认值写死旧租户）：
  // `sync-decision-history.mjs` 是关键词周更链的「决策历史同步」段（人工排的独立段），
  // 它的 `envFile` 默认值同样是 `E:/小红书/.env.local`，而它写的是 kcne 租户的关键词 base
  // ⇒ 默认路径下拿旧租户凭据读新租户 base 报 91403 Forbidden。同一个修法，
  // 于是它与它的测试各多一条 skills → runtime 依赖。
  'skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs',
  'skills/sycm-to-feishu-base/tests/sync-decision-history.test.mjs',
  'skills/sycm-to-feishu-base/scripts/update-weekly-base.mjs',
  'skills/sycm-to-feishu-base/tests/adapter-feishu-weekly.test.mjs',
  'skills/sycm-to-feishu-base/tests/copy-weekly-table.test.mjs',
  'skills/sycm-to-feishu-base/tests/paste-endpoint.test.mjs',
  'skills/sycm-to-feishu-base/tests/run-weekly-post-ai.test.mjs',
  'skills/sycm-to-feishu-base/tests/run-weekly-pre-ai.test.mjs',
  'skills/sycm-to-feishu-base/tests/update-weekly-base.test.mjs',
  'skills/xws-export-market-analysis/scripts/export-market-analysis.mjs',
  'skills/xws-export-market-analysis/scripts/flow.mjs',
  'skills/xws-export-market-analysis/scripts/segments.mjs',
  'skills/xws-export-market-analysis/tests/flow.test.mjs',
  'skills/xws-export-market-analysis/tests/prepare-flow.test.mjs',
  'skills/xws-faq-operator/tests/adapter-faq-product.test.mjs',
  'skills/xws-sku-collection/tests/adapter-sku-collection.test.mjs',
  'skills/xws-to-feishu-base/tests/adapter-feishu-import.test.mjs',
  'skills/xws-to-feishu-base/tests/import-failures.test.mjs',
]);

const RUNTIME_TO_SKILLS = Object.freeze([
  'runtime/apply-xws-sku-manifest.mjs',
  'runtime/browser-ports.test.mjs',
  'runtime/competitor-history-publish-core.mjs',
  'runtime/competitor-visualization-core.mjs',
  'runtime/create-weekly-history-tables.mjs',
  'runtime/diagnose-attribute-writeback.mjs',
  'runtime/diagnose-vocab-gain.mjs',
  'runtime/diagnose-weekly-field-conversion.mjs',
  'runtime/export-live-competitor-formulas.mjs',
  'runtime/faq-operator-client.test.mjs',
  'runtime/fill-weekly-attribute-labels.mjs',
  'runtime/inspect-competitor-sku-linkage.mjs',
  'runtime/migrate-competitor-history-period-fields.mjs',
  'runtime/migrate-faq-summary-schema.mjs',
  'runtime/migrate-history-to-weekly-tables.mjs',
  'runtime/normalize-weekly-stable-links.mjs',
  'runtime/provision-competitor-weekly-schema.mjs',
  'runtime/publish-competitor-visualization.mjs',
  'runtime/publish-faq-detail-enrichment.mjs',
  'runtime/publish-faq-summaries.mjs',
  // 2026-09-21 新增：一键刷新五家店页面（把「上一轮把页面留在哪」收回来）。它复用链子自己的
  // 读侧与词表（expected-pages 的期望页面清单、date-picker 的读页面状态），不是第二份实现；
  // 而「新建页面」这条写路径全仓只有 shop-pages.mjs 一处，刷新只调它、自己不建。
  // 换句话说：这条 runtime → skills 是**复用**，不是把业务逻辑倒灌进机制层。
  'runtime/refresh-shop-pages.mjs',
  'runtime/repair-current-week-and-sync-main.mjs',
  'runtime/repair-weekly-tables.mjs',
  'runtime/run-question-library-collection.mjs',
  'runtime/run-xws-sku-dry-run.mjs',
  'runtime/shop-pages.mjs',
  'runtime/shop-pages.test.mjs',
  'runtime/shop-window-label.mjs',
  'runtime/shop-window-label.test.mjs',
  'runtime/sop-runtime/run-feishu-import-two-stage.mjs',
  'runtime/summarize-xws-sku-queue.mjs',
  'runtime/sync-latest-ab-to-main-core.mjs',
  'runtime/sync-latest-ab-to-main.mjs',
  'runtime/sync-weekly-sku-history.mjs',
  'runtime/update-competitor-class-labels.mjs',
  'runtime/xws-sku-dry-run-core.mjs',
  'runtime/xws-sku-dry-run-core.test.mjs',
  'runtime/xws-sku-payload-parser.mjs',
]);

test('skills → runtime 的依赖清单与登记逐字一致（新增与消失都要显式改这里）', () => {
  const actual = findCrossDirDeps().skillsToRuntime;
  const { added, removed } = diffAgainstWhitelist(actual, SKILLS_TO_RUNTIME);
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    `依赖清单变了。\n新增：${added.join('、') || '(无)'}\n消失：${removed.join('、') || '(无)'}\n`
      + '处置：新增要在 SKILLS_TO_RUNTIME 里登记并说明理由；消失要同时删掉那一行（白名单不许腐烂）。',
  );
});

test('runtime → skills 的依赖清单与登记逐字一致（这是交付形态被锁死的根因）', () => {
  const actual = findCrossDirDeps().runtimeToSkills;
  const { added, removed } = diffAgainstWhitelist(actual, RUNTIME_TO_SKILLS);
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    `依赖清单变了。\n新增：${added.join('、') || '(无)'}\n消失：${removed.join('、') || '(无)'}\n`
      + '处置：同上一测。注意 runtime → skills 是**业务倒灌机制层**的方向，新增应当先问一句'
      + '「这个东西是不是该留在能力的目录里」（见提案 D3），而不是直接登记。',
  );
});

test('守卫本身是活的：扫描确实读到了文件（否则「全绿」只是没扫到）', () => {
  const all = [...walkMjs('skills'), ...walkMjs('runtime')];
  assert.ok(all.length > 200, `只扫到 ${all.length} 个 .mjs，扫描范围可能坏了`);
  const deps = findCrossDirDeps();
  assert.ok(deps.skillsToRuntime.length > 10 && deps.runtimeToSkills.length > 10,
    '两侧都应有实质依赖；若都变空，先确认不是扫描逻辑坏了');
});
