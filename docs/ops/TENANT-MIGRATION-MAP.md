# 竞品数据搬迁到新租户：映射表与影响面

状态：2026-09-14 **六步全部完成**（旧租户废弃，默认目标已切到新租户）。
同日晚补完三件事：**失败分类缺陷已按方案 A 修掉**（§6）、**关键词库 base 的副本已建好并改指**（§0 第 2 条）、
**修后用真实 base 跑通收据级复现**（§6.6 后两行：同一条消息的修前/修后收据对照）。
适用范围：竞品周更 SOP（base `OWebbPUcBa7B8JseYLccQCy9nkf` → 副本 `OUMqbkYwVaQxQNsv2EDc1DV7nDf`）。

> **现役值以 `runtime/feishu-targets.mjs` 为准（2026-09-20 复核）。**
> 本文是 2026-09-14 搬迁当天及随后的**历史记录**。文中出现的 `OUMqbkYwVaQxQNsv2EDc1DV7nDf`
> 是搬迁期的测试副本，**2026-09-15 已经切走**；现役竞品 base 是用户指定的正主
> `QcnhbEzYpacGvUskCbVcrcm3nFd`（名字「浴缸竞品分析」，四个可稳定引用的表 id 在同文件里）。
> 关键词库 base 同理：文中记的旧租户 `N21Abkg0HakO6AsbCaDckvcwnVd` 已换成
> `HdBhbttB5aScbasWJAMc0gGXnpe`。
> **别拿本文里的 token 直接当参数跑** —— 去读那个文件，读到的才是现役值。

## 0. 侦察结论

1. 新 base `OUMqbkYwVaQxQNsv2EDc1DV7nDf`（租户 `kcne618basvj`）是原 base 的**结构 + 数据完整副本**：
   - 10 张生产表**逐表行数完全相同**（2004 / 734 / 4346 / 2023 / 1461 / 734 / 2023 / 1423 / 0 / 1462）；
   - 抽查 5 张关键表的**字段名与字段类型逐字一致**：竞品主表 36、历史总表 V1 44、SKU明细 17、问题主库 23、周表_09-06 35；
   - 表 ID 全部不同，另多一张默认「数据表」`tblg6lkg6431QulJ`（1 字段 / 5 行）。
2. 关键词库 base `N21Abkg0HakO6AsbCaDckvcwnVd`（名字就叫「词库 最新 副本」）**仍在旧租户 `rcndesfqro3x`**，
   实测 URL 为 `https://rcndesfqro3x.feishu.cn/base/N21Abkg0HakO6AsbCaDckvcwnVd`，**没有随竞品 base 一起复制**：
   复制一张 base 只会复制那张 base 自己，词库是**另一张独立的 base**，不属于竞品 base。
   新应用能读到它靠的是**跨租户共享**（外部协作者），不是因为它在新区。

   注意：`/drive/v1/files`（应用云空间根目录）对新应用返回空列表，因此**无法从应用侧枚举**新租户里是否
   另有一份词库副本；要确认只能由人在浏览器里看。

   **后续（同日）**：用户在浏览器里复制了一份到新租户，
   token `HdBhbttB5aScbasWJAMc0gGXnpe`（名字「词库 最新 副本 副本」），
   `table=blkzxLvtVkhhqgfK` 是**仪表盘 block id**（不是表 id）。
   逐表核对结果：**8 张表的字段签名与行数全部一致**——
   关键词历史总表 V1（27 字段 / 2067 行）、关键词分析 V1（修正版）（26 / 301）、
   关键词分析 V1 各期（29 / 300）、关键词编号库 V1（5 / 475）。
   代码已改指这一份（见 §3.1）：`runtime/feishu-targets.mjs` 的 `kcne.keywordBase`
   + 新增的 `keywordBaseToken()` 访问器；`skills/huitun-to-feishu-keyword-heat/scripts/flow.mjs`
   的 `DEFAULT_TARGET` 从单点配置派生。旧 token 仍留在 `legacy` profile 里作为回滚路径。
   → 「词库会不会因为旧租户停用而断」这条风险就此关闭。
