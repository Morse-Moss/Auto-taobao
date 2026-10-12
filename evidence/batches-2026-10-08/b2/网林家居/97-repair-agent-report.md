# 修复 agent 报告 — 网林家居（stage=backfill，cause=STAGE_FAILED）

- 目标日：2026-10-08
- 店：网林家居（proxy=19062 / browser=19052 / profile=wanglin-custom）
- 证据目录：`evidence/batches-2026-10-08/b2/网林家居/`
- 作业依据：`docs/ops/REPAIR-AGENT-HANDOFF.md`
- 结论：**agent 修不动，但不需要人** —— 成因是平台空态 `SOURCE_NO_ROW_FOR_DATE`（生意参谋「询单到付款」对该店该日返回「暂无数据」），**不是** 0、也不可修补；按分诊表 `notifyLevel:'silent'`，**不发飞书、不驻留**。

---

## 0. 第 0 步：把实例拉起来

| 步 | 命令 | 回读结果 |
|---|---|---|
| 0.1 | `curl -s -m 5 http://127.0.0.1:19062/targets` | **空**（实例不在） |
| 0.2 | `node scripts/start-all-hold.mjs --only 网林家居`（后台托住） | 起就位，进程托住 |
| 0.3 | `Get-NetTCPConnection -LocalPort 19062 -State Listen` 读两遍 | 两遍都 `127.0.0.1:19062 Listen pid=139676`（一致） |
| 0.4 | `curl …/19062/targets` | 只有 1 个「网林家居 · 日报采集窗口」标签页 |

## 1. 读现场

- `97-repair-request.json`：cause=STAGE_FAILED，stage=backfill，candidates=`[REAPPLY_DATES, RELOAD_PAGE]`。
- `98-failure-state.txt`：页面标题「生意参谋」，URL=`sycm.taobao.com/qos/service/frame/shop/performance/new#/shop`（**已登录**的工作页）；「询单到付款」表日期列原值=`["暂无数据","汇总值","平均值","全店汇总值","全店平均值","同行同层优秀","同行同层均值"]`，日期行数=0，页面文字含「统计时间 2026-10-08」「暂无数据」「共 0 条」。b2 目录无 `escalation-handoff.json`，本店当轮按「已知、不需要人」处理，**b2 未发飞书**。

## 2. 重试复现

命令：`node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date 2026-10-08 --shops 网林家居 --only health-check,sycm-reset,sycm-date-again,backfill`
日志：`97-retry1.log`

回读：
- health-check 归位 create 两个工作页；sycm 页在位且**已登录**（`qos/.../shop/performance`）。
- 阶段 backfill：`SOURCE_NO_ROW_FOR_DATE 这一天的源表里没有日期行（…返回的是空态，不是读不到）｜日期列原值=[…]｜日期行数=0｜期望=2026-10-08` ⇒ exit 1。
- 汇总：`网林家居：failed（停在 backfill）`；**EXIT=1**；分诊 `需人 0 处；不需要人 1 处（网林家居@SOURCE_NO_ROW_FOR_DATE）`。

## 3. 逐个候选动作（闭集内，先排练再真跑）

命令模板：`node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 网林家居 --proxy http://127.0.0.1:19062 --stage backfill --cause STAGE_FAILED --action <动作> --log-dir evidence/batches-2026-10-08/b2/网林家居`

| 候选 | --dry-run | 真跑 | 回读 |
|---|---|---|---|
| `REAPPLY_DATES` | exit 0（排练，目标页=`qos/.../shop/performance`） | **applied=false**，exit 1 | detail=「日期需要重新落位（sycm）—— 请重试该站点的落位阶段来完成」（报告者，非执行者）。留证 `97-repair-REAPPLY_DATES.json` |
| `RELOAD_PAGE` | exit 0 | **applied=true**，exit 0 | detail=「页面已重载并就绪」。留证 `97-repair-RELOAD_PAGE.json` |

## 4. 重试（RELOAD_PAGE applied=true 之后）

命令：`node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date 2026-10-08 --shops 网林家居 --only sycm-reset,sycm-date-again,backfill`
日志：`97-retry2-after-reload.log`

回读：**EXIT=1**，仍 `SOURCE_NO_ROW_FOR_DATE`（日期列原值不变、日期行数=0）；sycm 工作页仍**已登录**。⇒ 页面类动作都试过，**不能修**。

## 5. 为什么「修不动」也「不需要人」

- 成因是**平台返回空态**：该店该日的「询单到付款」源表里没有日期行（显示「暂无数据」，而**同行同层优秀/均值两行有数**）⇒ 这一天的「询单量 / 同层同行询单量」注定取不到。
- 这与分诊表 `remediation-table.mjs` 的 `SOURCE_NO_ROW_FOR_DATE` 定义逐字吻合：`action:'HUMAN'` 但 `notifyLevel:'silent'`，`why`＝「平台这一天就没有出这一行…重试、修页面、人去平台都变不出来」；它**不在** `HUMAN_REQUIRED_CAUSES` 里。
- **绝不能填 0**：平台空态 ≠ 0（没有这一行，不是数值为 0）。
- 页面/登录都正常（sycm 页已登录、alatmama 报表页在位），所以人去了也**没有任何一页要动**。

## 6. 结论

- **agent 修不动**（候选试完、两次重试均失败）；**但不需要人介入**，也**不该发飞书**（`silent`）。
- 试过什么：候选 `REAPPLY_DATES`（applied=false）、`RELOAD_PAGE`（applied=true）；两次重试均 exit 1。
- 关键回读：日期列原值 `["暂无数据","汇总值","平均值","全店汇总值","全店平均值","同行同层优秀","同行同层均值"]`、日期行数 `0`、期望 `2026-10-08`；sycm 页 `qos/.../shop/performance`（已登录）。
- 是否改仓库代码：**否**。

## 附：本目录留证清单

- `97-retry1.log` / `97-retry2-after-reload.log`
- `97-repair-REAPPLY_DATES.json` / `97-repair-RELOAD_PAGE.json`（另：`97-repair.json`、`97-repair.txt` 为最后一次动作的产物）
