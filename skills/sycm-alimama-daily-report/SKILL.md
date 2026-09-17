---
name: sycm-alimama-daily-report
description: Collect the logged-in SYCM shop daily report, SYCM inquiry metrics, and Alimama keyword/audience promotion report; validate their date and schema; import the combined source row; and backfill inquiry fields in the authorized Feishu daily-report base. Use for daily operations reporting, reruns, dry-run validation, and Feishu readback verification.
---

# 生意参谋 + 阿里妈妈运营日报

Use the dedicated daily-report Edge profile and proxy. This workflow is specific to the merchant account and must not reuse the Xiaowangshen buyer profile.

## Runtime Contract

- Browser: Edge debug port `19022`, profile `D:/Retire/edge-daily-report-profile`.
- CDP proxy: `http://127.0.0.1:19023`, browser id `edge-daily-report`.
- Ports and profile paths come from `runtime/browser-ports.mjs` (single source of truth); the launchers read them, and scripts must not hardcode a second copy. Override with `PROJECT_BROWSER_PORT` / `CDP_PROXY_PORT` / `CDP_BROWSER_PORT` when a machine needs different values.
- Why two browsers are mandatory, not a convenience: SYCM / Alimama / Feishu require the merchant account, while the Xiaowangshen extension only works on the buyer account. One browser profile cannot hold both, so the daily-report chain and the competitor chain each need their own instance, debug port, and proxy port. Merging them fails silently: clicks and navigation succeed, but on the other account's browser.
- Feishu targets: resolve the source table/view and `各店铺数据日报` table through `runtime/feishu-targets.mjs`.
- Credentials: resolve the active kcne credential file through `runtime/feishu-targets.mjs`; never copy its values into this skill or evidence.
- Stop at login, CAPTCHA, QR/SMS, account-risk, permission, or other security controls.

Read [references/sop.md](references/sop.md) when collecting fresh source files or diagnosing page drift. If both downloads already exist, start with the deterministic runner.

## Date Placement

Set the reporting date on both sites before collecting anything. Never rely on the page's remembered state.

```powershell
node skills/sycm-alimama-daily-report/scripts/date-picker.mjs --site alimama --date 2026-09-15
node skills/sycm-alimama-daily-report/scripts/date-picker.mjs --site sycm --date 2026-09-15
```

- Mode is derived, not guessed: the requested date equal to the site's yesterday uses the `1天` preset; any other date uses an explicit selection. `--mode preset|explicit` forces one.
- Alimama encodes every filter in the URL hash, so the date, both scenes, the 30-day cycle, and the daily granularity are applied by navigation alone — no calendar clicks. The script then rereads the filter bar and asserts all of them.
- Sycm needs the `询单到付款` tab first; the date control under `汇总分析` is a different widget. The script switches the tab, applies the date, and asserts the tab is still active afterwards.
- A refused assertion prints the step trace, so a failure is diagnosable without re-running by hand.

## Deterministic Import

The runner is dry-run by default. It rejects a schema mismatch, missing scene, mismatched dates, an existing same-day shop row, an unexpected Feishu target, or a value incompatible with the target field type.

```powershell
node skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs `
  --shop-xlsx "C:/path/to/日报.xlsx" `
  --promotion-zip "C:/path/to/营销场景报表.zip" `
  --date 2026-09-15
```

Inspect the generated `plan.json`. Add `--commit` only when the target and reporting date are authorized. A committed run must create exactly one record and generate `receipt.json` after rereading that record.

Two blocks in `plan.json` / `receipt.json` exist so the run can be audited afterwards:

- `environment` — `computedAt`, `node`, `proxyUrl`, and the browser/proxy ports, ids and labels, each with a `source` (`env` / `registry-default` / `env-invalid`) and its `registryDefault`. It answers "did this run deviate from the port registry?" in one line, e.g. `browserPort: {"port":9223,"source":"env","registryDefault":19022}`. It only observes: an invalid env value is recorded as `env-invalid` rather than failing a data import (the runner does not read those ports itself).
- `sourceSelfChecks` — whether both source files really are the reporting date: per-source `targetRowCount`, `matchedRowDate` / `observedDates`, and an overall `allMatchDate`. When it fails the run stops **before** field mapping and names both files, instead of the older `unexpected <scene> identity/date` message that named neither.

Rows in the Feishu grid are **append-only**, so their order is record creation order, not chronological order. `batchCreateRecords` and the UI paste path both add to the end, and the OpenAPI cannot insert at a position. Backfilling an older date therefore lands *after* the newer date that was pushed first (measured: 09-15 at row 5, 09-14 at row 6). The data itself cannot drift across rows: `统计日期`, `关键词推广日期` and `人群推广日期` must be equal within a row, enforced by `buildCombinedFields` and again by `assertSourceDates`.

A view sort on `统计日期` is the obvious remedy but **does not persist on this view** (measured 2026-09-17): the sort panel accepts it and the grid re-renders in order, yet a full page reload returns `sortInfo` to `[]`, disabling the panel's `自动排序` switch changes nothing, and adding the sort issues zero network requests. The server-side check settles it — listing records with and without `view_id` returns the same order (creation order). Permissions offer no explanation (`records: []`, `isLock:false`, `view.sort={visible:true,editable:true,localEditable:false}`), and a sibling view in the same base (`tblm9Hx7R9A1YoLC`) does keep its `sortInfo`. So do **not** rely on a view sort in this SOP: reconstruct positions from `recordCountBefore/After` in the receipts, or save a new view first and sort that one. Evidence: `docs/ops/DAILY-REPORT-RUN-2026-09-17-FINDINGS.md` §8.5.

If the Feishu app returns `403 / 91403`, do not retry the API. Use the logged-in Feishu grid: select the first cell of one newly created row and paste the generated `paste.tsv` through the proxy's real `POST /paste` endpoint. Then verify the exact row and the observed pre-write count:

```powershell
node skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs `
  --shop-xlsx "C:/path/to/日报.xlsx" `
  --promotion-zip "C:/path/to/营销场景报表.zip" `
  --date 2026-09-15 `
  --verify-existing --expected-before-count 4
