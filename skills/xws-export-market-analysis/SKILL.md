---
name: xws-export-market-analysis
description: Run Xiaowangshen (小旺神) Taobao market-analysis competitor exports from the logged-in Taobao home page, configure search/channel/sort/page/price/frequency settings, monitor slow collection with bounded progress checks, and validate the resulting CSV/XLSX files. Use for requests to collect competitor product data, price/sales/ranking tables, or repeat the Xiaowangshen export workflow. Do not use this skill to modify Feishu bases; hand a validated artifact to xws-to-feishu-base instead.
metadata:
  version: "2.1.0"
---

# 小旺神市场分析导出

Version: `2.1.0`

Use the bundled runner to start at Taobao home, search the requested keyword, open Xiaowangshen market analysis, configure the requested contract, wait for the plugin's own collection to finish, export files, and validate them. Keep the browser session and the shared Proxy under the user's control.

## Data Fidelity and Batch Identity

- Treat the plugin's displayed and exported values as source data. Preserve `月收货人数` or `付款人数` exactly, including uniform values such as `1`, `0`, `-`, and `100+`. Never infer, smooth, reject, or replace a value because it looks unusual; plausibility observations are report-only and never justify a local rewrite.
- Structural validation is still mandatory: row count, contiguous ranks, unique product links, field order, CSV/XLSX equality, and image integrity when images are requested. A business-looking anomaly must not be converted into a validation failure.
- A clean latest full-range run starts from a new adaptive checkpoint and requests `1-END`. Do not seed that run with historical or legacy segmented records. If a stalled run resumes from `completedEnd + 1`, preserve every part's source timestamp and label a merge that combines different collection times as `mixed_snapshot`; it must not be presented as a same-time snapshot.
- The live result dialog and the downloaded CSV are the authority for rows and fields. Filenames may be stale or misleading; retain the filename warning and do not change the data to match it.

## Image and Export Boundaries

- CSV is the canonical row/field artifact. XLSX with images is a media variant and must be checked separately.
- If Xiaowangshen itself omits one or more embedded images, preserve the original download and report the missing product links. Do not synthesize images, visit product detail pages to repair a market-analysis export, or claim that the image-complete XLSX contract passed.
- A partial-media XLSX does not invalidate the CSV collection, but it is not eligible for an image-required Feishu import until the image contract is satisfied.

## Observed Runtime Rules

- `开始分析` may need one bounded retry when the result dialog does not open; after the visible result dialog appears, continue with the same run rather than launching a duplicate collection.
- A diagnostic request with HTTP `200` or a successful `*_FINISH` message is a completed request signal. `NO_REQUEST_SIGNAL` is reserved for a snapshot with no completed or pending request evidence; page progress and the stall threshold remain the completion authority.
- Export downloads can be slow. Keep one supervised process and wait for a new, stable file; do not create parallel export clicks or retry storms.
- Login, CAPTCHA/slider, security, quota, or account-risk controls remain hard stops. Do not use detail-page browsing as a workaround for a missing image or field.

## Required Skills and Dependencies

1. Load `web-access` before any browser or network action. Use its dependency check and risk notice.
2. Load `xlsx` before validating CSV/XLSX artifacts.
3. Use the shared Proxy at `http://127.0.0.1:3456` and the user's logged-in Edge session. Do not open a second browser-level CDP WebSocket.
4. Run from `D:\Retire\sycm-automation`; do not write to `E:\Revolution`.
5. Adaptive runs require PostgreSQL through `XWS_DATABASE_URL`. Keep the connection string and database credentials outside the project; never copy them into source files, checkpoints, manifests, logs, or artifacts.

## PostgreSQL Runtime Contract

- PostgreSQL is authoritative for adaptive run identity, collection contract, progress, part metadata, final manifest metadata, and orchestration ownership. Local checkpoint JSON and lock files are not authoritative and must not be used for new adaptive runs.
- Use a session-scoped PostgreSQL advisory lock keyed by the complete adaptive run identity. One dedicated connection must hold that lock from the initial fresh/resume decision through child execution, artifact validation, state commits, merge validation, and final state commit. Closing the connection or terminating the process releases ownership.
- A fresh run creates a unique immutable run identity and must fail if that identity already exists. Resume must name an existing run and match its complete collection contract: keyword, requested pages, channel, sort, price, frequency, export modes, output directory, trial authorization, and stall policy.
- Persist checkpoint, part, and manifest changes transactionally. Progress may advance only after the corresponding local artifact exists and its range, validation result, size, and SHA-256 have been verified. `completedEnd` is monotonic and must never move backward under concurrent or repeated writes.
- CSV/XLSX files remain immutable local artifacts. PostgreSQL stores their paths, hashes, sizes, ranges, validation metadata, and source timestamps; do not store image binaries or other large media in PostgreSQL.
- Before merge, independently re-read and hash every recorded artifact and verify contiguous page coverage. Do not trust database metadata alone. Publish final metadata only after the merged artifact passes the normal output contract.
- The adaptive wrapper owns the full-lifecycle advisory lock. Child exporters launched by that wrapper must not compete for the same lock again.

