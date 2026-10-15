# 周报竞品链「合并」EBUSY 修复（1.9.4）证据

## 背景（一次真跑，2026-10-14 23:40 → 10-15 00:10）
- 驱动 `runtime/run-weekly-collection.mjs` 全量十段（1-4..37-40，40 页）重跑，后台任务 jURWle。
- 十段**全部采成**：`code=0`，rows=160/160/173/166/153/131/192/192/166/141（合计 1634），
  `csv=yes / xlsx=yes` 全段齐。
- 唯一失败＝最后一步「合并」：日志 `合并 失败：undefined`，整轮退出码 1。
- 收尾告警已真发飞书：alertId `weekly-round-20261015`、status SENT（1.9.2 的投递修复有效）。

## 根因
- 合并调用（原 `main()` 内联）：
  `spawnSync(process.execPath, [MERGER, ...mergeArgs], { cwd, encoding, maxBuffer, timeout })`
  **未写 stdio** ⇒ 默认 stdio 的 stdin 是**管道**。
- 宿主沙箱下该形态 `spawnSync` 直接 `EBUSY`：`status=null`、`stdout/stderr` 全 `undefined`
  ⇒ `String(merge.stderr || merge.stdout)` 只打出 `undefined`；进程 2 毫秒返回。
- 同一病根第四次发作（1.7.1 日报链 5 处、1.9.2 supervise `deliver()`、本次合并）。
  合并这处**从未被任何用例钉过**（预检那处有、合并这处没有），所以漏网。

## 复现（repro-stdio.txt）
同一条子进程命令，唯一变量是 stdio 形态：
- 默认 stdio：`status= null error= EBUSY stdout= undefined stderr= undefined`
- 显式 `['ignore','pipe','pipe']`：`status= 0 stdout= "{\"ok\":true,\"from\":\"child\"}"`

## 修复
- `runtime/run-weekly-collection.mjs`：把合并步骤抽成可测的
  `runMergeStep(collected, { mergedCsv, spawnImpl })`，显式 `stdio: ['ignore','pipe','pipe']`。
- `runtime/run-weekly-collection.test.mjs`：新增 3 条 —— ① 调用形状钉 `stdio`（stdin 必须
  `ignore`、不许 `input:`、`--require-images` 不能省）；② 合并非零退出 ⇒ `ok=false`；
  ③ spawn 起不来（EBUSY 形状）⇒ `ok=false`、`json` 为空。
- 版本 1.9.3 → 1.9.4（`VERSION` / `package.json` / `CHANGELOG.md` 三处逐字一致）。

## 验证到什么程度（说实话）
- 最小差分复现：见 `repro-stdio.txt`。
- 按修正路径补跑合并（`merge-rerun.txt`）：`status=0`，产出
  `runtime/weekly-merged-1791994250176.csv/.xlsx`，**1540 行、带图 1538、缺图 2（在容差内）**。
- 结构分析（`merged-analysis.txt`）：16 字段；序号 1..1540 连续且唯一；商品链接 1540/1540 唯一；
  商品图片列空值 0；与 09-15 段 21-40（730 行、半程）交集 123。
- 定向用例 `node --test runtime/run-weekly-collection.test.mjs`：11/11；突变（stdin `ignore`→`pipe`）
  **只**第 9 条转红、还原后 11/11。
- 全量 `runtime` 套件：**1354/1354、退出码 0**（原始输出 `tmp/merge-fix-20261015/runtime-suite-194.txt`）。
- ⚠️ 本次**未**重跑整条驱动（重跑＝重采，采集是实时快照）。合并修复的活体验证＝上面那次
  「按修正路径补跑」；下次整轮重跑会走这条路径。

## 脚本（可跑）
- `merge-stdio-repro.mjs`：最小差分复现（同一条子进程命令、两种 stdio 对照）。
- `merge-fixed-run.mjs`：镜像 `runMergeStep` 的补跑合并（读 `runtime/.weekly-collection-receipt.json`）。