```

## Inquiry Backfill

In the same logged-in SYCM browser, open `服务 -> 店铺绩效 -> 业绩分析 -> 询单到付款`, select `日`, and set the requested date through the date-placement step above. The inquiry runner reads the `当日询单人数` column from the requested date row and, when present, the `同行同层均值` row. It maps them to `询单量` and `同层同行询单量` respectively.

The `同行同层均值` row only exists in the `1天` preset. A custom date returns three rows without it, so `同层同行询单量` is unavailable from the source. That is fail-closed by default; pass `--allow-missing-peer` to degrade explicitly to writing only `询单量`. The plan and receipt then carry `degraded.code = PEER_UNAVAILABLE` and the peer field is left blank rather than zeroed.

Dry-run first, then commit the reviewed plan:

```powershell
node skills/sycm-alimama-daily-report/scripts/run-inquiry-backfill.mjs `
  --date 2026-09-15 --source-shop 盖文旗舰店 --shop 盖文天猫

node skills/sycm-alimama-daily-report/scripts/run-inquiry-backfill.mjs `
  --date 2026-09-15 --source-shop 盖文旗舰店 --shop 盖文天猫 --commit

# historical date: only 询单量 is obtainable
node skills/sycm-alimama-daily-report/scripts/run-inquiry-backfill.mjs `
  --date 2026-09-14 --source-shop 盖文旗舰店 --shop 盖文天猫 --allow-missing-peer --commit
```

The runner requires the live SYCM shop identity to match `--source-shop`, one exact SYCM table, one exact date row, one exact Feishu row matched by date and `--shop`, and — unless the peer benchmark is explicitly degraded — one exact `同行同层均值` row. Both target fields must be blank, or both must already equal the source values; under degradation only `询单量` is judged and the peer field must stay blank, so a rerun still returns `ALREADY_VERIFIED`. It updates only those fields and compares every other field before and after the write.

## Data Contract

- Shop data contributes 119 columns in exact workbook order.
- Promotion CSV must contain exactly one `371 / 关键词推广` row and one `372 / 人群推广` row.
- Each promotion block uses CSV columns 1-67, leaving the target-only `原二级场景ID` and `原二级场景名字` blank. The final four subsidy columns are excluded because the target table has no matching fields.
- `统计日期`, `关键词推广日期`, and `人群推广日期` must all equal the requested report date.
- Preserve text values such as percentages, `NULL`, comma-formatted counts, ranges, and `-` exactly when the target field is text. Convert only fields whose live target type is numeric or date.
- Never populate `空列不用管`, `店铺`, `字段 1` through `字段 5`, `父记录`, formulas, relations, or lookup fields.
- A same-date row is a hard duplicate stop. Do not overwrite or append a second row automatically.

## Acceptance

Accept a committed run only when the table record count increases by exactly one, the returned record id exists on reread, all written fields match after Feishu type normalization, both scene ids are correct, all three dates match, target-only promotion fields remain blank, and the derived `店铺` field resolved to exactly one value. `店铺` is computed asynchronously by Feishu, so that one field is reread with a bounded retry; exhausting the budget is still a failure, reported together with the record id that does exist.

Accept an inquiry backfill only when the source page is on the requested date, the numeric values come from the named column and rows, the Feishu target row is unique, the written values match on reread, and all unrelated fields are unchanged. Under `PEER_UNAVAILABLE` degradation, accept only `询单量` and require `同层同行询单量` to be blank.
