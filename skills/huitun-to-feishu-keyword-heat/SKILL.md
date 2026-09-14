---
name: huitun-to-feishu-keyword-heat
description: Collect exact-name topic view counts from 灰豚数据红薯版 for the live Feishu A候选 keyword queue, preserve displayed evidence, and optionally perform a guarded topic-view-only Feishu backfill with formula settlement and integrity verification. Content heat remains an upstream input; this Skill never derives or writes it. Use when a keyword-analysis table needs the next A候选 batch checked in Huitun/Xiaohongshu topic search, or when a previously collected Huitun result JSON must be dry-run validated or safely applied. Do not use for broad Huitun crawling, approximate topic aggregation, or editing unrelated Feishu fields.
---

# 灰豚小红书话题热度回填

Use this Skill for the bounded follow-up stage after the upstream AI/content analysis and search/transaction heat have produced a Feishu `A候选` queue. The bundled runner reads the live queue, opens the user's logged-in Edge session through the shared web-access Proxy, searches each keyword in 灰豚红薯版的“话题搜索”, keeps only a completely同名话题, and prepares a local evidence manifest. It writes only `灰豚话题浏览量`; it never creates, derives, overwrites, or clears `内容热度` or `对应产品方向`. Feishu is written only when `--apply` and the exact `--confirm-table` are both present.

## Required setup

1. Load `web-access` before any browser or network action. Run its dependency check for Edge and use the shared Proxy at `http://127.0.0.1:3456`; do not open another browser-level CDP WebSocket.
   The runner also verifies `/health` reports `connected=true` and `browser.id=edge` before reading or opening any Huitun target. A Proxy connected to another browser is a hard stop.
2. Use the existing Feishu app credential file through `--env-file`. The file must define `FEISHU_APP_ID` and `FEISHU_APP_SECRET`; never print, copy, or inspect credential values beyond authentication.
3. Start with an authorized Feishu copy/table. Always pass the current weekly `--table-id` and `--table-name`; the CLI intentionally has no fixed table default because each batch uses a new table.

Before browser actions, show the web-access risk notice. Rediscover the labeled target from `/targets` before every `eval`, click, screenshot, navigation, or close action. The runner labels its own tab with the run ID and leaves it open when a human handoff or stall occurs.

## Quick start

Read-only collection and dry-run (recommended first):

```powershell
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" `
  --app-token <app-token> --table-id <current-weekly-table-id> --table-name "<current-weekly-table-name>"
```

The command writes `results.json`, `events.jsonl`, and `manifest.json` under `runtime/huitun-runs/<run-id>/`. It does not mutate Feishu. Review the dry-run summary before applying:

```powershell
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" `
  --app-token <app-token> --table-id <current-weekly-table-id> --table-name "<current-weekly-table-name>" `
  --results <dry-run-results.json> --apply --confirm-table <current-weekly-table-id>
```

To resume from a result file after a browser interruption, use `--results <path>`; the runner still re-reads the live queue and refuses a stale or incomplete result set.
Reused results must be no older than 24 hours by default; adjust the bounded policy explicitly with `--result-max-age-hours N` when a longer handoff is genuinely required.

## 运行时入口（Agent SOP Runtime）

除上面的人工 CLI 链之外，本 Skill 还登记了一条确定性能力 `huitun.keyword-heat.collect@1.1.0`
（`manifest.json` / `scripts/adapter.huitun-keyword-heat.mjs` / `tests/adapter-huitun-keyword-heat.test.mjs`）。
它把「复验 + 授权写入 + 回读验收」接进通用两段式运行器；**浏览器采集仍由上面的 CLI 完成**，
运行时入口不发起任何浏览器动作：

- 采集段读 `results.json`（由 CLI 采集产出）+ 飞书只读（表名 / 字段类型 / 记录），独立复验来源身份、
  队列指纹绑定、字段类型、结果新鲜度与逐行身份，产出「已结算的写入计划」工件；
  队列为空时确定性拒绝 `NO_CANDIDATES`（不伪造一条 0 行的发布去推进游标）。
