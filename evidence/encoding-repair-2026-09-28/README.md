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

## 取证脚本（只读，已归档）

按仓库 `.gitignore` 的规矩（`/tmp/` 是 scratch，要留档的证据一律复制到 `evidence/<轮次>/` 再提交），
本次用到的 4 个脚本已从 `tmp/` 复制到本目录 `scripts/` 下，并把相对路径改成从新位置出发
（import 改 `'../../../runtime/...'`、`root = resolve(dirname, '../..')`）。归档后**逐个真跑过**，
`check-date-style-0928.mjs` 的输出与归档前逐字一致。

| 脚本 | 作用 |
| --- | --- |
| `scripts/verify-encoding-fix.mjs` | 复现 + 突变验证：修前 / 修后 / 剥掉修复块三种形态的 U+FFFD 计数 |
| `scripts/check-date-style-0928.mjs` | 全表逐日「旧式 / 新式」分布（下面那张表的来源） |
| `scripts/dump-legacy-rows-0928.mjs` | 把 09-20 以后的全部旧式行整条打出（用来确认它们是占位空行） |
| `scripts/identify-snapshot.mjs` | 在 8 份重复快照里认定「哪一份真的被导入过」（逐字段比对） |

这四个都是**只读**的。会写飞书的两个脚本（删除 `repair-*`、重推 `reimport-*`）**刻意没有复制进来**，
免得有人误跑；原件留在 `tmp/`：

```
node tmp/repair-encoding-2026-09-28.mjs           # 只读：体检、落备份、打印将删除的清单
node tmp/repair-encoding-2026-09-28.mjs --commit   # 执行删除（会写飞书）
```

## 复现与验证

- 复现（修复前）：`PYTHONIOENCODING=gbk` 跑 `read-product-xls.py`，输出含 U+FFFD **601** 次，
  与飞书乱码逐字一致（`scripts/verify-encoding-fix.mjs` 的前后对照 + 突变体）。
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

### 1. `planProductImport` / `planInquiryImport` 的「已有记录」键会差一天

写入用 `Date.UTC(...)`，而飞书读回来是**同一日期 +08 零点**（如 `1788192000000`：UTC 读 08-30、+8 读 08-31），
于是 `new Date(v).toISOString().slice(0,10)`（UTC 读法）得到的是**前一天**。
代码位置：`skills/sycm-product-data/scripts/product-core.mjs:49`、`skills/sycm-inquiry-data/scripts/inquiry-core.mjs:55`。

2026-09-28 全表实测（脚本 `scripts/check-date-style-0928.mjs`）：

| 表 | 日期范围 | 行数 | 日期读法 |
| --- | --- | --- | --- |
| 商品数据底单 | 09-01 ~ 09-19 | 每天 200+ | **全部旧式**（UTC 读法差一天） |
| 商品数据底单 | 09-23 / 09-25 / 09-26 | 88 / 167 / 165 | **全部新式**（两种读法一致） |
| 商品数据底单 | 09-20 / 21 / 22 / 24 | 无 | 根本没有行 |
| 商品询单数据底单 | 09-01 ~ 09-19 | 每天 40~58 | **全部旧式** |
| 商品询单数据底单 | 09-20 ~ 09-30 | 每天 **1** 行 | 旧式，但**只有「数据日期」有值、其余 13 个字段全空** |

要点：

- 那批「每天 1 行」是**预建的日期占位行**（`record_id` 连续，一直铺到 09-30，含未来日期）。
  因为 `商品ID` 为空，判重键 `(日期, 商品ID)` 里的 ID 是空串，**撞不上任何真实数据行**，不构成风险。
- 真正的风险面 = **09-01 ~ 09-19 那 19 天**：它们含真实数据行且全部是旧式 ⇒
  **这 19 天中任何一天重跑或回补，都会重复插入，而且不报错。**
- 只跑「前一天」时打不着：目标日都在 09-20 之后，落在旧式区之外。
  本次修复目标日（09-23 / 09-25）亦为新式，所以重推不受影响（模拟结果：删除后 167/30/21 行全部可新建，跳过 0）。
- 归属澄清：这条隐患只在**商品数据链**；**日报链读日期本就用 +8**
  （`skills/sycm-alimama-daily-report/scripts/daily-report-runtime.mjs:157`），没有这个问题。

### 2. 因此 `--apply` 的幂等性对旧式行不可靠

同日重推可能重复插入。要动那段代码前先想清楚这一层。
修法很小：读日期时统一**先 +8h 再取 `toISOString().slice(0,10)`**。

## 未做（需单独授权）

- 未改 `planProductImport` / `planInquiryImport` 的日期读法（属行为改动，要单独一轮）。
- 未开新版本号（`VERSION` / `package.json` / `CHANGELOG` 未动）。
