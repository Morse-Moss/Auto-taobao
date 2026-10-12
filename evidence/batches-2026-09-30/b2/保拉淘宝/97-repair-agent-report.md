# 修复 agent 报告 —— 保拉淘宝

- 目标日：2026-09-30（Asia/Shanghai）
- 失败阶段：`push`｜成因：`STAGE_FAILED`
- 代理：`http://127.0.0.1:19063`（与 `runtime/browser-ports.mjs` 的 `shopInstance('保拉淘宝').proxyPort` 一致 ✓）
- 结论：**agent 修不动（现场已不在）—— 转人**。**未执行任何修复动作**，未写飞书。

> 本家是四家里信息量最大的一家：它**不是**代理连不上的问题，而是**产物本身坏了**。
> 下面把「请求单写的成因」与「我实测到的事实」分开记录，并明确指出两者不等价。

## 时间线

| 时刻（+0800） | 动作 | 结果 |
| --- | --- | --- |
| 15:58 | 读 `97-repair-request.json` / `07-push.txt` / `05-shop-report.txt` / `06-promotion-fetch.txt` / `02-alimama-date.txt` / `98-failure-state.json` | 现场事实已取 |
| 15:58 | `ls -la` 下载目录两个产物 | xlsx 4837 bytes @15:52；zip 793 bytes @15:53 |
| 15:58 | 用 python `zipfile` 解 xlsx 结构 | 无 `xl/sharedStrings.xml` 之外的字符串表 —— 与 `extract-sources.py` 报警一致 |
| 15:58 | `curl http://127.0.0.1:19063/targets` | **exit=7（连接被拒）** |
| 15:59 | 监听端口扫描 19000–19100 | 只有 **19022 / 19023** |
| 16:00 | 判定停工条件满足 | **停手** |

## 失败那一刻的现场（读自落盘证据）

`07-push.txt`（07:53:02Z，`run-daily-report.mjs` exit=1）：

```
$ node .../run-daily-report.mjs --date 2026-09-30 --proxy http://127.0.0.1:19023 \
    --shop-key 保拉淘宝 --commit \
    --shop-xlsx C:\Users\Administrator\Downloads\日报_20261001_2126a56c37577d49332c487be702f3dc.xlsx \
    --promotion-zip C:\Users\Administrator\Downloads\营销场景报表_20261001_155218.zip
--- stderr ---
Error: source extraction failed: ... openpyxl\styles\stylesheet.py:237: UserWarning: Workbook contains no default style ...
  File ".../extract-sources.py", line 33, in main
    raise ValueError(f'expected 119 shop columns, got {len(rows[0]) if rows else 0}')
ValueError: expected 119 shop columns, got 6
    at extractSources (.../run-daily-report.mjs:237:34)
```

`05-shop-report.txt`（07:52:33Z）—— **同一家店**的采集段：

```
[3/4] 3s：统计区间=["2026-09-01","2026-09-30"]｜下载按钮=true
[3/4] 统计区间 2026-09-01 ~ 2026-09-30 含目标日 2026-09-30 ✓
[4/4] 点「下载报表」
      → y=601（中心点命中） → {"clicked":true,"tag":"SPAN","text":"下载报表"}
      新文件：日报_20261001_2126a56c37577d49332c487be702f3dc.xlsx（4837 bytes）
      shopXlsxPath = C:\Users\Administrator\Downloads\日报_20261001_2126a56c37577d49332c487be702f3dc.xlsx
```

`06-promotion-fetch.txt`（07:52:50Z）：推广 zip 取件成功（`生成成功`、真实勾选、入口命中）。
`02-alimama-date.txt`：`--site alimama --date 2026-09-30` → `status=APPLIED`。
`shop-report-manifest.json`：`bytes=4837`、`sha256=8e3a7b1d30d3…`、`observedAt=07:52:50Z`。

## 我实测到的事实（只读，不改任何东西）

1. **产物就是这个文件、就是这个大小**：4837 bytes，15:52 落盘，与 manifest 的
   `bytes`/`sha256` 一致 ⇒ 不是「读错文件」。
2. **它不是 Excel 二进制结构**：`zipfile.ZipFile(...).namelist()` 给出
   `[Content_Types].xml, _rels/.rels, docProps/app.xml, docProps/core.xml, xl/sharedStrings.xml,
   xl/styles.xml, xl/workbook.xml, xl/_rels/workbook.xml.rels, xl/worksheets/sheet1.xml]`
   —— 结构**完整**，只是 `sharedStrings.xml` 里**一条共享字符串都没有**，
   所以 `rows[0]` 落成 6 个（很可能是 6 个空单元格）。
3. **`extract-sources.py` 的两条前序断言都没触发**：
   - `Workbook.sheetnames != ['data']` → **通过**（否则报的是 `expected only data sheet`）；
   - `len(rows[0]) != 119` → **在这里炸**。
   ⇒ 所以「列数」这条判据的数值本身不可信（6 列不是这份工作簿的真实列数），
   真正的异常在**更上游**：下载到的文件里没有数据行。

## 请求单给的成因与实测事实**不等价**（这是本次最该记住的一条）

