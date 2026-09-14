# 竞品数据搬迁到新租户：映射表与影响面

状态：2026-09-14 代码改造（第 2 步）与只读验证（第 3 步）已完成并通过；第 4 步（新 base 写验证）被用户侧协作者权限阻塞。
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

### 3.1 单点配置模块（已实现）

`runtime/feishu-targets.mjs` 是唯一事实来源，导出：

- `PROFILES`（`Object.freeze`，含 `legacy` / `kcne` 两个 profile）、`STABLE_TABLE_KEYS`；
- `DEFAULT_PROFILE`（切租户时只改这一行）；
- `SYCM_FEISHU_PROFILE` 环境变量 + `resolveProfileName` / `activeProfileName` / `getProfile`；
- 访问器 `competitorBaseToken` / `tableId(logicalName)` / `envFilePath` / `baseUrl` / `profileTargets`；
- `parseEnvFile` / `loadFeishuCredentials`（凭据也从这里走，避免各处重复解析）。

三个设计决定：

1. **周表不进本文件**。竞品周 / SKU周 / 问题库每周新建，id 天然过期；继续由
   `runtime/weekly-table-target.mjs` 按名字解析（`parseWeeklyTable` / `latestWeeklyTable` / `requireWeeklyTable`）。
2. **空值不是名字**。`SYCM_FEISHU_PROFILE=`（shell 里很常见的写法）会得到空串而不是
   `undefined`，`?? DEFAULT` 挡不住；`resolveProfileName` 显式判 `null`/`undefined`/空串后回落默认值，
   否则每个脚本都会在启动时炸掉。
3. **默认仍指向 `legacy`**。代码先就位、后切换；切换只需改 `DEFAULT_PROFILE` 一行或设环境变量，
   回滚同理，不需要改任何业务脚本。

`runtime/feishu-targets.test.mjs` 11 条用例覆盖：两个 profile 覆盖同一批逻辑名、
table id 互不相同且形状合法、base 与 baseUrl 自洽、profile 冻结、别名解析与未知名抛错、
环境变量切换（含空串回落）、**默认 profile 仍是 legacy**（切换后该断言会失败，用来提醒同步文档）、
`tableId` 命中与未知名抛错、凭据路径分租户、`parseEnvFile` 处理注释/空行/引号、`loadFeishuCredentials` 只认两个键。

### 3.2 已改造的活跃脚本（11 个文件，38 处）

| 文件 | 替换处数 | 改了什么 |
| --- | --- | --- |
| `runtime/prepare-weekly-competitor-table.mjs` | 3 | base token、env 路径 |
| `runtime/create-weekly-formula-fields.mjs` | 5 | base token、env 路径、`OLD_TABLE` 默认值改为必填（跨租户后旧 id 失效） |
| `runtime/tally-weekly-classification.mjs` | 4 | base token、env 路径，新增「未给 `WEEKLY_TABLE_ID` 时按名字取最新竞品周表」 |
| `runtime/backfill-weekly-date-fields.mjs` | 6 | 各 PLAN 的 table id 改 `null` + 按名字在目标 base 内解析 |
| `runtime/run-faq-operator.mjs` | 2 | `DEFAULT_BASE_URL`、`DEFAULT_ENV_FILE` |
| `runtime/publish-faq-detail-enrichment.mjs` | 2 | 同上 |
| `runtime/publish-competitor-visualization.mjs` | 2+2 | `DEFAULT_ENV_FILE`；并把 `--base-url` / `--history-table-id` 由必填改为按 profile 兜底（调用方仍可覆盖） |
| `runtime/apply-xws-sku-manifest.mjs` | 3 | `TARGET.appToken` / `mainTableId` / `skuTableId`、env 路径 |
| `runtime/summarize-xws-sku-queue.mjs` | 3 | 同上 |
| `runtime/sync-weekly-sku-history.mjs` | 4 | 同上 |
| `runtime/sync-latest-ab-to-main.mjs` | 4 | 同上 |

