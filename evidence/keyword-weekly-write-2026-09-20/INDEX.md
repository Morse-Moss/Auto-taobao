# evidence/keyword-weekly-write-2026-09-20

关键词周更链「写入段」第一次真跑（用户点名授权）。**最终结果：三段全部写成，`APPLIED_AND_VERIFIED`。**
过程里先被飞书权限挡了一次，定位清楚、修好、再跑通 —— 两次尝试的原始输出都留在这里。
每条都标了**结论**与**它证不了什么**。

## 一句话结论

建表 + 写周表 + 写历史 + 写编号库，四个动作全部完成并**用两条独立路径核对过**：
脚本自己的回读验收，加上一次不采信自报的独立回读（`independent-readback.txt`）。**零残留、零半截数据。**

## 时间线（本机 Asia/Shanghai）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 起依赖 | `scripts/start-all-hold.mjs --only "竞品链…,商家浏览器…"` | 竞品链 `9222/3457` ok；商家链 `19022/19023` ok |
| 1 建表 dry-run | `copy-weekly-table.mjs` | `DRY_RUN`：源 300 行 / 29 字段 / 尚无同名副本 |
| 1 建表 apply | 同上 + `--apply --confirm-base` | **`COPIED_AND_VERIFIED`** → 新表 `tblZsUns9353w3nl` / `关键词分析 V1（2026-09-19）`，29 字段 / 12 公式 / 0 记录 / 1 视图 |
| 2 导入 dry-run | `update-weekly-base.mjs` | **`DRY_RUN_READY`**（真实目标，非排练） |
| 2 导入 apply 第 1 次 | 同上 + `--apply` | **失败** `POST …/tables/tblDEZY8RkwoHLEX/records/batch_create 403 91403 Forbidden` |
| 失败后复核 | 复跑 dry-run | 与写入前逐项一致 ⇒ **零残留** |
| 权限探针（失败时） | `feishu-perm-probe.mjs` | 同 base 4/4 表读 200、写全 91403；`/members` 返 `403 1063004` 读不出名单 |
| 跨 base 对照 | `feishu-perm-probe-crossbase.mjs` | **决定性**：同一应用对竞品库、各店铺日报写探针 `HTTP 200 code=0`；只有关键词库是 91403 ⇒ **base 级协作者角色** |
| 人工修权限 | 用户在飞书侧改成可编辑 | — |
| 权限探针（修复后） | `feishu-perm-probe.mjs` | 写探针 4/4 表 `HTTP 200 code=0`；`/members` 也能读了，列出 `appid full_access cli_a96ee8749078dbcf` |
| 写入前 dry-run | `update-weekly-base.mjs` | 仍 `DRY_RUN_READY`，各项计数与失败前一致 |
| 2 导入 apply 第 2 次 | 同上 + `--apply --confirm-base --confirm-weekly-table` | **`APPLIED_AND_VERIFIED`** |
| 独立回读 | `readback-weekly.mjs`（不采信自报） | 四个数全部对上（见下） |

## 写入与验收的实数

脚本自报（`update-apply.txt`）：

```
writes.libraryCreated                          19
writes.weeklyCreated                          300
writes.historyCreated                         300
writes.previousHistoryBatchUpdated              0
writes.invalidHistoryBatchMarked                0
writes.historyFieldsCreated                     0   ← 批次有效性 字段已存在，无需新建
backup.file  runtime/keyword-analysis-backups/weekly-base-before-20260920T023157Z.json
```

独立回读（`independent-readback.txt`，直接问飞书，不看脚本输出）：

| 表 | 行数 | 其他判据 |
| --- | --- | --- |
| 新周表 `tblZsUns9353w3nl` | **300** | 排名 1..300 连续唯一（去重后仍 300）；关键词编号 300 个非空且唯一；采集日期 = 2026-09-19 |
| 历史总表 `tbl7HbH11JsQx6FL` | **2367**（原 2067 + 300） | 逐批 `{1:300, 2:267, 3:300, 4:300, 5:300, 6:300, 7:300, 8:300}`；有效性 `有效 2100 / 无效-周期错误 267`；**未核验 0** |
| 编号库 `tblDEZY8RkwoHLEX` | **494**（原 475 + 19） | — |
| 上一张周表 `tblrX0GM7HkVhF85`（受保护） | **300** | 未被改动 |

