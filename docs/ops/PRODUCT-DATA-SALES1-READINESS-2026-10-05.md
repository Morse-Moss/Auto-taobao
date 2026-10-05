# 商品数据链「销售1部」自动化就绪度评估

日期：2026-10-05（20:5x 更新）　评估人：接线员
范围：`scripts/run-product-data-job.mjs`（商品底单 / 商品询单 两段；推广段本阶段有意跳过），对象＝销售1部 8 家

---

## 一、结论

**可以开始收集，但不能直接开定时。** 建议按「排练 → 小批真写 → 全 8 家 → 才改定时任务」四步走。

原本的 1 个明确堵点（推广段写错 base）**已用「显式跳过」闸门解掉**（选项 b，2026-10-05 落地，代码 + 5 条守卫）；
另外补上了文档里一直记为「尚未做」的**视口回读闸门**。这两件事做完之后，剩下的全是
**「没真机跑过的组合」**，不是已知缺陷：

| 类别 | 内容 | 处置 |
|---|---|---|
| 已解 | 推广段会把 10 月数据写进 9 月 base | `--skip-promotion`：采集与导入**两段都不做**，收据记 `SKIPPED` |
| 已解 | 窗口被屏幕尺寸夹窄时采集脚本只会报一堆 `not-hit` | 起完实例回读视口，不达标停在 `start` 段 |
| 未验 | 「8 家 × 10 月 base」这个组合一次都没真机跑过（上次成功是 2026-09-28，5 家、9 月 base） | 第 1、2 步验收 |
| 未验 | 3 家（网林淘宝 / 里可林天猫 / 网林家居）从没跑过商品链 | 第 1 步特意各选一家 |
| 未验 | 09-29 改的运行锁（`3f282dc`）在这条链上没跑过 | 第 1 步就会走到 |
| 待办 | 定时任务的名字 / rrule / prompt 三处口径不一致 | 第 4 步统一 |

**把握度自评：约 90%，不到 95%。** 差的 5 个百分点全部来自上表三行「未验」——
它们只能靠真机跑一次来消，靠读代码消不掉。所以建议**先跑第 1 步（约 20 分钟、只读不写飞书）**，
它同时验掉「新店」「8 家 × 10 月 base」「运行锁」三件事；跑过再决定要不要往真写走。

---

## 二、已经就绪的部分（每条都有可核对依据）