请求单写的是 `cause=STAGE_FAILED / stage=push`，候选 `REAPPLY_DATES`、`RELOAD_PAGE`。
但现场事实指向的是：

| 维度 | 请求单/候选的预设 | 实测事实 |
| --- | --- | --- |
| 页面日期 | 「可能已不在目标日」 | `05/06` 两个阶段都命中 2026-09-30 ✓ |
| 下载动作 | 「元素不理会点击」 | `clicked:true` 且中心点命中 ✓ |
| 文件落盘 | `RELOAD_PAGE` 换新渲染可救 | **文件确实落盘了**（4837 bytes，manifest 有哈希）✗ |
| 真正的坏点 | 未覆盖 | **落盘的文件里没有数据**（无共享字符串、无数据行） |

`98-failure-state.json`（07:53:05Z）拍的是 `one.alimama.com/index.html#!/report/download-list`
（**感知层拍错页**，本项目已知缺陷），但它的表格结构旁证了同一件事：

```
tables: [ {rows:0, cols:6}, {rows:40, cols:6} ]    ← 阿里妈妈下载任务管理页，6 列
```

**这 6 列正是 `extract-sources.py` 报的那个 6 的可能来源**（感知层在读阿里妈妈页，
而 `extract-sources.py` 在读那个坏掉的 xlsx；两者都得到 6，但**不是同一个东西**）。

## 试过的候选动作

**一个都没试。** 两条独立理由，任一条都足以停手：

1. **现场已不在**：`curl http://127.0.0.1:19063/targets` → `exit=7`；19063 无监听；
   `edge-profiles/paola-taobao` 无进程。任何 `repair-shop-stage.mjs` 调用都会先死在
   「读不到页签（代理连不上）」。停工条件已满足。
2. **两个候选都打不中真因**：`REAPPLY_DATES` 的 `--stage push` 不是落位站点，
   `repair-shop-stage.mjs:259` 会返回「没有阶段提示 ⇒ 不知道该把日期落到哪个站点，停手」
   （`applied=false`）；`RELOAD_PAGE` 要修的是「元素不理会点击」形态，
   而这里点击已经命中、文件也已经落盘 —— **重载再点一次只会再拿到一个坏文件**。

## 需要人做什么

1. **这家店不能靠重试解决**：需要重新采集并获得一份**有数据**的工作簿。
   现场恢复后跑：
   `node scripts/run-daily-job.mjs --date 2026-09-30 --shops 保拉淘宝`
2. 观察 `05-shop-report.txt` 里的 `统计区间` 是不是 `2026-09-30 ~ 2026-09-30`。
   本轮它下的是 **`2026-09-01 ~ 2026-09-30`（整月）**，返回值只有 4837 bytes ——
   一个月 30 天的日报不该这么小。**「整月范围 + 极小文件」是这次的强线索**，
   建议核对生意参谋日报页的默认区间设置（`更新设置：自动更新-最近1天` 在科塔的预览页上出现过）。
3. 若重采仍得到小文件，请人工在生意参谋预览页点一次「下载报表」并**人工打开**
   那个 xlsx，确认它有没有数据行 —— 这一步能把「站点侧给不出数据」与
   「下载链路截断」彻底分开。
4. 注意：本家 `push` 未完成 ⇒ **底单第 2026-09-30 行的保拉那一行没有写**。

## 代码层面的建议（**本次未改任何代码**，仅记录）

`extract-sources.py:33` 的报错信息 `expected 119 shop columns, got 6`
在「文件结构完整但没有数据」时是**误导性的** —— 它让人以为列数配置错了。
建议（下次有人动这块代码时再议，不是本次任务范围）：
在 `len(rows[0]) != 119` 之前先判「工作簿有没有数据行 / 有没有共享字符串」，
把「文件坏了」与「列数不对」两种成因分开报。**本次刻意不改**：
（a）现场已不在，改完也无从验证；（b）仓库里 `skills/xws-export-market-analysis/**`
与 `run-collection-host.mjs` / `supervise-collection.mjs` 存在**大量未提交改动**（见下），
改动窗口不干净。

## 一处必须交代的并发事实

`git status --porcelain` 有 **136 个未提交改动**，最近提交是 `148fefc`（15:54:30）。
其中 `skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs` 的 mtime 是
**15:48:44**，即**在本轮跑（15:31–15:55）的过程中被改过**；`run-multi-shop-day.mjs` /
`date-picker.mjs` 的 mtime 是 15:40:22。这意味着本轮跑用的代码与现在磁盘上的代码**不是同一份**。
按指导书「别的会话在改的文件一个字都不要碰」，本 agent **没有修改任何文件**。

## 权限与边界遵守情况

- 只读现场（读证据、`ls`/`stat`、`curl` 只读探测、python 只读解包）；**未**改 `.workbuddy/`；
  **未**启动/停止任何进程、容器或浏览器；**未**碰任何端口；**未**移动/删除任何产物。
- **未**改仓库代码 ⇒ 无 `97-repair-agent-code-diff.patch`。**未**发飞书。
- 基线 `git log -1` = `148fefc8dac2bc238f9ba5fe2a520203ec14727d`。
