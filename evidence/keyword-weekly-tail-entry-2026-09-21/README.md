# 关键词链「本地分析完再上传飞书」——把 1.6 收进同一条命令（2026-09-21）

## 结论先行

`runtime/run-keyword-weekly-local-analysis.mjs` 现在是一条命令跑完三段：

```
规则段（4 字段） → 内容热度（1 字段） → 决策历史同步（基数 + 历史快照）
```

第三段就是原来那条要靠人记得另跑的 `skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs`（简称 1.6）。
接入方式与它自带的能力：

| 事项 | 做法 |
| --- | --- |
| 谁写 | 仍然只有 1.6 一个实现，入口**按路径 spawn 它**，不复制它的逻辑 |
| 启用 | 给 `--history-table-name` ＋ `--previous-table-name` ＋ `--expected-history-rows`；真写再加 `--confirm-history-table` |
| 不启用 | 与从前逐字相同（只跑前两段），尾部打一句「没跑会缺什么 / 怎么补」；显式关掉用 `--skip-decision-history` |
| 幂等 | 先起一次只读 dry-run 问「缺不缺」；`writeUnits === 0` ⇒ **一个写入子进程都不起**，状态 `ALREADY_SYNCED` |
| 自愈 | 写完独立回读比对；历史快照与源表不一致才跑第二遍 `--recalculate-existing-snapshots`（只改不一致的格） |
| 判据 | 本地五列 + 决策历史**两段都绿**才报 `APPLIED_AND_READBACK_VERIFIED`，否则 `APPLIED_WITH_GAPS` |

## 为什么要「两遍」

不是我加的门槛，是 1.6 自己的写入顺序决定的：

- `sync-decision-history.mjs:1032` 先写历史快照，`:1033` 才写本期三个基数；
- 而历史快照里的 `是否重点词` 读的是 `近2周重点达标次数` —— 基数为空时那个公式落 `待数据`；
- ⇒ 第一遍快照进历史表的 `是否重点词` **必然是中间态**。

09-19 期实测印证：第一遍 apply 报 `APPLIED_AND_VERIFIED`，但历史表批次 8 的 `是否重点词` 是
`否×295 待数据×5`，而源表现值是 `否×296 是×4`；第二遍只改了 5 格。
（这一条本身是 2026-09-21 补跑时发现的，记录在 `evidence/keyword-weekly-columns-audit-2026-09-21/README.md`）

所以处置不是「记得再跑一遍」，而是让入口自己比对、自己补。

## 证据清单

| 文件 | 是什么 | 分母 / 口径 |
| --- | --- | --- |
| `unit-entry-2026-09-21.txt` | `node --test runtime/run-keyword-weekly-local-analysis.test.mjs` 原始输出 | **15 tests / 15 pass / 0 fail** |
| `guards-affected-2026-09-21.txt` | 受影响四个守卫：`arch-boundary` / `browser-ports` / `ci-matrix-coverage` / `content-heat-judge` ＋本入口用例 | **49 tests / 49 pass / 0 fail** |
| `runtime-suite-after-entry-2026-09-21.txt` | `node scripts/run-test-suite.mjs runtime --concurrency=1` 原始输出 | **runtime 组 91 file(s) / 812 tests / 812 pass / 0 fail**（改动之后跑的版本＝`b2fd302` 的前一个工作区状态） |
| `mutation-entry-2026-09-21.txt` | `node runtime/content-heat-judge.mutation.mjs` 原始输出 | **11 条突变全部 `CAUGHT_AND_NAMED`，`restoredOk: true`** |
| `entry-dryrun-2026-09-19.txt` | 入口对 **真表** 跑一次（不带 `--apply`，只读） | exit 0；第三段 `ALREADY_SYNCED` / `writeUnits 0` / `wrote false` |
| `writer-rule-dryrun.txt` | 规则段单独 dry-run（只读） | `recordsPlanned: 10`，全是 `细分标签: []` 的空写 |
| `writer-content-heat-dryrun.txt` | 内容热度单独 dry-run（只读） | `recordsPlanned: 0` / `preservedExisting: 300` |
| `run-entry-decision-history-dryrun-2026-09-21.mjs` | 跑上面第一行的脚本（一次性，随手归档） | — |
| `precheck-writers-dryrun-2026-09-21.mjs` | 跑上面第二、三行的脚本（一次性，随手归档） | — |

### 真机只读取证的三个要点

1. **表名解析到的是真表**：入口报的 `tblZsUns9353w3nl`（本期）/ `tbl7HbH11JsQx6FL`（历史）/ `tblrX0GM7HkVhF85`（上一期）
   与 `evidence/keyword-weekly-columns-audit-2026-09-21/` 里那张全景表逐字相同。
2. **1.6 的真 stdout 解析得动**：`planned` 五项全 0、`pending` 两项全 0 ⇒ `writeUnits 0` ⇒ `ALREADY_SYNCED`。
   这就是「09-19 期重跑第三段 = 零写入」的直接证据。
3. **两个写入器也已经没有实质要写的格**：内容热度 `recordsPlanned: 0`；规则段的 10 格全是 `细分标签: []`（写空值，
   与表上现状同为空）。所以这一轮没带 `--apply` 真跑 —— 不带也一样能证明接线通了，而带 `--apply` 会真的发起一次 canary PATCH。

### 新增的五条突变（都是 2026-09-21 加的）

| 突变 | 期望被哪条用例抓住 |
| --- | --- |
| 只读探路跟随入口的 `--apply`（探路那一次也真写） | 第三段幂等 / 第三段自愈 |
| 历史快照定格了也不再补第二遍（自愈被关掉） | 第三段自愈 |
| 回读不按批次筛（上一批的有值率把本批缺口洗绿） | 第三段独立回读 |
| 整体状态判据退回「表上不能有空格」 | 整体状态判据 |
| —（原有 7 条照旧全绿） | — |

## 顺带修掉的一个假黄

老判据是「本地五个字段表上空格数必须为 0」，而 `细分标签` 是 MultiSelect：
本地规则对很多词本来就判不出标签（09-19 期 290/300 有值，剩 10 行本地也判不出）。
于是这条判据**永久报黄**，人就会学会忽略它 —— 等于没有判据。

新判据的基线取**本地分析自己的结果**：本地判得出、表上却没有值，才算缺口（`unexplainedBlank`）。
`stillBlank` 仍然保留（原始事实），只是不再等同于「有缺口」。

## 仍然没做到的

- **没进排期**：`runtime/round-schedule.json` 里没有关键词周更这一条。挂排期前要先按
  `scheduler-wiring-needs-registered-capability` 确认调度器认得这个能力标识（manifest ＋ adapter ＋ 登记 ＋ 测试），
  而 `runtime/` 下的入口**不算能力**。
- **opt-in**：不带 `--history-table-name` 就仍然会缺。今天的状态是「承接者有了，但要不要它跑取决于调用者带没带参数」。
- 08-26 期（批次 4）按用户口径不处理（过期一个月）。