## Safety Gate

- Discover fresh targets from `/targets` before every browser action. Never persist or reuse a target ID after navigation, reload, or a wait.
- Never read passwords, cookies, tokens, browser storage, password-manager data, or authentication headers.
- Stop immediately with `HUMAN_REQUIRED` when login, CAPTCHA/slider, QR or SMS verification, account risk, security, permission, or access-control text appears. Leave the page unchanged and report the exact handoff.
- Click the visible free-trial action only when the user has explicitly authorized it and the command includes `--allow-trial`. The runner permits one bounded DOM fallback if the first visible click is intercepted; it never loops or bypasses a control.
- Keep Edge and the Proxy running. Do not close tabs, dismiss security prompts, add stealth/fingerprint changes, or create retry storms.
- Preserve the displayed ranges and `-` values exactly. Never infer hidden exact numbers.
- This skill exports files only. Do not open, clone, paste into, or edit a Feishu table in this workflow.

## Quick Start

Use `--prepare-only` to configure the plugin and stop at the recording/approval checkpoint without consuming a collection run:

```powershell
node "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\export-market-analysis.mjs" `
  --keyword "浴缸" --prepare-only
```

After the user has authorized trial use (when prompted), run the bounded export:

```powershell
node "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\export-market-analysis.mjs" `
  --keyword "浴缸" --channel all --sort sales --pages 1-40 `
  --price 0-unlimited --frequency 10-15 --export csv,xlsx-images `
  --allow-trial --output-dir "C:\Users\Administrator\Downloads"
```

`--output-dir` tells the runner which directory to scan for a new download; it does not change Edge's download preference. Set it to the actual Edge download directory. CSV is mandatory whenever XLSX is requested so cross-format fields can be compared.

Run network-free checks with:

```powershell
node "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\export-market-analysis.mjs" --self-test
py -3 "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\validate-output.py" --self-test
```

For a full 1-40 collection, use the adaptive runner. It starts one `1-40` task, records each verified progress
boundary, and when the plugin stalls it automatically starts only the remaining tail (`33-40`, then `36-40`,
for example). It has no fixed total runtime limit: `--stall-seconds` is only the continuous no-progress threshold.
Every stalled run must first produce a validated partial CSV; otherwise the cursor does not advance. Completed
parts are merged by product link and re-ranked before a final CSV/XLSX is published.

```powershell
node "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\run-adaptive-export.mjs" `
  --keyword "浴缸" --pages 1-40 --frequency 30-45 --stall-seconds 300 `
  --channel all --sort sales --price 0-unlimited --export csv,xlsx-images `
  --checkpoint "D:\Retire\sycm-automation\runtime\xws-bathtub-adaptive-20260903-checkpoint.json" `
  --output-dir "C:\Users\Administrator\Downloads" --allow-trial
```

A command without `--resume` is always a new adaptive task. Give it a new checkpoint path; it refuses to overwrite an existing checkpoint and starts at the requested first page. To continue a prior task, explicitly provide both `--resume` and `--checkpoint FILE`; the runner then starts from the verified `completedEnd + 1` after validating the collection contract.
It never treats a no-progress stall, login wall, CAPTCHA, or security prompt as permission to skip pages.

The older segmented runner remains available for compatibility with historical checkpoints. It writes one
checkpoint JSON and keeps completed segment artifacts, but it is not the default strategy for new full-range runs.

```powershell
node "D:\Retire\sycm-automation\skills\xws-export-market-analysis\scripts\run-segmented-export.mjs" `
  --keyword "浴缸" --pages 1-40 --segment-size 8 --frequency 30-45 `
  --channel all --sort sales --price 0-unlimited --export csv,xlsx-images `
  --checkpoint "D:\Retire\sycm-automation\runtime\xws-bathtub-checkpoint.json" `
  --output-dir "C:\Users\Administrator\Downloads" --allow-trial
```

The segmented runner records `RUNNING`, `DONE`, `STALLED`, `HUMAN_REQUIRED`, or `FAILED` per page segment.
When a segment stops, resolve the recorded issue and run the same command again to continue from that segment.
It does not bypass login, CAPTCHA, slider, or security controls.

