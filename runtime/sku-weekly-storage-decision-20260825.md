# SKU 周度存储决策

## 决策

每周固定新建两张带日期范围的表，不保留跨周历史总表：

- `SKU明细`（`tblddWTrPeB4TKmR`）是当前 SKU 工作表，一条 SKU 以 `SKU唯一键=商品ID|SKU ID` 去重。
- 每周建立 `SKU周_YYYY-MM-DD_YYYY-MM-DD`，保存该周的完整 SKU 快照。
- 竞品采集同步建立 `竞品周_YYYY-MM-DD_YYYY-MM-DD`，保存该周竞品快照；竞品主表只保留当前可关联记录。

同一周重跑只允许写入同名周表并按业务唯一键更新；新周必须新建新表。周表名称就是唯一的时间索引，不再依赖分析周次或采集批次表。

## 不做

- 不删除或覆盖其他周表。
- 不把多个周的数据追加到同一张周表。
- 不为旧记录猜测日期；每张周表必须使用真实采集起止日期。

## 验收

先运行 `runtime/create-weekly-history-tables.mjs --start-date YYYY-MM-DD --end-date YYYY-MM-DD --apply` 创建空周表，再导入本周数据。创建脚本会拒绝同名表和缺少模板表的情况；导入后按 `SKU唯一键`/`商品周期唯一键` 回读验证。
