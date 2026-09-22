---
name: xws-sku-collection
description: "Collect sellable SKUs for A/B competitors from real Taobao product pages through Xiaowangshen, build a deterministic dry-run, and write only explicitly authorized batches to Feishu with read-back verification."
metadata:
  version: "1.9.0"
---

# 小旺神 SKU 采集入库

Version: `1.9.0`

Use this skill when the user asks to collect SKU information for A/B competitors classified in a Feishu
`竞品主表`, using the visible SKU copy control on the real Taobao product page, and then write the result to the
authorized Feishu `SKU明细` table.

Version `1.6.0` fixes the observed collection failures. The copy target is the Xiaowangshen title-side copy bar
`#xws-copy`: select the visible `.xws-copy-item.xws-copy-link` whose normalized text is exactly `SKU`, then
click its container with a real mouse gesture. Do not use the toolbar `SKU预览` entry or its `一键导出` button as
the clipboard source. The topology contract now selects the unique separator that is present across the complete
set of specification options, so an internal `+` in a value remains part of the original specification when
`-` is the stable separator. When both `-` and `+` produce the same valid segment shape, the parser uses
`-` deterministically; `+` is used only when `-` is not valid. Ambiguous separator sets, unknown segment
counts, and combinations without price evidence remain blocked. Product URLs may be `item.taobao.com` or
`detail.tmall.com`; preflight and topology must use the live URL actually opened in Edge.

Version `1.7.1` records the login-boundary fix: the toolbar's normal personal-center `请登录` entry is not a
login wall. Preflight only treats a visible login dialog, CAPTCHA/security control, or explicit Xiaowangshen
login/verification text as an auth blocker. A visible SKU control plus a successful clipboard read is sufficient
when the page has no separate success toast. Never ask the operator to log in solely because `#xws-detail-tool`
contains static `请登录` text.

Version `1.8.0` records two deterministic recovery rules from the 2026-08-25 batches:

- After navigating to a new product, require a fresh product-ID/page-URL match before reading the clipboard. A
  reused page can show a successful copy message while leaving the previous product's payload in the clipboard;
  the payload hash and capture receipt must be rejected when the page identity is not fresh.
- For space classification, an explicit `SKU尺寸` is the only dimension source. Do not mix measurements found in
  `SKU规格` (for example, `18mm`/`25mm` thickness) into the space decision. Use specification dimensions only as
  a deterministic fallback when `SKU尺寸` is absent; ambiguous ranges remain `需人工核验`.

This skill owns the SKU collection boundary and weekly snapshot handoff. The existing `xws-to-feishu-base` skill
owns XLSX competitor imports and V2 table/schema creation; do not combine those workflows in one run.

Version `1.9.0` records the weekly storage correction completed on 2026-08-25:

- `竞品周_YYYY-MM-DD_YYYY-MM-DD` is repaired from the complete source export before any main-table sync. The
  source rank is authoritative and must remain contiguous/unique; do not copy rank values from a partial history
  table. Preserve source images as real Feishu attachments, using embedded workbook images first and the same-row
  source image URL only as an attachment-upload fallback.
- The current `竞品主表` is a master index, not a weekly snapshot. Upsert the current weekly product set into it,
  preserve existing AI/manual values, retain products absent from the current week, and mark them as not present
  instead of deleting them. A stable text `商品ID` is required in both the master and weekly competitor table.
- Weekly SKU selection uses the current weekly Feishu formula result (`是否有效竞品=是` and `竞品分类` A/B),
  while a repeated week is idempotent by `SKU周期唯一键`. A later week re-collects the same product because SKU
  options may change; it never overwrites a prior weekly snapshot.
- Do not create a new bidirectional relation field for each weekly table. Keep only the stable current relations
  `竞品主表.SKU采集明细` and `SKU明细.所属竞品`; weekly tables use text `主表记录ID`, `竞品周记录ID`,
  `商品周期唯一键`, and `SKU周期唯一键`. If an old SKU weekly row belongs to a product absent from the current
  competitor weekly table, set `竞品周关联状态=历史商品，本周竞品周未出现` instead of leaving the relation silently blank.
- Feishu Open API is the write path for records, attachments, fields, formulas, and read-back verification. DOM is
  reserved for browser-only collection/configuration surfaces. A Feishu bot webhook is notification-only and must
  not replace the Bitable Open API.

