# 2026-09-28 飞书商品数据乱码修复（218 行）

## 结论

| 表 | 日期 | 处理 | 结果 |
| --- | --- | --- | --- |
| 商品数据底单 | 2026-09-25 | 删 167 → 重推 167 | 乱码 0，表行数 4746（回到基线） |
| 商品询单数据底单 | 2026-09-25 | 删 30 → 重推 30 | 乱码 0，表行数 1028（回到基线） |
| 商品询单数据底单 | 2026-09-23 | 删 21 → 重推 21 | 乱码 0 |

删改合计 218 行。**两张表的行数在修复前后完全一致**（4746 / 1028），即净变化为 0。

## 根因

`skills/sycm-product-data/scripts/read-product-xls.py` 没有钉死 stdout 的输出编码。
node 侧 `spawnSync(..., { encoding: 'utf8' })` 按 UTF-8 解子进程 stdout，而 Windows 上 python
默认跟随 locale（cp936 / GBK）输出 ⇒ 父进程环境里没有 `PYTHONUTF8` / `PYTHONIOENCODING` 时，
中文被解成 `�`（U+FFFD）。修法：脚本内 `sys.stdout.reconfigure(encoding='utf-8')`（提交 `9e24e3f`）。

## 证据文件

- `backup-dryrun-*.json` / `backup-commit-*.json`
  删除前对将被删除的 218 行做的**整份逐字段备份**（`record_id` + `fields`），
  另含当天未被删除的行（两张占位空行 `recvu1ydUjDAoQ` / `recvu1ybRetlBF`）。
  可据此回滚。约 532 KB/份。
- `reimport-summary.json`：12 批重推的逐批收据（期望 / 源行 / 计划 / 写入 / 表总行）。
- `product/<店铺>/receipt.json`：底单重推收据（5 份）。
- `inquiry-2026-09-25/<店铺>/receipt.json`：询单 09-25 重推收据（5 份）。
- `inquiry-2026-09-23/<店铺>/receipt.json`：询单 09-23 重推收据（2 份）。

## 复现与验证

- 复现（修复前）：`PYTHONIOENCODING=gbk` 跑 `read-product-xls.py`，输出含 U+FFFD **601** 次，
  与飞书乱码逐字一致（`tmp/verify-encoding-fix.mjs` 的前后对照 + 突变体）。
- 重推时**刻意清空** `PYTHONUTF8` / `PYTHONIOENCODING`（复现当初出错的环境），12 批
  计划数 = 期望数 = 写入数，无一偏差。见 `reimport-summary.json`。
- 回读：两张表 U+FFFD 命中 **0**；抽样 `商品名称` / `当前在线` / `延迟统计` 均为正常中文。

## 源文件（用于重推）

- 底单 09-25：`%USERPROFILE%\Downloads\【生意参谋平台】商品_全部_2026-09-25_2026-09-25 (N).xls`
  里可林淘宝 24 行、网林天猫 17 行、盖文淘宝 55 行、盖文天猫 35 行、科塔淘宝 36 行（合计 167）。
  同一天有 3 组重复快照（55/35/24 各两份），**逐字段比对确认它们与线上行完全一致**、任选其一均可。
- 询单 09-25：`%USERPROFILE%\Downloads\product-inquiry-<店铺>-2026-09-25.xls`（5 份，合计 30 行）。
- 询单 09-23：`evidence/product-inquiry-2026-09-23/gaiwen-{taobao,tmall}-inquiry.xls`（7 + 14 = 21 行）。

## 顺手撞到、需要注意的两件事（本次未改）

1. **`planProductImport` / `planInquiryImport` 的「已有记录」键会差一天**：
   写入用 `Date.UTC(...)`，而飞书读回来是**同一日期 +08 零点**（`1788192000000` ⇒ 2026-09-01），
   于是 `new Date(v).toISOString().slice(0,10)` 得到的是**前一天**。
   分布实测：2026-09-01 ~ 09-19 的行是「旧式」（读法差一天），**09-23 起是「新式」（两种读法一致）**。
   本次修复目标日（09-23/09-25）恰好都是新式，所以重推不受影响（模拟结果：删除后
   167/30/21 行全部可新建，跳过 0）。
2. **因此 `--apply` 幂等性对旧式行不可靠**（同日重推可能重复插入）。要动那段代码前先想清楚这一层。

## 未做（需单独授权）

- 未改 `planProductImport` / `planInquiryImport` 的日期读法（属行为改动，要单独一轮）。
- 未开新版本号（`VERSION` / `package.json` / `CHANGELOG` 未动）。
