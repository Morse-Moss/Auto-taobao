# 一轮多店铺跑通记录 — 目标日 2026-09-17（四家店串行）

跑于 2026-09-18 晚。驱动：`skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`。
这一轮是**只读复验**（`--verify-existing 1879`），不是写入 —— 目标是先把链的接线与产物验通。

```
node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date 2026-09-17 --verify-existing 1879
```

## 一句话结论

四家店各十个阶段全部 ok，**523 秒（8 分 43 秒）**，零人工干预。飞书底单跑前跑后都是 **1880 条**、
2026-09-17 仍是那 **5 行**、字段逐字未变 —— **这一轮一个字节都没写飞书**。

## 覆盖范围

| 运营叫法（`--shop-key`） | 店铺浏览器 / 代理 | 采集段读到的源产物店名 |
| --- | --- | --- |
| 里可林淘宝 | 19031 / 19041 | 里可林家居 |
| 网林天猫 | 19032 / 19042 | 网林家居旗舰店 |
| 盖文淘宝 | 19033 / 19043 | 盖文全卫定制 |
| 科塔淘宝 | 19034 / 19044 | 科塔全卫定制 |

推送段与回读段仍走商家浏览器 19022 / 19023（要读飞书 base 页）。四家店的审计身份逐阶段显式设置，
`receipt.json` 的 `environment` 里四项 `source` 全是 `env` —— 没有一家被记成 19022/19023。

## 逐环节印证（都是回读下游产物，不是「脚本说成功」）

1. **采集段两条产物路径都被驱动抓到**：`shopXlsxPath`，以及带 `[fetch] ` 前缀的 `promotionZipPath`
   （后者原先抓不到，是这一晚修的一处）。
2. **推送段当场自证店铺键**：`[shop-key] 里可林淘宝 ↔ 源产物店名 里可林家居 一致（证据目录 daily-report-2026-09-17-里可林淘宝）`。
   三家写入方的 `--shop-key` 全部同值，证据目录没有并进别家那一代。
3. **收据（`receipt.json`）**：`status=UI_COMMITTED_AND_VERIFIED`、`recordId=recvvyR2ueWnn8`
   （与底单 09-17「里可林家居」那一行**同一个 id**）、`verifiedFields=241`、
   `recordCountBefore/After=1879/1880`、`derivedReadbackAttempts=1`。
4. **双端自证 `sourceSelfChecks.allMatchDate=true`**：店铺工作簿 31 行、30 个唯一日期、命中目标日 **1** 行；
   推广 CSV 只有目标日一个日期、2 行（371 关键词推广 / 372 人群推广）。`targetOnlyPromotionFieldsBlank=true`。
5. **目标表**：base `PTfHbPt9EaIzddsfL8Jcj238nrb`（「各店铺日报」正主）→ `总数据来源底单` `tblkY3W8tnPWPcnh`，
   视图 `vewwg0rhjo`，与 `runtime/feishu-targets.mjs` 登记逐字一致。
6. **回填（干跑）判 `ALREADY_VERIFIED`**：`recordId=recvtXf5OikETg`（表 `各店铺数据日报` `tblUnwn05vl8Wik9`）、
   询单量=3 / 同层同行询单量=6。源页 URL 停在 `qos/service/frame/shop/performance/new#/shop`
   —— 说明第 7 步「回位」+ 第 8 步「重跑落位」确实生效（漏做会在这里报 `expected one 当日询单人数 table, got 0`）。
7. **独立回读**：换一条通路（CDP 读页面内存模型）读同一个事实，底单 `recordsNumFromPageModel=1880`；
   两张截图落盘。
8. **`NULL` 留空留痕**：里可林那一行两条 stderr `[留空] UV价值 / 无线端UV价值：数据源给的是文本标记 NULL…
   ⇒ 该格留空（不是 0）`，符合 09-18 定下的处置。

## 这一轮之后重读底单（零写入证据）

```
底单（总数据来源底单）当前 1880 条
2026-09-17 的行：5 条
  recvvyuoVc9nXi 盖文旗舰店 / recvvyR2ueWnn8 里可林家居 / recvvyRBZ74juL 网林家居旗舰店
  / recvvyS3CjfdVy 盖文全卫定制 / recvvySuZ5zUpB 科塔全卫定制
=> 逐店 verify 模式要的 --expected-before-count = 1879
```

当日 5 行 = 四家淘宝店 + 盖文旗舰店（运营叫法「盖文天猫」，本轮未跑，见下）。

## 产物

- 本目录：`summary.json`（含每阶段的 argv）＋ `<店铺>/NN-<阶段>.txt`（每阶段完整 stdout/stderr），共 40 份阶段日志。
- `evidence/daily-report-2026-09-17-<运营叫法>/`：`receipt.json`、`plan.json`、`paste.tsv`、
  `inquiry-backfill-plan.json`、`independent-readback.json`、两张截图。

## 与早先那一轮的关系（交叉印证）

09-17 这天的数据是**早先那一轮**真的写进去的：`evidence/multi-shop-run-2026-09-18/RUN-LOG.md`
（手工逐条命令、`--commit`、真写入；提交 `f01cb4a`；底单 1876 → 1880）。
那份台账的收尾里明确记着「**没有改「按店铺循环」的驱动（驱动还没写）**」—— 本目录这一轮补的正是那一块：
同一批店、同一天，改由驱动串起来跑。两轮各自独立记录，四家的编号逐字对上：

| 店铺 | 底单 recordId | 询单表 recordId | 询单量 / 同层同行 | payloadFields |
| --- | --- | --- | --- | --- |
| 里可林淘宝 | `recvvyR2ueWnn8` | `recvtXf5OikETg` | 3 / 6 | 241 |
| 网林天猫 | `recvvyRBZ74juL` | `recvtXf5OixAca` | 4 / 13 | 240 |
| 盖文淘宝 | `recvvyS3CjfdVy` | `recvtXf5OinIxX` | 4 / 6 | 240 |
| 科塔淘宝 | `recvvySuZ5zUpB` | `recvtXf5OiXSb1` | 5 / 6 | 241 |

⇒ 这一轮复验的是**早先那一轮真的写进去的那批行**，不是「碰巧也有 5 行」。
（注意两轮的 `recordCountBefore/After` 在收据里都写 `1879 → 1880`：verify 是逐店核一行，
判据是 `before.length === N + 1`，所以四家报的是同一个数 —— 这不是「四家各加了一行」。）

另外两处关系：

- 早先那一轮的「发现 1」（证据代次目录缺店铺维度 ⇒ 四家串行互相覆盖）当时**未修**，
  写的是「等指令」。这一轮的目录名是 `daily-report-2026-09-17-<运营叫法>`，即那个缺陷修好之后的形态。
- 早先那一轮提出「采集段也应把用哪个代理/浏览器记进审计（现在只有推送段有 `browser_port`）」。
  这一轮每一阶段的四个审计变量都由驱动显式设置，四家店的审计身份互不相同 —— 那条改进已落地。

## 没做 / 没覆盖的

- **没有写飞书**。要真写（`--commit`）必须先按 `references/sop.md` §9.3 把 09-17 那天清掉 ——
  会在这张表上产生真实的删除 + 重写，需要单独的决定。
- **盖文天猫本轮没跑**：它没有隔离 profile，不在这一轮的四家店里（它的 09-17 行是早先写的）。
- **另外 7 家店**（保拉淘宝 / 保拉天猫 / 网林淘宝 / 里可林天猫 / 安比龙头店 / 科塔龙头店 / 安比淘宝）
  两侧身份未实测、无隔离 profile，要人工登录后才能纳入。
