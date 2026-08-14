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
