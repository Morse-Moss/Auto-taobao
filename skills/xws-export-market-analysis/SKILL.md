---
name: xws-export-market-analysis
description: Run Xiaowangshen (小旺神) Taobao market-analysis competitor exports from the logged-in Taobao home page, configure search/channel/sort/page/price/frequency settings, monitor slow collection with bounded progress checks, and validate the resulting CSV/XLSX files. Use for requests to collect competitor product data, price/sales/ranking tables, or repeat the Xiaowangshen export workflow. Do not use this skill to modify Feishu bases; hand a validated artifact to xws-to-feishu-base instead.
---

# 小旺神市场分析导出

Use the bundled runner to start at Taobao home, search the requested keyword, open Xiaowangshen market analysis, configure the requested contract, wait for the plugin's own collection to finish, export files, and validate them. Keep the browser session and the shared Proxy under the user's control.

## Required Skills and Dependencies

1. Load `web-access` before any browser or network action. Use its dependency check and risk notice.
2. Load `xlsx` before validating CSV/XLSX artifacts.
3. Use the shared Proxy at `http://127.0.0.1:3456` and the user's logged-in Edge session. Do not open a second browser-level CDP WebSocket.
4. Run from `D:\Retire\sycm-automation`; do not write to `E:\Revolution`.

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

Defaults are an 8-second progress poll, a 120-second no-progress threshold, and a bounded deadline of `pages * (max_frequency + 15 seconds) + 500 seconds`. Use `--poll-seconds` or `--stall-seconds` only when the task requires it; the parser enforces minimums. A slow Xiaowangshen response is expected and is supervised by one process, not by repeated browser clicks.

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
- `STALLED`: preserve the run directory and screenshot, report the last observed page/row count, and inspect the plugin manually before deciding whether to start a new run.
- Missing target, toolbar, dialog, export button, or download: fail the run with its evidence; rediscover once at the next explicitly bounded step, never indefinitely.
- Validation failure: do not pass the file to Feishu. Keep the artifacts for diagnosis and report the first failing contract.

For the next stage, pass the validated XLSX path and manifest to `$xws-to-feishu-base`; that skill owns embedded-image extraction, Feishu media upload, attachment-field writes, and copy-only Feishu acceptance.