改造方式：用「精确字面量 + 期望出现次数」的临时脚本替换（次数不符即整体失败），
不做模糊正则——避免误伤 `runs/`、`*-backups/`、`evidence/` 里的历史证据。

### 3.3 有意未改的

- 20 余个遗留/一次性脚本（`repair-weekly-tables.mjs`、`repair-current-week-and-sync-main.mjs`、
  `normalize-weekly-stable-links.mjs`、`create-weekly-history-tables.mjs` 等）仍保留硬编码：
  它们要么是一次性修复工具、要么需要人工判断，改造收益低于风险。
- 三个测试文件仍引用旧 base token（`skills/xws-sku-collection/tests/adapter-sku-collection.test.mjs`、
  `runtime/apply-xws-sku-manifest.test.mjs`、`runtime/publish-faq-detail-enrichment.test.mjs`）：
  改 token 会改变测试语义（它们断言的是「传进去的 token 被原样使用」），留待切换租户时随用例一起改。


## 4. 实施顺序与进度

1. **用户侧前置**（部分完成）：开放平台补 `bitable:app` + `drive:drive` 并重新发布版本 —— 已完成
   （`/drive/v1/permissions/.../public` 返回 200，`99991672` 消失）。**仍缺**：把应用
   `cli_a96ee8749078dbcf` 加为**副本 base** 的「可编辑」协作者（当前仍 `403 91403`）。
   注意：实测发现应用被加成了**旧生产 base** 的协作者（详见 §6），需确认是否本意。
2. **代码侧**：✅ 已完成 —— 见 §3.1 / §3.2。回归：`runtime` 套件 372/372 全绿（59 → 60 文件）。
3. **只读验证**：✅ 已完成 —— 见 §5。
4. **写验证**：⛔ 被阻塞 —— 需要第 1 步的协作者权限。计划：在新 base 建一次性演练表，
   跑两段式 `xws.feishu.import --commit`，确认 `publicationStatus=VERIFIED` + 游标推进，然后删表。
5. **正式切换**：未开始。env 文件指向新应用 + `DEFAULT_PROFILE=kcne`，跑一轮真实周更（或等下一个周期）。
6. **回滚**：旧 base 原样保留；把 `DEFAULT_PROFILE` 切回 `legacy` 即可，不需要改代码。

## 5. 只读验证证据（2026-09-14）

验证工具：`runtime/verify-feishu-profile.mjs`（只读：除换取 `tenant_access_token` 外不发任何写请求）。
它存在的理由——搬迁后「代码里那串 id 到底落在哪个 base 的哪张表上」只能靠实测回答，
grep 源码只能证明字面量长什么样。换 `DEFAULT_PROFILE` 之后同样可以拿它当回滚前的核对。

### 5.1 结构对比（`node runtime/verify-feishu-profile.mjs`）

```
── legacy  旧租户 rcndesfqro3x            base 浴缸竞品分析 V2（测试）
   competitorMain  tblJ9LHFN6pMVjPv  竞品主表          字段 36  记录 2004  sig e7acd5066b38
   skuDetail       tblddWTrPeB4TKmR  SKU明细           字段 17  记录  734  sig 1bb9a58d71ea
   history         tblH0bmmOuogxDHi  竞品历史总表 V1    字段 44  记录 4346  sig d58a3e2ccd21
   questionMaster  tblCrsUpiVlpWjVw  问题主库          字段 23  记录 2023  sig 0d8490e14185
   周表数量 6   协作者接口 OK（5 个成员）

── kcne  新租户 kcne618basvj              base 浴缸竞品分析 V2（测试） 副本
   competitorMain  tbl94WyAsVNdMkJf  竞品主表          字段 36  记录 2004  sig e7acd5066b38
   skuDetail       tbltI9UufhunLc3u  SKU明细           字段 17  记录  734  sig 1bb9a58d71ea
   history         tblktwxWKt8sjpXL  竞品历史总表 V1    字段 44  记录 4346  sig d58a3e2ccd21
   questionMaster  tbl37PRcIXQCtfYk  问题主库          字段 23  记录 2023  sig 0d8490e14185
   周表数量 6   协作者接口 拒绝 1063004 User has no share permission

结构对比：4 张稳定表的字段签名逐一相同。
```

