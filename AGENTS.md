# 生意参谋自动化项目

## Scope

- `skills/` contains the project-owned SYCM export and Feishu import skills.
- `evidence/` contains validation outputs and run evidence; do not treat it as live input.
- `runtime/` contains project-local notes or future launch wrappers.
- The logged-in Edge profile, credentials, cookies, and the shared `web-access` Proxy remain outside this project.
- The current Feishu app credential file remains at `E:\小红书\.env.local`; pass its path to import commands and never copy its values into this project.

## Operating Rules

- Use the shared `web-access` Proxy at `http://127.0.0.1:3456` and its single CDP connection.
- Rediscover page targets before each browser action; never persist target IDs.
- Stop for login, CAPTCHA, QR/SMS, account-risk, security, permission, or other platform controls. Do not dismiss or bypass them.
- Modify only authorized Feishu copies, never the original template.
- Preserve displayed ranges and `-` values verbatim.

## Acceptance

- SYCM export: ranks contiguous and unique, source fields present, and CSV/XLSX validated.
- Feishu import: exact source-row count, first/last rank match, five source fields in order, no duplicate rows, and copied views/tables remain present.
- Xiaowangshen API import: authorized target table starts empty, all 16 fields exist, `商品图片` is attachment type `17`, and API verification reports equal source-row, imported-row, and attachment counts.
- A stable session is evidence for the current run only; it does not guarantee future login persistence.
