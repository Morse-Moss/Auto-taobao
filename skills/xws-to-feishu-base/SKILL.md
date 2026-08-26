---
name: xws-to-feishu-base
description: Import Xiaowangshen (小旺神) market-analysis XLSX exports with embedded product images into an authorized empty Feishu Bitable copy through the Feishu API. Use when competitor rows must preserve the 16-field Xiaowangshen contract and write real attachment images rather than image URLs.
---

# Xiaowangshen To Feishu Base

Import one validated Xiaowangshen XLSX into an authorized empty Feishu Bitable copy. Extract each embedded image, upload it as Bitable media, and write the returned `file_token` to the `商品图片` attachment field.

## Safety Boundary

- Never modify the original template or a table containing records.
- Use only a user-authorized copy or test table.
- Keep Feishu credentials in the caller-provided environment file. Never print, copy, or store them in this project.
- Stop with `HUMAN_REQUIRED` for login, CAPTCHA, QR/SMS, risk, security, or permission prompts.
- Do not read cookies, browser storage, tokens, or authentication headers.
- When browser work is needed, reuse the shared `web-access` Proxy and rediscover the target before every action. Never open a second browser-level CDP WebSocket.

## Input Contract

Require these 16 headers in order. The sixth source header may be `月收货人数` or the observed current export label `付款人数`; keep the actual source label when creating/validating the authorized target table:

`序号, 商品图片, 商品标题, 商品链接, 价格, 月收货人数|付款人数, 类目, 同款数, 平台, 占位类型, 店铺名, 店铺旺旺, 店铺类型, 地址, 收藏人数, 卖点`

Require exactly one embedded image for every data row. Preserve text such as `-`. Convert `价格` to a number. For `月收货人数`, convert a trailing-plus value such as `100+` to `100` because the target field is numeric. For `付款人数`, preserve displayed text such as `14人看过` verbatim and use a text target field; never infer a number.

Require the target table to:

- contain zero records;
- contain all 16 source fields;
- define `商品图片` as attachment field type `17`.

## Workflow

1. Run dry-run extraction first. Confirm source row count and embedded image count match.
2. Read target fields and record count through the Feishu API.
3. If the app lacks access, add the approved Feishu app to the authorized copy with `可编辑` permission. Do not change any other document.
4. Run commit mode. The importer uploads each image, builds attachment values as `[{ file_token }]`, then creates all records in one batch.
5. Accept completion only when API verification reports the exact source row count and the same attachment count.
6. Refresh the Feishu copy and visually confirm that `商品图片` displays rendered thumbnails rather than URLs.

## Commands

Dry run:

```powershell
node "D:\Retire\sycm-automation\skills\xws-to-feishu-base\scripts\import-xws-to-feishu.mjs" `
  --xlsx "C:\path\to\xiaowangshen.xlsx" `
  --base-url "https://tenant.feishu.cn/base/APP_TOKEN?table=TABLE_ID" `
  --work-dir "D:\Retire\sycm-automation\runtime\xws-feishu-dry-run"
```

Commit to an authorized empty copy:

```powershell
node "D:\Retire\sycm-automation\skills\xws-to-feishu-base\scripts\import-xws-to-feishu.mjs" `
  --xlsx "C:\path\to\xiaowangshen.xlsx" `
  --base-url "https://tenant.feishu.cn/base/APP_TOKEN?table=TABLE_ID" `
  --env-file "C:\path\to\.env.local" `
  --work-dir "D:\Retire\sycm-automation\runtime\xws-feishu-live" `
  --commit
```

The environment file must define `FEISHU_APP_ID` and `FEISHU_APP_SECRET`. Do not pass secret values on the command line.

## Verification

```powershell
node --test "D:\Retire\sycm-automation\skills\xws-to-feishu-base\tests\*.test.mjs"
py -3 -m unittest "D:\Retire\sycm-automation\skills\xws-to-feishu-base\tests\extract_xws_xlsx_test.py"
```

