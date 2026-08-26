---
name: xws-faq-raw-collection
description: "Collect a reproducible weekly FAQ source snapshot from qualifying Taobao competitors: raw 问大家, raw 评论, per-product evidence, and a dated Feishu question table. Do not use for market-analysis or SKU collection."
metadata:
  version: "1.2.0"
---

# 小旺神 FAQ 原始采集

This is a separate business workflow from competitor market-analysis exports and SKU collection. Its output is
an immutable, traceable source corpus for later FAQ analysis. It must not summarize, classify, count, or generate
FAQ conclusions during collection.

## Source selection

1. Resolve the newest valid `竞品周_YYYY-MM-DD_YYYY-MM-DD` table in Feishu. Do not use old values from `竞品主表`.
2. Keep only `是否有效竞品=是` and `竞品分类` in `A-爆款竞品`, `B-高价值竞品`.
3. Sort the live formula field `月收货人数计算值` descending, then weekly `序号` ascending. Require exactly five.
4. Lock product ID, main record ID, weekly record ID, real product URL, title, class, monthly value, and weekly rank in
   `top5-manifest.json` before opening any product page.

## Browser collection

Use the shared web-access CDP connection and one product at a time. Rediscover the target after every navigation.
Before each source action verify the product ID in the URL, page title, plugin toolbar, login state, and free-trial
quota. Never buy membership or bypass login, CAPTCHA, risk, or account verification.

For each locked product:

- `问大家`: open the tool, export all rows with `导出 CSV 表格`, and preserve the downloaded file as `qa.csv`.
- `评价`: select all content, all dates, no SKU, and no `大家印象`; use `评价下载`, never `评价分析`.
- Xiaowangshen normally emits a ZIP containing review TXT files plus optional media attachments. Preserve the full
  archive as `reviews-source.zip`; create `reviews.csv` from `.txt` entries only as a lossless row-oriented parsing
  artifact. JPG/MP4 attachments remain in the source archive but are never treated as comment text.
- Verify download landing, stable non-zero size, readable ZIP/CSV, and SHA-256 before marking a source complete.

An empty `问大家` export is valid only when the page explicitly reports no data. The product still needs at least
one non-empty raw source. A page showing `100%` without a landed file is `BLOCKED_EXPORT_NOT_LANDED`, not success.

## Evidence contract

Directory: `runtime/question-library-collection/<start>_<end>/<商品ID>/`

- `qa.csv` and `qa-receipt.json`
- `reviews-source.zip`, `reviews.csv`, and `reviews-receipt.json`
- `run-status.json`; `alert.json` for any stop or recovered barrier

Receipts must include product identity, source type, raw source filename, normalized filename when present, raw
source SHA-256, normalized SHA-256, download time, row/file counts, selected scope, and quota observations.
The source record key is:

`周期|商品ID|来源类型|原始源文件SHA-256|导出行号`

Never use a locally rewritten analysis result as evidence. Preserve completed products when a later product fails.
Resume the failed source/product only after its recorded alert is resolved; do not skip it or switch to a different
product to hide the failure.

The manifest is immutable for a run directory. If `top5-manifest.json` already exists, compare every locked field
and stop on any difference; never replace it with a newly calculated TOP5. A changed weekly source requires a new
period/output directory. Each product directory also appends operational events to `events.jsonl` with `at`,
`productId`, `event`, and relevant source/progress/quota fields. Use `scripts/append-faq-event.mjs` for consistent
JSONL writes.

For review normalization, use PowerShell Core (`pwsh`) with `scripts/normalize-xws-reviews.ps1`. It requires a valid ZIP,
streams the archive and normalized CSV to avoid loading large media bundles into memory, sorts `.txt` entries by path,
decodes UTF-8 strictly then GB18030, writes one lossless TXT entry per CSV row with proper CSV escaping, and records
raw and normalized hashes plus excluded media-entry count. The ZIP remains the only source hash used for idempotency.
Do not hand-edit `reviews.csv`.

## Feishu snapshot

After all five products have complete evidence, create or reuse exactly `问题库_<开始日期>_<结束日期>` as the
immutable raw source table. Use the Bitable Open API, not Feishu DOM, for writes and read-back.

Write one row per raw source row with these fields:

`商品ID`, `主表记录ID`, `竞品周记录ID`, `商品链接`, `商品标题`, `竞品分类`, `来源类型`, `原始内容`,
`高频问题或关键词`, `出现次数`, `采集状态`, `来源记录唯一键`, `采集时间`

`来源类型` is `问大家` or `评论`; analysis fields remain blank; `采集状态=已采集` only for non-empty raw content.
The write is guarded until every selected product has both source receipts, except an explicitly verified empty
问大家 source. Batch at most 500 records, read back keys and raw content, and rerun against the same evidence to
prove `toCreate=0`.

## Operational commands

Use `runtime/run-question-library-collection.mjs` to lock the live TOP5 first. Use `--apply` only after evidence
validation passes and the exact Base app token is confirmed. The runner must prefer `reviews-source.zip` for the
source hash while parsing rows from `reviews.csv`. It validates receipt identity, source filenames, hashes, review
scope, zero analysis calls, and explicit empty-QA status before any apply. A source download gets at most one
bounded retry after reopening the product page; repeated failure writes an alert and stops that product.

## Hard stops and success

Stop the current product and write an alert for login, CAPTCHA, risk, quota exhaustion, missing toolbar, identity
mismatch, export failure, or missing download. Do not fabricate rows, infer URLs, or silently retry indefinitely.

Success requires: five locked products, each source traceable to its product and raw file, no analysis values written,
Feishu read-back complete, and a repeated apply reporting `toCreate=0`. During optimization or evidence repair,
never run `--apply`; finish offline validation first.

## Operator mirror

The fixed `问题库` table is the operator-facing mirror and uses its existing eight-field header. After the dated raw
table is analyzed, run `runtime/sync-question-library-template.mjs` with the same period. It copies the raw text,
classified topic, and the occurrence count read back from the Feishu formula summary into the fixed table. It must
stop when the fixed table is non-empty but differs from the selected period; it must never silently append duplicates
or overwrite another period. A repeated sync against the same period must report an exact match and `toCreate=0`.
