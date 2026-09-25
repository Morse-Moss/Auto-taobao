# 生意参谋自动化项目

## Scope

- `skills/` contains the project-owned SYCM export and Feishu import skills.
- `evidence/` contains validation outputs and run evidence; do not treat it as live input.
- `runtime/` contains project-local notes or future launch wrappers.
- The logged-in Edge profile, credentials, and cookies remain outside this project.
- The active Feishu credential file is resolved from `runtime/feishu-targets.mjs` (currently the kcne tenant: `E:/小红书/.env.feishu-kcne.local`); pass its path to import commands and never copy its values into this project. Never hardcode tenant app tokens or base/table ids — read them from that single source of truth.
- Read `docs/ops/LESSONS-2026-09-14_15.md` before changing a state machine, a release path, or collection semantics: it lists the failures that have already cost time here.

## Operating Rules

- Xiaowangshen browser work uses the project's debug Edge on port `9222` (`--user-data-dir=D:\Retire\edge-debug-profile`, which has the 小旺神 extension) plus CDP proxy `3457`; exports pass `XWS_PROXY=http://127.0.0.1:3457` and `XWS_BROWSER_ID=edge-isolated`. The SYCM/Alimama daily-report workflow uses its separate merchant Edge on `19022` (`D:\Retire\edge-daily-report-profile`) plus proxy `19023` and browser id `edge-daily-report`. All four values live in `runtime/browser-ports.mjs` — read them from there, never hardcode a second copy. Do not use the shared proxy on `3456` (another project's), and treat `9223`/`3458` as other projects' ports since 2026-09-16. No production file may point at another project's proxy: `runtime/browser-ports.mjs` exports the registry plus a test that fails on any `http(s)://<host>:3456` literal in shipped code or a `SKILL.md` (comments explaining the ban are allowed, and the allowlist is empty on purpose).
- The two chains must never share one browser instance: SYCM/Alimama/Feishu need the merchant account, while the 小旺神 extension only works on the buyer account. Getting this wrong fails silently — clicks and navigation succeed on the other account's browser.
- Route ownership is a table, not a habit — `ROUTES` in `runtime/browser-ports.mjs` is authoritative and `docs/ops/PROJECT-BROWSER-AND-PORTS.md` §1.3 is its readable digest. Buyer browser (`9222`/`3457`) carries the competitor chain (小旺神 market analysis, SKU, FAQ, question library) on `s.taobao.com` / `item.taobao.com` / `detail.tmall.com`. Merchant browser (`19022`/`19023`) carries keyword search-rank (生意参谋 搜索排行), the 灰豚 keyword-heat route (its own independent account — it sits there only so the whole keyword route needs one browser), the daily report (生意参谋 + 万相台/阿里妈妈 + Feishu), the weekly Feishu paste, and the reserved 千牛/卖家工作台 slot (`myseller.taobao.com` / `qianniu.taobao.com`). Assign a chain by the account its target site requires, never by which browser happens to be open. A seller-version account cannot use 小旺神 at all, so a merchant login on the buyer profile silently degrades collection rather than failing. A test also cross-checks that a route's declared browser matches the ports and browser ids its own skill scripts reference — editing one side alone turns it red.
- Rediscover page targets before each browser action; never persist target IDs.
- "Released when done" is not the default and must not be assumed: `scripts/run-daily-job.mjs` without `--batches` has **no stop step at all** (its plan is only ensure-instances → login-preflight → chain), so a collection finishing leaves every browser and proxy running. Only `--batches N` goes through `scripts/run-batches.mjs`, whose release-after-batch is the one real caller of `scripts/stop-all.mjs`. When release is being verified or relied on, use `--batches` and say so explicitly.
- Never accept "released" from `scripts/stop-all.mjs`'s exit code alone: its release path has a known false-green (it reads the process table with a sync spawn, gets `EBUSY` under a sandboxed session, then asserts "nothing is running, nothing to do" and still exits 0). Confirm release by re-reading each port (`Get-NetTCPConnection -LocalPort <port> -State Listen`, twice — the first read can be stale) and, when it matters, by counting `msedge` processes.
- Stop for login, CAPTCHA, QR/SMS, account-risk, security, permission, or other platform controls. Do not dismiss or bypass them.
- Modify only authorized Feishu copies, never the original template.
- Preserve displayed ranges and `-` values verbatim.
- After selecting 50 rows per page in SYCM, wait for the table itself to refill to at least 50 rows; the selector can show 50 while stale data is still rendering, which can skip ranks 11-50.

## Acceptance

## Development delivery check

- A local commit is not a delivered change. Before reporting completion, run `npm run check:delivery -- --commit=<sha>` and report `mainline_contains_commit`, `remote_contains_commit`, and `worktree_clean` separately.
- A worktree or feature branch may remain only when the handoff explicitly names its path, branch, commit, and next absorption action. Do not infer that a pushed branch changed `main`.
- The primary checkout is the default for bounded development. Use a worktree only for explicit isolation or concurrent work, and record its path, branch, base commit, owner, and absorption action.
- Before a local commit, run `npm run check:staged` and `npm run test:staged`; do not use `--no-verify` to bypass a failing check. Fix the check, narrow the staged scope, or stop at the evidence boundary.
- `npm run test:staged` has a wall-clock budget (default 1800 s per command, `--budget-seconds=N`, `0` = unlimited). Over budget it kills the whole process tree and exits **3 = INCOMPLETE**: that is neither a pass nor a failure, so report it as "no verdict" and never as green or red. Raise the budget (`--budget-seconds=7200`) or run the named command deliberately when you actually need that verdict — do not read a timeout as a test failure.
- Do not run `npm run test:staged` while a browser-driven chain (daily report, keyword, competitor) is in flight, or when machines are about to be handed over. Selecting a skill's implementation change runs **that skill's whole test suite**, including end-to-end files that spawn the real CLI as child processes; measured on 2026-09-25 that selection ran 664 cases in **7.6 hours**, 92% of it spent in 7 cases that each wait out the CLI's own 60-minute download deadline. It is a long, resource-holding run, not a quick check.

- SYCM export: ranks contiguous and unique, source fields present, and CSV/XLSX validated.
- Feishu import: exact source-row count, first/last rank match, five source fields in order, no duplicate rows, and copied views/tables remain present.
- Xiaowangshen API import: authorized target table starts empty, all 16 fields exist, `商品图片` is attachment type `17`, and API verification reports equal source-row, imported-row, and attachment counts.
- Daily inquiry backfill: source shop/date/column and target date/shop match exactly, both inquiry fields match on reread, and unrelated target fields are unchanged.
- A stable session is evidence for the current run only; it does not guarantee future login persistence.
