---
name: huitun-to-feishu-keyword-heat
description: Collect exact-name topic view counts from 灰豚数据红薯版 for the live Feishu A候选 keyword queue, preserve displayed evidence, classify content heat at the confirmed 1000w threshold, and optionally perform a guarded two-field Feishu backfill with formula settlement and integrity verification. Use when a keyword-analysis table needs the next A候选 batch checked in Huitun/Xiaohongshu topic search, or when a previously collected Huitun result JSON must be dry-run validated or safely applied. Do not use for broad Huitun crawling, approximate topic aggregation, or editing unrelated Feishu fields.
---

# 灰豚小红书话题热度回填

Use this skill for the bounded follow-up stage after search and transaction heat have produced a Feishu `A候选` queue. The bundled runner reads the live queue, opens the user's logged-in Edge session through the shared web-access Proxy, searches each keyword in 灰豚红薯版的“话题搜索”, keeps only a completely同名话题, and prepares a local evidence manifest. It writes Feishu only when `--apply` and the exact `--confirm-table` are both present.

## Required setup

1. Load `web-access` before any browser or network action. Run its dependency check for Edge and use the shared Proxy at `http://127.0.0.1:3456`; do not open another browser-level CDP WebSocket.
2. Use the existing Feishu app credential file through `--env-file`. The file must define `FEISHU_APP_ID` and `FEISHU_APP_SECRET`; never print, copy, or inspect credential values beyond authentication.
3. Start with an authorized Feishu copy/table. The defaults target `关键词分析 V1（修正版）` (`tblN1uT1LpzyqqWx`) only because that is the currently verified table; pass all target options when using another authorized table.

Before browser actions, show the web-access risk notice. Rediscover the labeled target from `/targets` before every `eval`, click, screenshot, navigation, or close action. The runner labels its own tab with the run ID and leaves it open when a human handoff or stall occurs.

## Quick start

Read-only collection and dry-run (recommended first):

```powershell
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs"
```

The command writes `results.json`, `events.jsonl`, and `manifest.json` under `runtime/huitun-runs/<run-id>/`. It does not mutate Feishu. Review the dry-run summary before applying:

```powershell
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" `
  --apply --confirm-table tblN1uT1LpzyqqWx
```

To resume from a result file after a browser interruption, use `--results <path>`; the runner still re-reads the live queue and refuses a stale or incomplete result set.
Reused results must be no older than 24 hours by default; adjust the bounded policy explicitly with `--result-max-age-hours N` when a longer handoff is genuinely required.

## Workflow contract

1. Authenticate to Feishu and verify the exact table name, field definitions, and complete record count. Read every record whose `优先级` is exactly `A候选`; fail if any such record has an empty `搜索词`, then require uniqueness. Refuse a queue larger than `--max-candidates` unless the user explicitly raises the bound. Create a queue fingerprint from the table identity and `(record_id, 搜索词)` pairs; do not persist the app token itself.
2. Unless `--results` is supplied, open `https://dy.huitun.com/app/#/dashboard` in a labeled tab, select the visible `logo_xhs` platform option, and wait for `https://xhs.huitun.com`. Open the visible `话题搜索` menu item and verify the keyword input before querying.
3. For each candidate, set `请输入话题关键词`, capture the pre-submit result signature and loading state, and click the visible search button once. Poll at a bounded interval. Accept a result only after the submitted query is unchanged, a post-submit loading/result transition has been observed (a spinner that already existed before the click does not count), no visible spinner remains, and the DOM result signature is stable twice. A stalled query is terminal for the run; preserve its screenshot.
4. Normalize only the leading/trailing `#` characters for matching. `#家用浴缸#` matches `家用浴缸`; `#成人家用浴缸#`, `#浴缸家用#`, and other near matches do not. Never add or sum similar topics. Preserve the source display value such as `109.4w`, `1,314`, or `-` in the result evidence; numeric conversion is used only for the threshold and Feishu numeric field.
5. Apply the confirmed first-version rule: `灰豚话题浏览量 >= 10,000,000` means `内容热度（后续）=高`; otherwise it is `低`. A no-exact-topic result is explicitly recorded with view count `0`, so it cannot remain in the queue forever.
6. Build a dry-run plan and compare its keyword set and queue fingerprint with the freshly re-read live `A候选` queue. Reused result files must carry the exact 灰豚红薯版/话题搜索 provenance and a valid `collected_at`; reject missing, wrong-source, future, or expired evidence. On `--apply`, write only `内容热度（后续）` and `灰豚话题浏览量` for blank fields, after creating a local pre-write backup. Existing non-empty values that differ are never overwritten.
7. Poll Feishu until the formula `优先级` settles (`A-立即跟进` at or above the threshold, otherwise `B-持续观察`). Verify field definitions (ignoring JSON key order only), row count, every unrelated record field including `是否重点词`, both written values, and the explicitly expected `优先级` formula result before reporting `APPLIED_AND_VERIFIED`.

## Safety and handoff

- Never read passwords, cookies, tokens, browser storage, or authentication headers. The runner only reads visible page text and table data needed for the contract.
- On a visible login wall, QR/SMS prompt, CAPTCHA/slider, account-risk/security/permission control, stop with `HUMAN_REQUIRED` and name the stage. `allowLogin` only permits the passive `登录/注册` link on the official platform-selection page; it never suppresses QR, SMS, or `请登录` challenges. Do not click through, dismiss, or bypass the control. The selected red-book page must show a confirmed account or the run stops.
- Do not purchase, start a trial, change subscription, edit formulas, change field definitions, create records, or touch the original Feishu template in this skill.
- `--apply` is an external data write. Require the user's current authorization and the exact table ID confirmation. If the queue changes during collection, abort instead of guessing.
- Keep the displayed ranges and `-` values verbatim. A missing exact topic is not permission to infer a number.

## Evidence states

The manifest status is one of:

`DONE_NO_CANDIDATES` -> no live `A候选` rows; no browser work is needed.

`DRY_RUN_READY` -> results and a complete, write-scoped plan are saved locally; Feishu is unchanged.

`APPLIED_AND_VERIFIED` -> the two-field write, formula settlement, backup hash, and integrity checks all passed.

`HUMAN_REQUIRED` -> user action is required; leave the labeled browser tab and evidence intact.

`STALLED` -> the bounded query deadline or progress condition was exceeded; preserve the screenshot and do not silently retry.

For the verified DOM selectors and observed table shape, read [page-contract.md](references/page-contract.md).

## Offline checks

```powershell
node --test "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\tests\*.test.mjs"
node "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat\scripts\run-huitun-topic-heat.mjs" --self-test
py -3 "D:\codex\skills\.system\skill-creator\scripts\quick_validate.py" "D:\Retire\sycm-automation\skills\huitun-to-feishu-keyword-heat"
```
