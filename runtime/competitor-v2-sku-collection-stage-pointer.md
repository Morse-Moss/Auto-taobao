# Competitor V2 SKU Collection

```yaml
stage: CLOSE
outcome: The 2026-08-25 SKU collection batches were written and verified, then preserved in SKU周_2026-08-23_2026-08-29.
controls:
  execution: STAGED
  risk: CRITICAL
  delivery: LOCAL
scope:
  owned:
    - Authorized Feishu Base OWebbPUcBa7B8JseYLccQCy9nkf / 竞品主表 tblJ9LHFN6pMVjPv (read live formulas only)
    - Authorized Feishu Base OWebbPUcBa7B8JseYLccQCy9nkf / SKU明细 tblddWTrPeB4TKmR (36-record write for source recvsD4nahhATl completed and verified)
    - runtime/competitor-v2-sku-collection/ evidence and auth-status/alert receipts only
  forbidden:
    - Reclassifying or writing Feishu formula fields locally
    - Feishu AI execution or prompt changes
    - Trial, payment, quota, login, CAPTCHA, or security actions
    - Changes to the 1,333 existing main-table records
  unrelated_or_unknown:
    - All existing dirty worktree changes outside this new pointer and run evidence
dod:
  - Live Feishu formula results select one valid A/B row with a product link.
  - The Xiaowangshen SKU button visibly confirms a real copy on that product page.
  - Evidence stores the raw copied payload, SHA-256, selected main record ID, link, formula class, capture time, and plugin feedback.
  - The observed sellable combinations are written once, with no conflict or duplicate SKU unique key.
  - Post-write Feishu read-back verifies every new SKU唯一键, 所属竞品 relations, and space decisions.
  - A fresh `AUTH_READY` preflight is required before any clipboard read; `AUTH_REQUIRED` writes a sanitized operator alert and exits with code 2.
approvals:
  - action: Read the authorized Base and run one Xiaowangshen SKU capability probe.
    policy_id: BOUNDED_PREAUTH
    decision: allowed
    bounds: One currently formula-classified A/B record; one real SKU copy action; no paid/trial action; no Feishu record write before a parsed dry-run manifest is checked.
    evidence: User explicitly directed SKU collection from A/B competitors by clicking the visible Xiaowangshen SKU control.
  - action: Create exactly 36 SKU detail records and read them back.
    policy_id: BOUNDED_PREAUTH
    decision: allowed and completed
    bounds: Base OWebbPUcBa7B8JseYLccQCy9nkf; table tblddWTrPeB4TKmR; 36 records only; source record recvsD4nahmz2o; no other record or schema mutation.
    evidence: User explicitly authorized the exact target and count.
  - action: Create exactly 6 SKU detail records and read them back.
    policy_id: BOUNDED_PREAUTH
    decision: allowed and completed
    bounds: Base OWebbPUcBa7B8JseYLccQCy9nkf; table tblddWTrPeB4TKmR; 6 records only; source record recvsD4nahr0sD; no other record or schema mutation.
    evidence: User explicitly confirmed the exact target and count in this turn.
  - action: Start the next bounded A/B SKU collection round.
    policy_id: BOUNDED_PREAUTH
    decision: allowed for read/capture/dry-run; write authorization pending
    bounds: One live A/B record at a time; no Feishu write before the new exact parsed count is reported and authorized.
    evidence: User explicitly asked to use xws-sku-collection for the next round.
  - action: Create exactly 36 SKU detail records and read them back.
    policy_id: BOUNDED_PREAUTH
    decision: allowed and completed
    bounds: Base OWebbPUcBa7B8JseYLccQCy9nkf; table tblddWTrPeB4TKmR; 36 records only; source record recvsD4nahhATl; no other record or schema mutation.
    evidence: User explicitly authorized the exact Base, table, source record, and count.
verification:
  focused:
    - Fresh Feishu read-back of formula class and validity before selection.
    - Visible Xiaowangshen copy feedback followed by a single clipboard read.
    - Payload SHA-256 and parser fixture after format discovery.
  stage_exit:
    - Before/after SKU-detail count, unique-key dry run, relation and space-decision read-back.
  real_observation:
    - Product page and plugin copy status in the shared logged-in Edge session.
review:
  shape: combined
  correction_budget: 2
  knowledge_impact:
  - Completed: v1.2.0 captures the repeatable guarded contract, atomic clipboard step, batch index, and retry/recovery evidence split.
  - Completed: v1.3.0 adds Edge-profile persistence boundaries, read-only auth preflight, capture gating, and structured operator alert output.
  - Completed: v1.8.0 records fresh product identity gating, explicit SKU尺寸 precedence over specification thickness, and same-week snapshot comparison normalization.
non_goals:
  - Bulk collection, product-link discovery by title inference, and any main-table AI-field change.
```

Current stage: WEEKLY-MODEL - COMPLETE_FOR_2026-08-23_2026-08-29. Competitor weekly snapshot was repaired from the complete 1461-row source, master index was upserted to 2004 products, stable text links were written, and obsolete per-week bidirectional relation fields were removed.

Last completed verified step: `竞品周_2026-08-23_2026-08-29` has 1461 contiguous unique ranks and 1461 real image attachments; `竞品主表` has 2004 rows and all 1461 weekly products have `主表记录ID`; `SKU周_2026-08-23_2026-08-29` has 734 rows, 684 current-week competitor links, and 50 explicit historical-not-in-current-week statuses. Focused SKU tests (60) and XWS/Feishu tests (72) passed.

Next exact action: start the next weekly collection by selecting the newest valid A/B queue and creating a new per-product evidence directory; do not reuse these payloads or assume the 2026-08-23 period for a future week.
