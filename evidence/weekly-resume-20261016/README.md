# 周报竞品链：整轮续跑能力 + 导入器 EBUSY 修复（1.9.7 批）

日期：2026-10-16　状态：**已完成离线验证，等发版**
证据目录：`evidence/weekly-resume-20261016/`

## 一、改了什么（两个文件对，四个文件）

### 1. 导入器 EBUSY 修复（`skills/xws-to-feishu-base/scripts/import-xws-to-feishu.mjs`）
- `extractManifest` 从内部函数改为**导出函数**，入参改单对象解构
  （`{ xlsx, outputDir, python, spawnImpl = spawnSync }`）；
- spawnSync 显式 `stdio: ['ignore', 'pipe', 'pipe']`；
- 非零退出/起不来时报错携带 `result.error.code`（原来是
  `result.stderr || result.stdout` 两个流都 undefined 时 `.trim()` 把真因吞掉，
  只剩一句 `Cannot read properties of undefined (reading 'trim')`）。

### 2. 周采集驱动整轮续跑（`runtime/run-weekly-collection.mjs`）
- `parseDriverArgs` 新增 `--resume` 旗标（默认 false）；
- 新增导出纯函数 `planResume(ranges, { resume, prefix, receipt, exists })`，
  三条判据**缺一不复用**：
  ① 显式给了 `--resume`（不猜意图：新一周本来就要新快照）；
  ② 收执的 `checkpointPrefix` 与本次逐字相同（前缀＝「哪一轮」的身份）；
  ③ 那段记录的 csv/xlsx 文件此刻仍在盘上（被清过就重采）；
- 新增 `readPreviousReceipt()`；`main()` 里收执提前构造并**逐段**落盘
  （`runtime/.weekly-collection-receipt.json`，被 kill/重启不丢已采成的段），
  `planResume` 判定复用的段直接进 `collected`，不再起采集；
- 收执新增 `checkpointPrefix` / `resume` 字段。

## 二、为什么

- **EBUSY 是同一病根的第四处**：宿主沙箱下 `spawnSync` 默认 stdio 的 stdin 是
  管道 ⇒ 直接 EBUSY ⇒ `status=null`、`stdout/stderr` 全 undefined。
  前三处：1.7.1（日报 notify）、1.9.2（supervise deliver）、1.9.4（周报合并）。
  这次更早——dry-run 就崩，`--commit` 更是连门都进不去。
- **「崩了重采十段」是周报链挂定时的最大风险**：十段每段几分钟到几十分钟，
  整轮白重采的代价是整个采集周期。这是挂每周一定时的前置开发项
  （提案 `evidence/weekly-scheduling-20261015/PROPOSAL.md` B 项）。

## 三、验证到什么程度

- 定向测试：`runtime/run-weekly-collection.test.mjs` **18/18**（净增 7：
  planResume 六条 + `--resume` 旗标一条）；
  `skills/xws-to-feishu-base/tests/cli.test.mjs` **5/5**（净增 2：
  抽取子进程 stdio 形状、EBUSY 形状报错须带 `spawn failed: EBUSY`）。
  原始输出：`test-run-weekly-collection.txt` / `test-cli.txt`。
- **突变验证 4/4**（`mutation-verify.txt`，脚本 `tmp/mutation-planresume.mjs`）：
  逐条打坏判据——去前缀判据 / 去 `--resume` 判据 / 去「产物在盘」判据 /
  去「收执里有 csv/xlsx 路径」判据——每次**只有**对应用例转红、其余 5 条不受影响，
  还原后逐字节一致（sha 级自证），还原后全量复跑全绿。
  ⚠️ 第一版第 4 条突变锚点选错（把 `exists(...)` 判据一起打掉，红了两条），
  改成只动 `part.csv && part.xlsx` 段后 4/4 通过——这正说明判据是真的在管事。
- 全量 runtime 套件 **1363/1363 退 0**（1.9.6 基线 1354，净增 9＝本批新增用例）。
- ⚠️ **续跑能力本身未经真机**：下一期 2026-10-19（周一）00:00 定时轮即是首次真机。

## 三之二、本期导入结果（已独立回读核实）

- 正式导入 26m37s、退出码 0；导入方报告：`importedRows=1540`、`attachmentCount=1538`、
  `periodStamped={2026-10-11 → 2026-10-17, collectedAt 2026-10-16}`（报告在
  `runtime/xws-feishu-weekly-2026-10-11_2026-10-17-merged/report.json`）。
- **独立回读**（不依赖导入器自己的报告；`import-readback.txt`，脚本
  `tmp/import-check-20261016/readback.mjs`）：表内记录数 = **1540**、其中「商品图片」
  (type=17) 非空行 = **1538**；周期字段（`数据开始日期`/`数据结束日期`，Unix ms）
  = **2026-10-11 00:00 → 2026-10-17 00:00**（+08），首行末行一致。写前基线 = 0 记录。
  ⇒ READBACK-OK。
- 缺图 2 行的来源：两个源段（21-24 第 131 行、25-28 第 192 行）本身无图，非导入缺陷；
  与上次周导先例（1417 行/1415 附件，同样缺 2）同容差。

## 四、文件清单

- `runtime/run-weekly-collection.mjs` / `.test.mjs`
- `skills/xws-to-feishu-base/scripts/import-xws-to-feishu.mjs` /
  `skills/xws-to-feishu-base/tests/cli.test.mjs`
- `test-run-weekly-collection.txt`、`test-cli.txt`、`mutation-verify.txt`、
  `import-readback.txt`
