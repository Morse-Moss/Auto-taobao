# 第五家「盖文天猫」补采 09-18（2026-09-19 下午，用户登录后）

## 为什么有这一轮

用户 2026-09-19 13:40 回了一句「登录了」——指的是上一轮新建的第五个隔离窗口
（标题「盖文天猫 · 日报采集窗口」，profile `gaiwen-flagship`，19035／代理 19045）里登了商家号。
按上一轮说定的三件事接着做：① 读两侧身份、升级登记表；② 补采 09-18 这一家；③ 回读确认没串店。

## 一、身份：两侧都读到，登记表升到 `expression`（提交 `eadad75`）

表达式**从仓库源码 import**（`collect-core.mjs` 的 `sycmShopIdentityExpression` / `alimamaIdentityExpression`），
不在探针里另写一份 —— 避免「验的是另一套」。

| 站点 | 读回 | 期望（登记表） | 判据 |
| --- | --- | --- | --- |
| 生意参谋页头 | `盖文旗舰店 主店` → `盖文旗舰店` | `盖文旗舰店` | ✅ checked |
| 阿里妈妈页头 | `盖文旗舰店:阿彦 ID：2995200080` | 同上 | ✅ checked（名字与 ID 都对） |

⇒ `sycmHeaderVerified: 'expression'`（原 `'text'`）、`alimamaVerified: 'expression'`（原 `'human-record'`）。
**2026-09-17 人工抄下来的那两个值与实测逐字一致** —— 人工记录这次是对的，但在此之前它只能算
`human-record`：判据必须来自可复现的读法。`shop-identities.test.mjs` 里那张「谁还没验到表达式级」的
显式清单随之清空（断言保留：以后再有新店会当场点名）；另有一条家数断言 `expression == 4` 同步改成 5。
日报技能段复跑 **151 / 151**。

## 二、预检：补两个工作页（跑批前置，不是新能力）

体检要「两个必需页面各恰好一个」，而现况是：

- 商家浏览器（19022/19023）：只剩一页 `sycm.taobao.com/portal/home.htm`，**工作页与飞书底单页都不在**；
- 盖文天猫（19045）：生意参谋停在 `portal/home.htm`（阿里妈妈页已在）。

处置：把「同一主机下唯一的那一页」导航到工作页（生意参谋回位地址取自 `date-picker` 的 `SITES`），
飞书底单页按 `?table=&view=` 新建。补后逐项回读：商家浏览器 生意参谋 1 ✅ 飞书 1 ✅；盖文天猫 生意参谋 1 ✅ 阿里妈妈 1 ✅。

**踩到的一个坑（记下来）**：第一版补页脚本从 `dailyReportTargets()` 里取了 `tableId` / `viewId`，
而它实际的字段名是 **`sourceTable` / `sourceView`（还有 `inquiryTable`）** ⇒ 建出来的飞书页是
`?table=undefined&view=undefined`（飞书把它重定向到了另一张表）。用既有探针 `90-fix-feishu-page.mjs`
（值全部从出版登记表读）重新导航并**回读** `table=tblkY3W8tnPWPcnh view=vewwg0rhjo` 一致 ✅。
教训：**飞书目标的字段名不能按常理猜**（同族坑：包装层 `fieldName` vs 裸 OpenAPI `field_name`）。

## 三、排练（`rehearse`，一个字节都不写飞书）

`node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date 2026-09-18 --shops 盖文天猫 --allow-missing-peer`

11 个阶段全跑通，结论 `ok`。三个关键自证点：

1. **日期自证**：`date-picker --site sycm` 报 `mode: preset`、点了「1天」、`observedAfter: 统计时间 2026-09-18`
   ⇒ 回填读的那张表**确实是 09-18**（不是靠参数推断的）。
2. **源产物自证**：xlsx `日报_20260919_adc987ef…xlsx`（hash 段 `adc987ef` ＝ 盖文旗舰店），
   push 干跑 `shopName: 盖文旗舰店`、`targetOnlyPromotionFieldsBlank: true`。
3. **降级开关这次没用上**：回填干跑 `degraded: null`（同行同层行读到了）。
   原因是 **09-18 就是「昨天」**，SYCM 的「1天」预设仍带同行同层行 —— `--allow-missing-peer`
   是给「目标日不是昨天」的补跑准备的（09-19 补 09-18 恰好在边界内）。开关照给不影响结果。

两条 `[留空]`（`UV价值` / `无线端UV价值`）是老坑的正常形态：数据源给文本 `NULL`、数字列存不下 ⇒
**留空 + 留痕，不写 0**。

## 四、真跑（`--commit`）

| 阶段 | 结果 | 数字 |
| --- | --- | --- |
| push（底单新增一行） | `COMMITTED_AND_VERIFIED` | `recordCount 1883 → 1884`，新行 `recvvDTtfI0os0`，校验 241 字段 |
| backfill（询单表两个字段） | `COMMITTED_AND_VERIFIED` | `recvtXeynRd8yM`：询单量 **12**、同层同行询单量 **35**，`unchangedOtherFields: true` |
| readback（独立通路） | 底单 09-18 命中 **5** 行（原 4）、询单表 09-18 命中 12 行 | 盖文天猫 = 12 / 35 ✅ |

**没串店的两条硬证据**：

1. 提交前（排练）与提交后的两份 `independent-readback.json` 逐行 diff：
   底单**只新增 1 行**（`统计日期 2026-09-18`、`店铺名称 盖文旗舰店`）、其余 0 行变化；
   询单表**只有 1 行变化**（盖文天猫），其余 11 行逐字不动。
2. 审计表 `daily_report_push_audit` 第 39/40 行：push 走 `19022/19023`（推送段本来就在商家浏览器上）、
   backfill 走 `19035/19045`、`browser_id = edge-shop-gaiwen-flagship`、`shop_name = 盖文天猫`。

## 五、09-18 这一天现在五家齐

| 店铺 | 询单量 | 同层同行询单量 |
| --- | --- | --- |
| 盖文天猫（本轮补） | 12 | 35 |
| 盖文淘宝 | 6 | 6 |
| 里可林淘宝 | 4 | 6 |
| 网林天猫 | 6 | 12 |
| 科塔淘宝 | 5 | 6 |

## 六、还没做的（如实写，别当已完成）

1. **09-19（今天）这一天还没采过任何一家** —— 等用户点头（建议登完第五家后一次跑全部五家）。
2. 回填那条命令**不带身份判据**（没传 `--expect-shop/--expect-member`）—— 这是**既有缺口**，
   不是本轮引入；本轮靠「窗口自己的身份已实测 + 源产物 shop-key 断言」兜住。
3. 盖文天猫窗口里还留着 `about:blank` 与一个 bing 搜索页（用户在登录过程中留下的），未获许可不动。
4. 判据/代码本轮只改了身份登记表与它的两条断言；**runtime 段未重跑**（本轮没碰 runtime 下的文件），
   日报技能段 151/151 是改后复跑的。