3. 新应用 `cli_a96ee8749078dbcf` 能读：竞品 base、竞品 base 副本、关键词库 base。
   ~~**写不通**（在副本上建表 / 建字段均 `403 91403`）~~ —— **当日复测已更正：写通了**
   （`POST /tables` 200、`POST /fields` 200、`DELETE` 200），详见 §5.3 与
   `docs/ops/FEISHU-APP-SETUP-NEW-TENANT.md` §5.3。原来的 `91403` 是「应用还不是协作者」，
   与权限 scope 缺失（`99991672`）是两回事。
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
关键词库 base：`N21Abkg0HakO6AsbCaDckvcwnVd`（旧租户）→ 副本
`HdBhbttB5aScbasWJAMc0gGXnpe`（新租户，代码已改指；旧 token 保留在 `legacy` profile）。

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
| 关键词库 base `N21Abkg…` | 26 | 已改为按 profile 单点配置（`keywordBaseToken()`），默认指向新租户副本 |
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
3. **默认值一行控制**。代码先就位、后切换：2026-09-14 先落代码（默认仍 `legacy`），
   读写验证都通过之后同一天把 `DEFAULT_PROFILE` 改成 `kcne`。回滚 = 改回 `legacy`，不动业务脚本。
   测试里有一条「默认 profile 是当前生产租户」的断言，默认值被改而没人同步文档时它会失败。
4. **关键词库 base 有独立访问器**（`keywordBaseToken(logicalName)`）。
   它是**另一张独立的 base**，复制竞品 base 不会带上它，所以它的 token 必须单独维护；
   但它与竞品 base **同属一个 profile**（同一套凭据、同一个租户），
   所以不进 `tables`（那是竞品 base 内的逻辑表名 → table id），而是平级的 `keywordBase` 字段。
   两件事分开：**同一个 profile 里的两张 base**，不是两个 profile。

`runtime/feishu-targets.test.mjs` 覆盖：两个 profile 覆盖同一批逻辑名、table id 互不相同且形状合法、
base 与 baseUrl 自洽、profile 冻结、别名解析与未知名抛错、环境变量切换（含空串回落）、
**默认 profile 是 kcne 且旧租户仍可显式选择**、`tableId` 命中与未知名抛错、
凭据路径分租户、`parseEnvFile` 处理注释/空行/引号、`loadFeishuCredentials` 只认两个键，
以及**关键词库 base 与竞品 base 各自随 profile 切换、不得混搭**（这是「两张 base 指向不同租户」
的唯一守门人——写错一个字面量就会被它拦下）。

### 3.2 已改造的活跃脚本（11 个文件，38 处 + 词库改指）

| 文件 | 替换处数 | 改了什么 |
| --- | --- | --- |
| `runtime/prepare-weekly-competitor-table.mjs` | 3 | base token、env 路径；2026-09-15 起**基准表由「上一周周表」改为「竞品主表」**（旧做法会把任何一次缺字段一路继承下去），并新增 `--apply-missing` 给已有周表补普通字段 |
| `runtime/create-weekly-formula-fields.mjs` | 5 | base token、env 路径、`OLD_TABLE` 默认值改为必填（跨租户后旧 id 失效）；2026-09-15 起默认＝竞品主表（可被 `COMPETITOR_OLD_TABLE_ID` 覆盖）、增加 19 查找引用的重建、默认 dry-run（`--apply` 才写） |
| `runtime/tally-weekly-classification.mjs` | 4 | base token、env 路径，新增「未给 `WEEKLY_TABLE_ID` 时按名字取最新竞品周表」 |
| `runtime/backfill-weekly-date-fields.mjs` | 6 | 各 PLAN 的 table id 改 `null` + 按名字在目标 base 内解析 |
| `runtime/run-faq-operator.mjs` | 2 | `DEFAULT_BASE_URL`、`DEFAULT_ENV_FILE` |
| `runtime/publish-faq-detail-enrichment.mjs` | 2 | 同上 |
| `runtime/publish-competitor-visualization.mjs` | 2+2 | `DEFAULT_ENV_FILE`；并把 `--base-url` / `--history-table-id` 由必填改为按 profile 兜底（调用方仍可覆盖） |
| `runtime/apply-xws-sku-manifest.mjs` | 3 | `TARGET.appToken` / `mainTableId` / `skuTableId`、env 路径 |
| `runtime/summarize-xws-sku-queue.mjs` | 3 | 同上 |
| `runtime/sync-weekly-sku-history.mjs` | 4 | 同上 |
| `runtime/sync-latest-ab-to-main.mjs` | 4 | 同上 |

词库 base 那一路（**另一次改指**，2026-09-14 晚）：`runtime/feishu-targets.mjs` 的
`kcne.keywordBase` 换成新租户副本 token，并在该模块新增 `keywordBaseToken()`；
`skills/huitun-to-feishu-keyword-heat/scripts/flow.mjs` 的 `DEFAULT_TARGET` 由写死的
token 改为从单点配置派生（实测 `{"appToken":"HdBhbttB5aScbasWJAMc0gGXnpe",…,"envFile":"E:/小红书/.env.feishu-kcne.local"}`）。

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

