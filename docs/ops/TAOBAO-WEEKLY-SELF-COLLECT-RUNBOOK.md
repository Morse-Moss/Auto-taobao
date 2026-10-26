# 淘宝自采周报 · 手动跑手册

替代已停摆的小旺神市场分析导出。**当前阶段是「独立跑两周」，不接排期**：
连续两周手动跑一遍三段链，结果可比对稳定后，再谈接进周一 00:00 的定时任务。

排期不是现在该做的事——链没跑熟就挂定时，出问题时切不开是脚本错还是环境错。

**跑的时间点必须是周一**，不是周日。周报周期是「周日→周六」，
所以 2026-10-26（周一）这轮覆盖 `2026-10-18(Sun)~2026-10-24(Sat)`。
周日跑等于在周期还没结束时取快照，会少掉最后一整天。

---

## 0. 前置检查（每次跑之前 30 秒）

| 检查 | 命令 / 判据 |
|---|---|
| 竞品浏览器起着 | 9222 端口有监听。端口号唯一来源 `runtime/browser-ports.mjs`（`competitorBrowser`），别手写 |
| 代理起着 | 3457（`competitorProxy`） |
| Python 可用 | `"E:/AI/Python/python.exe" -c "import openpyxl, PIL"`，**不要用 workbuddy 内置 Python**，它没有 openpyxl |
| 磁盘 | 图片目录约 250MB／期，xlsx 约 19MB／期 |

小红书站内登录态失效时，采集会在导航阶段失败，不会产出半截数据（每页独立落 checkpoint）。

---

## 1. 三段链

以 2026-10-26 那期为样板。`<DATE>` 是**跑的那天** `YYYYMMDD`（只用于文件名），
周期另算：跑日 2026-10-26 → 周期 2026-10-18~2026-10-24。两者不要混。

### 1.1 采集合成 CSV（约 9 分钟）

```bash
node runtime/collect-taobao-search.mjs --keyword 浴缸 --pages 1-40 \
  --out runtime/taobao-weekly-<DATE>.csv \
  --raw-out runtime/taobao-weekly-<DATE>.json \
  --checkpoint-prefix runtime/taobao-weekly-<DATE>
```

判据（10-26 实测值）：`40/40 页`、原始 1920 条 → 去重 1384 行、`14 秒/页`、退出码 0。
中断后重跑同一条命令会从 checkpoint 续，不会从第 1 页重来。

### 1.2 下载主图（约 30 秒）

```bash
node runtime/fetch-weekly-images.mjs \
  --csv runtime/taobao-weekly-<DATE>.csv \
  --out runtime/taobao-images-<DATE> \
  --concurrency 6
```

判据：`failed: []`、`downloaded + skipped == considered`、目录里文件数 == 数据行数。
落盘名是 `<item_id>.img`（不按 URL 猜扩展名，PIL 按字节嗅探）。已有文件自动跳过，所以重跑天然续传。

### 1.3 生成带图 xlsx（约 1 分钟）

```bash
"E:/AI/Python/python.exe" runtime/build-weekly-xlsx.py \
  --csv runtime/taobao-weekly-<DATE>.csv \
  --images runtime/taobao-images-<DATE> \
  --out runtime/taobao-weekly-<DATE>.xlsx \
  --manifest runtime/taobao-weekly-<DATE>.xlsx.json
```

判据：`embeddedImages == rows`、`missingImages: 0`、`bytes` 约 19MB。

---

## 2. 验收（必做，别只看上一段自己报的数字）

三段链的产物只有过了下面三关才算跑对。第 2 关是最硬的一关：
**真跑下游抽图脚本**，不是「我看着像」。

```bash
# 关1：xlsx 能被下游抽出图（顺带产出供关2 用的 manifest）
"E:/AI/Python/python.exe" skills/xws-to-feishu-base/scripts/extract_xws_xlsx.py \
  runtime/taobao-weekly-<DATE>.xlsx tmp/extract-<DATE> --manifest tmp/extract-<DATE>.manifest.json

# 关2：结构 + 契约一次过
#   表头 16 列逐字一致 / 行数 / 图数 / 图落在第 2 列且行号一一对应 / 无重复无孤儿
#   / 文件头是已知图片格式 / 抽样行与 CSV 相符 / 图片列无残留文本 / validateDataset 通过
node runtime/verify-weekly-xlsx.mjs \
  --manifest tmp/extract-<DATE>.manifest.json \
  --csv runtime/taobao-weekly-<DATE>.csv \
  --dir tmp/extract-<DATE>
```

`ok: true` + `problems: []` + `contract.rankRange == "1-N"` 才算过。

**为什么非要回读**：10-26 第一次生成时 `序号` 整列为空、`商品图片` 里塞着 URL——
原因是 `headers.index('商品图片')` 是 0 基、写单元格的列号是 1 基，差一位。
build 自己报的是「1384 张全嵌好了」，一直到回读才暴露。导入链会因为序号不连续直接判死。

---

## 3. 已知缺口（每期都会遇到，不是偶发）

