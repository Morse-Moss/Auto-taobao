---
name: sycm-to-feishu-base
description: Export logged-in 生意参谋 search rankings and import them into an authorized Feishu Bitable copy while preserving fields, formulas, views, and AI prompts. Use for first-time imports and weekly workflows that add one dated table to the same Base, reuse permanent keyword numbers, append history, stop for Feishu AI, then synchronize Huitun-backed decision history.
---

# 生意参谋到飞书多维表

Use this skill for first-time imports into a user-authorized Feishu copy and for later weekly snapshots inside that same Base. Keep each weekly analysis table isolated, keep permanent keyword numbers stable, and append every batch to the shared history table.

## Required Skills

1. Load `web-access` before any browser or network action. Run its dependency check and display its risk notice.
2. Load `xlsx` when creating or validating CSV/XLSX output.
3. Reuse `sycm-export-search-rank` for the 生意参谋 export phase; do not duplicate its selectors or login logic.

## Safety Boundary

- Use the user's already logged-in browser session. Never read credentials, cookies, password-manager data, tokens, or browser storage.
- Stop with `HUMAN_REQUIRED` at login, QR/SMS/CAPTCHA, account-risk/security prompts, or permission barriers. Never dismiss or bypass platform controls.
- Treat the supplied Feishu URL as the template. Do not edit it directly. Only create and modify an explicitly authorized copy.
- Keep request frequency low. Do not add stealth, fingerprint spoofing, anti-detection, or retry storms.
- Discover fresh target IDs before every browser action that depends on a target; target IDs expire when tabs sleep or reload.

## Inputs and Data Contract

Accept:

