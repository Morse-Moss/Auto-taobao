---
name: sycm-export-search-rank
description: Export all pages of the logged-in 生意参谋 (sycm.taobao.com) 搜索排行 table for a verified seven-day reporting window to validated CSV and XLSX files through the web-access CDP browser session. Use for weekly or ad-hoc search-ranking exports, retained-session checks, pagination collection, and preparation of 排名、搜索词、搜索人气、点击率、支付转化率 data for Feishu import.
---

# 生意参谋搜索排行导出

Export the current search-ranking category with deterministic rank and workbook validation. Reuse the user's retained CDP browser session; never handle credentials or bypass platform controls.

## Required Skills

1. Load `web-access` before any browser or network action. Run its dependency check and show its risk notice.
2. Load `xlsx` before creating or validating the workbook.
3. Read [references/sycm-search-rank.md](references/sycm-search-rank.md) only when changing selectors, diagnosing page drift, or switching category behavior.

## Safety Gate

- Discover the current `targetId` from `/targets` on every run. Never persist it.
- Never read or export passwords, cookies, tokens, browser storage, password-manager data, or authentication headers.
- Stop with `HUMAN_REQUIRED` at login, QR/SMS/CAPTCHA verification, or any platform risk/security restriction. Do not dismiss, suppress, or bypass those controls.
- Keep the user's existing tab and browser open. Do not close Edge or the CDP Proxy.
- Operate at low frequency. Do not add stealth patches, fingerprint spoofing, random human-mimicry, or retry storms.

## Workflow

1. Run the web-access dependency check for the configured browser.
2. For the complete production/demo workflow, run the official exporter with `--from-home`. It reuses an existing `sycm.taobao.com` tab or creates a new allowlisted home tab when none exists, navigates to the fixed home URL, visibly clicks Market and Search Ranking, verifies category id `50002411` and visible category `普通浴缸`, explicitly selects `7天`, and verifies both the selected state and a seven-calendar-day displayed range before export:

```powershell
node "D:\Retire\sycm-automation\skills\sycm-export-search-rank\scripts\export-search-rank.mjs" --from-home --period 7d --date latest --cate-id 50002411 --category "普通浴缸"
```

`--date` is the end date of the seven-day window. The page can return to `日` when entered again, so never assume the previous period selection persisted.

After selecting `50` in the page-size control, wait for both the control to display `50` and the data table to contain at least 50 real rows. The control updates before the table finishes refilling; navigating immediately can skip ranks 11-50 and must be treated as an incomplete page, not as valid source data.

Do not assemble homepage navigation with ad-hoc PowerShell. The Node.js entry point is the only supported full workflow. Omit `--from-home` only when intentionally exporting from an already-open search-ranking page.

3. If the script returns `HUMAN_REQUIRED`, leave the browser unchanged, state the exact handoff, and continue only after the user resolves it.
4. Accept completion only when the script reports `period=7天`, `dayCount=7`, the expected end date, contiguous unique ranks `1..N`, unique non-empty search terms, non-empty metrics, page sizes, both output paths, and the verified pair's CSV/XLSX SHA-256 values.
5. Leave the page on search-ranking page 1 with `7天` still selected after collection.

Final CSV/XLSX files are published only after both temporary files pass validation. Existing output files are never overwritten.

`scripts/source-period-proof.mjs` and `scripts/verify-export-pair.py` re-open the published XLSX, read its `验证信息` sheet, require `dateType=recent7`, compare all five CSV/XLSX fields row by row, and return both hashes. Reuse an old export only when this pair verification passes for the requested end date; a CSV filename alone is not period evidence.

Use `--output-dir`, `--prefix`, `--delay-ms`, or `--max-pages` only when the task requires them. Run `--help` for the exact CLI contract. Use `--self-test` for a network-free validation of the rank checks.

## Data Contract

- Read the displayed rank from each row. Never calculate rank from page number or DOM row position.
- Resolve ranks 1-3 only from the verified rank-icon assets; fail closed if those assets drift.
- Sort the final dataset by the extracted rank because DOM order can differ from rank order.
- Preserve displayed ranges and `-` values verbatim; do not invent exact values behind masked metrics.
- Export exactly: `排名`, `搜索词`, `搜索人气`, `点击率`, `支付转化率`.
- Record `period`, `startDate`, `endDate`, `dayCount`, and `dateRange` in the export receipt and XLSX validation sheet.
- Treat the paired XLSX validation sheet and exact CSV/XLSX equality as the reusable source proof. Reject a missing or mismatched companion file.

## Session Evidence

Treat a successful rerun as evidence that the session survived until that run. Do not claim that it will remain logged in for a week or for any fixed duration. A future weekly run must recheck the content and hand off login if needed.