Treat `report.json` as the machine-readable run receipt. It must report `dryRun: false`, equal `sourceRows` and `importedRows`, and `attachmentCount` equal to both.

## V2 competitor analysis import

Use `import-competitor-v2.mjs` when the Xiaowangshen export must become a structured competitor-analysis copy. It preserves the 16 source fields, adds the approved calculated/classification fields, and creates exactly these three allowed tables:

- `竞品主表`: source fields plus calculated values and deferred-data markers.
- `SKU明细`: schema only; keep empty until SKU collection is separately authorized.
- `问题库`: fixed operator-facing eight-field mirror; raw collection writes to dated `问题库_开始日期_结束日期`,
  and the post-analysis mirror may populate this table only after the dated source and Feishu summary are verified.

The empty `SKU明细` schema is part of the same V2 contract: its fields are `商品链接`, `商品标题`, `竞品分类`, `SKU名称`, `SKU规格`, `SKU尺寸`, `尺寸汇总`, `适用空间`, `空间判定状态`, `空间判定依据`, `商品ID`, `SKU唯一键`, `采集状态`, and `待补数据项`. `适用空间` is a single-select field with only `小户型` and `常规卫生间`; `大户型` is intentionally excluded. `所属竞品` is a single bidirectional relation to `竞品主表`, with the reciprocal main-table field `SKU采集明细`. Schema preparation may add or repair only these approved empty-table fields and relation metadata; it must not create SKU records or alter existing main-table values.

The importer extracts one embedded image per source row and writes it as a real Bitable attachment. It never writes image URLs to `商品图片`. Apply these approved deterministic rules in priority order because `竞品分类` is a single formula result:

- `A`: monthly received count >= 80 and monthly received amount >= 200,000.
- `B`: explicit 人造石 evidence in the title and monthly received count >= 10.
- `C`: price >= 8,000. Do not use main-image, shape-special, or appearance inference.
- `D`: price < 1,000.
- If more than one condition matches, output only the highest-priority value in `A > B > C > D` order.

Normalize `PMMA`、`高分子`、`绮美石`、`可丽耐`、`杜邦石` and `亚克力人造石` to `人造石`; keep plain `亚克力` as `亚克力`. Keep all source records. `是否有效竞品` is the only analysis gate and is a deterministic Feishu formula; `排除原因` is also a formula. For valid competitors, blank AI fields are backfilled with `无注明`; for `否` and `待确认`, all seven AI fields are backfilled with `不适用`; existing non-empty AI values are preserved. Only `是` may populate calculated fields, attributes, data status, pending items, or competitor class. `待补数据项` checks monthly received count plus all seven AI fields, and treats `无注明`/`不适用` as missing evidence. A missing price produces blank price-band/monthly-amount formulas and `竞品分类=不适用`. The remaining seven fields use [references/competitor-v2-ai-prompts.md](references/competitor-v2-ai-prompts.md) when configuring the AI fields.

Run a dry-run first:

```powershell
node "D:\Retire\sycm-automation\skills\xws-to-feishu-base\scripts\import-competitor-v2.mjs" `
  --xlsx "C:\path\to\xiaowangshen.xlsx" `
  --base-url "https://tenant.feishu.cn/base/APP_TOKEN?table=TABLE_ID" `
  --work-dir "D:\Retire\sycm-automation\runtime\competitor-v2-dry-run" `
  --expected-rows ACTUAL_SOURCE_ROW_COUNT `
  --search-keyword "浴缸"
```

After the user authorizes the copy and gives the app `可编辑` access, run commit mode. The command is idempotent by source rank: after an interrupted run it verifies existing rows and imports only missing rows.

```powershell
node "D:\Retire\sycm-automation\skills\xws-to-feishu-base\scripts\import-competitor-v2.mjs" `
  --xlsx "C:\path\to\xiaowangshen.xlsx" `
  --base-url "https://tenant.feishu.cn/base/APP_TOKEN?table=TABLE_ID" `
  --env-file "C:\path\to\.env.local" `
  --work-dir "D:\Retire\sycm-automation\runtime\competitor-v2-live" `
  --expected-rows ACTUAL_SOURCE_ROW_COUNT `
  --search-keyword "浴缸" `
  --apply `
  --confirm-app-token "APP_TOKEN"