- 发布段只读工件字节：重读目标表 → 逐行对账（身份 / 守卫字段 / 现值）→ 只写仍然为空的
  `灰豚话题浏览量` → 由飞书真实回读（含 `优先级` 公式结算）收场。目标必须与**已审批工件**携带的
  一致，否则拒绝写入并留下 `REJECTED` 收据。已有同值静默跳过（幂等），已有别的值拒绝覆盖
  （`OVERWRITE_REFUSED`）。
- 采集段与发布段之间不通过进程内状态传递数据，因此可以从落盘工件跨进程恢复；
  回读未收敛（例如公式一直没结算）时判 `UNKNOWN` 待对账，**不允许盲重试**。

```powershell
node runtime/sop-runtime/two-stage-runner.mjs `
  --capability huitun.keyword-heat.collect `
  --identity '{"tenantId":"sycm","storeId":"keyword-heat","platform":"xhs","accountId":"operator","browserProfileId":"edge-isolated","contractVersion":"sop-context-v1"}' `
  --business-key "huitun|<table-id>" `
  --expected-rows <candidate-keyword-count> `
  --collect-input '{"resultsFile":"<run-dir>\\results.json","envFile":"E:\\小红书\\.env.local","appToken":"<app-token>","tableId":"<table-id>","tableName":"<table-name>"}' `
  --work-dir "<dir>\.sop"
```

省略 `--commit` 时只跑采集段：复验通过则 `publicationStatus` 保持 `NOT_REQUESTED`、游标不推进。
真实写入必须补 `--commit --operator "<审批人>"`（人工闸门由此被记录，而不是靠一个命令行开关）；
写入后由回读收据结算 `VERIFIED` 或 `UNKNOWN`（对账后才能重试）。运行器与该能力的详细决策，含
「工件携带计划而非结果文档」「队列指纹只在有待写行时才拦」等取舍，见
`docs/architecture/MIGRATION-6-HUITUN-WEEKLY-REPORT.md`。

## Workflow contract

