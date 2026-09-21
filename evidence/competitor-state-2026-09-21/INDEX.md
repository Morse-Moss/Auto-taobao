# 竞品链现状取证 2026-09-21

## 为什么取这组证

多份文档对同一批飞书字段记了互相矛盾的数字：

- `docs/ops/WEEKLY-SUPERVISION-2026-09-13_2026-09-19.md` §1 表与 §3 P1-2：`搜索关键词`「全空、未修」，周表 35 字段
- `docs/ops/WEEKLY-RUN-2026-09-13_2026-09-19-FINDINGS.md` §3：同一列 1417/1417 已写满
- `docs/ops/WEEKLY-FLOW-CURRENT-2026-09-20.md` §3.2：第 7 步产物无消费者（推断，非实测）

⇒ 本轮**不采信任一份文档**，改为直接写只读探针发 GET 实测。

## 方法与边界

两个探针**只发 GET**（`listTables` / `listFields` / `listRecords`），未创建、未更新、未删除任何记录或字段。
运行时间 2026-09-21 09:2x（+08:00）。凭据取自 `runtime/feishu-targets.mjs` 解析出的
`E:/小红书/.env.feishu-kcne.local`，base `QcnhbEzYpacGvUskCbVcrcm3nFd`（profile kcne）。

## 文件清单

| 文件 | 是什么 |
| --- | --- |
| `competitor-weekly-state.mjs` | 探针一：单期明细（最新周表 / 竞品主表 / SKU明细 的字段类型 + 有值率） |
| `competitor-weekly-state.txt` | 探针一输出 |
| `weekly-tables-across-periods.mjs` | 探针二：**四期竞品周表 + SKU 周表跨期有值率对比** |
| `weekly-tables-across-periods.txt` | 探针二输出 |
| `inventory-2026-09-21.txt` | 端口/实例只读盘点（竞品链 9222/3457 当时整缺） |
| `now.txt` | 本次取证的实测时间（`current_time` 是会话开始快照，不可用） |

## 结论（详见 `docs/ops/WEEKLY-FLOW-CURRENT-2026-09-20.md` §七）

1. **本期（09-13~09-19）是四期里唯一写满的一期**：12 个关键字段 10 个 100%、`数据状态`/`待补数据项` 98.4%、
   只有 `商品ID` 是 0/1417。**真正全空的是 08-30 与 09-06 两期**（除公式列外全 0）。
2. 周表 `搜索关键词` = **1417/1417（100%）** ⇒ `WEEKLY-SUPERVISION` P1-2 已过时，
   `sync-latest-ab-to-main-core.mjs:79` 那道 fail-closed 本期是通的。
3. 主表 `尺寸`/`适用空间` **仍是 Lookup(19)、15/2004＝0.7%**；周表已改 Text 100%。
4. **SKU 周表全 base 只有 1 张**（`SKU周_2026-08-23_2026-08-29`），本期从未创建。
5. 第 6 步硬阻塞＝买家号登录态；竞品链浏览器当时整缺。