1. **用户侧前置**：✅ 已完成（2026-09-14 复测通过）。
   开放平台补 `bitable:app` + `drive:drive` 并重新发布版本 —— 已完成（`99991672` 消失）；
   把应用 `cli_a96ee8749078dbcf` 加为**副本 base** 的「可编辑」协作者 —— 已完成（复测见 §5.3）。
   注意：应用同时还是**旧生产 base** `OWebbPUcBa7B8JseYLccQCy9nkf`
   与**旧租户的词库 base** `N21Abkg…` 的协作者（跨租户共享），
   这两处是否保留需要用户确认（词库已在新租户有副本，旧的那份可以撤共享）。
2. **代码侧**：✅ 已完成 —— 见 §3.1 / §3.2。回归：`runtime` 套件 385/385 全绿（59 → 60 文件）。
3. **只读验证**：✅ 已完成 —— 见 §5.1 / §5.2。
4. **写验证**：✅ 已完成 —— 见 §5.3。在新 base 建一次性演练表 `_演练_kcne_20260914` 跑
   两段式 `xws.feishu.import --commit`，得到 `publicationStatus=VERIFIED` + 游标 1→3，然后删表。
5. **正式切换**：✅ 已完成（2026-09-14）。用户确认旧租户废弃、以后在新租户上开发，
   于是把 `DEFAULT_PROFILE` 由 `legacy` 改为 `kcne`，并把 kcne 的 `writeVerified` 声明翻真。
   实测（不设任何环境变量）：`activeProfileName()` → `kcne`，`envFilePath` →
   `E:/小红书/.env.feishu-kcne.local`，`competitorBaseToken` → `OUMqbkYwVaQxQNsv2EDc1DV7nDf`
   （**当时值**；2026-09-15 已换成 `QcnhbEzYpacGvUskCbVcrcm3nFd`，见文首现役值提示）；
   `runtime/tally-weekly-classification.mjs` 直接跑出
   `resolved weekly table: 竞品周_2026-09-06_2026-09-12 (tblH56IUDG9l96V8)`，
   统计结果与旧租户逐字节相同。
   切换时被回归抓出 2 条失败：`runtime/apply-xws-sku-manifest.test.mjs` 两个用例
   把旧 base token 手抄进夹具（`--confirm-app-token OWebbPUc…`），而 `TARGET` 在导入时按默认
   profile 定型 → 报 `confirm-app-token mismatch`。已改为从 `feishu-targets` **派生**期望值
   （那两条用例测的是「确认参数与当前目标是否一致」，不是「目标是哪个租户」）。
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
4. **写路径当时仍未打通**：kcne 侧 `协作者接口` 返回 `1063004 User has no share permission`，
   与建表 `403 91403` 一致 —— 应用能读全库但不具备编辑权。（用户补权限后已解除，见 §5.3。）

### 5.3 写验证：新 base 上的两段式真实提交（2026-09-14，用户授权）

前置复测（用户补协作者权限后）：

```
create table: status=200 code=0 success id=tblhm4nNWZOaKzpS
create field: status=200 code=0 success
readback fields: code=0 names=文本:1, 价格:2
delete table: status=200 code=0 success
after: code=0 tables=11
```

演练场地：在副本 base `OUMqbkYwVaQxQNsv2EDc1DV7nDf` 新建一次性表 `_演练_kcne_20260914`
（`tblBEhDouarnVkG5`）。字段不是手写的，而是**从真实周表 `竞品周_2026-09-06_2026-09-12` 克隆**
28 个可克隆字段（7 个公式字段 type=20 按设计延后，等第二遍重建）；
合同核对 `价格 type=2 / 月收货人数 type=1 / 商品图片 type=17`。

命令：

```
node runtime/sop-runtime/run-feishu-import-two-stage.mjs \
  --xlsx runtime/xws-bathtub-top3-with-images.xlsx \
  --base-url "https://kcne618basvj.feishu.cn/base/OUMqbkYwVaQxQNsv2EDc1DV7nDf?table=tblBEhDouarnVkG5" \
  --commit --env-file "E:/小红书/.env.feishu-kcne.local" \
  --operator user-approved-2026-09-14 \
  --period-start 2026-09-06 --period-end 2026-09-12 --expected-rows 3 --json
```

结果：

| 项 | 值 |
| --- | --- |
| `gate` | `APPROVED` / `ALLOW_WITH_APPROVAL` / `HIGH` |
| 采集段验证器 | `structure:ok` `row_count:ok` `digest:ok` `adapter:ok`，rowCount 3 |
| `publish.verdict` | **`VERIFIED`** |
| `commitKey` | `1014593893a5d8c17639a6ad98453476` |
| 回读收据 | `rows:3` `attachments:3` `digest:a67f43f365f077fb…` |
| `publicationStatus` | `VERIFIED` |
| `cursorAdvanced` | `true`，`verifiedCursor` `1 → 3`（version 1） |
| 决策轨迹 | `APPROVAL → PUBLICATION/READY → COMMITTED → VERIFIED` |
| 退出码 | 0 |

