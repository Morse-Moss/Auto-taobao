# XWS Three-Round Acceptance - 2026-08-06

Contract: 淘宝首页 -> 小旺神 `浴缸` / 全平台 / 价格从高到低 / 1-3 页 -> CSV + 带图 XLSX -> 飞书独立空测试表 -> API 图片导入 -> API 与浏览器验收。

| Round | Source time | Rows | Embedded images | Feishu table | Records | Attachments | Visual |
| --- | --- | ---: | ---: | --- | ---: | ---: | --- |
| 1 | 21:40 | 138 | 138 | `tblx6ds2EUSLKY9l` | 138 | 138 | thumbnails rendered |
| 2 | 21:56 | 138 | 138 | `tbl3PDOFwRepDGmu` | 138 | 138 | thumbnails rendered after load |
| 3 | 22:03 | 138 | 138 | `tblWvWqgeGRTBCVK` | 138 | 138 | thumbnails rendered |

All three source files use 16 fields and the observed `付款人数` variant. CSV/XLSX match within each round. `付款人数` is preserved as displayed text; no numeric inference is applied.

Cross-round source hashes differ because live marketplace values and result membership changed. Round 1 vs 2 had 59 non-image cell differences across 12 rows; round 2 vs 3 had 84 across 33 rows; round 1 vs 3 had 107 across 36 rows. Treat each round as a timestamped snapshot, not a deterministic static fixture.

Evidence:

- `runtime/xws-api-round1/report.json`
- `runtime/xws-api-round2/report.json`
- `runtime/xws-api-round3/report.json`
- `runtime/xws-api-round1-visual.png`
- `runtime/xws-api-round2-visual-loaded.png`
- `runtime/xws-api-round3-visual.png`
