---
name: sycm-alimama-daily-report
description: Collect the logged-in SYCM shop daily report, SYCM inquiry metrics, and Alimama keyword/audience promotion report; validate their date and schema; import the combined source row; and backfill inquiry fields in the authorized Feishu daily-report base. Use for daily operations reporting, reruns, dry-run validation, and Feishu readback verification.
---

# 生意参谋 + 阿里妈妈运营日报

Use the dedicated daily-report Edge profile and proxy. This workflow is specific to the merchant account and must not reuse the Xiaowangshen buyer profile.

## Runtime Contract

- Browser: Edge debug port `9223`, profile `D:/Retire/edge-daily-report-profile`.
- CDP proxy: `http://127.0.0.1:3458`, browser id `edge-daily-report`.
- Feishu targets: resolve the source table/view and `各店铺数据日报` table through `runtime/feishu-targets.mjs`.
- Credentials: resolve the active kcne credential file through `runtime/feishu-targets.mjs`; never copy its values into this skill or evidence.
- Stop at login, CAPTCHA, QR/SMS, account-risk, permission, or other security controls.

Read [references/sop.md](references/sop.md) when collecting fresh source files or diagnosing page drift. If both downloads already exist, start with the deterministic runner.

## Deterministic Import

The runner is dry-run by default. It rejects a schema mismatch, missing scene, mismatched dates, an existing same-day shop row, an unexpected Feishu target, or a value incompatible with the target field type.

```powershell
node skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs `
  --shop-xlsx "C:/path/to/日报.xlsx" `
  --promotion-zip "C:/path/to/营销场景报表.zip" `
  --date 2026-09-15
```

Inspect the generated `plan.json`. Add `--commit` only when the target and reporting date are authorized. A committed run must create exactly one record and generate `receipt.json` after rereading that record.

If the Feishu app returns `403 / 91403`, do not retry the API. Use the logged-in Feishu grid: select the first cell of one newly created row and paste the generated `paste.tsv` through the proxy's real `POST /paste` endpoint. Then verify the exact row and the observed pre-write count:

```powershell
node skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs `
  --shop-xlsx "C:/path/to/日报.xlsx" `
  --promotion-zip "C:/path/to/营销场景报表.zip" `
  --date 2026-09-15 `
  --verify-existing --expected-before-count 4
```

## Inquiry Backfill

In the same logged-in SYCM browser, open `服务 -> 店铺绩效 -> 业绩分析 -> 询单到付款`, select `日`, and set the requested date. The inquiry runner reads the `当日询单人数` column from the requested date row and the `同行同层均值` row. It maps them to `询单量` and `同层同行询单量` respectively.

Dry-run first, then commit the reviewed plan:

```powershell
node skills/sycm-alimama-daily-report/scripts/run-inquiry-backfill.mjs `
  --date 2026-09-15 --source-shop 盖文旗舰店 --shop 盖文天猫

node skills/sycm-alimama-daily-report/scripts/run-inquiry-backfill.mjs `
  --date 2026-09-15 --source-shop 盖文旗舰店 --shop 盖文天猫 --commit
```

The runner requires the live SYCM shop identity to match `--source-shop`, one exact SYCM table, one exact date row, one exact benchmark row, and one exact Feishu row matched by date and `--shop`. Both target fields must be blank, or both must already equal the source values. It updates only those two fields and compares every other field before and after the write.

## Data Contract

- Shop data contributes 119 columns in exact workbook order.
- Promotion CSV must contain exactly one `371 / 关键词推广` row and one `372 / 人群推广` row.
- Each promotion block uses CSV columns 1-67, leaving the target-only `原二级场景ID` and `原二级场景名字` blank. The final four subsidy columns are excluded because the target table has no matching fields.
- `统计日期`, `关键词推广日期`, and `人群推广日期` must all equal the requested report date.
- Preserve text values such as percentages, `NULL`, comma-formatted counts, ranges, and `-` exactly when the target field is text. Convert only fields whose live target type is numeric or date.
- Never populate `空列不用管`, `店铺`, `字段 1` through `字段 5`, `父记录`, formulas, relations, or lookup fields.
- A same-date row is a hard duplicate stop. Do not overwrite or append a second row automatically.

## Acceptance

Accept a committed run only when the table record count increases by exactly one, the returned record id exists on reread, all written fields match after Feishu type normalization, both scene ids are correct, all three dates match, and target-only promotion fields remain blank.

Accept an inquiry backfill only when the source page is on the requested date, the two numeric values come from the named column and rows, the Feishu target row is unique, both written values match on reread, and all unrelated fields are unchanged.