Weekly storage uses explicit per-week tables: `SKU明细` (`tblddWTrPeB4TKmR`) is the current working table keyed
by `SKU唯一键`, while each collection creates `SKU周_YYYY-MM-DD_YYYY-MM-DD` and preserves that week's snapshot.
Competitor imports use the matching `竞品周_YYYY-MM-DD_YYYY-MM-DD` table. Same-week reruns must target the same
named table and deduplicate by the business key; a new week must create new tables. Run
`runtime/create-weekly-history-tables.mjs` before a new weekly import. Never invent dates for older rows.

Latest-week source rule: select competitors from the newest valid `竞品周_YYYY-MM-DD_YYYY-MM-DD` table, then
resolve each product to a stable `竞品主表` record before creating current SKU rows. If no main record exists,
stop before writing; do not create an unlinked SKU row and do not silently point a SKU at a weekly row.

## Required Access

1. Load `web-access` before any browser or network action. Use **this project's competitor-chain
   Proxy** — the value in `runtime/browser-ports.mjs` (`PROJECT_PORTS.competitorProxy`, currently
   `http://127.0.0.1:3457`, browser id `edge-isolated`) — pointed at the debug Edge profile that
   has the 小旺神 extension. Do not borrow another project's shared proxy (`3456`): that browser is
   logged in with the merchant account and has no 小旺神, so collection silently degrades instead of
   failing. See `docs/ops/PROJECT-BROWSER-AND-PORTS.md` §1.1/§1.3.
2. Use the project runtime under `D:\Retire\sycm-automation\runtime` for parsing, manifests, and Feishu API
   operations. Do not copy credentials into the project. Pass the existing env-file path only to the runtime
   command; never print its values.
3. Before every browser action, rediscover the current target. Do not persist a target ID across navigation,
   reload, or waits, and do not open a second browser-level CDP connection. The collection flow runs in a
   background tab; foreground Edge display is not a workflow requirement.
4. Reuse the same Edge user profile for the whole collection service. Login persistence belongs to Edge and
   Xiaowangshen's own session storage, not this project: never copy cookies, local storage, passwords, tokens, or
   auth headers into the repository. A persistent profile reduces re-login frequency but is not proof of an active
   Xiaowangshen session; the preflight below is authoritative for each product batch.

## Safety Contract

- Operate only on the explicitly authorized Feishu Base/table. The current verified target is the project copy
  `OWebbPUcBa7B8JseYLccQCy9nkf`, main table `竞品主表` (`tblJ9LHFN6pMVjPv`), and SKU table `SKU明细`
  (`tblddWTrPeB4TKmR`). A future target needs a new explicit authorization.
- A write authorization must name the exact SKU record count, app token, SKU table ID, and source competitor
  record. A prior authorization does not cover another product or another batch.
- Stop immediately for login, CAPTCHA/slider, QR/SMS verification, account risk, security, permission, quota,
  or trial prompts. Do not dismiss or bypass the control.
- Do not change Feishu formulas, AI fields, source fields, table schema, or the 1,333 existing main-table rows.
  Formula results must be read from Feishu; never locally analyze and backfill formula fields.
- Do not read passwords, cookies, browser storage, auth headers, or raw credentials. Raw copied SKU payloads are
  protected local evidence and must not be printed in chat, committed, or uploaded to hosted services.
- Do not run unlimited bulk collection. Process one product per bounded batch and stop at the authorization gate.

## Workflow

### 1. Select a live A/B competitor

Read the current Feishu `竞品主表` record before opening Taobao. Require:

- `是否有效竞品=是`;
- `竞品分类` starts with `A-` or `B-`;
- a product link whose item ID can be extracted;
- the current title and formula class match the source evidence that will be captured.

Use the actual product link from the record. Do not infer a URL from a title or reuse a previous product's
payload.

### 2. Capture the real Xiaowangshen SKU payload

Before clicking anything, run the read-only auth preflight against the actual product page:

```powershell
node "D:\Retire\sycm-automation\runtime\xws-sku-auth-preflight.mjs" `
  --product-id "<product-id>" `
  --product-url "<product-url>" `
  --record-id "<main-record-id>" `
  --classification "<A-or-B-formula-result>" `
  --validity "是" `
  --output-directory "D:\path\to\batch"
```

