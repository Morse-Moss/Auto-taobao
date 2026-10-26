# 2026-10-26 收口：停驻留 + 销售2部接入推广明细链

执行人：Morse-Moss　时间：2026-10-26 15:56–16:15（+08）
用户指令：「按你推荐的执行，二部要全面接入系统已有的流程，推广明细链也要接」

---

## A. 停掉 10-25 那一轮的驻留（按用户已同意的推荐执行）

### 事实：驻留等的那个「人处理完了」其实已经发生

三层父子进程（`run-daily-job` 56384 → `run-batches` 56920 → `hold-and-resume` 45928），
14:27:56 起驻留，截止 18:27。每 15 分钟只打印一句
「成因 STAGE_FAILED 没有只读的『人处理完了』判据 ⇒ 不提前续跑」，**它永远不可能提前结束**。

而这一批 5 家的成因，当天都已经修完了：

| 店 | 停在哪 | 成因 | 现状 |
|---|---|---|---|
| 保拉淘宝 | push | `duplicate daily report row exists` | 设计行为（同日不写第二遍），数据已在飞书 |
| 保拉天猫 | push | `expected 71 promotion columns, got 73` | 已修（`45f4159e`：71/73 两种宽度都认） |
| 安比龙头店 | shop-report | 报表行标题不叫「日报」 | 已修（`060b9e4d`：按店登记「报表」/「取数」） |
| 科塔龙头店 | shop-report | 同上 | 已修（`060b9e4d`） |
| 安比淘宝 | promotion-submit / shop-report | 同上 + 平台瞬态 | 已修，三次排练全过 |

也就是说：留着它，只会在 18:27 发一条「等到截止还没等到 ⇒ 收尾」的收尾告警 ——
而那句话与事实相反（早就修完了），并且它会一直占着 `merchant-automation` 锁。

### 处置

只停 45928（驻留本身，无子进程），父链自行收尾：

```
STOPPED 45928
GONE    45928 / GONE 56920 / GONE 56384     ← 6 秒后三层全部退出
[2026-10-26T07:58:16.399Z] --- batch-chain 退出码=1
[2026-10-26T07:58:16.424Z] === 定时任务结束：全链退出码=1；证据目录 evidence/multi-shop-2026-10-25/ ===
```

**没有追加任何告警**：`holdStatus=-1` 不匹配 `HOLD_EXIT` 的任何一档，不触发完成提醒；
失败告警已在 14:27 发过（`daily-round-20261025`）。18:27 那条误导告警不会出现。

锁：`inspectWorkflowLock('merchant-automation')` → `locked:false, stale:false`（代码判据，不是看目录空）。

### 没有做的（需要时再说）

`19053–19057 / 19063–19067` 这 5 对端口仍在监听 —— 那是这一批当时判「不释放、把现场留给修复 agent／人」
的结果。现在这一轮已经收尾，这五个窗口成了纯占内存的残留。**没有动它们**（停存活进程要单独授权）。
今天做验证时正好用上了 19053/19063（保拉淘宝），所以这一步不算白留。

---

## B. 销售2部接入推广明细链

### B0 先纠正一处概念

用户说的「推广明细链」在本仓库有两层，**两层现在都通**：

| 层 | 表 | 写它的链 | 二部状态 |
|---|---|---|---|
| 商品推广数据底单（73 字段，关键词/人群两个场景） | 1 部 `tblDxXenp3vSg2SM` / 2 部 `tbl3SkayTTo9OlJo` | 商品链 10:00（`run-product-data-job.mjs` 的推广段） | **本来就通**：按 `productDataTargetsForShop(店, 日期)` 解析，二部那张早已登记。13 家全采后自动覆盖 |
| 推广日报（关键词数据 78 字段 / 人群数据 74 字段） | 1 部 `CjLs…` / 2 部 `RWux…` | 推广日报链 11:00（`run-promotion-sales1.mjs`） | **原来不通**，本轮接通 |

真正需要改的是第二层。

### B1 起点：三处把「销售一部」写死

1. `runtime/feishu-targets.mjs` 的 `PROMOTION_DAILY_MONTH_BASES` 只有 `2026-10:sales1`；
2. 同文件 `promotionDailyTargets(name, dateInput, department = 'sales1')` —— **带默认值**；
3. `skills/…/run-promotion-sales1.mjs` 里 `const SALES1 = [8 家]` 字面名单 + 导入器不传部门。