独立回读（不复用运行器代码，直接 `GET /bitable/v1/apps/:base/tables/:id/records`）：
`total=3`、`has_more=false`，价格 `612 / 2198.27 / 2098.14`，月收货人数 `"100"`（文本字段落字符串），
每条 1 张附件；三个日期字段已盖周期戳（`1788624000000` / `1789142400000` = 2026-09-06 / 2026-09-12）。

收尾：`DELETE` 演练表 → 200，base 回到原 11 张表，`drill table gone: true`。

**第一次尝试被 fail-closed 正确拦下**（缺 `--period-start/--period-end`，而目标表含三个日期字段）：
`sideEffectRefs` 为空、游标 `1 → 0`（未变）、零写入。这是 2026-09-14 上午加的「周表目标含日期字段必须盖周期戳」
防线按设计生效。**但它的失败分类有问题，见 §6 缺陷记录。**

### 5.4 公式 / lookup 字段的跨表引用检查（补做，2026-09-14 晚）

原本列在「待验证」里的「历史总表 V1 的公式(type 20)与 lookup(type 19)字段是否还指向旧表」，
用一条新判据关掉了：**表达式里出现的表 id 必须都属于同一个 base**。

做法：字段接口返回的 `property` 里，公式/lookup 的表达式把表 id 写死在字符串里；
把每个字段的 `property` 序列化后抽出所有 `tbl…` 形 token，与本 base 的表 id 集合比对，
不属其中的即**悬空引用**（复制 base 时最典型的事故——类型照样是 20/19，光比字段名与类型发现不了）。
实现为 `runtime/verify-feishu-profile.mjs` 的 `danglingTableRefs()`，悬空即计入该 profile 的 errors，
并在渲染里逐条列出「字段名 → 引用的表 id」。

同日扩展（关键词库 base 也纳入只读核查）：`inspectProfile` 之外新增 `inspectKeywordBase()`，
按 `profile.keywordBase` 独立读一张 base 的名称与表清单、逐表做同一套字段检查（含悬空引用），
错误前缀 `keyword …` 以便与竞品侧区分；并新增导出 `compareKeywordBases()`，按**表名**配对比字段签名
（刻意不比行数——行数随时间增长，不是结构不变量），一侧缺表则报 `ONLY_ONE_SIDE`。

实测结果（2026-09-14 晚，两个 profile 各查两张 base）：

```
── legacy：悬空表引用 0（竞品 base）+ 0（关键词库 base）
── kcne  ：悬空表引用 0（竞品 base）+ 0（关键词库 base）
结论 OK / 结论 OK
结构对比：4 张稳定表的字段签名逐一相同。
词库对比：两侧副本逐表字段签名相同（各 8 张表）。
```

即副本的公式/lookup 表达式**只引用本 base 内的表**，复制时引用被一起改写了；
关键词库副本 `HdBhbttB5aScbasWJAMc0gGXnpe`（名「词库 最新 副本 副本」）8 张表逐表签名与旧侧完全一致。
这两条风险关闭。

（该检查同时解释了「协作者接口」那一行为什么是参考信息：列成员需要更宽的 drive 权限，
新应用在被共享的 base 上会被拒 `1063004`，但这不影响读写——所以它不计入 errors。）

## 6. 缺陷记录与修复：fail-closed 闸门的失败分类被归成 BUG（2026-09-14 已修，方案 A）

### 6.1 现象

第一次尝试的收据里：

```
"blocker": { "class": "BUG", "detail": "bug suspected, stop automation: Target table has date fields … refusing to create an undated period table" }
"nextAction": "TERMINAL"
```

判定为**分类不准**，而不是闸门本身有问题：写入被正确拒绝，但原因被说成「疑似代码 bug，停止自动化」。

### 6.2 根因链（已定位到行）

1. 守卫在 `skills/xws-to-feishu-base/scripts/import-runner.mjs` 抛的是**裸 `Error`**，
   不带 `code` / `failureClass`；
2. `runtime/sop-runtime/side-effect-ledger.mjs:53` 走
   `error?.failureClass ?? classifyExternalFailure(error)`；
3. `runtime/sop-runtime/policy.mjs:159` 的 `classifyExternalFailure` 只认 HTTP 状态码与
   英文关键词，本能力的守卫消息两样都没有 → 落到 `return 'BUG'`；
4. `actionForFailure('BUG')` → `STOP_AND_ALERT`「bug suspected, stop automation」。

这与 `policy.mjs:156-158` 自己写的意图相反（"不能一律归 BUG——BUG 会触发 STOP_AND_ALERT，
把一次可修复的目标配置错误升级成停线"）。另外三个适配器
（`adapter.sku-collection` / `adapter.search-rank` / `adapter.huitun-keyword-heat`）
都已经有 `FAILURE_CLASS_BY_CODE` 这类**确定性 code → 分类**映射，只有 `adapter.feishu-import` 没有。

