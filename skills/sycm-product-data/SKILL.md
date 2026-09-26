---
name: sycm-product-data
description: Collect daily 商品排行 reports from logged-in shop SYCM browsers and append deduplicated rows to the authorized Feishu 商品数据底单.
---

# 商品数据自动采集

本流程覆盖商品底单、商品询单、商品推广三类数据，支持五家店铺并行采集，并写入已授权的飞书底单。

日常定时入口：

```powershell
node scripts/run-product-data-job.mjs --date yesterday --commit
```

定时调度由 WorkBuddy 负责，不注册 Windows 任务计划。WorkBuddy 每天调用总控入口；自动登录失败会沿用日报流程的飞书告警；三类数据结束后会释放五家店浏览器，并复核端口两次。

This flow uses one isolated shop browser per store. It logs in through the browser's native autofill, verifies the SYCM header identity, opens 商品排行, selects 日, clicks 下载, parses the downloaded XLS, and appends only missing `统计日期 + 店铺 + 商品ID` rows to the authorized Feishu table.

统一流程的第一步必须调用日报流程已有的自动登录守卫；它会并行处理店铺，失败时复用既有飞书告警并停止后续采集：

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

## 生命周期与释放

采集脚本是阶段脚本，不是完整宿主。真实运行必须沿用日报流程的顺序：`start-all --only <店铺>` → `login-preflight --login` → 三类数据采集/导入 → 释放浏览器。释放使用：

```powershell
node scripts/release-product-data-browsers.mjs --shops 里可林淘宝,网林天猫,盖文淘宝,盖文天猫,科塔淘宝
```

封装会委托 `scripts/stop-all.mjs --yes` 做 profile 和进程证据校验，再对每家店的浏览器端口和代理端口各读取两次；不能只依据 stop-all 的退出码判断已释放。

可复用的日报能力：

- `runtime/browser-ports.mjs`：店铺 profile、浏览器端口、代理端口的唯一登记源。
- `scripts/start-all.mjs` / `scripts/stop-all.mjs`：按 profile 验证的启动和 fail-closed 释放。
- `skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs`：五店并行登录检查、自动登录和既有飞书告警。
- `scripts/run-batches.mjs`：批次生命周期模板；商品流程应采用同样的启动、登录、工作、释放顺序。

2026-09-26 五店真实运行最初漏掉释放阶段：导入成功后浏览器和代理仍在监听，随后才执行 stop-all 并做两次端口回读。问题记录在 `evidence/product-five-run-2026-09-25/browser-release.json`。
