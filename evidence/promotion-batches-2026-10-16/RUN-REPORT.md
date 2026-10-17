# 推广日报补跑（2026-10-16）· 换组织后第一轮真写

- 目标日：2026-10-16（数据日期，阿里妈妈关键词/人群）
- 命令：`node scripts/run-batches.mjs --workflow promotion-daily --date yesterday --batch-size 5 --mode apply --notify --logs evidence/promotion-batches-2026-10-16`
- runId：`promotion-daily-2026-10-16-86f0df04-b2b7-4e4e-bd7c-fa3d3c5ccebb`
- 起止：2026-10-17T03:53 → 04:25（本地 11:53 → 12:25），32m05s，**退出码 0**
- 代码：1.12.2（`1b8b8be`）—— 本轮是该链在 rcnb 新 base 上、用 rcnb 凭据的**第一次真写**

## 一、结论

两批全绿，8 家全部成功，关键词 307 行 + 人群 202 行写进「10月推广数据-销售1部」，
对账门 `ok=true`、退出码 0、`gaps` 为空。完成提醒已送达（`promotion-ok-20261016` / SENT）。

## 二、逐店（源行数 / 写入行数 / 跳过）

| 店铺 | 关键词 | 人群 |
| --- | --- | --- |
| 里可林淘宝 | 43 / 43 / 0 | 19 / 19 / 0 |
| 网林天猫 | 11 / 11 / 0 | 26 / 26 / 0 |
| 盖文淘宝 | 22 / 22 / 0 | 18 / 18 / 0 |
| 盖文天猫 | 73 / 73 / 0 | 61 / 61 / 0 |
| 科塔淘宝 | 52 / 52 / 0 | 18 / 18 / 0 |
| 网林淘宝 | 55 / 55 / 0 | 33 / 33 / 0 |
| 里可林天猫 | 51 / 51 / 0 | 19 / 19 / 0 |
| 网林家居 | **0 / 0 / 0** | 8 / 8 / 0 |
| **合计** | **307** | **202** |

每家收据里的 `credentialFile` 都是 `E:/小红书/.env.feishu-rcnb.local`（凭据按目标取，已生效）。

## 三、独立回读（跑前/跑后各量一次，直读两张表）

| 表 | 总行数 | 目标日 2026-10-16 | 差额 |
| --- | --- | --- | --- |
| 关键词 `tblSPWt8ZBs0iL7f` | 516 → 823 | 0 → 307 | **+307** |
| 人群 `tbl7CUAdPMKJwKYp` | 666 → 868 | 0 → 202 | **+202** |

两次差额与逐店收据合计**逐项相等**（307=307、202=202），对账门的 `roundCounts` 三处同值。

## 四、对账门（`check-promotion-completeness.mjs --date 2026-10-16`）

- `ok=true`、退出码 0、`receipts=8`、`gaps=[]`
- 唯一零量项：`网林家居 / keyword`，`ZERO_CONFIRMED`（`plannedRows=skippedRows=0`）——
  回执实证平台当日确实为空，按既有口径交人工确认一次，**不当成功也不当故障**。

## 五、闸门、释放与提醒

- 前置闸：最近一轮（`promotion-batches-2026-10-15`）两批 chainStatus=0、无 CDP eval SyntaxError ⇒ 允许执行。
- 登录预检：两批均退出码 0（`login-preflight-b1/b2.json`）。
- 视口：`viewport-b1/b2.json` 均通过。
- 批次：两批 `chainStatus=0`、`decision.release=true`（全绿按计划收掉）。
- 释放：16 个店铺端口 `Get-NetTCPConnection -State Listen` **两轮**回读全 free（`listening_lines=0`）；
  `browser-inventory` 判 8 家「整套缺」。19022/19023 是今早 07:00 日报链的共用商家浏览器，非本链。
- 全局锁：跑前不存在，跑后 `NO_LOCK`。
- 重试：`里可林淘宝 / audience-submit` 重试 1 次后通过（该店单阶段保护性重试，属已知非故障）。

## 六、证据

- `batches.json` / `batches.log`、`b1|b2/summary.json`、`b1|b2/<店>/receipt.json`
- `login-preflight-b1|b2.json`、`viewport-b1|b2.json`
- 统一回执：`D:\Retire\sycm-automation-runs\promotion-daily\2026-10-16\<runId>\run-receipt.json`
- 回读基线：`tmp/promotion-daily-baseline-2026-10-16-pre.json` / `-post.json`