实际影响有限：`POLICY_DENIED`（`FAIL`）与 `BUG`（`STOP_AND_ALERT`）对该 run 都是终止，
区别只在**给运维的结论**——一个说「策略拒绝/配置不对」，另一个说「代码有 bug，停线」。
后者会把人引向排查代码而不是补参数。

### 6.3 为什么不是一个「就地补关键词」的小补丁

朴素修法（在 `classifyExternalFailure` 里加一条 `period|date field` 关键词）被否掉，因为它把
**能力的业务词汇塞进框架的策略模块**：框架从此要知道「周期表」「16 字段合同」这些概念，
下一个能力加一条，框架就成了一张关键词拼盘。正确的方向是反过来的——
**由能力自己给出确定性 code 与分类，框架只负责按分类决定下一步**。这也正是另外三个适配器
已经在走的路（`adapter.huitun-keyword-heat` 明确写着「默认的 failureClassOf 只按英文关键词猜，
而这条链的原因文案大多是中文，必须逐条显式映射」）。

原始记录里给过的两个方案：

- 方案 A（推荐，已采纳）：守卫抛带稳定 `code`（如 `PERIOD_REQUIRED`）的错误，
  能力侧维护 `FAILURE_CLASS_BY_CODE`，把它映射到 `POLICY_DENIED`。
- 方案 B（不采纳）：把「调用方参数缺失」一类归 `HUMAN_REQUIRED`（`WAIT_HUMAN`）。
  否决理由：CLI 是一次性进程，`WAIT_HUMAN` 对一个已经退出的进程没有语义；
  而且「等人工」会让人以为配置改好自动就会继续，实际不会。

### 6.4 已实施的修复

**唯一事实来源**：`skills/xws-to-feishu-base/scripts/import-core.mjs`
（`FAILURE_CLASS_BY_CODE` 在 :17，唯一构造入口 `fatalError()` 在 :46）。

选择 `import-core` 而不是适配器，是因为**同一族拒绝会在采集段与发布段分别抛出**：
`validateTarget` 的「目标表非空」在 `import-core` 里，同一个检查在 `import-runner` 里也有一份
（`prepareTarget` 的前置）；两个模块抛的必须是同一个 code 与同一个分类，否则分类就取决于
「这次是哪个模块先抛的」。这个模块本来就是该能力的共享叶子（`import-runner` / 适配器 /
CLI / 两个 runtime 脚本都 import 它），没有新增模块、没有新增依赖边。

机制：

1. 每个确定性拒绝都换成 `throw fatalError(code, message, details)`；`fatalError` 同时挂上
   `code` 与 `failureClass`，并且**code 漏登记时立刻抛**（开发期错误），
   不允许它悄悄退回默认分类器把原因说错。
2. 覆盖面是「运行时路径上的全部三个模块」：`import-core.mjs`（7 处）、
   `import-runner.mjs`（8 处）、`adapter.feishu-import.mjs`（8 处）。
   其余未改的 `throw new Error(...)` 都只存在于 CLI 与独立迁移脚本里，不经过运行时分类。
3. 适配器 `export { FAILURE_CLASS_BY_CODE, XWS_HEADERS }`（:175）——只做 re-export，
   不复制词表。另三个适配器都把这个词表挂在适配器模块上，运维排查时先看适配器，
   位置保持一致。

词表（17 个 code，三组）：

| 组 | code | 分类 | 理由 |
| --- | --- | --- | --- |
| 源/证据不合合同 | `SOURCE_HEADERS` `SOURCE_EMPTY` `SOURCE_IMAGE_AMBIGUOUS` `SOURCE_VALUE_INVALID` | `EVIDENCE_INVALID` | 重跑同一份输入没有意义，要换输入 |
| 采集能力跑不动 | `EXTRACTION_FAILED` | `CAPABILITY_DEGRADED` | 抽取器起不来，是本版本能力的问题 |
| 调用方/目标没准备好 | `BASE_URL_INVALID` `INPUT_REQUIRED` `INPUT_NOT_FOUND` `CLIENT_REQUIRED` `TARGET_NOT_EMPTY` `TARGET_IMAGE_FIELD` `TARGET_FIELDS_MISSING` `PERIOD_REQUIRED` `PERIOD_INVALID` | `POLICY_DENIED` | 修正参数后本可以重跑，**不是**代码缺陷 |
| 写后外部行为不符（刻意保留 BUG） | `POST_WRITE_COUNT_MISMATCH` `POST_WRITE_VERIFY_MISMATCH` | `BUG` | 见下 |
| 进程内调用顺序被破坏 | `STAGE_ORDER` | `BUG` | 真 bug（例如没跑 `start()` 就取工件） |