签名 = 「字段名:类型」排序后的 sha256 前 12 位。四张表签名与行数**两边逐一相同**，
说明副本在字段名、字段类型、行数三个维度都没有缩水。

### 5.2 真实脚本双 profile 对照

| 命令 | legacy | kcne | 判定 |
| --- | --- | --- | --- |
| `tally-weekly-classification.mjs` | 周表 `tbld2LVUhXBuIEwD`；1462 行；无分类 1032 / D 369 / C 36 / 不适用 24 / A 1；样例 `recvv59xzccKmD` | 周表 `tblH56IUDG9l96V8`；其余**逐字节相同** | 通过 |
| `prepare-weekly-competitor-table.mjs`（默认只读） | 列出 10 张表；`NEW WEEK TABLE ALREADY EXISTS` | 列出 11 张表（多「数据表」）；同样结果 | 通过 |
| `publish-competitor-visualization.mjs`（dry-run） | `preflight=READY`；历史表 `tblH0bmmOuogxDHi`；`rows={source:1462,desired:1462,creates:0,updates:1462}`；`sourceHash=00c77b3797fa6009` | `preflight=READY`；历史表 `tblktwxWKt8sjpXL`；同上；`sourceHash=00c77b3797fa6009` | 通过 |

关键观察：

1. **换 profile 即换目标**：三支脚本都只通过 `SYCM_FEISHU_PROFILE` 切换，`legacy` 侧输出与改造前一致
   （`DEFAULT_PROFILE` 仍是 `legacy`，所以未设环境变量时行为不变）。kcne 侧唯一新增的是默认「数据表」。
2. **副本是行级忠实的**：`tally` 两边连样例记录 id（`recvv59xzccKmD`）都相同；
   `publish-competitor-visualization` 两边的 `sourceHash` 完全相同。
3. **周表按名字解析在新租户可用**：kcne 侧 id 完全不同，仍能正确定位到 `竞品周_2026-09-06_2026-09-12`。
4. **写路径仍未打通**：kcne 侧 `协作者接口` 返回 `1063004 User has no share permission`，
   与建表 `403 91403` 一致 —— 应用能读全库但不具备编辑权。

## 6. 待验证 / 待确认

- **公式字段的表达式**是否已指向新表：类型抽查一致，但历史总表 V1 的 44 个字段里含公式
  （type 20）与 lookup（type 19），需抽查若干行的计算值在新旧 base 是否相同。
- **仪表盘 / 视图**：`publish-competitor-visualization.mjs` 发布的历史总表是仪表盘唯一数据源；
  副本里的仪表盘是否也复制过来、是否指向新表，需要在浏览器里确认。
- **关键词库 base 是否也要在新租户建副本**（用户未要求，暂不动；新应用已可直接读）。
- **`数据表` `tblg6lkg6431QulJ` 的 5 行**是否保留（导入需要空表）。
- **新应用对旧 base 可写**（2026-09-14 写探针实测：`POST /tables` 返回 200，探针表已即时删除）——
  这意味着应用被加成协作者的是**旧生产 base** 而不是副本。需用户确认是否有意为之。

## 7. 相关文档

- 新租户应用的权限设置与诊断：`docs/ops/FEISHU-APP-SETUP-NEW-TENANT.md`
- 两段式真实演练记录：`docs/architecture/MIGRATION-8-QUEUE-SCHEDULER-REPORT.md` §8
- 单点目标配置模块：`runtime/feishu-targets.mjs`（+ `runtime/feishu-targets.test.mjs`）
- 只读验证工具：`runtime/verify-feishu-profile.mjs`（+ `runtime/verify-feishu-profile.test.mjs`）
- 周表按名字解析：`runtime/weekly-table-target.mjs`