| 缺口 | 规模（10-26） | 处理 |
|---|---|---|
| 淘宝只给徽标不给数字 | 23 / 1384 行 | 「月收货人数」留空＝未披露，原文存 `evidence/taobao-<DATE>/monthly-sales-badges.json` |
| 类目 ID 未收录 | 2 / 1384 行 | 原始 ID 原样保留（泡澡桶/浴桶，被关键词搜混进来），**不许猜名字**；在下游做类目过滤 |
| 缩略图清晰度 | 全量 | 220×220 复刻小旺神规格；要更清晰改 `THUMB_SIZE` 与 JPEG quality，改完必须重跑第 2 节三关 |

徽标为什么不能折算成数字：`本月行业热销`／`行业销量Top3` 是「有没有进榜」，不是「卖了多少」，
前20→20 属于编造。为什么不能留在列里：下游公式（月收货金额、客单价带分类）会拿这一列做乘法，
塞文案得到的是错误值而不是空白。计数列留空是唯一既诚实又不污染下游的写法。

采集器（`taobao-search-core.mjs` 的 `countColumnOf`）现在会自动留空并计数，所以新采集不需要额外处理。
只有补**历史 CSV**（旧规则产出的）时才要跑一次：

```bash
node runtime/blank-weekly-sales-badges.mjs runtime/taobao-weekly-<DATE>.csv evidence/taobao-<DATE>/monthly-sales-badges.json
```

该脚本写盘后会回读逐格 diff，只允许「月收货人数由文案变空」这一种改动，其它任何变动直接抛错。

---

## 4. 禁止事项

- **不重采历史周**。搜索结果是实时快照，没有任何办法回放上一周。缺的周就是缺。
- **不删 `runtime/taobao-images-<DATE>/`**。它是重新生成 xlsx 的唯一输入，删了要重下 250MB。
- **不用 CSV 里的图片 URL 直接喂飞书**。「商品图片」是附件字段（type 17），必须走带内嵌图的 xlsx。
- **不改 `salesCountOf` 让它把徽标转成数字**。它会静默污染下游所有金额公式。
- 采集/下载/生成这三段都可以随时重跑；**不要**用 `--pages` 以外的参数绕过去重。

---

## 5. 两周之后接排期前要补的

1. 编排入口：目前是三条手工命令。接排期需要按 `buildSegments(40, 4)` 分段驱动 + 段级收据。
2. 失败告警：现在失败就是退出码非 0，没有飞书告警。
3. 登录态预检：采集前应有一次只读预检，登录墙要先喊人，而不是让 40 页逐页失败。
4. 飞书写入：见第 6 节，2026-10-26 已实测跑通一次，但只跑过一次，不足以下结论。

---

## 6. 写入飞书（两周稳定后，或需要补当期时）

目标表按周新建，名字格式 `竞品周_<开始>_<结束>`，窗口是**周日→周六**。
例：2026-10-26 周一这轮覆盖 `竞品周_2026-10-18_2026-10-24`。

```bash
# 6.1 建表（读主表字段基准；默认只读，--create 才建）
COMPETITOR_NEW_WEEK=竞品周_<开始>_<结束> node runtime/prepare-weekly-competitor-table.mjs --create

# 6.2 离线预检：拿新表真实字段类型，把每一行走一遍 buildRecordFields，不连生产
node runtime/preflight-weekly-import.mjs <新表tableId> tmp/extract-<DATE>.manifest.json

# 6.3 导入（串行上传，实测 27 分 27 秒／1384 行；自带写后条数与附件数校验）
node skills/xws-to-feishu-base/scripts/import-xws-to-feishu.mjs \
  --xlsx runtime/taobao-weekly-<DATE>.xlsx \
  --base-url "https://kcne618basvj.feishu.cn/base/QcnhbEzYpacGvUskCbVcrcm3nFd?table=<新表tableId>" \
  --env-file "E:/小红书/.env.feishu-kcne.local" \
  --commit --period-start <开始> --period-end <结束> \
  --python "E:/AI/Python/python.exe"

# 6.4 重建派生字段（公式/查找引用，必须在导入之后）
COMPETITOR_NEW_TABLE_ID=<新表tableId> node runtime/create-weekly-formula-fields.mjs --apply

# 6.5 规则列回填（10 列：材质/外形/安装方式/功能/风格/尺寸/适用空间/数据状态/待补数据项/搜索关键词）
#     默认 dry-run 会打印各列预计填充率与竞品分类分布，先看数再 --apply
node runtime/fill-weekly-attribute-labels.mjs --table-id <新表tableId> --apply --confirm-app-token QcnhbEzYpacGvUskCbVcrcm3nFd

# 6.6 独立回读（另起一次读取，期望值来自 CSV）
node runtime/verify-weekly-import-readback.mjs --table <新表tableId> \
  --csv runtime/taobao-weekly-<DATE>.csv --expect-null-sales <徽标行数>
```

**导入是「先全传后一次性写」**：1384 张图按 250ms 间隔串行上传，全部传完才分 3 批
（每批 500）batch_create。所以上传阶段失败时表里是 0 行，不会留半张表；
一旦开始批量写，失败才会留残行。这个过程**没有任何进度输出**，27 分钟里
`getRecordCount` 一直是 0 是正常的，别据此以为卡死。

6.3 必须带 `--period-start/--period-end`：目标表有三个日期字段时，缺周期参数会 fail-closed，
不允许产出无日期的周期表。

导入中途失败时表里会留下部分记录，且**重跑会被 `TARGET_NOT_EMPTY` 拒绝**（这是有意的，防重复写）。
正确做法是先把该表记录清空再整体重跑，不要在残缺表上续写。