顺带修掉的两条同类问题（同一个根因，不是顺手改别的）：

- `parseBaseUrl('')` 原来抛的是 `new URL('')` 的 **`TypeError: Invalid URL`**，
  同样会被归成 BUG。现在包成 `BASE_URL_INVALID`。
- 适配器 `prepare()` 原来对缺 `baseUrl` 的输入也会走到同一个 `TypeError`，现在显式报
  `INPUT_REQUIRED: baseUrl is required to bind the artifact to its target`
  （`baseUrl` 本来就是 manifest 声明必填的 `target_table`）。

### 6.5 刻意**没有**改的两条，与范围边界

- `POST_WRITE_COUNT_MISMATCH` / `POST_WRITE_VERIFY_MISMATCH`（`import-runner.mjs:119/:132`）
  **仍然归 BUG（停线交人工）**。语义上最贴的其实是 `COMMIT_UNKNOWN`（→ `RECONCILE_COMMIT`：
  先对账再谈重试），但那会把「写后数量不符」从「停线」改成「回对账」，
  属于**写路径语义变更**，不在本次授权范围内。这里的取舍是：宁可停线交人工，
  也不冒充「确定未发生」去重试。要不要改判 `COMMIT_UNKNOWN` 是另一个决策。
- `feishu-client.mjs` 不在范围内：它的失败消息带 HTTP 状态码
  （`Feishu API failed: 4xx/5xx …`），默认分类器本来就能归对——这正是 `classifyExternalFailure`
  存在的原因。缺陷恰恰出在**不带状态码的自有守卫**上。
- CLI（`import-xws-to-feishu.mjs`）与独立迁移脚本的参数校验也不改：它们不经过
  Side Effect Ledger / Worker，错了只是打印一行退出，没有「分类」这个观测面。

### 6.6 验证证据

| 层次 | 证据 | 结果 |
| --- | --- | --- |
| 缺陷与修复同框（单元） | 「同一条消息，裸 `Error` 归 `BUG`/`STOP_AND_ALERT`；挂上 code 归 `POLICY_DENIED`/`FAIL`」 | 通过 |
| 词表自洽 | 每个分类都 ∈ `FAILURE_CLASS`，且都能映射出下一步动作 | 通过 |
| 真入口 + 真账本 | `runImport` 抛出的守卫错误经真 `createSideEffectLedger().commit()` | `status=FAILED`、`failureClass=POLICY_DENIED`、持久化记录同值 |
| 生产路径上的 handler | `createFeishuImportPublisher().handler()`（`run-feishu-import-two-stage.mjs:199` 交给发布段的就是它） | 原样交出 `code`/`failureClass` |
| **收据级**（真 registry + 真 Controller + 真账本 + 真发布段） | 断言那次演练写错的那个字段 | `verdict=REJECTED`、`publicationStatus=READY`、`blocker.class=POLICY_DENIED`、`detail` 含 `policy denied`、**不含** `bug suspected`、`nextAction=TERMINAL` |
| 回归守卫（源码级） | 三个运行时模块里「非注释行出现 `throw` 就必须走 `fatalError`」 | 通过（唯一例外是 `fatalError` 自己那条漏登记喊停） |
| 套件 | `skills --skill=xws-to-feishu-base` / `runtime` | **95/95**、**397/397** |
| 真实入口（dry-run） | CLI `--xlsx … --base-url …`（dry-run）、两段式 runner（默认只采集段） | 两者都正常：3 行 / 3 图；采集段四个验证器 `structure,row_count,digest,adapter` 全 ok，`sideEffectRefCount=0` |
| **真实 commit 收据（缺陷现场复现）** | 新租户 base 里一次性演练表 `tbl9iqZ1bDVn2fZp`，两段式 runner `--commit` 但**故意不给** `--period-start/--period-end` | `verdict=REJECTED`、`commitKey=46997dd02a9a5f6a18222855fcae2b02`、**`blocker.class=POLICY_DENIED`**（修之前是同一条消息归 `BUG`）、`detail` 含 `policy denied` 且**不含** `bug suspected`、`publicationStatus=READY`、游标未推进（`{start:1,end:0,version:0}`）、退出码 2；**独立回读确认 0 行（零写入）** |
| 真实 commit 收据（成功路径无回归） | 同一张演练表，补齐 `--period-start 2026-09-06 --period-end 2026-09-12` | `verdict=VERIFIED`、`commitKey=1b02520a159026625a5e08f1c16a10a0`、回读 `rows:3/attachments:3`、发布期验证器 `readback,publication` 全 ok、`blocker=null`、`publicationStatus=VERIFIED`、游标 `1→3`（version 1）、退出码 0；独立回读 3 行、价格 `612 / 2198.27 / 2098.14`、月收货人数 `"100"`、每条 1 附件、三个日期字段盖戳 |