```

The verified 2026-08-18 run imported 1,333 rows and 1,333 attachments into an authorized test copy. The run receipt must report `mode: APPLIED_AND_VERIFIED`, equal `sourceRows`/`importedRows`, and equal `sourceImages`/`attachmentCount`. Feishu read-back may represent numeric values as strings and omitted values as `null`; the verifier treats those representations as equivalent without changing stored data.

### Migrate an existing authorized V2 copy

Use `migrate-competitor-v2-analysis.mjs` only for an explicitly authorized existing `竞品主表` that already contains the V2 fields. It converts the two analysis gates (`是否有效竞品`, `排除原因`) and seven deterministic outputs (`月收货人数计算值`, `计算口径`, `月收货金额`, `客单价带分类`, `竞品分类`, `待补数据项`, `数据状态`) to live Feishu formulas, adds only approved options when the live field is actually multi-select, and verifies every affected field after read-back. Validity uses explicit title evidence; category placement is preserved but not used because accessories can share the bathtub category path. Downstream formulas reuse the raw-title gate rather than depending on another formula field. Formula writes happen first and must settle in Feishu before any record write is planned. The only permitted record write is a batch update containing the seven AI fields, populated exclusively with blank-value sentinels derived from the settled Feishu `是否有效竞品` result: valid rows use `无注明`, while `否`/`待确认` rows use `不适用`; existing non-empty AI values are preserved. Formula fields, source fields, and other record fields are blocked by the mutation guard. The script never clicks or runs Feishu AI and reports `aiRunTriggered=false`.

Run dry-run first, then apply with both exact target confirmations. `--expected-rows` must be the current
validated XLSX row count for this run; it has no historical default:

```powershell
node "D:\Retire\sycm-automation\skills\xws-to-feishu-base\scripts\migrate-competitor-v2-analysis.mjs" `
  --base-url "https://tenant.feishu.cn/base/APP_TOKEN?table=TABLE_ID" `
  --expected-rows ACTUAL_CURRENT_TABLE_ROW_COUNT

node "D:\Retire\sycm-automation\skills\xws-to-feishu-base\scripts\migrate-competitor-v2-analysis.mjs" `
  --base-url "https://tenant.feishu.cn/base/APP_TOKEN?table=TABLE_ID" `
  --env-file "C:\path\to\.env.local" `
  --expected-rows ACTUAL_CURRENT_TABLE_ROW_COUNT `
  --apply `
  --confirm-app-token "APP_TOKEN" `
  --confirm-table-id "TABLE_ID"
```

Accept the migration only when `receipt.json` reports `mode: APPLIED_AND_VERIFIED`, `formulaRecordUpdates=0`, and a second dry-run reports zero formula, option, and AI-sentinel updates. A dry-run that reports local formula results as record updates is invalid and must not be applied.

## Maintenance cleanup

`cleanup-empty-xws-tables.mjs` is restricted to the six legacy XWS stability/round table names. It reads each table and refuses to delete any table with records, a duplicate name, or a name outside the allowlist. It does not target `数据表`, `竞品主表`, `SKU明细`, or `问题库`.

```powershell
node "D:\Retire\sycm-automation\skills\xws-to-feishu-base\scripts\cleanup-empty-xws-tables.mjs" `
  --base-url "https://tenant.feishu.cn/base/APP_TOKEN?table=TABLE_ID" `
  --env-file "C:\path\to\.env.local" `
  --confirm-app-token "APP_TOKEN" `
  --table-name "XWS API Stability Round 1" `
  --table-name "XWS API Stability Round 2" `
  --table-name "XWS API Stability Round 3" `
  --table-name "XWS Round 1 Price High Top 138" `
  --table-name "XWS Round 2 Price High Top 138" `
  --table-name "XWS Round 3 Price High Top 138"
```