脚本侧的对应判据：`protectedPreviousWeekUnchanged: true`、`priorCollectionDateInvented: false`、
`unverifiedBatchRows: 0`。两边结论一致。

## 文件对照

| 文件 | 结论 |
| --- | --- |
| `copy-dryrun.txt` | 建表前状态：源表 300 行 / 29 字段 / `existingCopyCount=0` |
| `copy-apply.txt` | 建表回执：`COPIED_AND_VERIFIED`、`newTableId=tblZsUns9353w3nl` |
| `copy-field-compare.txt` | **只读正面核对**：新表与源表字段名集合完全相同（无缺无多），公式字段各 12 个；12 处「差异」全部只是公式里的自表引用被飞书重写成新表 id（预期）。源表按 API 读到的属性里没有 AI Prompt 类字段，所以 `aiFieldCount=0` 与事实一致。 |
| `attempt1-update-dryrun.txt` | 第 1 次写入前的 dry-run（当时目标周表已存在且为空） |
| `attempt1-update-apply-FAILED-91403.txt` | **第 1 次失败原文**：`403 91403 Forbidden` |
| `attempt1-update-dryrun-after-failure.txt` | 失败后复跑 ⇒ 与写入前逐项一致 ⇒ **fail-closed，无半截数据** |
| `feishu-perm-probe.txt` | 失败时的权限探针（读 200 / 写全 91403） |
| `feishu-perm-probe-crossbase.txt` | **定位的关键证据**：跨 base 对照 |
| `feishu-perm-probe-after-fix.txt` | 修权限后：写探针 4/4 通过，`/members` 可读且该应用是 `full_access` |
| `update-dryrun-before-apply.txt` | 第 2 次写入前的 dry-run（与第 1 次一致） |
| `update-apply.txt` | **成功回执 `APPLIED_AND_VERIFIED`** + 写入计数 + 备份文件路径 |
| `independent-readback.txt` | 独立回读（不采信自报） |

## 根因（有正面证据，不是猜）

**同一条链的两个 91403，成因完全不同 —— 不要混：**

| 本次遇到的 | 成因 | 判定方式 |
| --- | --- | --- |
| 第 1 次写入 91403 | **真权限**：kcne 应用在这个 base 里只有"可阅读" | 跨 base 对照：同应用对另两个 base 能写 |
| 代码里的 `envFile` 默认值（已修 4 处） | **假故障**：默认凭据文件指向旧租户 | 显式传正确 `--env-file` 就好了 |

第 1 类的正确定位手法（本轮验证有效）：**用「删除一个不存在的 record id」当写权限探针**
（不改动任何数据），再用同一个应用跨 base 做对照组。三步就能把「应用 scope 缺 / base 协作者只读 / 表级权限」
分开。这套手法已存成技能 `feishu-api-permission-triage`。

## 顺手记一个假阴性（避免下次再踩）

独立回读第一版把「批次 8 有没有 300 行」算成 **0**。原因不是数据，是我的比较写错了：
`批次编号` 字段类型是 **type=2（数字）**，但飞书 API **把它读回来是字符串** `"8"`，
于是 `=== 8` 恒为假。用 `String()` 归一后是 300，`records/search` 过滤 `批次编号=8` 也返回 `total=300`。
这与项目笔记里「数字列不能回写字符串」是同一枚硬币的两面：**读写两侧的类型都不该凭直觉**。

## 这份证据证不了什么

- 写探针用的是「删除一个不存在的记录 id」，它只能证明**权限有没有**，不能证明真实写入会通过字段校验
  （后者由 `APPLIED_AND_VERIFIED` 的回读覆盖，两者不互相替代）。
- `aiFieldCount=0` 是「按 API 读到的字段属性里没有 AI Prompt 类字段」，不是「这个 base 从没有过 AI 字段」。
- 独立回读覆盖的是**行数与批次分布**，不覆盖公式是否全部无错、也不覆盖 AI 字段（本轮 AI 字段按设计留空）。
- 下一段（AI 结算 → 灰豚 → 决策历史同步）**都还没跑**，那条链的结论不能从这份证据推。
