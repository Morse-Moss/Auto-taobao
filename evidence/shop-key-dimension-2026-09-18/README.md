# 证据目录加「店铺」维度（P1 修复）· 2026-09-18 晚

修的是 `evidence/multi-shop-run-2026-09-18/RUN-LOG.md` 的**发现 1**，
也就是 `docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md` §4.7 那条。
用户 2026-09-18 对五项待拍板项答复「**按你推荐的来**」，本目录是第 2 项（「修」）的取证。

## 缺口是什么

`evidence/daily-report-<日期>[-rerunN]/` 原先只按日期取名。四家店串行跑同一天时，
`--commit`（`policy:'latest'`，并入当前最新一代）与询单回填会把**后一家**的
`plan.json` / `paste.tsv` / `receipt.json` / `inquiry-backfill-*.json`
**覆盖掉前一家的**，一个目录最后只剩最后一家，而且从文件名上看不出来。
09-18 那一轮因此真实丢了 5 个文件的本地副本（业务事实一件没丢：
每个 recordId / 字段值 / 每次审计都有独立来源 —— stdout 台账 + `daily_report_push_audit` + 两条回读通路）。

## 改了什么（三处代码 + 两处文档）

| 文件 | 改动 |
| --- | --- |
| `daily-report-runtime.mjs` | 新增 `SHOP_KEY_PATTERN` 与 `evidenceBaseDir({ evidenceRoot, reportDate, shopKey })`。**不给键 ⇒ 返回值与旧形状逐字相同**；给了键 ⇒ `daily-report-<日期>-<键>`。纯函数：只吃参数、不读文件，所以三个写入方都能在原来的位置调用它 |
| `shop-identities.mjs` | 新增 `assertEvidenceShopKey(key, observed)`：键必须是**已登记**的运营叫法（未登记直接抛，不回落成「不核对」）；`observed.fullName`（源产物店名）/ `observed.shopKey`（同一命令里的 `--shop`）给了就核，对不上即停 |
| `run-daily-report.mjs` | `--shop-key`；目录改走 `evidenceBaseDir`；在拿到 `fields['店铺名称']` 之后、建目录之前核键，并打一行 `[shop-key] … 一致（证据目录 …）` |
| `run-inquiry-backfill.mjs` | `--shop-key`；目录改走 `evidenceBaseDir`；读表之后核 `--shop` 与键是否同一家 |
| `readback-daily-report.mjs` | `--shop-key`；目录改走 `evidenceBaseDir`；**并把键的核对挪到 `mkdirSync` 之前**（原先它根本不核键 ⇒ 任意字符串都能当目录后缀） |
| `references/sop.md` | §12.5 从「已知缺口」改写为「已修 + 现在的形状 + 仍需真跑验的那一条」；§6.3 补一句 base 名由谁决定；§6.4 补 `--shop-key` |
| `docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md` | §4.7 改写为「已实施并验证」，并交代那个「必须先想清楚的约束」是怎么解的；§7 新增第 8 行 |

**那个约束**（§4.7 原样）：`main()` 里 `resolveOutputDir` 排在 `extractSources` **之前**
（「先定产物落哪一代，再动任何东西」）。解法是**不动语义** ——
`evidenceBaseDir` 是纯函数，键是**调用方显式输入**，不是「读完 xlsx 自动得出」。
代价是「按店铺循环」那层驱动必须自己知道在跑哪家店（它本来就知道）；
共享窗口的页头**不能**当来源（19022 的页头实测是里可林家居，与 19031 撞店）。

## 证据清单

| 文件 | 是什么 | 结果 |
| --- | --- | --- |
| `01-suite-113.txt` | `node scripts/run-test-suite.mjs skills --skill=sycm-alimama-daily-report --concurrency=1` 原文 | **113 / 113 通过**（新增 5 条：`evidenceBaseDir` 默认形状 / 带键 / 非法键；`assertEvidenceShopKey` 一致与错标签；三个写入方的接线守卫） |
| `02-mutations.txt` | 五条突变：改坏 → 看它真的红**并点名** → 还原（sha256 自证逐字节一致）→ 复跑绿 | 5/5 各自红在该红的那一条；还原后 14~16/16 全绿 |
| `03-cli-wiring.txt` | **真命令行**七个用例（死代理端口 19999）：回读×{无键,带键,键用页头名}、回填×{无键,带键,键带路径穿越}、推送×{带键} | 见下 |
| `04-git-diff-stat.txt` | 本次改动的 diff 概览 | — |
| `05-unit-all.txt` | `run-test-suite.mjs unit`（技能 + 运行时全量离线）原文 | 见下方「全量回归」一节 |

`03` 里七条的判据是「**哪个目录出现了**」，因为三个写入方里有两个（回读 / 回填）是
「先 mkdir 再去连浏览器」⇒ 在死代理下它们会建完目录才失败，目录名就是接线的直接证据：

- 回读 无键 ⇒ `evidence/daily-report-2026-01-01`（**旧形状，逐字不变**）✔
- 回读 带键 `里可林淘宝` ⇒ `evidence/daily-report-2026-01-02-里可林淘宝` ✔
- 回填 无键 ⇒ `evidence/daily-report-2026-01-03` ✔
- 回填 带键 `科塔淘宝`（与 `--shop` 同值）⇒ `evidence/daily-report-2026-01-04-科塔淘宝` ✔
- 回读 键用页头店名 `盖文旗舰店` ⇒ **一个目录都没建**，报 `未登记的店铺「盖文旗舰店」；已登记：…` ✔
- 回填 键 `../../etc` ⇒ **一个目录都没建**，报 `invalid shop key for evidence dir: "../../etc"` ✔
- 推送 带键（死代理）⇒ **不建目录**（它先认飞书页、再 mkdir）；只证明「参数被接受」。

探针用 `2026-01-01` 这类永远不会被真跑用到的日期，**跑完只删自己建的空目录**（4 个已删，
复查无残留；非空目录一律保留）。探针本体在仓库外：`D:/Retire/probe-live/13-mutate-shop-key.mjs`、
`14-cli-shop-key-paths.mjs`。

## 全量回归

本批改动只落在日报技能内（`skills/sycm-alimama-daily-report/`），没有动 `runtime/`。
「本批最相关的那一套」`skills --skill=sycm-alimama-daily-report` 已 **113/113 绿**（`01`）。
在它之外另跑了一次 `run-test-suite.mjs unit`（技能 + 运行时全量离线）作为回归扫，
原文落在 `05-unit-all.txt`；**结果以那份文件的 `# pass` / `# fail` 两行为准**
（跑得久，本 README 不代抄数字 —— 抄一次就多一个会过期的副本）。

## 本次明确没有做的事

- **没有动已落库的数据**（用户对 NULL 列形态的选择是「保持现状」）。
- **没有起任何浏览器**：这一轮所有取证都不依赖登录态。推送方带键的真实落点**仍未验**，
  只能在下一次真跑时看 `plan.json` 的 `evidence.outputDir` 或 stdout 那行 `[shop-key]`。
- **没有写飞书**。
- **没有做「按店铺循环」的驱动**（那是下一项；本项只是它的前提）。