| 项 | 状态 | 依据 |
|---|---|---|
| 范围口径 | OK：默认就是销售1部 8 家 | `buildProductJobPlan` 默认取 `collectingShopKeys()`；实测展开＝里可林淘宝/网林天猫/盖文淘宝/盖文天猫/科塔淘宝/网林淘宝/里可林天猫/网林家居 |
| 8 家 → 飞书落点 | OK：8/8 全部解析到 10 月销售1部 base | 只读实跑 `productDataTargetsForShop(店, '2026-10-04')`：8 家全得 `FhCUbn7vVaEc26sRjMAccQJAn5e`「10月商品监控表-销售1部」，商品表 `tbley1xD9wDfQheX`、询单表 `tblenEzSMpp5RTQb` |
| 10 月 base 的**写**权限 | OK：应用是 full_access | 只读查协作者表：`appid cli_a96ee8749078dbcf perm=full_access` |
| 10 月两张被写表的形状 | OK：与 9 月逐字段零差异 | 2026-09-30 只读 diff：商品底单 73 列、询单底单 14 列，缺 0 / 多 0 / 类型差异 0 / 顺序一致；2026-10-05 复核字段名逐字一致 |
| 10 月 base 的**写前基线** | OK：1 / 1 / 19，全是 8~9 月残留行 | 只读分页数：商品底单 1 行（2026-08-31）、询单底单 1 行（2026-09-27）、推广表 19 行（2026-08-31 ×1 ＋ 2026-09-29 ×18）。**没有任何 10 月的行** ⇒ 第一次真写的新增行是可数的 |
| base 是否需要「店铺」选项 | 不需要 | 商品与询单底单里**没有**店铺字段；店名只进导入收据的 manifest，不写字段 |
| 8 家身份 | OK | `SHOP_IDENTITIES` 13 条；8 家的 `sycmHeader` 齐全（实测值，非派生） |
| 环境预检 | OK：今天实跑通过 | `node` / `python` / 飞书凭据 / 端口唯一（28 个店铺端口）/ 项目根，5 项全 PASS |
| 分批形态 | OK：每批只起本批，跑完立刻释放 | `runRound` 内 `start-all.mjs --only <本批>`；释放按批走 `release-product-data-browsers.mjs --shops <本批>`。**与日报链那个「`--batches` 不分批起实例」的缺口不同，这条链是真分批**（2026-10-05 逐行核对 `scripts/run-product-data-job.mjs` 的 `startAll` 调用点在 `for (const round of rounds)` 循环体内） |
| 定时入口的默认命令 | OK | `renderProductJobEntry` 默认渲染 `--batches 5`＋`--skip-promotion`；定时任务的 prompt 已同步改（仍 PAUSED） |
| 视口闸门 | OK：新落地并已在真实例上读通 | `runtime/shop-viewport-gate.mjs`；真实例只读实测盖文天猫 `1528x732 / dpr 1.25`、网林家居 `1506x642 / dpr 1.25`，均达标；孤儿代理（保拉淘宝 19063，浏览器已不在）被正确判 `VIEWPORT_UNREADABLE` |
| 跨部门批量导入缺陷（已知 07） | 对本范围不咬 | 8 家全属 sales1，每批内部同一个 base；该缺陷只在「一批里跨部门」时发作；推广段的批量调用已整段跳过 |
| 守卫测试 | OK：60/60 | `shop-viewport-gate` 12 ＋ `product-data-skip-promotion-wiring` 5 ＋ `product-data-job-core` ＋ `product-data-batch-release-wiring` ＋ `product-data-path-sync-spawn-guard` ＋ `arch-boundary` ＋ `version-consistency` ＋ `environment-preflight` ＋ `browser-ports` |

---

## 三、推广段：已按选项 (b) 处理，不是「照旧跑」

**做过的事：** 给链加了一个显式的「本阶段不做推广」闸门（`--skip-promotion`），
采集段整段 `continue`、导入段整段进 else 分支跳过，收据里记 `SKIPPED`（第四个状态词），
缺口归因里**不记**推广缺口 —— 否则链会被自己的闸门判成失败。

**没做的事（有意）：** `import-promotion-data.mjs` 的目标**仍是 9 月的 base**
（`DQ2DbRinJaDx8Ss4gVFczsTXn3d` 的 `tblaCPQMLWAq21Gw`，只读实测 2750 行、`2026-08 × 123` ＋ `2026-09 × 2626`、无 10 月行）。
按你说的「推广线还在分支开发，先不管」，这次不改造它，只保证**不会顺手跑到它**。

**到期条件（写在代码注释里）：** 推广链接上 main 之后，把 `renderProductJobEntry` 的
`skipPromotion` 默认值翻回 `false`，并同步改 `product-data-job-core.test.mjs` 里那条
「定时入口必须带 `--skip-promotion`」的断言 —— 那条断言就是这条闸门的到期提醒。

---

## 四、定时任务的现状（要一起拍板）

- ID `c4c5cd7d-6abb-4b98-9658-f12c5a8e6748`，名字「sycm 商品数据定时（**每日 18:00**）」，
  实际 rrule 是 `FREQ=DAILY;BYHOUR=22;BYMINUTE=8` —— **名字与实际计划不一致**。
- 状态 **PAUSED**（本次没有启用它）。
- prompt 已于 2026-10-05 20:5x 更新：家数改 8、命令加 `--batches 5 --skip-promotion`、
  端口清单改成 8 家的真实端口、汇报口径改成「两段 + 推广 SKIPPED」。
- **要你拍板的两件事：** ① 名字（18:00）与 rrule（22:08）留哪个；② 什么时候启用。

---

## 五、建议的开工顺序（每步都有验收判据）

**第 1 步 · 排练（约 20 分钟，不写飞书）**
`--shops 盖文淘宝,网林家居`，**不带** `--commit`。
选一家老店 + 一家新店：新店的采集路径是这条链上唯一完全没跑过的部分。

