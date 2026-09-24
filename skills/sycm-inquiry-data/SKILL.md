---
name: sycm-inquiry-data
description: Export 生意参谋商品咨询分析 daily XLS files and import item-level inquiry rows into the authorized Feishu 商品询单数据底单.
---

# 商品咨询分析

The source is the logged-in shop-specific SYCM browser. The workflow asserts the shop identity, selects 商品分析 → 商品咨询分析 and 日, reads the report link rendered by the page, downloads the XLS through the same browser session, removes the report header and 平均值/汇总值 rows, then appends only new `数据日期 + 商品ID` rows to the authorized Feishu copy.

The report has 12 source columns. `延迟统计` and `-` are preserved verbatim. The target table does not contain a shop field, so the import receipt records the source shop and the idempotency key is `数据日期 + 商品ID`.
