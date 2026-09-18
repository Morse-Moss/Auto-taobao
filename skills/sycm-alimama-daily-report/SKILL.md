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
- A multi-shop round spans **three** things, and the collection stages are the ones that move: each shop's SYCM / Alimama work runs on **that shop's own** browser + proxy (19031/19041 里可林淘宝, 19032/19042 网林天猫, 19033/19043 盖文淘宝, 19034/19044 科塔淘宝 — `SHOP_BROWSERS` in `runtime/browser-ports.mjs`), while the push stage and the readback stage stay on this chain's `19022`/`19023`, because they read the Feishu base page and that page only exists in that browser. Every shop needs its own proxy: the collection scripts speak only the proxy API (`/targets` `/eval` `/navigate` `/click` `/clickPoint`), whereas bare CDP offers `/json/list` alone. The driver sets each stage's four audit variables (`CDP_BROWSER_PORT` / `CDP_PROXY_PORT` / `CDP_BROWSER_ID` / `CDP_BROWSER_LABEL`) explicitly — leave them unset and every shop's audit row is recorded on this chain's ports, and the run still reports success.
- Feishu targets: resolve the source table/view and `各店铺数据日报` table through `runtime/feishu-targets.mjs`.
- Credentials: resolve the active kcne credential file through `runtime/feishu-targets.mjs`; never copy its values into this skill or evidence.
- Stop at login, CAPTCHA, QR/SMS, account-risk, permission, or other security controls.

Read [references/sop.md](references/sop.md) when collecting fresh source files or diagnosing page drift. **To run the whole chain for real (daily operation or a customer demo), follow sop.md §10**: one numbered table of the whole write path — what each step should print, the fallbacks, and the pre-flight checks that must pass before you start. If both downloads already exist, start with the deterministic runner. **For more than one shop in one pass, use `scripts/run-multi-shop-day.mjs` (see Multi-Shop Round below) instead of walking §10 by hand** — that order carries three coupled invariants which a hand-run breaks silently (§12.6). If a SYCM step reports `got 0` or `got 2` pages, read §12.7 before touching a selector: the "working page" predicate must be a path fragment, never the host name.

## Collection

Both source-file downloads are scripted. Each locates its own page (it refuses unless exactly one matching page exists), verifies the hit with `elementFromPoint` before clicking, and judges success by the **filesystem** — a new file appearing — never by what the page claims.

```powershell
node skills/sycm-alimama-daily-report/scripts/collect-shop-report.mjs --date 2026-09-15
node skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs --phase submit --date 2026-09-15
node skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs --phase fetch  --date 2026-09-15
```

- Shop report: enters 公共空间, opens the `日报` preview, and **asserts the preview's 统计日期 range contains the requested date** before downloading; it also refuses if the report definition id changed. It prints `shopXlsxPath`.
- Promotion report is two phases because the platform may take up to ten minutes to generate the file: `submit` clicks `下载报表 → 确定`, `fetch` goes to 下载任务管理 and clicks the task's `下载`. The run order keeps that wait behind other steps instead of idling in front of it.
- Add `--locate-only` to either script to run every lookup and hit-check **without clicking anything** — safe to repeat, and the way to prove the selectors still match before a real run.
- `fetch` takes the newest task in the list (never filtered by "today": the date inside a task name is the export date, not the reporting date). Pass `--task <name>` when the list is ambiguous.

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

Local audit trail: every run that actually touches an external system appends one row to `daily_report_push_audit` (migration `007`), so "did we push 09-14, from which source file, in which environment" is answerable with local SQL instead of digging through `evidence/daily-report-*/receipt.json`. It is an **append-only audit log, not a ledger**: `runtime/daily-report-audit.mjs` exports no read function, the table has no business unique key, and duplicate detection still asks Feishu only. It is therefore allowed to disagree with Feishu — that disagreement is the signal it exists to surface. Writes are best-effort: a failure logs `[audit] 未写入（不影响本次结论）：…` and never fails the run. Dry runs write nothing; failed pushes write `outcome='failed'` with the error in `detail`. Query snippets and the exact boundary: `references/sop.md` §6.2. When an operator clears a day by hand and asks for a re-run, follow `references/sop.md` §9: re-pushing the same date creates a **new** `recordId` (the old one does not come back) while the count still goes up by exactly one, and reusing the previous source files is correct only when their sha256 still matches the last receipt.

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

## Multi-Shop Round

One date, N shops, in one pass. **Do not hand-roll the order.** The numbered steps of §10.1 carry three coupled invariants that drift apart the moment a human drives them:

- the date placement must be **redone after** the shop-report download, because opening the `日报` preview navigates that same tab away — skip it and the backfill stops at `expected one 当日询单人数 table, got 0`;
- all three writers (`run-daily-report.mjs`, `run-inquiry-backfill.mjs`, `readback-daily-report.mjs`) must carry the **same** `--shop-key`; different values silently merge one shop's evidence into another shop's generation;
- the push stage's `--shop-xlsx` / `--promotion-zip` are **required**, and only the collection stage knows them — so collection and push cannot be handed to different people. A hand-typed path is the "default value is the target" failure shape, and the filenames alone cannot tell you.

The round opens with two different preflights, not the same one twice. Once per round it preflights the **merchant** browser (push and readback both run on it, and the Feishu ledger page exists only there); a failure there aborts the whole round **regardless of `--keep-going`**, because every shop is missing the same prerequisite. Each shop then preflights its **own** browser as its first stage, and only that shop stops. Expected pages are injected as **path-level** fragments taken from `siteAdapter()` and the ledger base token — never the health module's own host-level `--route=` defaults: `--route=dailyReport` reports 2 blocking findings on 19023 and both are false (`sycm.taobao.com` matches two pages; `one.alimama.com` matches none, since after the multi-shop change the Alimama page lives on each shop's own browser). A false red is worse than no check. Only an explicit `ok: true` passes — `null`, a missing `ok`, or a non-boolean `ok` counts as failure. Of the four layers (L0 identity, L1 environment, L2 session, L3 end-to-end) only L1 exists; `NOT_IMPLEMENTED` and `AUTH_UNKNOWN` are reported separately, and "no verdict" never becomes a pass.

```powershell
# rehearse (default): place dates, collect, dry-run — writes nothing to Feishu
node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date 2026-09-17

# reread-only: each shop's row on that date must still say what we pushed
node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date 2026-09-17 --verify-existing <N>

# real write; a same-shop same-date row is a hard duplicate stop (clear the day first, §9.3)
node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date 2026-09-17 --commit
```

`--shops a,b` narrows the round, `--only <stage>` runs a single stage (an unknown stage name throws at parse time with the full legal list — silently skipping the whole round with exit code 0 was the old failure shape), `--keep-going` continues past a failed shop. In `--verify-existing`, `N` is the target's total record count **before** the push and the predicate is `before.length === N + 1` (2026-09-17: `N = 1879`). Rehearse **cannot** run on a date that was already written — the dry run hits the same hard duplicate stop by design. Per-stage stdout/stderr plus the argv each stage actually received land in `evidence/multi-shop-<date>/<shop>/NN-<stage>.txt`, the once-per-round preflight in `evidence/multi-shop-<date>/00-health-check-daily.txt`, and the roll-up in `summary.json`. `references/sop.md` §12.6 holds the mode table and the measured 2026-09-18 run (four shops × ten stages, no manual intervention; the round is eleven stages since the preflight was wired in — see §12.8).

## Independent Readback

```powershell
node skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs --date 2026-09-15
# optional: --output-dir <dir> | --shot-suffix <suffix> | --skip-screenshots | --leave-on source|inquiry
```

The writer proving itself cannot rule out the writer and the reader being wrong together, so this reads the same facts through a completely different path — CDP into the Feishu page's bitable in-memory model — and saves `independent-readback.json` plus two screenshots. It is a corroborating witness, never the authority. Four limits are **recorded** in the output rather than silently dropped:

- The page model stores SingleSelect **option ids** while the OpenAPI stores **names**. Option ids are resolved in three ordered layers — the cell's own field, then the canonical shop table, then a whole-base scan flagged `ambiguous-option-id` — because a single global scan mis-reads 5 of 12 shops whose short names collide across tables.
- Every table is navigated to before it is read: a stale tab's record set is a snapshot from when it was opened (measured 12 records apart).
- `recordsNumFromPageModel` is an upper bound. Missing rows are recorded as `rowsComplete:false` + `onDateCountIsLowerBound:true` + a `caveat`; a count from a partially materialized table is a lower bound, never a conclusion.
- It does not carry derived values at all. The source table's `店铺` is a Lookup (type 19) and has **no key** in `record.fields` (exactly one field missing out of 265), so it is listed in `absentFields` as `Lookup-key-absent-from-page-model` with a pointer to the readable `店铺名称`. That asymmetry is why the derived `店铺` acceptance check above stays on the OpenAPI path, reread by record id, and must not be moved here. Field coverage is scoped to `--date` (`fieldsCoverageScope`), since whole-table counts are dominated by other days.

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
