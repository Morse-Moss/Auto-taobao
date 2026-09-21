# 竞品周表「商品ID」补写（2026-09-21）

## 结论

四期竞品周表 + 竞品主表的 `商品ID` 现在**全部 100% 有值**：

| 表 | 表 id | 行数 | 补写前 | 补写后 |
| --- | --- | --- | --- | --- |
| 竞品主表 | `tblkYcczxBnW4v5G` | 2004 | 1461/2004（缺 543） | **2004/2004** |
| 竞品周_2026-08-23_2026-08-29 | `tblDpoBCxUJmNBR7` | 1461 | 1461/1461（本来就有） | 未动 |
| 竞品周_2026-08-30_2026-09-05 | `tblGayj9pTYY0Fb7` | 1423 | 0/1423 | **1423/1423** |
| 竞品周_2026-09-06_2026-09-12 | `tblosvuwE6xqYn6r` | 1462 | 0/1462 | **1462/1462** |
| 竞品周_2026-09-13_2026-09-19 | `tbllWI45sK0DfHpr` | 1417 | 0/1417 | **1417/1417** |

（SKU明细 830/830、SKU周_2026-08-23 734/734 本来就满，本次未动。）

## 这一列空着的原因（不是链接不够用）

- `商品ID` 是**文档化字段**：`docs/references/COMPETITOR-FIELD-REFERENCE.md` §4.6 写着「淘宝商品 id，
  SKU 采集的入口参数」，`runtime/competitor-weekly-schema-core.mjs:57` 也把它列进周表架构。
- 实测**周表 1417/1417 的商品链接都能提出 id**（提不出 0 行）——所以缺的不是数据源。
- 真正原因是**没有写入方**：发布路径 `runtime/competitor-history-publish-core.mjs:41,126` 是
  「读 `商品ID`，读不到就从链接提，再写进**历史总表**」，方向是从周表往外流；周表自己这一列没人写。
  主表侧 1461/2004、SKU明细 830/830 有值，都不是这条路径的产物。
- ⇒ 本次不是新口径，是把**已有的派生值落盘**，让这一列不再与它自称的含义不一致。

## 做了什么

- 新建 `runtime/fill-weekly-product-id-core.mjs`（判据层）+ `fill-weekly-product-id-core.test.mjs`（9 条）
  + `fill-weekly-product-id-core.mutation.mjs`（5 条突变），CLI 为 `runtime/fill-weekly-product-id.mjs`。
  CLI 与同仓 `fill-weekly-attribute-labels.mjs` 同一口径：默认 dry-run，真写要
  `--apply` + `--confirm-app-token` 与当前 base token 逐字相同。
- 只写 `商品ID` 一列：不碰任何属性列，不碰主表 / SKU明细 / 历史总表。
- 三条边界（都由测试守着）：**只填空不覆盖**；已有值与链接 id 不一致时**不写但要报**（conflict）；
  链接提不出 id 的行**单独计数**（noId），不许并进「已填」。
- 三张表的实际写入：conflict 0、noId 0、二次执行零更新（幂等）。

## 验证

1. 写入器自检 + 回读：三张表都是 `APPLIED_AND_VERIFIED`，回读空白数 **0**（预期 0，等于 noId 数）。
   收据：`receipt.json`（09-13 期）、`competitor-week-2026-08-30.receipt.json`、
   `competitor-week-2026-09-06.receipt.json`；stdout 见 `apply-*.txt`。
2. **独立回读**（`readback-independent-all-tables.txt`，早期版本为 `readback-independent.txt`）：
   另起只读探针（`D:/Retire/probe-live/product-id-audit.mjs`），**不复用**仓库里的 `extractProductId`，
   自己用另一份正则重提一遍 id 逐行比对，先断言字段存在再谈有值率。结果：**7 张有这一列的表全部 100%、
   不一致 0 行**（主表 2004、四期周表 1417/1423/1462/1461、SKU明细 830、SKU周 734）。
3. 判据的突变验证（`mutation-verification.txt`）：**5/5 CAUGHT_AND_NAMED**，
   源码逐字节还原（`MUTATION_ALL_CAUGHT_AND_RESTORED`）。
   覆盖的错法：允许覆盖已有值 / 把 noId 并进已填 / 幂等失效 / recordId 重复不抛 / 读回判据恒真。
4. dry-run 记录：`dryrun-2026-08-30-and-09-06.txt`（写入前的现场）。

## 边界（本次没做）

- **没有让任何读取方改用这一列**。当前各处的读法仍是 `text(商品ID) || extractProductId(商品链接)`
  这种「先读列、读不到再提」的双轨（例：`runtime/summarize-xws-sku-queue.mjs:76`、
  `runtime/competitor-history-publish-core.mjs:41`），所以本次补写**不会改变任何现有计算结果**——
  它的价值是让这一列名实相符、并让「稳定键」这件事在表上有落点，而不是解锁某条具体链路。
- 没有改任何公式、字段类型或视图。
- 主表那 543 格是**第二轮**才补的（用户先批周表、再批主表），同一列同一规则、同样只填空：
  dry-run 报 543 待写、已有 1461 格与链接一致（**不一致 0** —— 顺带校验了既有的那 1461 个值），
  写入后回读 0 格空。收据 `main-table.receipt.json`，记录见 `dryrun-main-table.txt` / `apply-main-table.txt`。

## 附：灰豚段队列探测（同一轮顺手做的只读检查）

`huitun-queue-probe.txt`：关键词周表 `tblZsUns9353w3nl` 当前队列 `READY`、`candidateCount=1`
（`candidateMode=A_ONLY`），即「判定到 A候选 才去灰豚取数」这条口径已经是既有实现；
人工闸门前置：0 行「待数据」，所以 AI 闸门未拒绝。