The preflight must return `AUTH_READY`. It only inspects the visible Xiaowangshen toolbar and does not click a
login link. It writes a sanitized `xws-sku-auth-status-*.json` and updates `batch-index.json`. If it returns
`AUTH_REQUIRED`, it also writes `xws-sku-operator-alert.json` and exits with code `2` (`HUMAN_REQUIRED`).
The same applies to `PAGE_UNAVAILABLE` — the target product page was not found (or the proxy could not read it),
which is decided **before** the classifier runs; that case exits with code `3` (`STALLED`), matching the exit
codes callers already branch on.

**Delivery is wired by default** (2026-09-22). Unless told otherwise the preflight hands the alert JSON to
`runtime/notify-feishu.mjs` on stdin and records what that CLI reported in `delivery.status`
(`SENT` / `FAILED` / `DEDUPED` / `MUTED`) — nobody has to pass a flag for the alert to reach a human. Two flags
change that and only two:

- `--no-notify` — explicit silence, for offline rehearsals. The receipt reads `MUTED`, which is deliberately
  **not** `NOT_CONFIGURED`: that older value meant "the delivery line is missing", and conflating the two is what
  let the 2026-09-13 blocker sit unnoticed.
- `--notify-command <path>` — replaces the destination with an operator-owned one. An `.mjs`/`.js` path is run
  with `node`; anything else is spawned as an executable. (A `.cmd`/`.bat` wrapper will **not** start: Node
  ≥18.20.2 throws `EINVAL` on `.cmd` when `shell:false`.) The wrapper and its destination are operator-owned and
  must not be committed with credentials or webhook secrets.

Repeated checks for the same open issue are deduplicated; after a fresh `AUTH_READY` check the alert is marked
`RESOLVED` so the operator knows the queue can resume.

Only after `AUTH_READY`, locate `#xws-copy` on the real Taobao product page and select the visible
`.xws-copy-item.xws-copy-link` whose normalized text is exactly `SKU`. Verify the target text immediately before
the action, click that item's container once through a real mouse gesture, then require a visible `已复制` or
equivalent success message. The `data-spm-anchor-id` suffix is dynamic and must not be persisted as the selector.
The toolbar `SKU预览` entry and the preview dialog's `一键导出` button are inspection surfaces, not the clipboard
capture control. Accept the copy only when the page visibly confirms success and the clipboard payload is non-empty.
`capture-xws-sku-payload.mjs` requires the matching `--auth-status-file` from the preflight; it
reads the clipboard once, validates the source identity/copy feedback, hashes the exact payload, writes the
protected payload and sanitized receipt, and updates `batch-index.json`. Do not copy the clipboard into a second
intermediate file or print it.

Capture the page SKU topology from the same product page. Bind the topology to the payload hash and record the
property count and valid sellable-combination count. Empty or unavailable combinations must be excluded by the
page topology, not guessed from line order.

### 3. Parse and dry-run

Use the existing deterministic modules:

- `xws-sku-payload-parser.mjs` expands verified valid combinations and creates `SKU唯一键` as
  `商品ID|SKU ID`;
- `xws-sku-dry-run-core.mjs` validates the Feishu field contract, current A/B formula result, bidirectional
  `所属竞品` relation, existing unique keys, and field equality;
- `run-xws-sku-dry-run.mjs` reads live Feishu state and writes a hash-bound manifest and sanitized receipt.

The SKU field contract is fixed:

- `适用空间` may only be `小户型` or `常规卫生间`; `大户型` is rejected;
- `所属竞品` is a single bidirectional link to the selected main-table record;
- existing identical unique keys are `alreadyPresent` and are never overwritten;
- any conflict, duplicate existing key, changed source identity, changed formula class, or payload/topology hash
  mismatch blocks the write.

The dry-run must show the exact parsed count and a write plan. A plan is not authorization and must not mutate
Feishu. Each new product must use its own evidence directory; the directory's `batch-index.json` is the canonical
map of payload, capture receipt, topology, manifest, apply receipt, and final dry-run receipt basenames.

### 4. Require exact authorization

Before any record write, report the dry-run count and wait for an explicit authorization naming the exact count.
The guarded apply command must repeat and verify the target app token, SKU table ID, count, and all four evidence
paths. It has no legacy default payload/topology paths. It must run a fresh dry-run immediately before writing; if
the current count or hash-bound evidence is not exactly authorized, stop without a write.

### 5. Apply once and verify

