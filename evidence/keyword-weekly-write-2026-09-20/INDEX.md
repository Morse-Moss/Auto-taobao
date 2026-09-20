# evidence/keyword-weekly-write-2026-09-20

关键词周更链「写入段」第一次真跑（用户点名授权）。结论：**建表成功，导入被飞书权限挡住**。
每条都标了**结论**与**它证不了什么**。

## 一句话结论

本轮实际状态：**三个真写入里完成 1 个**（新建本周分析表），随后在第一个 `batch_create`
上被 `403 91403 Forbidden` 拒掉，**没有留下半截数据**（失败后复跑 dry-run，四处计数与写入前逐项一致）。

## 时间线（本机 Asia/Shanghai）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 起依赖 | `scripts/start-all-hold.mjs --only "竞品链（买家号 ＋ 小旺神）,商家浏览器（日报/周表/灰豚）"` | 竞品链 `9222/3457` ok；商家链 `19022/19023` ok |
| 1 建表 dry-run | `copy-weekly-table.mjs` | `DRY_RUN`：源 300 行 / 29 字段 / 尚无同名副本 |
| 1 建表 apply | 同上 + `--apply --confirm-base` | **`COPIED_AND_VERIFIED`** → 新表 `tblZsUns9353w3nl` / `关键词分析 V1（2026-09-19）`，29 字段 / 12 公式 / 0 记录 / 1 视图 |
| 2 导入 dry-run | `update-weekly-base.mjs` | **`DRY_RUN_READY`**：周表 0 行、历史 2067→2367、编号库 475 行缺 19 词、批次 7→8、旧批次改动 0 |
| 2 导入 apply | 同上 + `--apply --confirm-base --confirm-weekly-table` | **失败** `POST …/tables/tblDEZY8RkwoHLEX/records/batch_create 403 91403 Forbidden` |
| 失败后复核 | 复跑 `update-weekly-base.mjs` dry-run | 周表仍 0 行、历史仍 2067、编号库仍 475/缺 19、旧批次改动仍 0 ⇒ **零残留** |

## 文件对照

| 文件 | 结论 |
| --- | --- |
| `copy-dryrun.txt` | 建表前状态：源表 300 行 / 29 字段 / `existingCopyCount=0` |
| `copy-apply.txt` | 建表成功回执：`newTableId=tblZsUns9353w3nl`、`COPIED_AND_VERIFIED` |
| `copy-field-compare.txt` | **只读正面核对**：新表与源表字段名集合完全相同（无缺无多），公式字段各 12 个；12 处「差异」全部只是公式里的自表引用 `$table[源表id]` → `$table[新表id]`（飞书自己重写，属预期）。源表按 API 读到的属性里没有 AI Prompt 类字段，所以脚本自报的 `aiFieldCount=0` 与事实一致。 |
| `update-dryrun.txt` | 真实的写入前 dry-run（不是排练）：目标就是新建的空周表 |
| `update-apply-FAILED.txt` | 失败原文：`403 91403 Forbidden`（第一次写就停，未继续） |
| `update-dryrun-after-failure.txt` | 失败后复跑 dry-run ⇒ 与写入前逐项一致 ⇒ **fail-closed，无半截数据** |
| `feishu-perm-probe.txt` | 权限边界探针（同一 base 四张表）：**读全部 200**；写探针全部 `403 91403`，**包括刚新建的那张空表** |
| `feishu-perm-probe-crossbase.txt` | **跨 base 对照（决定性）**：同一个应用对「竞品库」与「各店铺日报」两个 base 的写探针都是 `HTTP 200 code=0`；只有「关键词库」这个 base 是 91403 |

## 根因（有正面证据，不是猜）

**不是应用 scope 缺写权限，也不是表级权限 —— 是该 base 里这个应用只有"可阅读"。**

判据：同一个 `cli_a96e…` 应用
- 对关键词库 base 读得到（4/4 表 HTTP 200）、写不了（4/4 表 91403，含刚新建的空表）；
- 对另外两个 base（竞品库、各店铺日报）**读写都通**。

⇒ scope 是齐的；差别只在 base。另外 `GET /drive/v1/permissions/…/members` 返回
`403 1063004 User has no share permission`（应用也没有 drive 分享权限读名单），所以**读不出协作者名单**，
只能靠"跨 base 对照"来定位 —— 这条对照就是本轮的关键证据。

顺带一条**推断**（不是本轮证据）：关键词库的历史 7 个批次、2067 行是在旧租户里写进去的，
那批写入用的是另一个应用（`cli_aa…`）；kcne 这个新应用（`cli_a96e…`）**此前从未写过这个 base**
—— 本轮是它第一次尝试写。这与「疑似只被加成了可阅读」吻合，但**没有**直接证据证明是谁写的，
要坐实得去查该 base 的操作记录。

## 修复动作（只有 base 所有者能做）

1. 在该 base → 右上「…」→ 添加文档应用 / 协作者：把 `cli_a96e…`（kcne 那个应用）从「可阅读」改成**可编辑**；
   若开了「高级权限」，还要在该表的高级权限里给这个应用编辑角色。
2. 改完**不需要改代码**：`update-weekly-base.mjs` 的命令可以直接原样重跑（目标周表仍是空表，
   dry-run 会再次给出 `DRY_RUN_READY`）。

## 这份证据证不了什么

- 写探针用的是「删除一个不存在的记录 id」，它只能证明**权限有没有**，不能证明真实写入会不会通过字段校验。
- 没有证明「应用被加为可编辑之后一定能写完」—— 那只等修完权限重跑一次才算。
- `aiFieldCount=0` 是「按 API 读到的字段属性里没有 AI Prompt 类字段」，不是「这个 base 从没有过 AI 字段」。
- 新表 `tblZsUns9353w3nl` 目前是**空表**（29 字段 / 0 记录）。它不会被后续重跑冲突：
  `update-weekly-base.mjs` 的 dry-run 认它就是本周目标表。若不想留这张空表，需单独授权删除。
