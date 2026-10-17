# 商品数据补跑（2026-10-16）· 凭据修好后第一轮

- 目标日：2026-10-16
- runId：2026-10-16-20261017030520521-6570da99
- 命令：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5`
- 结束：2026-10-17T03:31:16Z（本地 11:31），耗时 25m57s，退出码 **1**
- 版本：1.12.2（凭据按目标解析 + 目标连通性开工前预检 + 导入失败原因入库）

## 一、结论

三段数据**全部进表**，但这一轮本身仍以失败收尾，两处缺口都已定位并补齐：

1. `里可林淘宝/推广` 采集失败：同一业务日第二次提交导出任务，阿里妈妈没有生成新任务
   （`added: []`），链判「无法唯一确认」⇒ 该店推广未采到。
   **已用上一轮（10:09）已采集的同一份 ZIP 补导**（`商品报表_20261017_101352.zip`，
   16 行、日期全为 2026-10-16），收据落在本目录 `promotion-import/里可林淘宝/receipt.json`。
2. `推广 sales1 批量导入失败`：**写其实成功了**（3 家 46 行已进表），死在写后回读。
   旧的推广导入器没有「先落收据、回读失败用 exit 2」这条纪律 ⇒ 主链把它当普通失败，
   又逐店重试了一遍（幂等，0 行），于是那 3 家的收据反而显示 `plannedRows=0 / duplicateRows=25`。
   这一轮已修（推广导入器补齐 exit 2，主链遇到 exit 2 不再逐店重试）。

## 二、逐段事实（源行数＝采集文件里的行数；计划行数＝去掉重复后的新增）

| 店铺 | 商品底单 | 询单 | 推广 |
| --- | --- | --- | --- |
| 里可林淘宝 | 20 | 5 | 16（补导） |
| 网林天猫 | 23 | 3 | 13 |
| 盖文淘宝 | 49 | 6 | 16 |
| 盖文天猫 | 44 | 11 | 26 |
| 科塔淘宝 | 27 | 6 | 20 |
| 网林淘宝 | 43 | 5 | 25 |
| 里可林天猫 | 28 | 1 | 17 |
| 网林家居 | 5 | 0 | 4 |
| **合计** | **239** | **37** | **137** |

网林家居询单 0 行是历史已知现象（平台空态，不填 0）。

## 三、独立回读（跑前/跑后各量一次，用 rcnb 组织凭据直读三张表）

| 表 | 总行数 | 目标日 2026-10-16 | 差额 |
| --- | --- | --- | --- |
| 商品底单 `tblvmGJfOL4OBYek` | 3486 → 3725 | 0 → 239 | **+239** |
| 询单 `tblb1uK5zQYd8yOq` | 774 → 811 | 1 → 38 | **+37** |
| 推广底单 `tblDxXenp3vSg2SM` | 1916 → 2053 | 0 → 137 | **+137** |

询单目标日的「1」是跑前就存在的空骨架行，不是本轮写的。三次差额与逐店源行数合计**逐项相等**。

## 四、闸门与释放

- 飞书目标预检（本轮新增，起浏览器之前）：1 张 base、3 张表全 `OK`（商品 73 / 询单 39 / 推广 82 字段），
  凭据文件 `E:/小红书/.env.feishu-rcnb.local`。见 `feishu-targets-preflight.json`。
- 登录预检：两批 `ALL_IN`，`needHuman` 为空；第二批先返回 3（有站点读不到）⇒ 补页后复查通过，未重登。
- 视口：8 家全 1506x642。
- 释放：两批 `release-b1/b2.json`；16 个端口用 `Get-NetTCPConnection -State Listen` **两轮**回读
  全部 free（`SUMMARY listening_lines=0`）。`browser-inventory` 判 8 家「整套缺」，
  19022/19023 是今早 07:00 日报链起的共用商家浏览器，非本链。
- 全局锁：跑前不存在、跑后已释放（`NO_LOCK`）。全程未起停任何非本链进程。

## 五、收据与分类

`run-receipt.json`：`status=FAILED`、`failure.class=TRANSIENT_EXTERNAL`（`EXTERNAL_RETRYABLE`）、
`failedStage=promotion-import`；stages：product COMPLETED / inquiry COMPLETED / promotion FAILED。

**分类偏差已在同轮修掉**（代码层）：上一轮 24 次 403/91403 被归成 `FAILED/UNCLASSIFIED`，
根因是导入失败原因没进缺口文案（只写「导入失败」四个字）。现在：

- 导入失败会带上子进程那句原话，并**跳过源码回显**（上一版截断预算全花在
  `throw new Error(\`Feishu API failed: ${response.status}…\`)` 这行模板上，状态码看不到）；
- `classifyWorkflowError` 认 403 / 91403 / 1063004 / 凭据 ⇒ `HUMAN_REQUIRED`；
- 推广导入器补齐「写已发生 ⇒ 先落收据 ⇒ 回读失败 exit 2（UNKNOWN_WRITE）」。

## 六、本轮改动（版本 1.12.2）

见 `CHANGELOG.md` 1.12.2 条。要点：`targetCredentials(target)` 成为按目标取凭据的唯一入口；
两张注册表每条必须显式登记 `envFile`（启动就红）；四个写入口 + 推广对账器切换；
开工前目标连通性预检；导入失败原因与分类修复；推广导入器的 UNKNOWN_WRITE 纪律。

## 七、证据清单

- `job.log`、`feishu-targets-preflight.json`、`environment-preflight.json`
- `collection-b1.json` / `collection-b2.json` / `collection.json`
- `login-preflight-b1.json` / `login-preflight-b2*.json`、`viewport-b1.json` / `viewport-b2.json`
- 每店 `product-import/receipt.json`、`inquiry-import/receipt-<店>.json`
- `promotion-import/<店>/receipt.json`（含补导的 `里可林淘宝`）
- `release-b1.json` / `release-b2.json`、`run-receipt.json`、`alert.json`
- 凭据幂等写探针：`evidence/credential-fix-20261017/probe.json`

## 八、事后处置（2026-10-17，版本 1.12.3）

1. **同日重跑自愈**（本节上面「结论」第 1 条的永久修复）：阿里妈妈对相同参数重复提交不生成新任务
   ⇒ 采集侧改为复用平台已在册的**提交当天**任务，并由导入器的**逐行日期**校验兜底。
   仅离线判据（定向 664/664、`runtime/*.test.mjs` 1338/1338、突变 5/5），
   首次真机验证要等下一次「同一业务日重跑」。
2. **网林家居 / 关键词 0 行**（推广日报链 10-16 那轮的对账结论，见
   `evidence/promotion-batches-2026-10-16/RUN-REPORT.md`）：`ZERO_CONFIRMED`，
   `plannedRows=skippedRows=0`，即平台当日真实为空、不是漏采。**本报告记为已确认项**，
   后续同一家店若连日重复出现同一结论，再考虑做「常空名单」，不在此之前另建登记表。
3. **补发完成提醒**：本轮失败告警已于 `2026-10-17T03:31:17Z` 发出（`alertId=product-round-20261016`，
   `SENT`），但当时两处缺口尚未补齐。补齐后补发一条「已恢复」（`product-ok-20261016`），
   免得收信人以为 10-16 仍然缺数据。

