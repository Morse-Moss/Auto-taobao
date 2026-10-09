---
name: sycm-inquiry-data
description: Export 生意参谋商品咨询分析 daily XLS files and import item-level inquiry rows into the authorized Feishu 商品询单数据底单.
---

# 商品咨询分析

The source is the logged-in shop-specific SYCM browser. The workflow asserts the shop identity, selects 商品分析 → 商品咨询分析 and 日, reads the report link rendered by the page, downloads the XLS through the same browser session, removes the report header and 平均值/汇总值 rows, then appends only new `数据日期 + 商品ID` rows to the authorized Feishu copy.

The report has 12 source columns. `延迟统计` and `-` are preserved verbatim. The target table does not contain a shop field, so the import receipt records the source shop and the idempotency key is `数据日期 + 商品ID`.

## Known intermittent failure: entry not rendered yet (fixed 2026-10-09)

`商品分析 → 商品咨询分析` is an SPA menu, not a link. Right after the shop page loads, the body holds only the prompt rows (`document.readyState === 'interactive'`, `bodyLen ≈ 32`), so an exact-text lookup for `商品分析` finds **0** matches. The entry appears only after the SPA finishes rendering (measured ≈ 8 s on 网林天猫), and even then `商品分析` is present while `商品咨询分析` is not until the parent menu has been clicked once.

The old collector clicked the parent **once** before a 30 s poll that only re-looked for `商品咨询分析`. A click that landed before the SPA rendered therefore doomed the whole step: `商品咨询分析` never appeared, the poll timed out, and — because the failure left nothing on disk — the operator saw only `找不到商品咨询分析入口（轮询 30s 仍未出现）` with `stoppedAt=inquiry-collect`.

Since 2026-10-09 the poll re-reads the page **every round** and re-clicks the parent whenever `planEntryPollStep` returns `click-parent` (parent present, child absent), so a single missed click no longer fails the step. The same failure path now writes a snapshot next to the export before throwing: `<out>.failure.json` (`{ note, reading, url, readyState, ... }`) and `<out>.failure.png`. If those two files exist, the page genuinely did not render the entry within 30 s — do not read a missing XLS as "this shop has no data".

This is transient, not a data gap: a re-run of the same shop succeeds (observed 2026-10-05 and 2026-10-09). Before re-running the chain, confirm with the read-only probe — `node tmp/probe-inquiry-entry-20261009.mjs <店铺> [--normalize]`, which only reads the page (no click, no navigation); a representative run is archived under `evidence/inquiry-entry-probe-2026-10-09/`.