**收尾**：演练表 `DELETE` → 200，base 回到原 11 张表。

「未做的一项验证」到这里已经补完——上一节 §5.3 留下的是「修之前」的现场，
本节两行是「修之后」同一现场、同一入口、同一条消息的收据对照。
唯一仍未被真实跑过的是另外三条能力（`sycm.feishu.weekly`、`xws.sku.collection`、
`huitun.keyword-heat.collect`）的发布段，与本次修复无关。

新增测试文件：`skills/xws-to-feishu-base/tests/import-failures.test.mjs`（11 个用例，
含上面「缺陷与修复同框」「收据级」「源码守卫」三条）。

## 7. 待验证 / 待确认

- ~~公式字段的表达式是否已指向新表~~：✅ 已关闭，见 §5.4（两侧悬空引用均为 0）。
- ~~仪表盘 / 视图是否随副本复制~~：用户已确认仪表盘随副本复制过来了。
  仍需在浏览器里确认它指向的是新表（应用侧看不到仪表盘对象）。
- ~~关键词库 base 是否单独再搬一次~~：✅ **已关闭**。用户在新租户复制了一份
  `HdBhbttB5aScbasWJAMc0gGXnpe`，逐表比对 8 张表的字段签名与行数全部一致，
  代码已改指（见 §0 第 2 条 / §3.1）。旧租户那份现在只是回滚路径（`legacy` profile）。
  连带可做但未做：撤销新应用对旧词库 base 的跨租户共享。
- **`数据表` `tblg6lkg6431QulJ` 的 5 行**：✅ 已按用户要求清空（回读 `total=0`，base 仍 11 表）。
- **协作者归属**：新应用目前是 4 处 base 的协作者——旧生产 base、副本 base、
  旧租户词库 base、新租户词库副本。**用户已明确：旧 base 的所有者已不是他，不必再管**
  （2026-09-14），故旧的几处共享不主动撤销；此处只留档。
- ~~§6 的失败分类缺陷修不修、按 A 还是 B~~：✅ 已按方案 A 修完，见 §6.4。
  剩余待决：§6.5 那两条写后异常要不要改判 `COMMIT_UNKNOWN`（对账）——用户「先不改」。
- ~~拿真表跑一次 commit 看真实收据 `blocker.class`~~：✅ **已关闭**，见 §6.6 后两行
  （同一入口、同一条消息的修前/修后收据对照，含零写入与独立回读）。
- **两个应用都缺 `tenant:tenant:readonly`**，所以 API 拿不到租户真名，
  只能用域名前缀（`kcne618basvj` / `rcndesfqro3x`）作标识。想拿到租户名需补该 scope。

## 8. 相关文档

- 新租户应用的权限设置与诊断：`docs/ops/FEISHU-APP-SETUP-NEW-TENANT.md`
- 两段式真实演练记录（首次跑通，App 自有租户）：`docs/architecture/MIGRATION-8-QUEUE-SCHEDULER-REPORT.md` §8
- 单点目标配置模块：`runtime/feishu-targets.mjs`（+ `runtime/feishu-targets.test.mjs`）
- 只读验证工具：`runtime/verify-feishu-profile.mjs`（+ `runtime/verify-feishu-profile.test.mjs`）
- 周表按名字解析：`runtime/weekly-table-target.mjs`
- §6 修复的测试：`skills/xws-to-feishu-base/tests/import-failures.test.mjs`
  （词表 / 缺陷复现 / 真账本 / 收据级 / 源码守卫）；失败码词表与 `fatalError` 在
  `skills/xws-to-feishu-base/scripts/import-core.mjs`
- 本次写验证的运行收据：`runtime/sop-runtime/two-stage-mu110brg/receipt.json`（成功）
  与 `runtime/sop-runtime/two-stage-mu10zyr2/receipt.json`（被 fail-closed 拦下）
- §6.6 收据级真实复现的运行收据：`runtime/sop-runtime/two-stage-mu16kph9/receipt.json`
  （修之后仍被拦下，`blocker.class=POLICY_DENIED`）与
  `runtime/sop-runtime/two-stage-mu16l30w/receipt.json`（补齐周期后 VERIFIED）

## 9. 同租户内换 base：kcne 的竞品目标切到正式 base（2026-09-15）

这次不是换租户，是**同一个租户（kcne618basvj）内换竞品 base**，所以流程比 §1-§6 短：
单点配置改一处 + 只读验证 + 写权限重新验证（后者**尚未做**）。

