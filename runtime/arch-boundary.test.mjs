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
  'skills/huitun-to-feishu-keyword-heat/scripts/flow.mjs',
  'skills/huitun-to-feishu-keyword-heat/tests/adapter-huitun-keyword-heat.test.mjs',
  'skills/huitun-to-feishu-keyword-heat/tests/flow.test.mjs',
  'skills/huitun-to-feishu-keyword-heat/tests/queue-probe.test.mjs',
  'skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs',
  'skills/sycm-alimama-daily-report/scripts/collect-shop-report.mjs',
  'skills/sycm-alimama-daily-report/scripts/daily-report-audit.test.mjs',
  'skills/sycm-alimama-daily-report/scripts/date-picker.mjs',
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
  'skills/sycm-to-feishu-base/tests/adapter-feishu-weekly.test.mjs',
  'skills/sycm-to-feishu-base/tests/copy-weekly-table.test.mjs',
  'skills/sycm-to-feishu-base/tests/paste-endpoint.test.mjs',
  'skills/sycm-to-feishu-base/tests/run-weekly-post-ai.test.mjs',
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
