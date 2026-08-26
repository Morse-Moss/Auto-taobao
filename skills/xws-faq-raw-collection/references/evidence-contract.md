# FAQ Evidence Contract

This reference is used when validating a completed or resumed FAQ collection.

## Source types

| Source | Raw artifact | Row artifact | Empty allowed |
|---|---|---|---|
| 问大家 | `qa.csv` | same file | Yes, only with an explicit no-data page state |
| 评论 | `reviews-source.zip` | `reviews.csv` | No |

The ZIP is authoritative for 评论. `reviews.csv` is a deterministic parsing artifact and must not be treated as
the downloaded source. A receipt stores both hashes when both files exist.

Review ZIP normalization is performed by `../scripts/normalize-xws-reviews.ps1`: entry paths are sorted
deterministically and each TXT entry is preserved as one escaped CSV row. Product operations are appended to
`events.jsonl` using `../scripts/append-faq-event.mjs`; event timestamps are evidence for retries, landed files,
validation, quota checks, and final state.

## Landing validation

Do not accept a progress label alone. Confirm the expected file exists, has non-zero size, is stable across two
checks, and can be read. For a ZIP, list entries and verify at least one non-directory entry. For CSV, parse the
header and count non-empty raw-content rows.

## Resume states

- `COMPLETED`: raw file landed and validated.
- `EMPTY_SOURCE_ROWS`: only valid for 问大家 when the page explicitly says no data.
- `BLOCKED_LOGIN_REQUIRED`: login or plugin identity must be restored.
- `BLOCKED_EXPORT_NOT_LANDED`: page completed but the raw file is absent or unreadable.
- `BLOCKED_QUOTA_OR_RISK`: quota, CAPTCHA, security, or account-risk barrier.

Only `COMPLETED` and verified empty 问大家 sources may pass the Feishu apply gate.
