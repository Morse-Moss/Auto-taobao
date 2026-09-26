---
name: sycm-promotion-data
description: Import validated 阿里妈妈商品报表 plan rows into the authorized 商品推广数据底单.
---

The source is the logged-in 阿里妈妈 商品报表 export, not 营销场景报表. Navigate 报表 → 商品报表 (`item_promotion`), set yesterday, 30-day cumulative attribution, select 关键词推广 and 人群推广, and in 商品数据明细 select both 商品 and 计划 dimensions before downloading. The dedicated collector asserts this page, filters, date and dimensions before submitting. `--locate-only` runs the assertions without submitting a download.

```powershell
node skills/sycm-promotion-data/scripts/collect-product-report.mjs --shop 盖文淘宝 --date 2026-09-25 --locate-only
node skills/sycm-promotion-data/scripts/collect-product-report.mjs --shop 盖文天猫 --date 2026-09-25 --locate-only
node skills/sycm-promotion-data/scripts/collect-product-report.mjs --shop 盖文淘宝 --date 2026-09-25
node skills/sycm-promotion-data/scripts/collect-product-report.mjs --shop 盖文天猫 --date 2026-09-25
```

This report's CSV schema can differ between Taobao and Tmall. Preserve each downloaded source as-is and compare each shop to its own reference before importing. Do not route these files through the unrelated 71-column 营销场景报表 importer.