Use `apply-xws-sku-manifest.mjs` for one guarded `batch_create`. Accept completion only when a fresh Feishu
read-back reports:

- the expected before/after SKU record counts;
- every parsed `SKU唯一键` already present exactly once;
- every row's `所属竞品` points to the selected main record;
- every row's approved space decision is persisted;
- `toCreate=0`, `conflict=0`, and `duplicateExistingKeys=0`.

The result must be saved as a sanitized apply receipt. Never include raw SKU option text or credentials in the
receipt or response.

For the clipboard step, pass the matching preflight receipt explicitly:

```powershell
node "D:\Retire\sycm-automation\runtime\capture-xws-sku-payload.mjs" `
  --output-directory "D:\path\to\batch" `
  --auth-status-file "D:\path\to\batch\xws-sku-auth-status-<run>.json" `
  --record-id "<main-record-id>" `
  --product-id "<product-id>" `
  --product-url "<product-url>" `
  --validity "是" `
  --classification "<A-or-B-formula-result>" `
  --copy-feedback "<visible-copy-confirmation>"
```

## 运行时入口（Agent SOP Runtime）

除上面的人工 CLI 链之外，本 Skill 还登记了一条确定性能力 `xws.sku.collection@1.0.0`
（`manifest.json` / `scripts/adapter.sku-collection.mjs` / `tests/adapter-sku-collection.test.mjs`）。
它把「复验 + 授权写入 + 回读验收」接进通用两段式运行器：

- 采集段读**六份本地输入**（`--payload-file`、`--capture-receipt`、`--topology-file`、
  `--topology-receipt`、`--manifest-file`、`--parser-file`），独立复验三方哈希、来源身份、
  来源资格（`是否有效竞品=是` 且分类 A/B）、解析器摘要与逐行契约（唯一键 / 关联 / 空间），
  产出可自证工件；**不发起任何浏览器动作**。
- 发布段只读工件字节，按 `SKU唯一键` 先对账再 `batch_create`（幂等，重跑不产生重复行），
  随后由飞书真实回读验收。目标必须与**已审批工件**携带的一致，否则拒绝写入。
- 采集段与发布段之间不通过进程内状态传递数据，因此可以从落盘工件跨进程恢复。

```powershell
node runtime/sop-runtime/two-stage-runner.mjs `
  --capability xws.sku.collection `
  --identity '{"tenantId":"sycm","storeId":"bathtub","platform":"taobao","accountId":"buyer-1","browserProfileId":"edge-isolated","contractVersion":"sop-context-v1"}' `
  --business-key "xws-sku-<product-id>-<capture-id>" `
  --expected-rows <parsed-sku-count> `
  --collect-input '{"evidenceDir":"<dir>","payloadFile":"<dir>\\xws-sku-payload-<capture>.txt","captureReceipt":"<dir>\\xws-sku-capture-<capture>.json","topologyFile":"<dir>\\xws-sku-topology-<product-id>.json","topologyReceipt":"<dir>\\xws-sku-topology-receipt-<product-id>.json","manifestFile":"<dir>\\xws-sku-dry-run-manifest-<run>.json","parserFile":"<repo>\\runtime\\xws-sku-payload-parser.mjs"}' `
  --work-dir "<dir>\.sop"
```

省略 `--commit` 时只跑采集段：复验通过则 `publicationStatus` 保持 `NOT_REQUESTED`、游标不推进。
真实写入必须补 `--commit --env-file "E:\小红书\.env.local" --operator "<审批人>"`
（人工闸门由此被记录，而不是靠一个命令行开关）；写入后由回读收据结算
`VERIFIED` 或 `UNKNOWN`（对账后才能重试）。运行器与能力的详细决策见
`docs/architecture/MIGRATION-5-XWS-SKU-REPORT.md`。

## Commands

Dry-run (pass all four files from one product directory):

```powershell
node "D:\Retire\sycm-automation\runtime\run-xws-sku-dry-run.mjs" `
  --payload-file "D:\path\to\batch\xws-sku-payload-<capture>.txt" `
  --capture-receipt "D:\path\to\batch\xws-sku-capture-<capture>.json" `
  --topology-file "D:\path\to\batch\xws-sku-topology-<product-id>.json" `
  --topology-receipt "D:\path\to\batch\xws-sku-topology-receipt-<product-id>.json" `
  --output-directory "D:\path\to\batch" `
  --env-file "E:\小红书\.env.local"
```