验收：两家两类都拿到文件；导入收据 `mode=dry-run`；收据里的 base 字段显示「10月商品监控表-销售1部」；
`viewport.json` 两家都 PASS；进程结束时端口两次回读为空。

**第 2 步 · 真写一小批（约 1 小时）**
同上两家，加 `--commit`。

验收：独立回读 10 月 base 的商品底单与询单底单，能数到新增行（基线 1 / 1）；
两家的 release 收据 `released` 非 `false` 且端口两次回读为空。

**第 3 步 · 全 8 家**
`--date <目标日> --commit --notify --batches 5 --skip-promotion`。

验收：8 家两段齐全、`gaps` 为空、退出码 0、推广段 `SKIPPED`；再回读 10 月 base 行数。

**第 4 步 · 改定时任务**
把名字与 rrule 对齐、确认 prompt 里的家数与参与采集口径一致，再取消 PAUSED。

---

## 六、开工前先确认的两件事

1. **有没有别人在跑**：查运行锁 `runtime/.workflow-locks/merchant-automation.json` + 端口盘点（只读）。
   2026-10-05 20:49 只读实测：**锁目录为空**，监听中的只有盖文天猫（19035/19045）、网林家居（19052/19062）、
   商家浏览器（19022/19023），外加一个**孤儿代理 19063**（保拉淘宝的浏览器已不在）。
   商品链与日报链共用同一把锁名 `merchant-automation`，所以 15:30 的日报没结束就不该开工。
2. **9 月表要不要先兜底**：本次只读已确认 9 月推广底单里没有 10 月的行，暂时干净；
   `--skip-promotion` 之后这条已经不需要依赖了。

---

## 七、需要人工协助的点（跑之前对齐，别等跑起来才发现）

| # | 事项 | 为什么需要人 | 谁来做 |
|---|---|---|---|
| 1 | **8 家店铺浏览器的登录态** | 只有 2 家（盖文天猫、网林家居）现在活着；其余 6 家冷启动后登录态未知。掉登录 ⇒ 链停在 `login-preflight`，**整批一步都不跑** | 你（或我按 SOP §11 跑 `login-merchant.mjs --commit`，登录墙只能人过） |
| 2 | **3 家新店（网林淘宝 / 里可林天猫 / 网林家居）的生意参谋页面** | 从没跑过商品链；「商品」导出与「询单」报表在这三家是否都有、权限够不够，没验过 | 第 1 步排练就会暴露；提前知道能省一轮 |
| 3 | **10 月 base 里那 20 行 8~9 月残留行要不要清** | 商品底单 1 行(08-31)、询单底单 1 行(09-27)、推广表 19 行(08-31×1/09-29×18)。留着不影响 10 月写入（去重按「统计日期+店铺+商品ID」），但会让「这表是不是干净的」每次都要重新解释 | 你定（推荐：留着，不改既有数据） |
| 4 | **定时任务的名字与 rrule 对齐** | 名字说 18:00、实际 22:08 | 你定留哪个 |
| 5 | **孤儿代理 19063（保拉淘宝）** | 浏览器已不在、代理还活着。它不在 8 家范围内，但会让端口盘点出现「有条目但没有对应窗口」 | 你定是否清（我不动存活进程） |

---

## 附：本次评估用到的只读证据

- 代码：`runtime/product-data-job-core.mjs`、`scripts/run-product-data-job.mjs`、
  `runtime/shop-viewport-gate.mjs`、`runtime/browser-ports.mjs`、
  `runtime/feishu-targets.mjs`（`SHOP_DEPARTMENTS` / `PRODUCT_DATA_MONTH_BASES` / `productDataTargetsForShop`）、
  `skills/sycm-promotion-data/scripts/import-promotion-data.mjs`
- 历史成功产物：`evidence/product-data-job-2026-09-28/<runId>/run-receipt.json`（COMPLETED，5 家，9 月 base）
- 本次只读探针（临时，未入库）：`tmp/probe-oct-base-rows.mjs`（10 月 base 行数与日期分布）
- 真实例视口回读：`node runtime/shop-viewport-gate.mjs --shops 盖文天猫,网林家居,保拉淘宝 --json`
- 前天取证目录：`D:/Retire/probe-20260930/`（10 月 base 只读取证、字段签名比对）
