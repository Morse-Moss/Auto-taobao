# 关键词周更「每周入参」解析 — 取证（2026-09-22）

对应文档：`docs/ops/WEEKLY-FLOW-CURRENT-2026-09-20.md` §9.7。

**这一批交付的是什么**：把「每周都会变的入参」（本期/上一期表名、批次号、克隆前历史行数）
从「人手改 JSON」变成「排期自己算」。**没有真跑过一轮**（真跑会写飞书）。

## 原始输出清单

| 文件 | 是什么 | 结果 |
| --- | --- | --- |
| `weekly-round-input-tests.txt` | `node --test runtime/weekly-round-input.test.mjs` | **23/23/0**，EXIT=0 |
| `adapter-feishu-weekly-tests.txt` | `node --test skills/sycm-to-feishu-base/tests/adapter-feishu-weekly.test.mjs` | **23/23/0**，EXIT=0 |
| `skills-suite.txt` | `node scripts/run-test-suite.mjs skills --concurrency=1` | **786/786/0**（1226.6 秒） |
| `runtime-suite.txt` | `node scripts/run-test-suite.mjs runtime --concurrency=1` | **844/844/0** |
| `sop-runtime-suite.txt` | `runtime/sop-runtime/*.test.mjs`（显式文件列表） | **398/398/0** |
| `mutation-checks.txt` | `node mutate-weekly-round-input.mjs`（4 个突变） | 逐个点名红 → 还原 → `sha256` 逐字节一致 |
| `show-plan.txt` | `round-runner.mjs --schedule-file … --show-plan` | `ok:true`，周期 `2026-09-13~2026-09-19`，`enabled:false`（只读，不碰库） |
| `live-resolve-real-period.txt` | `node probe-resolve-weekly-input.mjs`（真 reader，只发 GET） | 解析值 = 09-19 期人工手抄值（见下） |
| `live-fail-closed-missing-stable.txt` | 用真实配置 + `--force` 跑真 CLI | EXIT=1，停在 stable 校验，**零网络/零浏览器/零写入** |
| `live-fail-closed-unknown-resolver.txt` | 用坏 resolver id 跑真 CLI | EXIT=1，点名 `Unknown collectInputResolver` |

`probe-resolve-weekly-input.mjs` / `mutate-weekly-round-input.mjs` 是这两个探针/突变脚本的副本
（原件在 `tmp/`，而 `tmp/` 被 `.gitignore` 忽略 ⇒ 不复制一份就没法复核）。两处相对路径已按本目录深度改写
（原件在 `tmp/` 下用 `../runtime/…`，这里改成 `../../runtime/…`）—— 所以上面「复核命令」里那两条
**就是用这两份副本真跑出来的**，不是照抄原件的命令行。

`mutation-checks.txt` 的收尾自证：4 个突变各自**点名到期望的那条用例**，每轮还原后
`restored byte-identical: YES`，末次 `final sha256` 与起始 `ab4a7aff…b7bc5` 一致
⇒ 源码确实被改坏过、也确实逐字节还原了（文件级用例全绿不证明判据有效，这一步才证明）。
`live-resolve-real-period.txt` 是改完路径后用本副本重跑的，值与 `tmp/` 里那份逐项相同
（`batchNumber=9`、`expectedHistoryBefore=2367`、四个表 id 一致）⇒ 产物可复现，不是一次性巧合。

## 复核命令

```
node --test runtime/weekly-round-input.test.mjs
node --test skills/sycm-to-feishu-base/tests/adapter-feishu-weekly.test.mjs
node runtime/sop-runtime/round-runner.mjs --schedule-file runtime/round-schedule.json --show-plan
```

（探针需要飞书凭据与网络；只发 GET，不写。）

## 版本归属（诚实说明）

`skills-suite.txt` 与 `runtime-suite.txt` 这两次全量跑在 **`manifest.json` 描述那次改写之前**；
它们覆盖的代码文件在跑完之后**一个字节都没再动**。改的只有
`skills/sycm-to-feishu-base/manifest.json` 的 `description`（纯 prose），
因此改完之后单独重跑了覆盖该 manifest 的那个用例文件：`adapter-feishu-weekly-tests.txt`（23/23）。

## 刻意没做

- **`protectedTableName` 不推导**：它的语义是「上一有效周」，而「有效」的判据住在
  `sync-decision-history.mjs` 里、本仓库还没提出来；`PHASE-ARCHIVE.md` 那次演练
  weekly=09-12 / protected=08-29 **并不相邻** ⇒ 不是简单取上一期。推不出来就不猜。
  它是这条排期**唯一的待补项**，缺了在解析阶段就停（见 `live-fail-closed-missing-stable.txt`）。
- **没打开 `enabled`**、没跑 `--force` 的真轮次、没碰日报链、没碰任何存活进程。