The dry-run entrypoint also rejects missing evidence or output-directory flags; it never falls back to the retired
shared batch files.

Independent product dry-run: provide all four evidence files from one product directory. The command checks that
the evidence set is complete before reading Feishu:

```powershell
node "D:\Retire\sycm-automation\runtime\run-xws-sku-dry-run.mjs" `
  --payload-file "D:\path\to\batch\xws-sku-payload-<capture>.txt" `
  --capture-receipt "D:\path\to\batch\xws-sku-capture-<capture>.json" `
  --topology-file "D:\path\to\batch\xws-sku-topology-<product-id>.json" `
  --topology-receipt "D:\path\to\batch\xws-sku-topology-receipt-<product-id>.json" `
  --output-directory "D:\path\to\batch" `
  --env-file "E:\小红书\.env.local"
```

Guarded apply, only after an exact record-count authorization:

```powershell
node "D:\Retire\sycm-automation\runtime\apply-xws-sku-manifest.mjs" `
  --manifest "D:\path\to\approved-manifest.json" `
  --env-file "E:\小红书\.env.local" `
  --apply `
  --confirm-app-token "OWebbPUcBa7B8JseYLccQCy9nkf" `
  --confirm-sku-table-id "tblddWTrPeB4TKmR" `
  --payload-file "D:\path\to\batch\xws-sku-payload-<capture>.txt" `
  --capture-receipt "D:\path\to\batch\xws-sku-capture-<capture>.json" `
  --topology-file "D:\path\to\batch\xws-sku-topology-<product-id>.json" `
  --topology-receipt "D:\path\to\batch\xws-sku-topology-receipt-<product-id>.json" `
  --output-directory "D:\path\to\batch" `
  --confirm-record-count 36
```

For an independent product batch, pass the same four evidence flags and `--output-directory` used by its dry-run,
and replace `--confirm-record-count` with the newly authorized exact count. The guarded apply reruns that evidence-
bound dry-run before calling Feishu and uses the same evidence again for post-write verification. Omitting any one
of the four evidence flags is rejected before Feishu authentication.

The target Base/table contract is fixed, but every product must use a separate evidence directory and its own
payload, capture receipt, topology, topology receipt, manifest, and dry-run receipt. Never edit the old manifest or
reuse another product's payload/topology.

## Failure Handling

- `HUMAN_REQUIRED`: browser or platform control needs the user. Stop and report the exact control.
- `AUTH_REQUIRED`: Xiaowangshen login preflight failed. Keep the batch open, notify the operator from the
  structured alert, and resume only after a fresh preflight returns `AUTH_READY`.
- `STALLED`: the product target or Xiaowangshen toolbar could not be observed. Do not silently retry forever;
  surface the batch alert and preserve the current pointer.
- `DRY_RUN_BLOCKED`: keep the evidence, report the first contract mismatch, and do not write.
- `CONFLICT` or duplicate key: do not overwrite or merge; resolve the source/table discrepancy first.
- A write API error is readback-recoverable only for a transient network/timeout error or HTTP 5xx. HTTP 4xx,
  permission, authentication, invalid-field, and parameter errors must surface as failures immediately.
- Post-write verification retries only transport failures or a plan that is still settling with zero conflicts and
  no source-identity change. Conflicts, duplicate keys, changed parsed count, field errors, and relation errors stop
  immediately.
- The apply receipt separates `apiConfirmedRecordCount` from `verifiedRecordCount`; a readback-recovered write may
  have API confirmation `0` while the final Feishu read confirms the authorized rows. Preserve the receipt and
  report the unresolved state if verification does not settle.

## Verification

Run the focused SKU tests after code or contract changes:

```powershell
node --test "D:\Retire\sycm-automation\runtime\*sku*.test.mjs"
node --test "D:\Retire\sycm-automation\runtime\apply-xws-sku-manifest.test.mjs"
node --test "D:\Retire\sycm-automation\runtime\xws-sku-batch-index.test.mjs"
py -3 "D:\codex\skills\.system\skill-creator\scripts\quick_validate.py" `
  "D:\Retire\sycm-automation\skills\xws-sku-collection"
```

The project-local task pointer is
`D:\Retire\sycm-automation\runtime\competitor-v2-sku-collection-stage-pointer.md`. Update it with the
current stage, last verified step, and exact next action after each bounded batch.
