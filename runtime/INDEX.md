# runtime/ 入口索引

状态：初步分类（P0 产物）。分类依据是命名角色与已知调用关系，**尚未逐一确认生命周期**——这是 P2.3 的工作。在此之前，把本文件当作导航，不要当作权威合同。
权威边界提醒：`docs/standards/README.md` 把 `runtime/` 定位为"运行入口、阶段指针和单次运行状态；不是架构事实源"。但本目录实际含 14 个合同/决策文档与 168 个 git 跟踪入口，这个矛盾在治理方案 A2 中登记，尚未解决。

## 使用前必读

1. 冻结运行面（治理期间对外契约不变）：`run-faq-operator.mjs`、`run-weekly-local-analysis.mjs` 及 skills 侧的 `run-weekly-pre-ai.mjs` / `run-weekly-post-ai.mjs`。
2. 本机路径含中文（如 `E:\小红书\.env.local`），批量操作会触发安全删除守卫，逐个显式路径操作。
3. `D:\codex\skills\sycm-*`、`xws-*`、`huitun-*` 是指向本项目 skills 的目录联接，存在项目外消费者；搬移任何文件前先确认调用面。
4. `runtime/` 顶层有 468 个文件、3.8G 运行产物（多数被 .gitignore 排除）；`find`/`ls -R` 在此目录会超时，用 `find runtime -maxdepth 1` 限定深度。

## A. 长期编排入口（受冻结运行面保护）

`run-faq-operator.mjs`（FAQ 周更唯一入口）
`run-weekly-local-analysis.mjs`（被 skills 侧 run-weekly-post-ai.mjs 反向引用，是双向依赖的关键节点）
`run-question-library-collection.mjs`
`run-faq-ai-review.mjs`、`run-faq-human-review.mjs`、`run-faq-text-analysis.mjs`、`run-faq-topic-summary.mjs`
`run-xws-sku-dry-run.mjs`
`run-legacy-feishu-prompt-analysis.mjs`
`run-keyword-decision-formula-migration.mjs`

## B. 可复用核心库（被入口 import，本身少有副作用）

FAQ 链：`faq-operator-core`、`faq-operator-content`、`faq-ai-review`、`faq-detail-enrichment`、`faq-human-review`、`faq-local-summary`、`faq-text-analysis`、`faq-topic-summary`、`question-library-core`
关键词链：`keyword-analysis-v2-core`、`keyword-analysis-v2-feishu-plan`、`keyword-analysis-v2-feishu-runner`、`keyword-decision-engine`、`keyword-decision-formulas`、`keyword-decision-schema`、`keyword-dual-table-core`、`local-keyword-analysis`、`local-provider-runner`、`weekly-local-analysis`、`weekly-table-target`
竞品/可视化链：`competitor-history-publish-core`、`competitor-visualization-core`、`competitor-weekly-schema-core`、`sync-latest-ab-to-main-core`
SKU 链：`xws-sku-auth-preflight`、`xws-sku-batch-index`、`xws-sku-dry-run-core`、`xws-sku-payload-parser`、`xws-sku-topology-core`、`apply-xws-sku-manifest-core`、`build-xws-sku-dry-run-manifest`、`capture-xws-sku-payload`、`collect-live-xws-sku-topology`
旧写回：`legacy-feishu-writeback`、`legacy-feishu-prompt-analysis`

## C. 一次性迁移与修复（跑完即应退役；重复执行前必须确认幂等性）