## Workflow Contract

Follow this order; the runner owns the polling loop so the model does not wait page by page:

1. Create or discover a Taobao home tab and verify the logged-in state.
2. Set the search box and visibly submit the keyword. Rediscover the resulting `s.taobao.com/search?q=...` target.
3. Wait for the visible Xiaowangshen toolbar, open `市场分析`, and require a visible permission or configuration dialog before treating the click as successful. One bounded retry is allowed when the first click opens no dialog.
4. If permission is required, stop for authorization unless `--allow-trial` was explicitly supplied. Confirm the dialog changes to the configuration form.
5. Configure keyword, channel, sort, page range, price range, and frequency. Verify the live dialog values before starting.
6. With `--prepare-only`, write a `READY_FOR_RECORDING` manifest and stop here.
7. Otherwise mark and click `开始分析`. Record `COLLECTION_STARTED` only after the visible result dialog contains `商品数量`; retry once only when the configuration dialog remains visible, then poll until the requested final page is reported as complete.
8. Export CSV and the requested XLSX variant. After opening the XLSX dropdown, wait up to 5 seconds for the requested menu item to mount. Accept only files newer than the action and stable in size.
9. Run `validate-output.py`; publish `DONE` only when the live row count equals the validated file row count.

## State and Monitoring

The event log (`events.jsonl`) and manifest use these states/events:

`START` -> `HOME_READY` -> `SEARCH_READY` -> `PLUGIN_READY` -> `MARKET_ANALYSIS_OPEN` -> `TRIAL_READY` (if needed) -> `CONFIGURED` -> `COLLECTION_STARTED` -> `PROGRESS`/`COLLECTING` -> `COMPLETE` -> `EXPORT_STARTED` -> `DONE`.

`MARKET_ANALYSIS_RETRY` and `COLLECTION_START_RETRY` may appear once when the corresponding first click has no verified postcondition. They are bounded recovery events, not collection retries.

Risk markers transition to `HUMAN_REQUIRED`. A collection with no changed completed-page, row-count, or completion signature for the stall threshold transitions to `STALLED` and records a best-effort screenshot. Both are terminal for that run; do not silently retry.

Defaults for a single run are an 8-second progress poll and a 120-second continuous no-progress threshold. The
adaptive runner uses a conservative 300-second stall threshold and deliberately has no overall wall-clock cutoff.
A slow Xiaowangshen response is supervised by one process, not by repeated browser clicks. Its checkpoint stores
the requested range, each attempted tail, verified page progress, diagnostics, and validated partial artifacts.

## Output Contract

Require exactly these 16 columns, in this order. The sixth column may be either `月收货人数` (the older export label) or `付款人数` (an observed current export label); preserve whichever source label is present and require CSV/XLSX to match it:

`序号`, `商品图片`, `商品标题`, `商品链接`, `价格`, `月收货人数|付款人数`, `类目`, `同款数`, `平台`, `占位类型`, `店铺名`, `店铺旺旺`, `店铺类型`, `地址`, `收藏人数`, `卖点`.

Accept only when validation reports:

- rank `1..N` is contiguous and unique;
- product links are present and unique;
- CSV/XLSX headers match the contract;
- XLSX ZIP CRC is valid and every embedded image decodes when `xlsx-images` is requested;
- non-image fields match between CSV and XLSX exactly;
- the validated row count equals the live collection row count.

The runner writes a per-run `runtime/xws-runs/<run-id>/events.jsonl` and `manifest.json`. Treat the visible result title as the source of truth for sort and keyword. Plugin filenames can be stale or misleading (for example, a file may say `价格从高到低` while the live result says `销量排序`); keep the file, record the warning, and never change data to fit a filename.

## Failure Handling and Handoff

- `HUMAN_REQUIRED`: stop browser actions and name the page/control the user must resolve. Resume only after the user confirms it is cleared.
- `STALLED`: preserve the run directory, screenshot, diagnostics, and validated partial artifact. The adaptive runner resumes from the next verified page; if no validated partial CSV exists, it stops without advancing the cursor.
- Missing target, toolbar, dialog, export button, or download: fail the run with its evidence; rediscover once at the next explicitly bounded step, never indefinitely.
- Validation failure: do not pass the file to Feishu. Keep the artifacts for diagnosis and report the first failing contract.

For the next stage, pass the validated XLSX path and manifest to `$xws-to-feishu-base`; that skill owns embedded-image extraction, Feishu media upload, attachment-field writes, and copy-only Feishu acceptance.
