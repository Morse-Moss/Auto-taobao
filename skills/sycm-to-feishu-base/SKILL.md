---
name: sycm-to-feishu-base
description: Export logged-in 生意参谋 search rankings and import them into a cloned Feishu bitable while preserving fields, formulas, views, filters, sorting, grouping, dashboards, and AI classification fields. Use for weekly or ad-hoc workflows such as “普通浴缸词库导入飞书”, “生意参谋到飞书”, or replacing a cloned Feishu base with fresh ranking data.
---

# 生意参谋到飞书多维表

Use this skill for the bounded workflow: collect the current 生意参谋搜索排行 dataset, create a structure-preserving copy of a user-authorized Feishu bitable template, paste the source five columns into the existing first table, and verify the result.

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
- `tests/` contains offline regression checks for the TSV contract, field mapping, and shared Proxy paste contract.

### 1. Export

Run the existing exporter with its supported `--from-home` workflow when starting from the 生意参谋 home page. Keep the page on search-ranking page 1 after collection. Accept the export only after its CSV/XLSX validation reports contiguous ranks, unique terms, non-empty metrics, and both output paths.

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

## Failure Handling

- `HUMAN_REQUIRED`: leave the browser unchanged and report the exact user handoff.
- Missing or sleeping tab: rediscover `/targets`; open a new allowlisted tab only when needed. Never reuse a stale target ID.
- Copy not editable: stop; do not attempt to alter the external template.
- Wrong-cell paste: cancel before commit, then retry with real clipboard/keyboard input.
- Count mismatch or non-contiguous ranks: stop, do not publish or claim completion; preserve the copy for diagnosis.

## Final Report

Report the new Feishu URL, source file paths, source row count, imported row count, first/last rank evidence, and whether formula/AI fields and dashboards were observed. Separate verified facts from pending AI processing or unverified session longevity.
