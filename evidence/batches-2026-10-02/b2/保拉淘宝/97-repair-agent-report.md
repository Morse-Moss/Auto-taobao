# 修复 agent 报告 · 保拉淘宝

- 目标日：2026-10-02
- 批次：b2（`--batches 5`）
- 失败阶段：`push`（exit 1）
- 请求单成因：`STAGE_FAILED`
- 该店代理（登记表 `runtime/browser-ports.mjs` shopInstance().proxyPort）：`http://127.0.0.1:19063`
- 报告执行时间：2026-10-03 16:00–16:02（本地）

---

## 1. 最终结论

**修不动（agent 本轮无法修复）**。两条独立判据：

1. **hard 阻塞**：该店实例已被 `--batches` 释放，代理 19063 连不上（`fetch failed`），
   两个候选动作一个也执行不到（§4）。
2. **真正的失败点不在页面上，而在“下载下来的日报内容”里**（候选动作够不到）：
   `push` 阶段挂在 `extract-sources.py` 的**列数校验**上 ——
   `ValueError: expected 119 shop columns, got 6`。
   独立验证（§3）：本店当日下载的 `日报_20261003_2126a56c...xlsx` 确实**只有 6 列**，
   而同一天其它店下载的日报都是 **119 列**。
   `REAPPLY_DATES`（重落页面日期）/ `RELOAD_PAGE`（重载页面）改的是**页面状态**，
   改不了“这份报表模板本身只有 6 列”这件事。

---

## 2. 读到的现场（只读）

| 文件 | 关键事实 |
| --- | --- |
| `97-repair-request.json` | stage=push，cause=STAGE_FAILED，stageHint=null，candidates=[REAPPLY_DATES, RELOAD_PAGE]，代理 19063 |
| `01-health-check.txt` | 通过（阻断 0 项） |
| `05-shop-report.txt` | **exit 0**：身份 ✓（Paola Lenti保拉伦... / 保拉伦蒂:小保），点开「日报」预览，统计区间 `2026-09-03~2026-10-02` 含目标日 ✓，下载出 `日报_20261003_2126a56c37577d49332c487be702f3dc.xlsx`（**4853 bytes**） |
| `promotion-report-manifest.json` | 营销场景报表 zip 已落盘（789 bytes），sha256 记录在案 |
| `shop-report-manifest.json` | 上面那个 4853-byte 的 xlsx（sha256 `30ea0be...`）——**就是它列数不对** |
| `06-promotion-fetch.txt` | **exit 0**：营销场景报表取件成功 |
| `07-push.txt` | **exit 1**：`Error: source extraction failed ... ValueError: expected 119 shop columns, got 6`（栈：`extract-sources.py:33` ← `run-daily-report.mjs:237`） |
| `98-failure-state.json` | ⚠️ 拍错页（拍到 `shop-window-label.html`），不属失败页面 —— 已知缺陷，不作事实 |
| `99-recovery.txt` | 停手时把报表生成页送回工作页；回位后生意参谋工作页恰好一个 |

> 阶段口径提示：`push` 阶段跑在**共享商家浏览器** 19023 上（见 `07-push.txt` 的 `--proxy 19023`），
> 不是店铺实例 19063。所以这一家的失败与店铺实例是否活着关系不大 —— 真正卡住的是**内容校验**。

---

## 3. 独立验证：下载日报的列数（关键证据）

用带 openpyxl 的解释器直接读 Downloads 里的成品文件：

```
E:/AI/Python/python.exe -c "import openpyxl; ... load_workbook(...).sheetnames / iter_rows ..."
```

| 文件 | sheets | rows | **ncols** |
| --- | --- | --- | --- |
| `日报_20261003_65141cc3c0fd...xlsx`（别家店，同日） | ['data'] | 31 | **119** |
| `日报_20261003_1442937a949c...xlsx`（别家店，同日） | ['data'] | 31 | **119** |
| `日报_20261003_ea518aea3e2d...xlsx`（别家店，同日） | ['data'] | 31 | **119** |
| **`日报_20261003_2126a56c...xlsx`（保拉淘宝，本单）** | ['data'] | 31 | **6** |

本单文件的 6 列表头与含目标日的一行：

```
header = ['统计日期','店铺名称','访客数','商品浏览量','商品收藏买家数','加购人数']
row    = ['2026-10-02','Paola Lenti保拉伦蒂','3,543','5,444','17','30']
```

**同一 report id（`2126a56c37577d49332c487be702f3dc`）的历史下载件，列数一直是 6：**

