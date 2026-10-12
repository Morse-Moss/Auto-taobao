# 销售1部 8 家 商品数据采集与导入 —— 运行报告

- 执行时间：2026-10-06 12:13:50 ~ 12:24:19（10m29s）
- 命令（原样，未改任何参数）：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify --batches 5 --skip-promotion`
- 目标日：**2026-10-05**（`--date yesterday` 按 Asia/Shanghai 解析；执行日为 10-06）
- runId：`2026-10-05-20261006041350559-1c48d3c8`
- 证据目录：`evidence/product-data-job-2026-10-05/2026-10-05-20261006041350559-1c48d3c8/`
- 收据状态：**FAILED / UNCLASSIFIED**，failedStage=`product-import`
- 退出码：**1**；告警投递：**SENT**
- 分批：2 批（第1批 5 家 / 第2批 3 家），每批跑完即释放

## 1. 两阶段逐店结果

商品底单（源行 / 计划新增 / 重复）：

| 店铺 | 源行 | 新增 | 重复 | 结果 |
|---|---|---|---|---|
| 里可林淘宝 | 23 | 23 | 0 | 写入成功 |
| 网林天猫 | 17 | 17 | 0 | 写入成功 |
| 盖文淘宝 | 54 | 54 | 0 | **无收据/exit 1，但数据已落库（见 §4）** |
| 盖文天猫 | 50 | 50 | 0 | 写入成功 |
| 科塔淘宝 | 33 | 33 | 0 | 写入成功 |
| 网林淘宝 | 32 | 32 | 0 | 写入成功 |
| 里可林天猫 | 30 | 30 | 0 | 写入成功 |
| 网林家居 | 4 | 4 | 0 | 写入成功 |

商品合计新增：23+17+54+50+33+32+30+4 = **243**

询单（源行 / 新增 / 重复）：

| 店铺 | 源行 | 新增 | 重复 | 结果 |
|---|---|---|---|---|
| 里可林淘宝 | 5 | 5 | 0 | 写入成功 |
| 网林天猫 | 3 | 3 | 0 | 写入成功 |
| 盖文淘宝 | 10 | 10 | 0 | 写入成功 |
| 盖文天猫 | 10 | 10 | 0 | 写入成功 |
| 科塔淘宝 | 4 | 4 | 0 | 写入成功 |
| 网林淘宝 | 2 | 2 | 0 | 写入成功 |
| 里可林天猫 | 1 | 1 | 0 | 写入成功 |
| 网林家居 | 0（排除 2 行汇总） | 0 | 0 | 无询单数据（非故障） |

询单合计新增：**35**。所有店 plannedRows == sourceRows，**重复拦截 0 条**（首跑，无历史行可撞）。

推广段：**SKIPPED**（`--skip-promotion` 有意跳过，非缺口）。

## 2. 独立回读（不采信链自报）

10 月销售1部 base（`FhCUbn7vVaEc26sRjMAccQJAn5e`）：

| 表 | 写前 10-05 行数 | 写后 10-05 行数 | 真实新增 |
|---|---|---|---|
| 商品表 `tbley1xD9wDfQheX` | 0（base 总 205） | **243**（base 总 448） | **+243** |
| 询单表 `tblenEzSMpp5RTQb` | 0（base 总 29） | **35**（base 总 64） | **+35** |

独立回读与链自报 afterRows 逐值一致（链末 `afterRows`：商品 448 / 询单 64）。

## 3. 登录 / 视口 / 释放

- 登录预检：第1批 5 家、第2批 3 家 **全部 verdict=OK**（生意参谋 + 阿里妈妈均 LOGGED_IN），needHuman=[]、unknown=[]，**无人工闸门**。
- 视口回读：8 家全部 1506x642（阈值 1200x600），**全过**。
- 释放：第1批（5 家）、第2批（3 家）收据均 `released:true`、两次端口回读 listening=0；独立复核 16 个店铺端口（调试 19031-19035/19050-19052 + 代理 19041-19045/19060-19062）**两遍全 free**。
- 本次跑未新增任何 msedge 残体（现存 16 个残体创建时间均为 10-05，早于本次运行）。

## 4. 唯一缺口的定性：盖文淘宝/底单 导入失败 = UNKNOWN_WRITE（实际已写入）

- 现象：`product-import/` 目录为空（无 receipt.json），子进程 exit 1，链记 `盖文淘宝/底单 导入失败`。
- 独立取证：
  - 源文件 `【生意参谋平台】商品_全部_2026-10-05_2026-10-05 (2).xls` 解析出 **54 条合规数据行**；
  - base 行数链条 245（网林天猫写后）→ **299**（盖文天猫写前）+54，中间只夹着盖文淘宝这一次导入；
  - 交叉核对：源文件 54 个商品ID **全部已在** base 的 10-05 记录里（缺 0）。
- 结论：**54 行全部写入成功**，失败发生在写后的 afterRows 回读/落收据环节（典型 UNKNOWN_WRITE，写入已发生但收据未落）。
- 按文档口径：先回读再决定是否重试 —— 回读显示数据完整，**不建议重试**（重试会被同日去重闸门拦成 0 行）。

## 5. 开工前既存项（本次未动）

- 运行锁目录 `runtime/.workflow-locks/` 开工时为空（运行中曾出现 `merchant-automation.json`，跑完已释放）。
- 遗留监听端口：`19023`（日报共享代理 pid 140236）、`19063`（保拉淘宝孤儿代理 pid 78316）——均为 10-05 遗留，与本链 8 家无关。
- 16 个 msedge 残体（gaiwen-flagship / wanglin-custom / likelin-home / suixin-custom / paola-taobao / edge-daily-report）——10-05 遗留，未动。

## 6. 该次运行期间未做

- 运行期间未改动仓库任何代码或配置；未重启/停止任何非本链进程；未删除锁文件；未重跑；未对失败店做任何写入重试。
- 后续的根因追查与代码修复发生在运行结束之后（见 §7、§8）。

## 7. 根因追查（12:39，只读取证）

- **报错原文**（`tmp/product-run-20261006.log:395`，紧接「网林天猫 询单已写入」之后）：
  `导入失败：Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
  **why 在那里**：`run-product-data-job.mjs` 的 `run()` 默认 `stdio: inherit`，而导入那两步没传 `capture:true`
  ⇒ 子进程 stderr 直接落进父进程 stdout，被这次的重定向文件接住（`job.log` 里只剩一句「失败（exit 1）」）。