1. Authenticate to Feishu and verify the exact table name, field definitions, and complete record count. Before candidate selection, stop with `AI_REQUIRED` if any populated `搜索词` row has a blank `优先级` or still has `优先级=待数据`; completely blank Feishu placeholder rows do not count. Only after this gate passes, read every record whose `优先级` is exactly `A候选`; fail if any such record has an empty `搜索词`, then require uniqueness. Refuse a queue larger than `--max-candidates` unless the user explicitly raises the bound. Create a queue fingerprint from the table identity and `(record_id, 搜索词)` pairs; do not persist the app token itself.
2. Unless `--results` is supplied, open `https://dy.huitun.com/app/#/dashboard` in a labeled tab, dismiss a visible新人营销弹窗 only when the dismissal is verified, select the visible platform switcher using the current header structure (with the legacy selector as fallback), select the visible `logo_xhs` platform option, and wait for `https://xhs.huitun.com`. Open the visible `话题搜索` menu item and verify the keyword input before querying.
3. For each candidate, set `请输入话题关键词`, capture the pre-submit result signature and loading state, and click the visible search button once. Poll at a bounded interval. Accept a result only after the submitted query is unchanged, a post-submit loading/result transition has been observed (a spinner that already existed before the click does not count), no visible spinner remains, and the DOM result signature is stable twice. A stalled query is terminal for the run; preserve its screenshot.
4. Normalize only the leading/trailing `#` characters for matching. `#家用浴缸#` matches `家用浴缸`; `#成人家用浴缸#`, `#浴缸家用#`, and other near matches do not. Never add or sum similar topics. Preserve the source display value such as `109.4w`, `1,314`, or `-` in the result evidence; numeric conversion is used only for the threshold check and the numeric Feishu view field.
5. Use the confirmed `10,000,000` (`1000w`) boundary only to validate the downstream priority result: a view count at or above it can satisfy the A-side condition only when the already-populated `内容热度` is `中/高`, search heat is `中/高`, and transaction heat is `高`. This Skill does not convert the view count into content heat. A no-exact-topic result is explicitly recorded with view count `0`, so it cannot remain in the queue forever.
6. Build a dry-run plan and compare its keyword set and queue fingerprint with the freshly re-read live `A候选` queue. Reused result files must carry the exact 灰豚红薯版/话题搜索 provenance and a valid `collected_at`; reject missing, wrong-source, future, or expired evidence. On `--apply`, write only the blank `灰豚话题浏览量` field after creating a local pre-write backup. Existing non-empty view values that differ are never overwritten; the existing content heat is always read-only.
7. Poll Feishu until the formula `优先级` settles (`A-立即跟进` only when the upstream content/search/trade conditions and the view threshold all hold; otherwise the formula's B/C result). Verify field definitions (ignoring JSON key order only), row count, every unrelated record field including `内容热度` and `是否重点词`, the one written value, and the explicitly expected `优先级` formula result before reporting `APPLIED_AND_VERIFIED`.
8. When called by `sycm-to-feishu-base/scripts/run-weekly-post-ai.mjs`, return `APPLIED_AND_VERIFIED` or `DONE_NO_CANDIDATES` and let that orchestrator continue directly into decision-history synchronization. Keep this Skill's own write scope limited to `灰豚话题浏览量`; the separate `对应产品方向` formula will recalculate after the three near-two-week counters are synchronized.

## Safety and handoff

- Never read passwords, cookies, tokens, browser storage, or authentication headers. The runner only reads visible page text and table data needed for the contract.
- On a visible login wall, QR/SMS prompt, CAPTCHA/slider, account-risk/security/permission control, stop with `HUMAN_REQUIRED` and name the stage. `allowLogin` only permits the passive `登录/注册` link on the official platform-selection page; it never suppresses QR, SMS, or `请登录` challenges. Do not click through, dismiss, or bypass the control. The selected red-book page must show a confirmed account or the run stops.
- Do not purchase, start a trial, change subscription, edit formulas, change field definitions, create records, or touch the original Feishu template in this skill.
- `--apply` is an external data write. Require the user's current authorization and the exact table ID confirmation. If the queue changes during collection, abort instead of guessing.
- The mutation allowlist contains exactly one field: `灰豚话题浏览量`. Attempts to write `内容热度`, `对应产品方向`, formulas, or any other field are blocked and treated as unauthorized.
- Keep the displayed ranges and `-` values verbatim. A missing exact topic is not permission to infer a number.

## Evidence states

The manifest status is one of:

`DONE_NO_CANDIDATES` -> no live `A候选` rows; no browser work is needed.

`AI_REQUIRED` -> at least one populated row has a blank `优先级` or is still `优先级=待数据`; finish the copied Feishu AI fields and let formulas settle before any Huitun browser query.

`DRY_RUN_READY` -> results and a complete, write-scoped plan are saved locally; Feishu is unchanged.

`APPLIED_AND_VERIFIED` -> the one-field topic-view write, formula settlement, backup hash, and integrity checks all passed.

`HUMAN_REQUIRED` -> user action is required; leave the labeled browser tab and evidence intact.

`STALLED` -> the bounded query deadline or progress condition was exceeded; preserve the screenshot and do not silently retry.

For the verified DOM selectors and observed table shape, read [page-contract.md](references/page-contract.md).

## Offline checks

```powershell
node --test "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\tests\*.test.mjs"
node --test "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\tests\adapter-huitun-keyword-heat.test.mjs"
node "D:\Retire\sycm-automation\runtime\sop-runtime\build-skill-registry.mjs" --check
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" --self-test
py -3 "D:\codex\skills\.system\skill-creator\scripts\quick_validate.py" "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat"
```

The registry check must stay green: it re-validates that this Skill's `manifest.json` still declares a
`publication`/`readback` validator pair (mandatory for its external `feishu_write` effect) and that its
`adapter.feishu` dependency resolves to the registered adapter entry.
