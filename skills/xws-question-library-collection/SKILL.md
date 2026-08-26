---
name: xws-question-library-collection
description: "Compatibility entry point for the FAQ raw collection workflow; use xws-faq-raw-collection for new runs."
metadata:
  version: "1.2.0"
---

# 小旺神问题库原始数据采集

New runs should use `xws-faq-raw-collection` (version 1.2.0), which defines the business boundary and the raw ZIP
evidence contract. This skill remains only as a compatibility entry point for existing callers.

Use this skill when the user asks for the next weekly question-library collection from the latest valid
`竞品周_YYYY-MM-DD_YYYY-MM-DD` table.

## Fixed business rule

1. Read the newest valid weekly competitor table, not `竞品主表` historical values.
2. Keep rows where `是否有效竞品=是` and `竞品分类` is `A-爆款竞品` or `B-高价值竞品`.
3. Sort by the live Feishu formula field `月收货人数计算值` descending, then weekly `序号` ascending.
4. Require exactly five products. Use their real `商品链接`; never infer a URL from a title.

The current verified Feishu target is Base `OWebbPUcBa7B8JseYLccQCy9nkf`. The raw weekly source must be resolved by
exact dated table name before any write. After analysis, the fixed `问题库` table is populated as the operator-facing
mirror through `runtime/sync-question-library-template.mjs`; it is not a second raw source.

## Browser collection

Use the shared web-access CDP connection and one product at a time. Before each product, verify the page ID,
product URL, plugin toolbar, and trial status. Stop and write an operator alert for login, CAPTCHA, account risk,
missing plugin, quota exhaustion, failed export, or product identity mismatch. Never buy membership or bypass a
security control.

For each selected product:

- Open `问大家`, export all rows with `导出 CSV 表格` and save as `<evidence-root>/<商品ID>/qa.csv`.
- Open `评价`, choose all content, all dates, no specified SKU, and no `大家印象` filter; use `评价下载` and save
  the complete raw ZIP as `<evidence-root>/<商品ID>/reviews-source.zip`, then normalize it with the new Skill script.
- Do not click `评价分析` in this version. Frequency and semantic analysis is a later stage.
- Store a sanitized product receipt containing product ID, source record IDs, source hashes, timestamps, and quota
  observations. Raw exports remain local evidence and are never committed.

## Feishu snapshot

Create or reuse exactly `问题库_YYYY-MM-DD_YYYY-MM-DD` as the raw source table. The fixed `问题库` table is populated
only by the post-analysis mirror step and retains its existing operator header.

Write one row per raw source row:

- `来源类型=问大家`: preserve one question and answer pair in `原始内容`.
- `来源类型=评论`: preserve one review's raw content.
- Leave `高频问题或关键词` and `出现次数` blank; set `采集状态=已采集` only after raw content is present.
- Use `来源记录唯一键=周期|商品ID|来源类型|源文件SHA-256|导出行号` for idempotency.
- Preserve `主表记录ID` and `竞品周记录ID` as stable text IDs; do not add a new weekly bidirectional relation.

## Guarded commands

First lock the live top-five selection without writing:

```powershell
node "D:\Retire\sycm-automation\runtime\run-question-library-collection.mjs" `
  --base-url "https://<tenant>.feishu.cn/base/<app-token>" `
  --period-start <YYYY-MM-DD> --period-end <YYYY-MM-DD> `
  --output-dir "D:\path\to\evidence\<period>"
```

After all ten raw exports (five `qa.csv` and five `reviews.csv`) exist and product receipts match, apply with the
same period and explicit confirmation:

```powershell
node "D:\Retire\sycm-automation\runtime\run-question-library-collection.mjs" `
  --base-url "https://<tenant>.feishu.cn/base/<app-token>" `
  --period-start <YYYY-MM-DD> --period-end <YYYY-MM-DD> `
  --evidence-root "D:\path\to\evidence\<period>" `
  --output-dir "D:\path\to\evidence\<period>" `
  --confirm-app-token <app-token> --apply
```

The apply path must read the source tables again, refuse a changed top-five selection, create records in batches of
at most 500, and read back every `来源记录唯一键` and non-empty `原始内容`. A repeated apply against the same
evidence must report `toCreate=0` and must not overwrite existing raw data.