迁移：`migrate-competitor-history-period-fields`、`migrate-faq-feishu`、`migrate-faq-summary-schema`、`migrate-history-to-weekly-tables`、`migrate-keyword-analysis-v2-formal`、`keyword-analysis-v2-formal-migration`
修复：`repair-history-types`、`repair-history-types-v2`、`repair-weekly-tables`、`repair-current-week-and-sync-main`、`fix-legacy-content-heat`（含硬编码 `D:/Retire` 路径，治理 B3 登记）
清理：`cleanup-history-placeholder-fields`、`cleanup-keyword-base-tables`
历史字段操作：`set-history-collection-dates`、`set-history-types`、`add-keyword-history-helper-fields`
表结构：`configure-history-schema-via-api`、`create-weekly-history-tables`、`provision-competitor-weekly-schema`、`provision-sku-history-table`
导入与同步：`import-history-via-api`（硬编码路径）、`paste-history-import`（硬编码路径）、`sync-latest-ab-to-main`、`sync-weekly-sku-history`、`sync-question-library-template`、`apply-legacy-feishu-writeback`、`apply-weekly-decision-formulas`、`apply-xws-sku-manifest`、`apply-local-keyword-analysis`
其它：`update-competitor-class-labels`、`normalize-weekly-stable-links`、`prepare-keyword-analysis-v2-test`

## D. 只读诊断与 UI 探查（原则上无写入，但 feishu-ui-* 会驱动真实浏览器）

状态读取：`get-feishu-state`、`summarize-feishu-state`、`eval-feishu-expression`、`export-live-competitor-formulas`、`diagnose-weekly-field-conversion`、`verify-weekly-decision-formulas-live`
结构探查：`inspect-ai-editor`、`inspect-competitor-sku-linkage`、`inspect-feishu-field-config-ui`、`inspect-field-containers`、`inspect-popovers`、`inspect-visible-text`、`summarize-popovers`、`summarize-ui-inspect`、`summarize-xws-sku-queue`
浏览器 UI 驱动：`feishu-ui-add-fields`、`feishu-ui-eval-once`、`feishu-ui-field-menu`、`feishu-ui-find-text`、`feishu-ui-menu-action`、`feishu-ui-open-add`、`feishu-ui-preflight`、`feishu-ui-probe`、`tmp-inspect-feishu-ui`（名字已声明临时，优先清理）

## E. 已退役（调用即抛错，属良性存根）

`retired-huitun-result-writer.mjs`、`retired-keyword-decision-writer.mjs`
`apply-keyword-decisions.mjs`、`apply-huitun-results.mjs`（已废弃的 8 批/日期模型与旧周表指向，读取结果前强制停止）
本目录的 fail-closed 存根是正确模式；C 类清理完成后应套用同一做法。

## F. 报告与文档生成

Python：`build-keyword-decision-brief.py`、`build-keyword-decision-report.py`（依赖仓库外 `table_geometry`，当前不可复现，见 requirements.txt 说明）、`build-keyword-ops-review-docx.py`、`generate-weekly-analysis-doc.py`、`append-formulas-and-prompt.py`、`read-faq-operator-xlsx.py`
Node：`build-keyword-dual-tables.mjs`、`generate-weekly-analysis-doc.mjs`、`publish-competitor-visualization.mjs`
依赖 `docx`（v9.7.1 已声明并验证 CJS 导出完整）：`generate-competitor-v2-business-docx.cjs`、`generate-competitor-v2-archive-docx.cjs`（注意：前者默认输出路径硬编码到 `C:/Users/Administrator/Desktop/`，治理 B3 登记）

## G. 合同与决策文档（14 个 .md，git 已跟踪，治理归属待定）

`competitor-v2-sku-collection-stage-pointer.md`、`competitor-v2-sku-schema-stage-pointer.md`、`competitor-v2-stage-pointer.md`、`huitun-candidate-contract.md`、`keyword-analysis-stage-pointer.md`、`keyword-analysis-v2-contract-20260811.md`、`keyword-field-contract-20260809.md`、`keyword-formula-ai-config-active.md`、`keyword-formula-ai-verification-20260809.md`、`keyword-formulas-ai-prompts-20260809.md`、`keyword-front-fields-ops-review-v1-20260811.md`、`sku-weekly-storage-decision-20260825.md`、`xws-three-rounds-20260806.md`、`xws-three-rounds-active.md`
其中 `*-contract.md` 与 `*-decision-*.md` 按其内容属于架构/合同事实，与 standards 对本目录的定位冲突；P2.3 应决定迁往 `docs/` 或修订 standards 的定义。