| 项 | 切换前（迁移期测试副本） | 切换后（正式） |
| --- | --- | --- |
| base 名 | 浴缸竞品分析 V2（测试） 副本 | 浴缸竞品分析 |
| base token | `OUMqbkYwVaQxQNsv2EDc1DV7nDf` | `QcnhbEzYpacGvUskCbVcrcm3nFd` |
| competitorMain | `tbl94WyAsVNdMkJf` | `tblkYcczxBnW4v5G` |
| skuDetail | `tbltI9UufhunLc3u` | `tbl3N48H4znz304T` |
| history | `tblktwxWKt8sjpXL` | `tbln7qqA6XopiL4Q` |
| questionMaster | `tbl37PRcIXQCtfYk` | `tblbJ9F91NiN8IfO` |
| 默认空壳表 | `tblg6lkg6431QulJ`（「数据表」，行已清空，表仍在） | **没有**（正式 base 只读列举 10 张表，无「数据表」）→ `scratchTable: null` |
| writeVerified | true（2026-09-14 实测建表/建字段/DELETE + 两段式 import VERIFIED） | **false**（2026-09-15 实测写入被拒，见下） |

**为什么这次不是数据迁移**：两个 base 的登记行数逐表相同（竞品主表 2004 / SKU明细 734 /
竞品历史总表 V1 4346 / 问题主库 2023 / 竞品周_2026-09-06_2026-09-12 1462），即测试副本是正式 base 的
**镜像**。所以切换只涉及「指向 + 表 id 映射 + 写权限复验」，不涉及搬数据。

**回滚**：改回 `runtime/feishu-targets.mjs` 里 kcne 的 `competitorBase` 与四个表 id
（旧值已写在同处注释里），跑 `node --test runtime/feishu-targets.test.mjs` 与
`node runtime/verify-feishu-profile.mjs --profile kcne` 复核。测试里有一条断言钉死了
kcne 的 base 与 history 表 id，所以「改了配置忘了同步」会当场失败。

**只读验证结果（2026-09-15 实测）**：`verify-feishu-profile.mjs --profile kcne` → 结论 OK；
四张稳定表字段数/记录数（36/2004、17/734、44/4346、23/2023）与迁移记录一致；悬空表引用 0。
协作者接口被拒（`1063004 User has no share permission`）——列表成员需要更宽的 drive 权限，
与读写无关，不影响结论。

**换 base 时漏改一处（已修）**：`scratchTable` 曾留在上一个 base 的值 `tbl7V2FuLlFXCZSi`，
而这张表现在**两个 base 里都不存在**（正式 base 根本没有「数据表」）→ 悬空引用。
已改 `scratchTable: null`（`feishu-targets.test.mjs` 12/12 通过）。
教训与 §5 的 `writeVerified` 同一条：**换 base 要逐字段过一遍这个文件，不能只改四个稳定表 id**。

**写权限：实测被拒（2026-09-15）**。用真实入口做了一次 `--apply`：

| 项 | 结果 |
| --- | --- |
| 命令 | `publish-competitor-visualization.mjs --period-start 2026-09-06 --period-end 2026-09-12 --expected-rows 1462 --apply --confirm-app-token QcnhbEzYpacGvUskCbVcrcm3nFd` |
| 结果 | 收据 `mode=BLOCKED`，`error.reasonCode=FEISHU_PERMISSION_REQUIRED` |
| 原始错误 | 独立幂等写探针（把 `平台` 写成它当前的值）→ **HTTP 403 / code 91403 / Forbidden** |
| 零写入证据 | 失败后立刻重跑 dry-run：`updates` 仍是 `1462/1462`、`sourceHash` 不变 → 没有一行被改写 |
| 收据留档 | `evidence/publish-blocked-permission-20260915.json` |

所以 `writeVerified` 现在不是「未验证」而是「**已验证 = 不可写**」。
要解开需要在飞书里把应用（App ID `cli_a96ee8749078dbcf`）加为
「浴缸竞品分析」(`QcnhbEzYpacGvUskCbVcrcm3nFd`) 的**可编辑协作者**——
与 §4 观察 4 是同一个 `91403`：当年补的权限补在**测试副本**上，正式 base 没补。

**正式 base 的表清单（只读列举，2026-09-15）**：四张稳定表 + 竞品周 08-23 / 08-30 / 09-06 +
SKU周 08-23 + 问题库 08-23 / 08-30，共 10 张。缺 `SKU周_2026-09-06_2026-09-12` 与
`问题库_2026-09-06_2026-09-12`（后者按 FAQ 状态机是「本周无合格竞品 → 发布为空操作」，属设计内）。

**未验证项（下一步必须做）**：新 base 的**写权限**。
验证方式沿用 §5.3 的成例（建表/建字段/DELETE 均 200 + 一次两段式 import 到 VERIFIED）。