第 2 条最危险：默认值即目标。二部接入后任何一处调用漏传部门，数据会**静默写进一部的表**，
而回读、对账门读的也是那张表 ⇒ 全绿、无人发现。

### B2 目标表从哪来（不是猜的）

用户 2026-10-26 10:17 那版《店铺账号信息表.xlsx》（`C:\Users\Administrator\Desktop\运营自动化\`）
第 10 行起写着 G/H 两列「对应飞书推广表格 / 飞书推广表格链接」：

- `10月推广数据-销售1部` → `https://rcnbpuvafkct.feishu.cn/base/CjLsb7qXRaeaC6srePtcLBkInTh`
- `10月推广数据-销售2部` → `https://rcnbpuvafkct.feishu.cn/base/RWuxbD8I3aFBkus3On8cn3sGnBe`

用接口读出二部那张 base 的三个页签：关键词数据 `tbl8XlaVkRtWoi5i`、人群数据 `tbln0U2ocO3MvSIn`、
商品信息底单 `tblQBNpLBjgqaRBX`。

**逐字段比对（含顺序）**：关键词 78 字段、人群 74 字段，与 1 部那张**完全一致**
⇒ 与商品链 2026-09-30 换 base 同一条纪律：签名一致才允许「只换 token，不动写入逻辑」。

### B3 改动（5 个源文件 + 3 处用例）

| 文件 | 改了什么 |
|---|---|
| `runtime/feishu-targets.mjs` | 登记 `2026-10:sales2`；**删掉** `department = 'sales1'` 默认值（漏传当场抛）；`assertPromotionDailyBaseCoverage` 新增「不同部门不许指向同一个 base／同一张表」的跨条目检查 |
| `runtime/batch-plan.mjs` | `WORKFLOW_DEPARTMENTS['promotion-daily']` 从 `['sales1']` 改为**从 `SHOP_DEPARTMENTS` 推导全部部门** |
| `skills/…/run-promotion-sales1.mjs` | `SALES1` 字面名单 → `promotionDailyShops()`（＝`collectingShopKeys()`）；`promotionSales1Plan` 判据改为「在采集范围里」，仍 fail-closed 并点名 |
| `skills/…/import-promotion-daily-report.mjs` | 按 `departmentOfShop(--shop)` 解析部门再查 base；回执新增 `department` 与 `baseToken` |
| `skills/…/check-promotion-completeness.mjs` | 对账门改成「按部门各读一张表再合并」——原实现只读一张，二部的行会被误判成「飞书里没有」 |

用例：`feishu-targets.test.mjs`（+2 条，含「两部共用一张 base 必须拦下」）、
`batch-plan.test.mjs`（判据从「只有一部」翻成「全部部门」）、
`run-promotion-sales1.test.mjs`（从「拒绝二部」翻成「接受二部、仍拒绝拼错的店」）、
`feishu-target-credentials.test.mjs`（补二部 envFile 与「两张 base 不同」）。

### B4 验到的（都是真机/真数据，不是推断）

1. **店铺 → 部门**：保拉淘宝、保拉天猫、安比龙头店、科塔龙头店、安比淘宝 全部解析成 `sales2`。
2. **部门 × 月份 → 目标**：`RWuxbD8I3aFBkus3On8cn3sGnBe` / `tbl8XlaVkRtWoi5i` / `tbln0U2ocO3MvSIn`；
   与 1 部三项全部不同（`base / keyword / audience` 各 true）。
3. **凭据**：`E:/小红书/.env.feishu-rcnb.local`，与 1 部同组织；两张表都能读到 78 / 74 个字段。
4. **阿里妈妈报表页（真机，19063 保拉淘宝，`--locate-only` 不提交）**：
   关键词 —— `[身份] 保拉伦蒂:数据监控 / 1991150160 ✓` → `[校验] 阿里妈妈关键词报表 / 2026-10-25 / 维度设置 ✓`；
   人群 —— 同样两行全过。
5. **导入映射（真数据 dry-run，不写飞书）**：用今早 11:00 那轮的真实 zip 打二部目标 ——
   `department=sales2`、`baseToken=RWux…`、关键词 68 行 / 75 列、人群 83 行 / 73 列、
   人群捕获 11 个主体ID。回执 `evidence/promo-dryrun-sales2-2026-10-26/receipt.json`。