- **真身**：`skills/xws-to-feishu-base/scripts/feishu-client.mjs` 的 `#request` 是
  **先 `await response.json()`、后判 `response.ok`** ⇒ 服务端回 HTML（网关 5xx / 限流拦截页）时在 `json()` 处就抛，
  **真实 HTTP 状态码被吞掉**，事后分不清 429 与 502/503。
- **卡在哪一步**：`import-product-data.mjs` 的顺序是
  `listRecords`(读到 245) → `batchCreateRecords`(54 条，落库) → **再 `listRecords` 算 afterRows（此处抛）**
  → `writeFileSync(receipt.json)`（**没跑到**）。
- **耗时对照**：其他 7 家底单导入各约 8 秒，盖文淘宝 64 秒（04:18:12 → 04:19:16）——
  差额就是那次坏响应的等待/重试。

## 8. 收尾动作（12:46 起，经用户同意）

### 8.1 重建该笔导入的对账收据

`盖文淘宝/product-import/RECONCILED-RECEIPT.json` —— **不是**导入脚本的原始产出：
文件名与 `receipt.json` 区分，并带 `receiptKind: RECONCILED` 与 notice，避免被清点工具误认成原始收据。

- sourceRows 54 / existingRows 245 / plannedRows 54 / afterRows 299
- 锚点：前驱＝网林天猫 receipt 的 `afterRows` 245；后继＝盖文天猫 receipt 的 `existingRows` 299
- 现场回读：base 上 10-05 共 243 条，源文件 54 个商品ID **缺 0**
- `recordIds: null` —— 原始响应里的 ID 随进程一起丢失，不可重建
- 重建脚本：`tmp/rebuild-gaiwen-taobao-receipt-1005.mjs`（只读源文件 + 只读 base）

### 8.2 三处代码修复（防复发）

| 位置 | 改动 |
|---|---|
| `skills/xws-to-feishu-base/scripts/feishu-client.mjs` | 新增私有 `#readPayload`：**先取正文、再尝试解析**；`#tenantToken` 与 `#request` 两处都改。非 JSON 时抛 `Feishu API failed: <真实状态码> non-JSON body: <正文片段>` |
| `skills/sycm-product-data/scripts/import-product-data.mjs` | 收据落盘提到「写后回读」**之前**；回读失败不再让收据消失（写入 `readbackError`），并以 **exit 2** 收场 |
| `scripts/run-product-data-job.mjs` | 新增唯一翻译处 `importOutcomeOf()`：exit 2 ⇒ 缺口带「阶段名 + 未知」⇒ `classifyWorkflowError` 归 **UNKNOWN_WRITE**（原为 FAILED/UNCLASSIFIED）；exit 1 仍记「导入失败」 |

三者合起来的效果：下次再遇到同样的坏响应，会**留下收据**、报 **exit 2**、整轮分类为 **UNKNOWN_WRITE**，
而不是「无收据 + exit 1 + UNCLASSIFIED」。

### 8.3 判据与证据

- 新增 `runtime/product-data-import-outcome-wiring.test.mjs`（6 条）：纯函数 + 「文案 → 分类」跨模块接线 + 收据落盘顺序的结构守卫
- `skills/xws-to-feishu-base/tests/feishu-client.test.mjs`：假 Response 补 `text`；新增 2 条（读/认证接口收到 HTML 时带出真实状态码）
- `node --test "runtime/*.test.mjs"` ⇒ **1033 / 1033 通过 / 0 失败 / 20.3s**
- `node --test "skills/sycm-product-data/scripts/*.test.mjs"` ⇒ 6 / 6
- `node --test runtime/product-data-import-outcome-wiring.test.mjs skills/xws-to-feishu-base/tests/feishu-client.test.mjs` ⇒ 10 / 10
- **突变验证**（`tmp/mutation-check-feishu-client.mjs`）：把两处调用还原成老写法 `response.json()` ⇒ 恰好那 2 条判据变红，
  原文已恢复 ✓ —— 证明判据不是恒绿的摆设（本仓在缺陷⑭上吃过这个亏）
- `node scripts/check-fast.mjs` ⇒ PASS（25 个 changed JS 文件）

### 8.4 未做（等点头）

- **未提交、未推送**。工作区里有**别人未提交的 25 个文件**（xws-export-market-analysis 那批 + `run-collection-host.mjs` 等，
  mtime 10-01 15:42）⇒ 提交必须走显式路径，且范围要单独确认。
- `npm run test:staged` **未跑**：选中 `xws-to-feishu-base` 的实现变更会拉起该 skill 的整套测试（含 spawn 真 CLI 的 e2e），
  2026-09-25 实测同类选择跑了 **7.6 小时** ⇒ 不在这轮跑（记忆里也有「09-29 实测 39 分钟零写入」的先例）。
