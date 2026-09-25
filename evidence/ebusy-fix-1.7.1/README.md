# 1.7.1 — 宿主沙箱掐断同步子进程（EBUSY）的定案与落地

目标日 2026-09-24 的日报补跑连续多轮全灭在这个问题上。本目录是**定案与验证**的原始产物；
改动本身见 `CHANGELOG.md` 的 `## [1.7.1]`。

## 一句话结论

**宿主沙箱按「每次工具调用」决定要不要掐断同步子进程，分界就在「给子进程一个管道 stdin」这一条上。**
`stdio: ['ignore','pipe','pipe']` 全通；不写 `stdio`（默认三根都是管道）或给 `input:` 必炸，
且是 **1~4ms fail-fast**（`status=null`、`error.code=EBUSY`、`errno=-4082`）—— 不是超时，也不是子进程崩了。

更要紧的两条推论：

1. **它会穿透到孙进程** —— 用 `['ignore',…]` 起起来的子进程，自己再做一次默认 stdio 的同步 spawn 照样炸。
   ⇒ 只改「最上层那个 spawn」不够，必须顺着调用链 grep 到底。
2. **它只掐「同步」那一条路** —— 异步 `spawn` 没事、Python 同步 `subprocess` 也没事、
   收 stdout/stderr 更是完全没事。别把成因说成「禁止同步起子进程」或「禁止用管道收输出」。

## 本目录文件

| 文件 | 是什么 |
|---|---|
| `all-affected-1.7.1.txt` | 最终口径：8 个用例文件 **132/132 绿、fail 0、退出码 0** |
| `affected-tests-1.7.1.txt` | 中间记录（含**先红后绿**那一轮：修审计表那处之前是 98/99） |
| `related-tests-1.7.1.txt` | 中间记录（含**先红后绿**那一轮：修 `runHostPrint` 之前是 30/33） |
| `mutation-1.7.1.json` | 驱动突变验证：**7/7 命中、`restored: true`** |

另有两处证据不在本目录（它们是探针，不是交付物）：

- `tmp/probe-1.7.1-depth-out.txt` —— **穿透到孙进程**的判据（这条推翻了「修顶层就够」）。
- `tmp/probe-1.7.1-alert-path-out.txt` —— 在本会话（沙箱确实开着）里真调 `notify-feishu.mjs`，
  新形态（`--alert-file` ＋ 显式 stdio）拿到 `status=DRY_RUN` 收据、且临时文件用完即删；
  同一次的自检行是 `blocked=true code=EBUSY`。
- `evidence/rehearse-2026-09-24-1.7.1/` ＋ `tmp/rehearse-2026-09-24.log` —— **真机整链排练**
  （默认档，飞书零写入）：里可林淘宝／盖文淘宝／盖文天猫／科塔淘宝 **四家 11/11 全阶段 exit=0、整轮零 EBUSY**
  （含第 7 步 `push` —— 那里有本版最要紧的第三处修复）；网林天猫停在第 6 步 `promotion-fetch`。

## 改了什么（10 处调用点／6 个文件 ＋ 1 个自检）

1. `skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs` —— 阶段 spawn 显式 `stdio`。
2. 同文件 `dispatchRoundAlert` —— 弃 `input:`，改 `notify-feishu.mjs --alert-file <tmp>.json`。
3. `skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs` —— **第 7 步 push 内那个
   `spawnSync(python, …)`**。不修这处，前两处白修：整轮会死在**第一次真的往飞书写字之前**。
4. `runtime/daily-job-plan.test.mjs` ＋ 5. `daily-report-audit.test.mjs` —— 测试侧的同一病根
   （症状是「整条跑不起来」：`null !== 0` / `spawnSync …cmd.exe EBUSY`）。
6. `scripts/check-fast.mjs`（2 处）＋ 7. `scripts/run-affected-tests.mjs`（3 处）—— **两道提交前门禁自己**。
   症状最具误导性：`spawnSync git EBUSY` 看起来像 **git 坏了**。
8. **新增跑前自检** `probeSyncSpawnSanity`（`run-multi-shop-day.mjs`，`main()` 里第一行 `[驱动]` 输出）：
   探**坏形态**并把「这是宿主执行环境限制，不是数据问题」写进日志。

## 状态与未了事项

- 版本三处（`VERSION`／`package.json`／CHANGELOG 首条标题）＝ **1.7.1**，由
  `runtime/version-consistency.test.mjs` 守着。
- **09-24 五家 ＋ 09-20 科塔这两笔数据，本版交付时还没写进去** —— 不是失败，是**时间窗**：
  阿里妈妈推广块上午有未回补窗口（08:04 的 CSV 与 11:22 之后逐字节不同），
  而查重键是「同一天＋同店铺」⇒ 早跑写进去的低值**无法同日重推、只能先删那天**。
  已挂一次性自动化在 11:50 补（见下）。
- **网林的日报仍会停在第 6 步 `promotion-fetch`**（复选框中心被表格单元格挡住，重试 6 次后按设计停手）。
  这是另一条已知缺陷，本版没碰 ⇒ **补多店必须带 `--keep-going`**，否则整轮停在第 2 家、只写进 1 家。
- 仓库里**其它**测试/工具脚本还有一批没写 `stdio` 的同步调用（多行写法，grep 数不出来），
  待清扫；系统性做法是加一条仓库守卫（原计划的 L3）。
- **两道提交前门禁的实际结论（照实）**：`npm run check:staged` 是 **PASS**；
  `npm run test:staged` **没拿到整体结论** —— 它被 `unit:skills` 段卡住（`unit` 的结构是
  「skills 段 exit 0 才接着跑 runtime 段」，所以后面 `runtime` 段与另三个 check 都没跑到）。
  两个卡点都与本版改动**无关**，且这 6 个文件本版一个字节没改 ⇒ 在 HEAD 上同样红：
  ① **10 条假红**＝未声明 `stdio` 的同步 `spawn`（断言原样 `null !== 0`）。取证见
     `probe-affected-false-reds-out.txt`：原样形态 `status=null errorCode=EBUSY`，
     同一条命令摘掉 stdin 就 `status=0` 并正常输出 `--help`。
  ② **1 条不结束的用例**＝`skills/xws-export-market-analysis/tests/prepare-flow.test.mjs:931`
     （历史稳定 26~27 秒，本次 18 分钟无输出）。它走的是**异步** `spawn`，而同一文件第 230 行的
     注释早已写明这条链会「一直轮询到 60 分钟的 final deadline 才失败（用例看似"挂死"）」。
  本次**没有**去停那个进程（未获授权不动任何进程），也**没有**顺手补那 10 处 —— 补了也不够，
  `unit:skills` 段仍会被②卡住。两类一起留给 L3。
- **本批交付时那笔 11:50 的补写还没发生**（一次性自动化，见 CHANGELOG 与当日实录）。