- a search-ranking category/keyword and date (default to the user's stated values);
- an authorized Feishu template URL;
- optionally, an existing validated CSV/XLSX export.

The import contract is exactly five source columns, in this order:

`排名`, `搜索词`, `搜索人气`, `点击率`, `支付转化率`

Preserve displayed ranges and `-` values verbatim. Do not turn masked ranges into invented numbers. Require contiguous unique ranks `1..N`, non-empty search terms, and an exact row-count match between the source and Feishu table.

## Workflow

### Reusable assets

- `scripts/build-paste-tsv.mjs` converts a validated five-column CSV to headerless TSV while preserving `-` and displayed ranges.
- `scripts/inspect-feishu-fields.mjs` reads the current Feishu table/view field order from the page's loaded model without editing the base.
- `scripts/copy-weekly-table.mjs` copies one analysis table's structure inside the same Base, verifies formulas, AI prompts, and views, and waits for the Base revision to reach cloud storage.
- `scripts/update-weekly-base.mjs` reuses or creates permanent keyword numbers, writes the dated weekly table, assigns batch numbers, appends history, creates a write-ahead backup, and verifies idempotency.
- `scripts/run-weekly-pre-ai.mjs` is the supported weekly entry point from a fresh verified seven-day SYCM export to `LOCAL_INPUT_READY`; it rejects daily or unproven artifacts before any Feishu write. It accepts an existing export only as an explicit `--source-csv` plus `--source-xlsx` pair, re-opens the workbook, proves the seven-day window, writes `input-snapshot.json` and `pre-ai-manifest.json` under `runtime/weekly-runs/<collection-date>/pre-ai-<stamp>/`, and **stops there**. It does not copy a table, does not append a batch, and makes no Feishu call of its own. The two remote stages (`copy-weekly-table.mjs`, `update-weekly-base.mjs`) are run either by `adapter.feishu-weekly.mjs` on the publish path or explicitly by an operator, using the parameters recorded in the manifest.
- `scripts/run-weekly-post-ai.mjs` is the **artifact** publisher: it takes `--publish-artifact <PUBLISH_READY json>`, digests-checks the plan against the live tables, and (with `--apply` plus exact Base/current/history/library confirmations) writes only keyword-library creates, current-table updates, and history-table updates, then re-reads to verify. It explicitly **rejects** `--pre-ai-manifest` as obsolete, and it does not run the Huitun stage or `sync-decision-history.mjs`.
- `scripts/sync-decision-history.mjs` snapshots each valid batch's proven `重点达标`, `A级达标`, and `探索达标` results into history, then writes the three `上一有效周...达标` inputs on the current table. It also freezes `标准归并词`, `是否重点词`, and `优先级` into history and maintains the formula-driven `本期标记` used by the permanent dashboard. The three `近2周...达标次数` fields are formulas that combine frozen inputs with the current row, so current search, trade, content, and Huitun changes recalculate immediately. The script ignores invalid or unverified batches rather than selecting the two largest batch numbers.
- `tests/` contains offline regression checks for the TSV contract, field mapping, and shared Proxy paste contract.

### 1. Export

Run the existing exporter with its supported `--from-home --period 7d` workflow when starting from the 生意参谋 home page. Treat the weekly `collection-date` as the seven-day window's end date. Keep the page on search-ranking page 1 after collection. Accept the export only after its receipt proves `period=7天`, `dayCount=7`, the expected end date, contiguous ranks, unique terms, non-empty metrics, and both output paths.

### 2. Clone the Feishu template

1. Open the supplied Feishu URL in the logged-in browser session and confirm the title/table before acting.
2. Use the file menu's `创建副本` action.
3. Name the copy deterministically, for example `生意参谋普通浴缸词库 2026-08-03`.
4. Select `仅多维表格结构` unless the user explicitly asks to copy old records. This preserves tables, fields, formulas, views, filters, grouping, sorting, dashboards, and AI fields without carrying stale sample rows.
5. Locate the new base from Feishu search if the copy dialog does not navigate. Record the new base URL and verify the copy is editable.

### 3. Import into the existing table

1. Open `数据表 2` (or the user-specified source table) in the copy and verify it is empty before import.
2. Confirm the first five field names match the data contract. Do not import as a new independent table.
3. Paste data without a header row into the first data cell using the shared web-access Proxy's `POST /paste?target=...` endpoint. The endpoint activates the target and sends a real `Ctrl+V` through the Proxy's single browser connection. Do not open a second browser-level WebSocket and do not rely on a synthetic `ClipboardEvent`.
   Build the clipboard payload with `node scripts/build-paste-tsv.mjs INPUT.csv > paste.tsv`; never assemble TSV by ad-hoc comma splitting.
4. If a paste preview or row/column confirmation appears, verify its dimensions before confirming.
5. If text starts accumulating inside one cell, cancel before commit, re-observe the cell, and retry once through the same Proxy endpoint after rediscovering the target.
6. Wait for Feishu autosave and any formula/AI fields to settle. Do not create duplicate rows to “fill” a delayed view.

### 4. Verify

Require all of the following:

- table count equals the source row count exactly;
- first row and last rank agree with the source;
- ranks are contiguous and unique;
- the five source fields are in the expected order;
- the copy still exposes `筛选`, `分组`, `排序`, and the copied dashboards/tables;
- Feishu reports the document saved to cloud.

If only the first page is visible, use the table's own scrolling or count indicator; do not infer completeness from DOM row count alone. Report AI-field processing as “started/settled” only when observed.

### 5. Add a later weekly batch to the same Base

Do not create another independent Base for a routine weekly update.

For the pre-AI phase, run the wrapper below. It performs a fresh verified seven-day SYCM export (or accepts an explicit `--source-csv`/`--source-xlsx` pair), refuses an invalid period receipt before any remote write, writes the local `input-snapshot.json` plus `pre-ai-manifest.json` pair, and stops at `LOCAL_INPUT_READY`. It does **not** copy a table, does **not** append a batch, and makes no Feishu call of its own — those are the two remote stages (items 1-4 below), run either by `adapter.feishu-weekly.mjs` on the publish path or explicitly by an operator using the parameters recorded in the manifest. Note that here `--apply` only means "write the local manifest"; it does not authorize a Feishu write:

```powershell
node "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\scripts\run-weekly-pre-ai.mjs" `
  --base-url "https://<tenant>.feishu.cn/base/<app-token>" `
  --source-table-id <previous-table-id> --source-table-name "<previous-table-name>" `
  --history-table-id <history-table-id> --library-table-id <library-table-id> `
  --collection-date YYYY-MM-DD --batch-number N --expected-history-before N `
  --env-file "<feishu-env-file>" --apply --confirm-base <app-token>
```

Use the individual stages below only for diagnosis or a controlled resume:

1. Run `copy-weekly-table.mjs` without `--apply` against the authorized Base and the previous analysis table. The script opens the authorized Base when no matching Feishu tab exists, but stops if multiple matching tabs exist. Review the source identity and confirm that the dated table name does not already exist.
2. Run it with `--apply --confirm-base <app-token>`. It must select `仅数据表结构`, preserve formula and AI Prompt configuration, create zero records, and wait until the Base revision advances. A frontend-only optimistic table is not completion.
3. Run `update-weekly-base.mjs` without `--apply`, passing the paired source CSV/XLSX and the immediately preceding analysis table's ID and exact name as the protected table. Review the source proof and hashes, source count, empty weekly-table state, previous/current history counts, reused versus missing library identities, and planned previous-batch updates.
4. Apply only with exact `--confirm-base` and `--confirm-weekly-table`. The script may create missing keyword-library records, create history text field `批次有效性`, write the new weekly table, assign blank legacy history rows to batch 1 during the initial migration, and append the current history batch as `有效`. Later runs preserve every existing batch. Its mutation guard blocks changes to the previous analysis table and unrelated fields.
5. Preserve the prior collection date when it is unknown. A known current date and ordered batch numbers do not authorize inventing a previous date.
6. Verify the weekly table count, contiguous ranks, unique permanent numbers, current collection date, zero formula errors, cumulative history count, batch distribution, keyword-library uniqueness, and unchanged previous analysis table. Re-run dry-run and require zero missing library rows and zero pending previous-batch updates.
7. Leave copied AI fields blank for the user or an explicitly authorized AI run and report `LOCAL_INPUT_READY` — that is the status the pre-AI runner actually writes. `READY_FOR_AI` is obsolete: `run-weekly-post-ai.mjs` explicitly rejects a manifest carrying it, so handing over an older status string stops the chain at the next stage. The current `优先级` formula returns `待数据` while `关键词分类` is blank, or while a `痛点词` lacks its service-check labels, so an unfinished AI batch cannot enter the Huitun queue. `对应产品方向` is a formula, not an AI field: it uses the three near-two-week counters with precedence `主推 > 增长 > 探索 > 暂无`.
8. Run only the copied AI fields that operations has confirmed. The two supported routes from here are: (a) the artifact route — build the local-analysis input, run `runtime/run-weekly-local-analysis.mjs INPUT_JSON OUTPUT_DIR <cc|codex|workbuddy>` to produce a `PUBLISH_READY` artifact, then hand it to `run-weekly-post-ai.mjs`; or (b) the operational route actually wired today — have operations settle the AI fields in the Feishu table itself and then run `sync-decision-history.mjs`. Do not hand a `pre-ai-manifest.json` to the post-AI runner; it rejects that flag. Never manually reconstruct the current table, batch, or expected row counts.
9. After the post-AI publish, run the two **separate** stages by hand — the post-AI runner does NOT chain them (verified 2026-09-20: a full-file grep of `run-weekly-post-ai.mjs` for `huitun` / `灰豚` / `sync-decision-history` returns nothing; its workflow writes only library creates, current updates, and history updates). First `huitun-to-feishu-keyword-heat` dry-run/apply, then `sync-decision-history.mjs` dry-run/apply. History may create the three numeric decision snapshots, the three text visualization snapshots, and formula field `本期标记`; it writes only proven values and only the three current `上一有效周...达标` inputs. Create the permanent dashboard once on `关键词历史总表 V1`, and filter every chart by `本期标记=是` plus `批次有效性=有效`. Do not create a dashboard per week. Switch `本期标记` only after all current visualization snapshots are complete. `A候选` remains unknown until Huitun resolves it; it must not be frozen as `A级达标=0`. `重点达标` does not depend on content heat, while missing evidence keeps only the affected formula result blank instead of inventing zero.
10. Treat `已有有效批次数` as a deprecated retained field. Do not require, populate, delete, or use it in formulas. Deletion needs separate approval because it is destructive.

For a known bad historical period, use the same weekly writer's bounded correction options only after a dry-run:

```powershell
--invalidate-history-batch <bad-batch-number> `
--expected-invalid-batch-rows <exact-row-count>
```

This may write only `批次有效性=无效-周期错误` to the exact records in that batch. Existing blank validity remains unverified and is never silently promoted. A legacy batch may be promoted only by `sync-decision-history.mjs` with an explicit previous-table identity, exact batch number and expected row count; the meaningful permanent keyword-number set must be unique and exactly equal to that history batch. Existing conflicting or mixed validity fails closed. Do not delete a bad batch or overwrite its dated analysis table.

For that bounded legacy correction, add these four arguments to the normal `sync-decision-history.mjs` dry-run and apply commands. Review `historyValidityToWrite` before apply; rerun dry-run afterward and require it to be zero:

```powershell
--previous-table-id <verified-previous-table-id> `
--previous-table-name "<verified-previous-table-name>" `
--verify-history-batch <exact-batch-number> `
--expected-verified-batch-rows <exact-row-count>
```

Prefer the supported POST-AI publisher. It validates a `PUBLISH_READY` artifact against the live tables, then writes only inside its separate dry-run / apply boundary. It is the **artifact** publisher, not the pre-AI manifest consumer — pass `--publish-artifact`, and note that `--pre-ai-manifest` is rejected outright:

```powershell
node "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\scripts\run-weekly-post-ai.mjs" `
  --publish-artifact "<analysis-artifact.json>" --apply `
  --confirm-base <app-token> --confirm-current-table <current-table-id> `
  --confirm-history-table <history-table-id> --confirm-library-table <library-table-id>
```

The artifact must carry `status: PUBLISH_READY`, a `publishPlan` whose digest matches its own body, and complete `evidence` (`source`, `providerDigest`, `promptDigest`). Post-AI writes three things and nothing else: keyword-library creates, current-table updates, and history-table updates. It does **not** clone a table, does **not** append a history batch, and does **not** run the Huitun stage or `sync-decision-history.mjs` — those stay separate stages.

Use the individual stages below only for diagnosis or recovery:

```powershell
# 1. Collect Huitun evidence and build a read-only backfill plan.
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" `
  --app-token <app-token> --table-id <current-table-id> --table-name "<current-table-name>" `
  --env-file "<feishu-env-file>"

# 2. Apply only the reviewed Huitun result file to the same confirmed weekly table.
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" `
  --app-token <app-token> --table-id <current-table-id> --table-name "<current-table-name>" `
  --env-file "<feishu-env-file>" --results "<results.json>" `
  --apply --confirm-table <current-table-id>

# 3. Dry-run the history snapshot and two-week helper calculation.
node "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\scripts\sync-decision-history.mjs" `
  --base-url "https://<tenant>.feishu.cn/base/<app-token>" `
  --current-table-id <current-table-id> --current-table-name "<current-table-name>" `
  --previous-table-id <previous-table-id> --previous-table-name "<previous-table-name>" `
  --history-table-id <history-table-id> --history-table-name "<history-table-name>" `
  --current-batch-number N --expected-current-rows N --expected-history-rows N `
  --env-file "<feishu-env-file>"

# 4. Apply the same history plan with all three exact confirmations.
node "D:\Retire\sycm-automation\skills\sycm-to-feishu-base\scripts\sync-decision-history.mjs" `
  --base-url "https://<tenant>.feishu.cn/base/<app-token>" `
  --current-table-id <current-table-id> --current-table-name "<current-table-name>" `
  --previous-table-id <previous-table-id> --previous-table-name "<previous-table-name>" `
  --history-table-id <history-table-id> --history-table-name "<history-table-name>" `
  --current-batch-number N --expected-current-rows N --expected-history-rows N `
  --env-file "<feishu-env-file>" --apply --confirm-base <app-token> `
  --confirm-current-table <current-table-id> --confirm-history-table <history-table-id>
```

If stage 1 returns `AI_REQUIRED`, stop and finish Feishu AI. If it returns `DONE_NO_CANDIDATES`, skip stage 2 and continue with stages 3-4; that state is valid only because the readiness gate already proved there are no pending `待数据` rows.

## Failure Handling

- `HUMAN_REQUIRED`: leave the browser unchanged and report the exact user handoff.
- Missing or sleeping tab: rediscover `/targets`; open a new allowlisted tab only when needed. Never reuse a stale target ID.
- Copy not editable: stop; do not attempt to alter the external template.
- Wrong-cell paste: cancel before commit, then retry with real clipboard/keyboard input.
- Count mismatch or non-contiguous ranks: stop, do not publish or claim completion; preserve the copy for diagnosis.
- Frontend table exists but Open API cannot see it: inspect the visible save state and Base revision. Wait for cloud save; do not create a duplicate table.
- Partially completed weekly write: rerun dry-run. The weekly updater resumes only matching ranks and rejects conflicting or unexpected records.
- Reused collection date: stop before appending history. One displayed collection date may belong to only one batch; an idempotent resume of that same batch is allowed.
- Missing or mismatched source XLSX: stop before any Feishu write. A CSV alone, a filename, or a caller-supplied date is not seven-day proof.
- Invalid/unverified historical batch: preserve it for audit but exclude it from trend and two-week decision inputs.
- Missing decision inputs: keep only the affected snapshot and matching `近2周...达标次数` blank. Missing content heat blocks `探索达标`, but does not block a provable `重点达标` or `A级达标`; never convert unknown evidence into zero.
- Incomplete current visualization snapshots: stop before creating or updating `本期标记`; keep the permanent dashboard on the last complete valid batch.

## Final Report

Report the Base and weekly-table URLs, paired source paths and hashes, weekly and cumulative history counts, batch and validity distributions, keyword-number reuse/new counts, first/last rank evidence, backup and receipt paths, and whether formulas and AI Prompt configuration were observed. Also report the pipeline state (`LOCAL_INPUT_READY`, Huitun dry-run/apply, decision-history sync), written versus pending helper counts, invalid periods, and missing historical dates separately from verified facts.
