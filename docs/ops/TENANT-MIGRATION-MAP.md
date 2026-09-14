# 竞品数据搬迁到新租户：映射表与影响面

状态：2026-09-14 侦察完成，等待用户侧开通写权限后实施。
适用范围：竞品周更 SOP（base `OWebbPUcBa7B8JseYLccQCy9nkf` → 副本 `OUMqbkYwVaQxQNsv2EDc1DV7nDf`）。

## 0. 侦察结论

1. 新 base `OUMqbkYwVaQxQNsv2EDc1DV7nDf`（租户 `kcne618basvj`）是原 base 的**结构 + 数据完整副本**：
   - 10 张生产表**逐表行数完全相同**（2004 / 734 / 4346 / 2023 / 1461 / 734 / 2023 / 1423 / 0 / 1462）；
   - 抽查 5 张关键表的**字段名与字段类型逐字一致**：竞品主表 36、历史总表 V1 44、SKU明细 17、问题主库 23、周表_09-06 35；
   - 表 ID 全部不同，另多一张默认「数据表」`tblg6lkg6431QulJ`（1 字段 / 5 行）。
2. 关键词库 base `N21Abkg0HakO6AsbCaDckvcwnVd` **没有副本**，但新应用可以直接读它 → 继续用同一个 token。
3. 新应用 `cli_a96ee8749078dbcf` 能读：竞品 base、竞品 base 副本、关键词库 base；
   **写不通**（在副本上建表 / 建字段均 `403 91403`，不是 `99991672`）。
4. 旧应用 `cli_aa93e98aeef81cef` 读不到副本（`91403`），读得到另外三个 base。

## 1. base 与 table 映射（按名字）

| 表名 | 旧 table_id | 新 table_id |
| --- | --- | --- |
| 竞品主表 | `tblJ9LHFN6pMVjPv` | `tbl94WyAsVNdMkJf` |
| SKU明细 | `tblddWTrPeB4TKmR` | `tbltI9UufhunLc3u` |
| 竞品历史总表 V1 | `tblH0bmmOuogxDHi` | `tblktwxWKt8sjpXL` |
| 问题主库 | `tblCrsUpiVlpWjVw` | `tbl37PRcIXQCtfYk` |
| 竞品周_2026-08-23_2026-08-29 | `tblSS5bxyIeXgngI` | `tbl596KBUUkeybLD` |
| SKU周_2026-08-23_2026-08-29 | `tblSgYvJzGBxzEBO` | `tblF8zp0nTvJKPkv` |
| 问题库_2026-08-23_2026-08-29 | `tblhVSqUrjZAQeAl` | `tbl9GRrUOOT4akoM` |
| 竞品周_2026-08-30_2026-09-05 | `tblOIPXlFVk91laj` | `tblcWaJ8BfmXXZBY` |
| 问题库_2026-08-30_2026-09-05 | `tblyxbr9MLWESAOK` | `tbllh4JTNptWqCsi` |
| 竞品周_2026-09-06_2026-09-12 | `tbld2LVUhXBuIEwD` | `tblH56IUDG9l96V8` |
| 数据表（副本新增，默认空壳） | — | `tblg6lkg6431QulJ` |

base 级：`OWebbPUcBa7B8JseYLccQCy9nkf` → `OUMqbkYwVaQxQNsv2EDc1DV7nDf`。
关键词库 base：`N21Abkg0HakO6AsbCaDckvcwnVd` **不变**。

## 2. 应用与凭据

| | 旧 | 新 |
| --- | --- | --- |
| App ID | `cli_aa93e98aeef81cef` | `cli_a96ee8749078dbcf` |
| 凭据文件 | `E:/小红书/.env.local` | `E:/小红书/.env.feishu-kcne.local` |
| 租户 | `rcndesfqro3x` | `kcne618basvj` |

切换动作：脚本读 env 拿 app id/secret，所以**换凭据 = 换 env 文件**；
但 base/table id 目前**硬编码在脚本里**，必须一并替换（见 §3）。

## 3. 代码影响面（盘点结果，2026-09-14）

| 目标 | 出现文件数（含产物/备份） | 说明 |
| --- | --- | --- |
| 竞品 base `OWebbPUc…` | 47 | 活跃代码约 20 个 `runtime/*.mjs` + FAQ 发布脚本 + 测试 |
| 关键词库 base `N21Abkg…` | 26 | 名称不变，无需改 |
| 竞品主表 `tblJ9LHFN6pMVjPv` | 166 | 大量是 runs/backup 产物，**不动** |
| SKU明细 `tblddWTrPeB4TKmR` | 140 | 同上 |
| 历史总表 `tblH0bmmOuogxDHi` | 8 | 活跃代码 + receipts |
| 周表 3 期 + 问题库 | 12 / 4 / 14 / 7 / 3 | 活跃代码：`backfill-weekly-date-fields`、`tally-weekly-classification`、`probe-weekly-views`、`repair-weekly-tables`、`normalize-weekly-stable-links` 等 |

结论：**不能靠逐个 sed 手改**。正确做法是引入**单点目标配置**（名字 → base/table id），
活跃脚本只读配置；`runs/`、`*-backups/`、`evidence/` 下的历史产物保留原值（它们是当时的证据）。

## 4. 实施顺序（草案）

1. **用户侧前置**：开放平台补 `bitable:app` + `drive:drive` 并重新发布版本；
   在目标 base 把应用加为「可编辑」协作者。
2. **代码侧**：新增单点目标配置模块（默认指向新租户），活跃脚本改为读取；
   保留一个开关可切回旧 base（回滚不需要改代码）。
3. **只读验证**：每个脚本 dry-run，对比新旧 base 读到的表/行数/字段一致。
4. **写验证**：在新 base 建一次性演练表，跑两段式 `xws.feishu.import --commit`，
   确认 `publicationStatus=VERIFIED` + 游标推进，然后删表。
5. **正式切换**：env 文件指向新应用 + 配置指向新 base，跑一轮真实周更（或等下一个周期）。
6. **回滚**：旧 base 原样保留；把开关切回即可，不需要改代码。

## 5. 待验证 / 待确认

- **公式字段的表达式**是否已指向新表：类型抽查一致，但历史总表 V1 的 44 个字段里含公式
  （type 20）与 lookup（type 19），需抽查若干行的计算值在新旧 base 是否相同。
- **仪表盘 / 视图**：`publish-competitor-visualization.mjs` 发布的历史总表是仪表盘唯一数据源；
  副本里的仪表盘是否也复制过来、是否指向新表，需要在浏览器里确认。
- **关键词库 base 是否也要在新租户建副本**（用户未要求，暂不动）。
- **`数据表` `tblg6lkg6431QulJ` 的 5 行**是否保留（导入需要空表）。
- 新应用对**旧 base** 是否可写（未测，避免在生产 base 上做写探测）。

## 6. 相关文档

- 新租户应用的权限设置与诊断：`docs/ops/FEISHU-APP-SETUP-NEW-TENANT.md`
- 两段式真实演练记录：`docs/architecture/MIGRATION-8-QUEUE-SCHEDULER-REPORT.md` §8
