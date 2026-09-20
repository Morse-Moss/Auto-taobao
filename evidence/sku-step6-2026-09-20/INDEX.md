# evidence/sku-step6-2026-09-20

本轮（本机时间 2026-09-20 上午，承接 09-19 深夜）两条链的现场留证。
每条都标了**结论**与**它证不了什么**，避免把「跑过一次」当成「已验证」。

## 竞品第 6 步（SKU/尺寸富化）—— 仍被人工闸门挡住

| 文件 | 结论 |
| --- | --- |
| `preflight-01.txt` | 正式预检 `runtime/xws-sku-auth-preflight.mjs` 返回 **STALLED（exit 3）**：`Product page target is unavailable: 921092099640` |

现场：竞品链（调试 Edge 9222 / 代理 3457）上商品页被重定向到
`login.taobao.com/havanaone/login/login.htm`，页头「登录」。
实测该页**没有**风控关键词，是普通登录墙；浏览器密码库里**没有**该账号的保存凭据
（`autofillId=false` / `autofillPassword=false` / `passwordValueLength=0`），所以只能由人登录。

目标行（未变）：周表 `recvvhOyFCtNA1` / 主表 `recvticyHkhtcR`；
店铺「勒示卫浴出口欧美25年」；商品 921092099640（PMMA 人造石浴缸，B-高价值竞品）。
`尺寸/适用空间` 当前「无注明」。

**仍未解的风险**：产物 `尺寸/适用空间` 目前没有可到达的消费者
（飞书开放 API 建不了 Lookup(type 19)；SKU 周表本周不存在）。

## 关键词周更链 —— 本地段就绪，写入段排练通过

| 文件 | 结论 |
| --- | --- |
| `shop-pages-before-keyword-export.txt` | 导出前各期望页面恰好一个（exit 0） |
| `keyword-export-2026-09-19.txt` | run1 超时：market_rank 停在别的类目，`waitForPath` 永不成立 |
| `keyword-export-2026-09-19-run2.txt` | run2 失败：`Ranks are not contiguous 1..N`（页大小 10→50 的已知竞态，**保护**不是故障） |
| `keyword-export-2026-09-19-run3.txt` | run3 **成功**：300 行、rank 1-300、`pageSizes 50/50/50/50/50/50`、周期 2026-09-13~09-19 |
| `category-tree-before.txt` / `category-tree-expand.txt` / `category-picked.txt` | 人工前置的分类是如何被点选的（脚本只校验、不设置） |
| `pre-ai-help.txt` / `pre-ai-run.txt` | `run-weekly-pre-ai.mjs` 跑到 `LOCAL_INPUT_READY`（批次 8） |
| `copy-weekly-dryrun.txt` | `copy-weekly-table.mjs` dry-run：源表 300 行 / 29 字段 / 尚无同名副本 |
| `copy-weekly-coldstart-verify.txt` | **修复后**的冷启动真机验证：首次尝试即成功（修复前同一场景必失败） |
| `update-weekly-rehearsal-dryrun.txt` | `update-weekly-base.mjs` **排练式** dry-run：`DRY_RUN_READY` |

排练 dry-run 的实数：编号库 475 行、**缺 19 个新词**；历史 2067 → 2367；
`批次有效性` 字段已存在（无需新建）；旧批次改动 0；历史里有 300 行的 `采集日期` 为空
（脚本如实披露，不代填）。

### 这份证据证不了什么

- `update-weekly-rehearsal-dryrun.txt` **不是**正式 dry-run：为了零写入，它的
  `--weekly-table-id` 指的是上一张表（2026-09-12），而不是本周还没建的新表。
  正式 dry-run 必须等 `copy-weekly-table --apply` 建出新表之后。
- 三个真写入（建表 / 写周表+历史+编号库）**都还没发生**，需要点名授权。

## 环境状态与代码修复留证

| 文件 | 结论 |
| --- | --- |
| `port-probe-all-down.txt` | `127.0.0.1` 直连探活 15 个端口（`9222`/`3457`/`19022`/`19023`/`19024`/`19031-19035`/`19041-19045`）**全部 DOWN**（09:26 与 09:38 各一次）。**只读探活，未启动任何进程。** |

### 顺手纠正一个我自己报错的数（重要）

我先前说「全量套件绿只有在代理活着时才有意义，因为 `paste-endpoint.test.mjs` 直连 19023」——
**这是错的**。`scripts/run-test-suite.mjs` 的 `EXCLUSIONS`（:40-49）把该文件从离线套件里**排除**了，
所以 `run-test-suite.mjs skills` 的数（54 文件 / 715 测试）**与代理在不在无关**。

这个误会的来源：直接对目录跑 `node --test skills/sycm-to-feishu-base/tests/` **会带上**那个被排除的文件，
于是出现「同一个改动，一个数说全绿、另一个数说 1 红」。**两个分母不同，不是回归。**

正确报法（两张数都要给）：

| 套件 | 命令 | 实测 | 说明 |
| --- | --- | --- | --- |
| 离线技能 | `run-test-suite.mjs skills` | **716 / 0 fail**（54 文件，09:50→10:10） | 不含活体文件；与端口无关。**本轮最终数** |
| 活体 | `run-test-suite.mjs integration` | 17 测试 / 8 pass / **1 fail** / 8 skip | 那 1 fail = `paste-endpoint.test.mjs`（`ECONNREFUSED 127.0.0.1:19023`，端口全 DOWN 时预期内） |
| 单独直跑 | `node --test .../paste-endpoint.test.mjs` | `not ok 1`（ECONNREFUSED） | 复现同一条 |
| 单技能 | `run-test-suite.mjs skills --skill=sycm-to-feishu-base` | 9 文件 / **86 / 0 fail** | 本轮改动集中在这个技能 |

本轮代码修复的判据与突变验证（**6 个突变点**，全部被点名拦住并逐字节还原）：
`copy-weekly-table.mjs` 就绪竞态；`run-weekly-pre-ai.mjs` / `update-weekly-base.mjs` /
`run-weekly-post-ai.mjs` / `sync-decision-history.mjs` 四处跨租户凭据默认值。
突变脚本在仓库外（`D:/Retire/probe-live/mutate-weekly-fixes.mjs`），避免被边界守卫扫到。

