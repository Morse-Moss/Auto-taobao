---
name: sycm-product-data
description: Collect daily 商品排行 reports from logged-in shop SYCM browsers and append deduplicated rows to the authorized Feishu 商品数据底单.
---

# 生意参谋商品数据底单

This flow uses one isolated shop browser per store. It logs in through the browser's native autofill, verifies the SYCM header identity, opens 商品排行, selects 日, clicks 下载, parses the downloaded XLS, and appends only missing `统计日期 + 店铺 + 商品ID` rows to the authorized Feishu table.

统一流程的第一步必须调用日报流程已有的自动登录守卫；它会串行处理店铺，失败时复用既有飞书告警并停止后续采集：

```powershell
node skills/sycm-product-data/scripts/login-preflight.mjs
```

默认覆盖日报流程已经跑通且有隔离实例的五家店：里可林淘宝、网林天猫、盖文淘宝、盖文天猫、科塔淘宝；也可以用 `--shops` 显式缩小范围。

只有收据为 `ALL_IN` 且退出码为 `0` 才能继续三类数据采集。验证码、风控或需要人工处理时保持停止，不绕过平台控制。

采集：

```powershell
node skills/sycm-product-data/scripts/collect-product-report.mjs --shop 盖文淘宝 --date 2026-09-23
node skills/sycm-product-data/scripts/collect-product-report.mjs --shop 盖文天猫 --date 2026-09-23
```

导入前先 dry-run；只有确认计划后才使用 `--apply`：

```powershell
node skills/sycm-product-data/scripts/import-product-data.mjs --file "C:\Users\Administrator\Downloads\商品报表.xls" --shop 盖文淘宝
node skills/sycm-product-data/scripts/import-product-data.mjs --file "C:\Users\Administrator\Downloads\商品报表.xls" --shop 盖文淘宝 --apply
```

生意参谋报表是最新来源；商品信息底单只用于辅助信息，不能阻止新商品上传。目标表使用项目登记的 kcne 凭据和固定授权表。批量写入后必须回读验证，登录、验证码、风控和身份不一致都 fail-closed。