| 文件 | 大小 | ncols |
| --- | --- | --- |
| `日报_20260930_2126a56c....xlsx` | 4845 | 6 |
| `日报_20261001_2126a56c....xlsx` | 4837 | 6 |
| `日报_20261002_2126a56c....xlsx` | 4846 | 6 |
| `日报_20261003_2126a56c....xlsx` | 4853 | 6 |

⇒ **不是本轮偶发**：这家店的「日报」保存报表（id `2126a56c...`）自 **2026-09-30 起**下载出来就只有 6 列，
而流水线要求 119 列。属于**店铺侧报表模板漂移**（那个“日报”模板只配了 6 个指标列），
不是页面状态、也不是日期筛选。

补充：`05-shop-report.txt` 报 exit 0 属于“**晚失败**”—— 采集/下载本身成功（拿到了文件），
但没人校验文件列数；列数不符一直到 `push` 才以 Python traceback 的形式炸出来。

---

## 4. 试过的候选动作（闭集内，逐个真跑）

命令模板：
`node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 保拉淘宝 --proxy http://127.0.0.1:19063 --stage push --cause STAGE_FAILED --action <动作> --log-dir evidence/batches-2026-10-02/b2/保拉淘宝`

| 动作 | 运行 | applied | 退出码 | detail |
| --- | --- | --- | --- | --- |
| `REAPPLY_DATES` | `--dry-run` | false | 3 | `读不到页签（代理连不上）：fetch failed` |
| `REAPPLY_DATES` | 真跑 | false | 3 | `读不到页签（代理连不上）：fetch failed` |
| `RELOAD_PAGE` | `--dry-run` | false | 3 | `读不到页签（代理连不上）：fetch failed` |
| `RELOAD_PAGE` | 真跑 | false | 3 | `读不到页签（代理连不上）：fetch failed` |

- 19063 free（§5 端口盘点）⇒ 两候选都到不了页面。
- 两个候选都 `applied !== true` ⇒ 按流程**不重试 `push`**。
- 候选耗尽 ⇒ 「agent 也修不动」。
- 证据落盘：`97-repair.json` / `97-repair.txt`（最后动作 `RELOAD_PAGE`）。

> 即使实例活着，这两个动作对本失败也**注定无效**：失败根因是“下载文件的列数”，
> 不是页面日期/页签状态。这一点是本单最值得记的结论。

---

## 5. 端口盘点（只读探测，未启停任何进程）

`curl -s -m 2 http://127.0.0.1:19063/json/version` → `000`（连接被拒）。
同轮全部 26 个店铺实例端口（19031-19035 / 19041-19045 / 19050-19057 / 19060-19067）均 `000`；
只有共享商家浏览器 19022/19023 在（`200`/`404`）。

---

## 6. 独立回读飞书底单（确认“没多写一行”）

`node skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs --date 2026-10-02`

- 底单（总数据来源底单，tblIuAX4nPc1zDOO）：`onDateCount=4`，命中 4 行：
  网林全卫定制 / 网林家居旗舰店 / 科塔全卫定制 / 里可林旗舰店。
  （底单「店铺」列是 Lookup type 19、回读必空，看「店铺名称」。）
- 结果与“保拉淘宝本轮未写入”一致（本店不在那 4 行里）。
- 回读产物：`evidence/daily-report-2026-10-02/independent-readback.json`。

---

## 7. 是否改代码

**没有改仓库代码。** 根因是**店铺侧报表模板只有 6 列**（运营/配置问题），
代码改动无法把列变出来。**但值得下一轮讨论一个改进**（本轮未做，避免无现场时臆改）：
`shop-report` 阶段下载后**立即校验 `data` 表列数**，不符就以清晰成因
（而非到 `push` 阶段扔 Python traceback）**早失败**——这能把“晚失败”变“早失败”，
但它不是本单的修复。

---

## 8. 转人 / 下一步

1. **人（根因）**：修「保拉淘宝」生意参谋里那份「日报」保存报表（id `2126a56c...`），
   让它恢复成 119 列布局（对齐其它店），否则**每天都会在同一处失败**（09-30 起已连续 4 天）。
2. **编排侧**：本轮的通用硬阻塞仍是“实例已释放”。
   在**店铺实例存活时**派修复 agent（`--no-release`/驻留）是唯一能让候选动作真正跑起来的前提；
   但对**本单**而言，即便实例活着，`REAPPLY_DATES`/`RELOAD_PAGE` 也救不了列数问题。
3. 遵守规则：本 agent **未启停任何进程/实例**；需重启实例才能修的情形不在此处处理。
