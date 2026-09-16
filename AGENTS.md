# 生意参谋自动化项目

## Scope

- `skills/` contains the project-owned SYCM export and Feishu import skills.
- `evidence/` contains validation outputs and run evidence; do not treat it as live input.
- `runtime/` contains project-local notes or future launch wrappers.
- The logged-in Edge profile, credentials, and cookies remain outside this project.
- The active Feishu credential file is resolved from `runtime/feishu-targets.mjs` (currently the kcne tenant: `E:/小红书/.env.feishu-kcne.local`); pass its path to import commands and never copy its values into this project. Never hardcode tenant app tokens or base/table ids — read them from that single source of truth.
- Read `docs/ops/LESSONS-2026-09-14_15.md` before changing a state machine, a release path, or collection semantics: it lists the failures that have already cost time here.

## Operating Rules

- Xiaowangshen browser work uses the project's debug Edge on port `9222` (`--user-data-dir=D:\Retire\edge-debug-profile`, which has the 小旺神 extension) plus CDP proxy `3457`; exports pass `XWS_PROXY=http://127.0.0.1:3457` and `XWS_BROWSER_ID=edge-isolated`. The SYCM/Alimama daily-report workflow uses its separate merchant Edge on `9223` (`D:\Retire\edge-daily-report-profile`) plus proxy `3458` and browser id `edge-daily-report`. Do not use the shared proxy on `3456`.
- Rediscover page targets before each browser action; never persist target IDs.
- Stop for login, CAPTCHA, QR/SMS, account-risk, security, permission, or other platform controls. Do not dismiss or bypass them.
- Modify only authorized Feishu copies, never the original template.
- Preserve displayed ranges and `-` values verbatim.
- After selecting 50 rows per page in SYCM, wait for the table itself to refill to at least 50 rows; the selector can show 50 while stale data is still rendering, which can skip ranks 11-50.

## Acceptance

- SYCM export: ranks contiguous and unique, source fields present, and CSV/XLSX validated.
- Feishu import: exact source-row count, first/last rank match, five source fields in order, no duplicate rows, and copied views/tables remain present.
- Xiaowangshen API import: authorized target table starts empty, all 16 fields exist, `商品图片` is attachment type `17`, and API verification reports equal source-row, imported-row, and attachment counts.
- Daily inquiry backfill: source shop/date/column and target date/shop match exactly, both inquiry fields match on reread, and unrelated target fields are unchanged.
- A stable session is evidence for the current run only; it does not guarantee future login persistence.