6. **链入口计划面**：`run-promotion-sales1.mjs --date yesterday --plan` 展开 13 家，
   顺序与 `SHOP_BROWSERS` 一致（一部 8 家在前、二部 5 家在后）。
7. **用例**：技能侧 27 个文件 **661/661**（改动前后同数）；runtime 侧相关 8 个文件 62/62，
   另 6 个编排/告警/端口/汇总契约文件 156/156；`arch-boundary` / `workflow-catalog` /
   `hold-and-resume-plan` 共 65/65。

### B5 没验到的（不许说成验过）

- **真写一行**。二部的两张表现在各只有 **1 行 2026-09-28 的试写数据**（关键词花费 0.46 元、
  1 次点击；人群 0 点击）。真实业务日的写入只能等 **明天 11:00** 那轮自己证明。
  注：那行日期是 09-28，与本轮业务日不同键，不会让明天的写入被判成「已存在」而跳过。
- **五家全部**。阿里妈妈报表页只验了保拉淘宝一家（其余四家身份已登记，但没有逐个跑 `--locate-only`）。
- **商品链推广段在二部的真写**。目标解析验过（`tbl3SkayTTo9OlJo`），但商品链今天没跑过二部。

### B6 明天 11:00 的验收判据（不要看 summary 的绿）

1. `evidence/batches-<业务日>/b<N>/<店>/receipt.json` 里 **`department`** 与 **`baseToken`** 对不对
   （二部必须是 `RWux…`）；
2. 两张表的行数比今天多，且新增行的「日期」＝业务日；
3. 独立回读：按 `promotionIdempotencyKey` 反查那几行确实在；
4. 对账门 `check-promotion-completeness.mjs --date <业务日>` 输出里应能看到
   `[对账门] 读 sales2 keyword：10月推广数据-销售2部 / tbl8XlaVkRtWoi5i → N 行` 这样的两行
   —— 只出现 `sales1` 那两行就说明二部根本没进这一轮。

---

## C. 明天的一个已知风险（今天现场量到的，不是推测）

三条链的证据根**默认是同一个** `evidence/batches-<业务日>/`（`scripts/run-batches.mjs:400`：
`options.logs ?? path.join('evidence', \`batches-${date}\`)`）—— 08:00 日报（带 `--batches 5`）与
11:00 推广（同样 `--batch-size 5`）都落这里，只是批次号 b1/b2/b3 相同。

今天 2026-10-25 的现场正好能验证后果：

| 文件 | mtime | 含义 |
|---|---|---|
| `batches-2026-10-25/b1/summary.json` | 14:27 | 已被 14:11 那轮**覆盖**，08:xx 那一批的轮级结论没了 |
| `batches-2026-10-25/b1/盖文天猫/01-health-check.txt` | 08:13 | 店铺级文件**还在**（那轮没碰这 5 家） |
| `batches-2026-10-25/batches.json` | 15:58 | 被本轮停驻留时的收尾**重写**（`holdStatus=-1`） |

结论：**轮级文件（`summary.json` / `batches.json` / `batches.log`）是后写覆盖先写；店铺子目录只要店名不同就各自留存。**

对明天的影响：11:00 推广轮会覆盖 08:00 日报轮的 b1/b2/b3 轮级小结。上面 B6 的验收判据
（逐店 `receipt.json` ＋ 对账门）**不受影响**，因为那两处读的都是店铺级产物。
但「08:00 那一轮的轮级结论」只保留到 11:00 之前 —— 如果 08:00 那轮有问题需要复查，
要在 11:00 前把 `batches-<业务日>/` 复制走。

这条早就在待办里（「批次证据覆盖：`evidence/batches-<日>/b<N>` 已存在即拒绝 + run-id」），
本轮没有动它 —— 它改的是三条链共用的证据写入契约，不该混在「二部接入」这一刀里。

## D. 版本与提交

按仓库纪律（VERSION 是唯一来源、CHANGELOG 首条与 package.json 一致、代码与变更记录同提交），
本轮**没有动 VERSION / CHANGELOG / package.json** —— 它们正被并行的 1.12.22 那批占着
（工作区里 `M VERSION`、`M CHANGELOG.md` 不是本轮的改动）。等 1.12.22 落地后，
这次的功能需要单独补一条版本记录。
