# 变更记录

本文件记录**每一个版本开发了什么**。格式参考 Keep a Changelog，版本号用 `x.y.z`。

## 版本口径（先读这一段，它决定了下面每条为什么这样写）

- **唯一来源是仓库根的 `VERSION` 文件**（纯文本一行）。`package.json` 的 `version` 与本文件
  第一条标题里的版本号都必须与它逐字一致 —— 三处各写一遍正是技术债 E1 的成因，
  现在由 `runtime/version-consistency.test.mjs` 守着，不一致就跑红。
- **一个版本 = 一次可交付的开发批次**，不是每一次提交。小到一次改注释的提交不单独开版本号。
- **每条要能回答三个问题**：改了什么 / 为什么改 / 验证到什么程度。
  只写「优化了体验」这种条目等于没写 —— 三个月后没人能从它推出当时的判据。
- **代码与本文档必须同一次提交**。先写代码后补 CHANGELOG，等于给了自己一个「反正能补」的借口，
  而实际结果总是它没被补上。
- **验证到什么程度要说实话**：离线用例全绿 ≠ 真机能跑。凡是只有离线判据的，这里写明
  「仅离线判据」；跑过真机的，写明证据目录。

## [1.7.1] - 2026-09-25

起因是 09-24 那天的**补跑四轮全灭**：链的每个阶段都只留下一行
`error=spawnSync … EBUSY`，飞书一个字没写，而且**连一条失败告警都发不出去**
（日志里是 `告警投递退出码=null`）。而同一天早上 08:14 的定时轮与 08:55 的一次手动
补跑却 11/11 全绿。本版把这条「时通时炸」的成因定死、把受影响的调用点改掉，
并加一道跑前自检，让「宿主掐断」与「数据坏了」在日志里当场分开。

### 成因：宿主沙箱按**每次调用**决定要不要掐断同步子进程，分界在 stdin 那条管道

不是随机、不是业务问题、不是 Node 版本问题。判据（全部只读）：

- **12 组对照**：`stdio` 里 stdin 是 `'ignore'` 的（`['ignore','pipe','pipe']`、
  `[ignore,pipe,ignore]`、`[ignore,ignore,pipe]`、标量 `'ignore'`、`'inherit'`、文件 fd）
  **全通**；stdin 是 `'pipe'` 的（`['pipe',…]`、不写 `stdio` 的默认值、`input:`）**全灭**：
  `error.code='EBUSY'`、`errno=-4082`（libuv `UV_EBUSY`）、`status=null`、
  `stdout=undefined`，且**1~4ms 内 fail-fast**（不是超时）。
  `input:` 与显式 `stdio:['ignore',…]` 同时给也照样炸 ⇒ `input` 会把 stdio[0] 覆盖回管道。
- **排除项**：换 `cmd.exe` / `python.exe` 做子进程同样炸；而 **Python 的同步
  `subprocess.run(capture_output=True)` 正常** ⇒ 不是 OS 层、也不是「所有同步子进程」；
  Node 版本、shim、以及全部 `CODEBUDDY_*` / `WORKBUDDY_*` / `SANDBOX_*` 环境变量逐个排除
  （自建命名管道可通；job object 拒绝 breakaway）。
- **归因到宿主**：宿主日志 `%USERPROFILE%\.workbuddy\logs\<日期>\<工作区>__*.log` 里
  **每次工具调用**都有一行 `[SandboxOrchestrator] OUTCOME … outcome=…`。
  同一台机器、同一个仓库、同一天：`outcome=sandbox-disabled` 的两次**全通**
  （08:14 与 08:55，后者把里可林淘宝 11 个阶段跑完），
  `background-sandbox` / `sandbox-success` 的每一次**全灭**（08:32、09:26、09:28）。
  ⇒ 「时通时炸」＝每次调用各自的沙箱判定，与代码和数据无关。
- **权限与沙箱是两件事**（不是「权限没开」）：沙箱开着的调用记的是
  `[SandboxPermissionGateway] sandbox path active → skip 8-Phase`、
  `[BashTool] sandbox path active, skipping 8-Phase permission check`；
  关着的调用记 `permissionPath=n/a`。把权限全开**不会**去掉沙箱，只会让失败更安静。

### 本版改动（1 个自检 ＋ 3 个生产调用点 ＋ 2 处测试 ＋ 2 个门禁脚本，共 10 处调用点／6 个文件）

1. **`runStage` 的每个阶段显式声明 `stdio: ['ignore','pipe','pipe']`**
   （`skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`）。
   改前它不写 `stdio` ⇒ 走 Node 默认的「三根都是管道」⇒ 正好是被掐的那一形态。
   这正是 09-24 四轮里**每个阶段**都只留三行的原因。改法照搬本仓已有的正确样例
   （`scripts/run-daily-job.mjs` 的 spawn 一直是 `['ignore', …]`，因此同一轮里它退出码正常
   而链的阶段全灭 —— 这条「父子不同命」的现场本身就是定位这次故障的线索）。
2. **失败告警改走 `notify-feishu.mjs --alert-file`，不再走 `input:`**
   （同文件 `dispatchRoundAlert`）。`input:` 会隐式建 stdin 管道 ⇒ 告警这一条路在沙箱下
   **必然**发不出去（09-24 四轮里 `告警投递退出码=null` 全是这么来的）。
   该 CLI 本来就有 `--alert-file` 这个开关，改用它并同样显式声明 stdio。
   告警 JSON 落系统临时目录、用完即删：它的职责只是**运输**，
   而「收信人到底看到了什么」已由 `告警文案（收信人看到的）` 那一段完整落在 job.log 里。
3. **跑前环境自检 `probeSyncSpawnSanity`**（同文件，`main()` 里**第一行** `[驱动]` 输出）。
   它用 `node -e 0` 探**被掐的那一形态**（`['pipe','pipe','pipe']`），把结论直接写进 job.log：
   掐断时是「这是宿主执行环境限制，不是数据问题」＋错误码；正常时是「这一轮不会因 EBUSY 失败」。
   为什么必须排在所有阶段之前：09-24 事后读日志的人第一反应是「采集脚本坏了／登录掉了」，
   而这两种成因的处置完全相反。探「坏形态」而不是「已修好的形态」还有一个理由：
   链上**其它**同步子进程仍在踩它（`runtime/browser-inventory.mjs` 的 `netstat` 扫描、
   `scripts/stop-all.mjs` 的 `netstat` / `taskkill`、各采集脚本内部），
   它们报 EBUSY 的症状是**静默降级**（把「读不到」当成「没有」）——
   这一行是解释那些症状的唯一线索。自检只读、失败不拦采集（诊断层，不是闸门）。
4. **顺手修掉同一个病根的两处测试代码**（`runtime/daily-job-plan.test.mjs` 的 `runHostPrint`、
   `skills/sycm-alimama-daily-report/scripts/daily-report-audit.test.mjs` 的 `git ls-files` 扫描）。
   它们起子进程时都没写 `stdio` ⇒ 在沙箱态下不是「断言失败」而是**整条跑不起来**：
   前者报 `null !== 0`（伪装成接线断了），后者报 `spawnSync …cmd.exe EBUSY`。
   本版给两处补上显式 `stdio`；`runHostPrint` 的断言消息同时改成带上 `result.error?.message` ——
   子进程**根本没起来**时 stderr 是空的，只报 stderr 会显示成 `没跑成：undefined`。
   这两处在本次验证时**先红后绿**（红的原文与转绿后的输出都在证据目录里），
   记下来是因为它们正是本版要治的形态：**把「读不到」报成「不存在」**。
5. **`run-daily-report.mjs` 里那个 `py extract-sources.py` 也补上显式 `stdio`**（同病根第 4 处）。
   为什么只修驱动那一层**不够** —— 实测这条限制**穿透到孙进程**：
   用 `stdio: ['ignore','pipe','pipe']` 起起来的子进程，它自己再做一次默认 stdio 的同步 spawn，
   照样拿到 `EBUSY`（`tmp/probe-1.7.1-depth-out.txt`）。
   而 `run-daily-report.mjs` 正是链第 7 步 `push` 跑的脚本，也就是**第一次真的往飞书写字**的那一步：
   它一死，整轮在写飞书之前就停住，前面六个阶段的采集全白做。
   （这条是动手核查「L1 到底够不够」时才发现的：整个链上**只有这一处**阶段内同步子进程，
   其余阶段全是走代理的 HTTP，不受这条限制影响。）
6. **两道提交前门禁自己也跑不起来**（`scripts/check-fast.mjs` 两处、`scripts/run-affected-tests.mjs` 三处，
   都是 `execFileSync('git', …)` 没写 `stdio`）。症状极具误导性：`spawnSync git EBUSY`
   看起来像 **git 坏了**，而真实原因是门禁给自己建了一根 stdin 管道。
   这条必须一起修：`AGENTS.md` 要求提交前跑 `npm run check:staged` / `npm run test:staged`，
   而**无人值守的自动化很可能就是跑在沙箱会话里** —— 门禁自己跑不起来，等于这道防线在那种会话里根本不存在。

### 本版**没有**做（明确记下来，免得下次当成年久失修）

- **三个「把读不到当成没有」的静默降级点**：`runtime/browser-inventory.mjs:332`、
  `scripts/stop-all.mjs:57` 与 `:137`。它们是已知缺陷②「释放路径假绿」的下游成因，
  但属于另一批（要连「读不到时该报什么」一起设计），本版只把**成因**写进上述自检文案。
- **禁止裸 `spawnSync` 的仓库守卫（原计划的 L3）＋剩下裸调用点的清扫**。本版只修了**本次路径上**的
  10 处（`grep -rn "spawnSync\|execFileSync\|execSync"` 之后逐处判读）。仓库里其它测试与工具脚本
  仍有一批同步调用没写 `stdio` —— 且**光看 grep 数不出来**（很多是"选项对象写在下一行"的多行写法），
  它们在沙箱会话里同样会「整条跑不起来」。判据：`[SandboxOrchestrator] OUTCOME` 不是 `sandbox-disabled`
  时，看到 `status=null` ＋ `error.code=EBUSY` 就按这条处理，**别去查那门业务**。
- **遮挡层判定假红**：另一条独立缺陷（`collect-core.mjs` 的 `dismissed` 与
  `collect-promotion-report.mjs` 的 `hitCheckDismissingOverlay`），本版未动。
- **商家浏览器（19022/19023）自动登录**：仍押后（1.7.0 已记）。

### 验证到什么程度（照实写）

- **离线判据全绿**（原始输出都在 `evidence/ebusy-fix-1.7.1/`）：
  · `all-affected-1.7.1.txt` —— **8 个文件 132/132、fail 0、退出码 0**：
    `runtime/version-consistency.test.mjs`、`run-multi-shop-day.test.mjs`、
    `daily-report-core` / `daily-report-runtime` / `daily-report-audit.test.mjs`、
    `runtime/daily-job-plan.test.mjs`、`runtime/alert-throttle.test.mjs`、`runtime/arch-boundary.test.mjs`。
    其中新增 3 条（自检的两种归因文案、探针形态）、改写 1 条（投递必须走 `--alert-file` 且显式 stdio）、
    另加 1 条**源码级接线判据**（驱动两个调用点必须显式 `stdio`、告警不许再用 `input:`、
    自检必须排在整轮体检之前、**push 阶段内部的 `py extract-sources.py` 也必须显式 stdio**）。
  · `affected-tests-1.7.1.txt` 与 `related-tests-1.7.1.txt` 是**逐步跑出来的中间记录**，两份都**先红后绿**：
    前者在修 `daily-report-audit.test.mjs` 那处之前是 98/99（红的是 `spawnSync …cmd.exe EBUSY`），
    后者是 30/33（红的三条都是 `run-daily-job.mjs --print 没跑成：undefined` ＋ `null !== 0`）。
    记下来是因为这两处红正是本版要治的形态：**把「读不到」报成「不存在」**。
  · `mutation-1.7.1.json` —— `run-multi-shop-day.mutation.mjs`：**7/7 命中、`restored: true`**。
    它每跑一次就把驱动源码改坏再还原，`restored: true` 意味着本版的改动**没有被它改坏**，
    也意味着那 7 条精确字符串替换在本版改动之后仍然唯一命中（改动的位置没把它们错开）。
- **两个调用点都在「本机这一轮确实被掐」的环境里真验过**
  （`tmp/probe-1.7.1-alert-path-out.txt`，探针脚本 `tmp/probe-1.7.1-alert-path.mjs`）：
  · A 用**真** `spawnSync` 探到 `blocked=true`、`code=EBUSY` —— 即这一轮本身就是被掐的那一形态，
    自检在它该发声的环境里发了声（不是我在推断「它应该会响」）。
  · B 走**真** `runtime/notify-feishu.mjs`：调用形态是
    `[notify-feishu.mjs, --alert-file, <tmp>.json]`、`stdio=["ignore","pipe","pipe"]`，
    收据 `status: DRY_RUN`（**一个字节都没发**）；告警临时文件「spawn 那一刻在、
    返回之后不在」＝用完即删。改动前这一条在同样的环境里是 `status=null`
    （就是 09-24 日志里的 `告警投递退出码=null`）。
  · 另有一张更早的 A/B/C/D/E 形状对照表（`tmp/probe-ebusy-fix-shape-out.txt`），
    它是这次定案的依据：D（`--alert-file` ＋ 显式 stdio）通、A（`input:`）与 C（都不加）灭。
  · **穿透性**（`tmp/probe-1.7.1-depth-out.txt`）：`['ignore','pipe','pipe']` 起起来的子进程里，
    它自己再做一次默认 stdio 的同步 spawn 仍然 `EBUSY`；换成 `['ignore',…]` 就 `status=0`。
    这条**推翻了「修好驱动那一层就够」这个假设**，也是本版多出改动第 5 条（push 阶段内部那一处）的原因。
    没有它，今天就跑不了任何一轮能写出飞书的补跑。
- **真机整链已跑过一次排练**（`--date 2026-09-24 --keep-going`，默认档＝两个写入方都干跑，
  **飞书一个字节都没写**；证据目录 `evidence/rehearse-2026-09-24-1.7.1/`，stdout 全文
  `tmp/rehearse-2026-09-24.log`）。这一轮本身就在**被掐的那个环境**里（同一次会话的自检行写着
  `blocked=true code=EBUSY`），结果：**里可林淘宝／盖文淘宝／盖文天猫／科塔淘宝 四家 11/11 全阶段
  exit=0**，第 7 步 `push`（就是改动第 5 条那一处 python 调用）也在内；网林天猫 停在第 6 步
  `promotion-fetch`（复选框中心被 `TD.` 挡住、6 次重试后按设计停手 —— **另一条已知缺陷，与本节无关**）。
  整轮零 `EBUSY` ⇒ 改动 1/3/5 三处调用点在真机上成立，不只是离线判据。
  · 附带推翻一条旧判断：09-24 那轮网林是停在**第 3 步** `promotion-submit`（全屏遮挡层回读判"没关掉"），
    这次它在第 3 步**顺利过了**（同一台机、同一个 938×442 的小窗口、同一天）
    ⇒ 那次大概率是**时序**（遮挡层还没落稳就点了），不是稳定的判据错误。
    当前真正的拦路点在第 6 步，**本版刻意没碰**（要连"挡住的到底是什么"一起查）。
- **`--keep-going` 是这次跑通的前提**：默认"首家失败即停整轮"会把整轮停在第 2 家（网林），
  只能写进 1 家；给它才拿得到 4 家。这条与代码无关，是**跑法**，记在这里免得下次又踩。
- **本次改动**顺手**没有**做（已在上面「本版没有做」里记过）：`runtime/browser-inventory.mjs:332`、
  `scripts/stop-all.mjs:57`/`:137` 这三处静默降级点仍在踩同一个限制（它们是**只读对账**与
  **释放路径**，不在链上；症状是「读不到当成没有」，不是「整轮死掉」）。
- **本次改动**没有**碰**：任何浏览器/容器/服务的起停（一个都没动），
  也没有对飞书写入任何真实数据（探针一律 `--dry-run`，且用独立节流文件、不碰生产节流状态）。
- **两道提交前门禁的实际结论，照实分两段写**（本版最需要交代的一处）：
  · `npm run check:staged` —— **PASS**。它能过正是改动第 6 条的功劳：改之前它自己都起不来，
    报的还是一句看起来像「git 坏了」的 `spawnSync git EBUSY`。
  · `npm run test:staged` —— **没有拿到整体结论**。它先跑 `unit`（= `run-test-suite unit`），
    而 `unit` 的结构是「`unit:skills` 段 exit 0 才接着跑 `unit:runtime` 段」，
    于是 `unit:skills`（58 个文件）这一段把整条门禁卡住，后面 `runtime` 段与 `docs` / `runtime-file` /
    `skill:sycm-alimama-daily-report` 三个 check 都没跑到。卡住的原因与本节改动**无关**，两类：
    ① **10 条假红**，同一个病根 —— 未声明 `stdio` 的**同步** `spawn`，断言原样是 `null !== 0`。
       它们落在 6 个本版**一个字节都没改**的文件里（`git status` 里看不到它们）⇒ 同样的红在 HEAD 上也在：
       `skills/huitun-to-feishu-keyword-heat/tests/cli.test.mjs`、
       `skills/sycm-export-search-rank/scripts/full-flow.test.mjs` 与 `source-period-proof.test.mjs`、
       `skills/xws-export-market-analysis/tests/cli.test.mjs`、`adaptive.test.mjs`、
       `merge-market-analysis.test.mjs`。取证见
       `evidence/ebusy-fix-1.7.1/probe-affected-false-reds-out.txt`：拿**逐字相同**的调用形态复现，
       得 `status=null errorCode=EBUSY`；同一条命令摘掉 stdin 就 `status=0`、正常打出 `--help`。
       这正是本版要治的形态，只是这一批不在本次路径上（留给 L3）。
    ② **1 条不结束的用例**（`skills/xws-export-market-analysis/tests/prepare-flow.test.mjs`
       第 931 行 `does not wait for a stubborn Element loading mask over the config form`）：
       历史日志里它稳定 26~27 秒（`runtime/_skills-suite-20260919.log` 中 `duration_ms: 26230.9`），
       本次跑到 18 分钟仍无新输出。它用的是**异步** `spawn`（本版治的那条限制掐不到异步），
       而同一文件第 230 行的注释早已写明这条链会「一直轮询到 60 分钟的 final deadline 才失败
       （用例看似"挂死"）」⇒ 属**既有的挂起路径**，与本版无关。
    本次**没有**去停这个进程（未获授权不动任何进程），也**没有**顺手补那 10 处 —— 补了也不够：
    `unit:skills` 段仍会被②卡住，门禁照样给不出整体结论。这两类一起留给 L3（见上面「本版没有做」）。

## [1.7.0] - 2026-09-24

起因是 09-24 08:14 那轮定时：**链本身 11/11 全绿、退出码 0、底单五行齐全**，
但跑前登录体检（login-preflight）给用户发了 **5 条飞书告警** —— 每店一条，全是**假红**。
用户的原话是「为什么给我发了这么多条报警」。本版把这条路径上四处「把读不到当成掉了」的
判断改掉，并给它补上了它一直没有的去重。

### 为什么是假红：判据只有一个，而它读不到时只能猜

体检的唯一判据是「读这个站点页面的**最终地址**」。但那一轮五家店是**冷启动**的浏览器：
窗口里一个页签都没有。页面**不在**时判据只能得出「读不到」，而 `--login` 那一档会把
「读不到」推成「这个后台没登录」⇒ 落进「需要人处理」⇒ 逐店发一条告警。
同轮链的第 0 步（health-check）**本来就会把页面归位**，归位之后五家店 11/11 全 ok。
⇒ 收信人被叫去处理一件**系统自己 20 秒后就会修好**的事，而且被叫了五次。

根子是一句话：**「页面不在」与「会话没了」是两件事，此前共用了一个结论。**

### 本版改动

1. **跑前体检先归位，再做判断**（`check-login-shops.mjs`，仅 `--login` 档）。
   复用 `runtime/page-normalize.mjs` 的 `normalizePages` —— 它本来就是为「体检**之前**的归位」
   写的，只是此前没接在这条命令前面。页面清单与开页 URL 取自 `runtime/shop-pages.mjs`，
   **不另造第二份补页实现**。三条纪律沿用不改：已在位的不动、同主机多于一页只报不猜、
   新建一律 `pinned=1`。**失败不阻断**：归位没做成时体检照跑、结论照报。
2. **新增结论 `PAGES_ABSENT`**（`login-merchant-core.mjs` / `login-merchant.mjs`）。
   判据是**两个纯函数**分开量：`loggedIn === null`（窗口里没有这一页 ⇒ 读不到）与
   `loggedIn === false`（页面在、被服务端弹回登录页 ⇒ 实锤掉了）。只有「读不到」而没有
   「实锤掉了」时才落这一态。它**刻意不在** `VERDICTS_NEEDING_HUMAN` 里 ——
   进人词表就等于又发一条假红。退出码 3，与「参数打错」（4）刻意分开。
3. **子进程一律 `--notify off`，告警改成整轮一条**（`check-login-shops-core.mjs` /
   `.mjs`）。原本 5 家店各起一个子进程、各发一条飞书；现在投递权整体收到本层：
   子进程一个字节都不发，本层在**整轮体检结束之后**发**一条**汇总
   （`alertId = sycm-login-round-<日期戳>`、标题写店数、原因与下一步逐店展开）。
   只有「真的确认要人处理」才发（`shouldNotifyRound`：`--login` 档 **且** 结论是 `NEEDS_LOGIN`）——
   只读体检一个字都不发。
4. **抽出去重：`runtime/alert-throttle.mjs`**。判据（编号 + 指纹 + 6 小时窗口）原先只活在
   日报链里，而这条链**根本没有去重实现** —— 一次预检能并发 5 条同一天的告警。
   现在两条链共用同一个状态文件（新增 `byAlertId` 映射，避免两条链互相覆盖对方的记账）。
5. **定时任务改名（不是改排期）**：`sycm 日报定时（每日 11:40）` → 名字里的时间与它实际的
   触发时刻（08:14）对不上，而 11:40 这个**安全边界**（阿里妈妈的上午未回补窗口）不能动：
   改名字，`rrule` 一个字符没动。

### 本版**没有**做（明确记下来，免得下次当成年久失修）

- **商家浏览器（19022/19023）的自动登录**：链第 0 步要求它的生意参谋工作页**恰好一个**，
  而这条链上**没有任何一步会自动登它**。这是已知缺口，本版押后（它要在上面 1/2 之后做，
  否则会用一个「会自己去登」的补页动作换掉一个「只报不猜」的动作，风险更大）。
- **释放策略**：保持「跑完不释放」，与 09-24 那轮的实际形态一致。

### 验证到什么程度（照实写）

- **离线判据全绿**：6 个文件 **155/155、fail 0、退出码 0**（发版后跑的，含版本号一致性守卫；
  `evidence/login-alert-round-2026-09-24/affected-tests-1.7.0.txt`。改动落地时先跑过一次 5 文件 149/149，
  同目录 `affected-tests-before-bump.txt`）。含新增的 `runtime/alert-throttle.test.mjs` 6 条、
  `login-merchant-core.test.mjs` 54 条（其中一条是**源码级接线判据**：`PAGES_ABSENT` 那段
  必须出现在登录流程循环**之前**，且 `needsHuman('PAGES_ABSENT') === false`）、
  `check-login-shops-core.test.mjs` 31 条（含「归位必须排在探针之前」「归位必须挂在 `--login` 档下」
  「子进程的 `--notify` 只能是 `notifyModeFor()`」）。
- **跨目录依赖守卫先红过一次**：新增 `skills/…/check-login-shops-core.mjs → runtime/notify-feishu-core.mjs`
  这条依赖（拿渲染器的键名白名单，另抄一份就是第二个事实）被守卫抓到，已显式登记并写明理由，
  之后 **3/3 绿**（先红的原始输出与重跑结果都在
  `evidence/login-alert-round-2026-09-24/arch-boundary-RED-before-registering.txt` 与 `…-GREEN-after.txt`）。
- **整轮告警过的是真渲染器**：构造一条「2 家店要登录」的告警，走
  `runtime/notify-feishu.mjs --dry-run`（**一个字节都没发**），核对正文里
  对象／店铺／任务／原因／下一步／时间／告警编号七项齐全，且**不含机器名与本机路径**
  （`evidence/login-alert-round-2026-09-24/`：`round-alert-input.json` 是输入、`round-alert-dry-run.json` 是渲染结果，
  生成脚本 `gen-round-alert.mjs` 与渲染命令都写在那份 README 里，**从该目录原地复跑逐字节相同**）。
  这步是必要的：`source` 里的键名写错时渲染器会**静默丢掉那一行**，收信人看不到
  「哪几家、哪个后台」而你以为发出去了 —— 所以 core 侧现在对未知键**当场抛错**。
- **只读真跑一次预检**（不带 `--login`，一个页面都没碰）：退出码 3、五家 `notify.mode` **全是 `off`**、
  `roundNotify.status = SKIPPED`（原因：「这一轮是只读体检，没有去登，所以一个字都不发」）、
  `normalize.asked = false`，且 stdout 是**纯 JSON**（stderr 0 字节）
  ⇒ `evidence/login-alert-round-2026-09-24/preflight-readonly.json`。五家店的代理当时没起（`fetch failed`），
  所以逐店结论是 `UNREADABLE / STOP_AND_ALERT`、`needHuman=[]` —— 这正是**改之前的形态做不到的事**：
  读不到的时候不再叫人。
- **只有离线判据、没有真机证据的两处**（如实写明）：① `--login` 档的归位**写路径** ——
  本会话没有起实例的授权，没真跑；但 `normalizePages` 这个函数**同一份实现**
  已在链的第 0 步于 09-22／09-23／09-24 三轮真跑里被考过，本版新增的只是「多一个调用点」；
  ② `PAGES_ABSENT` 的**真机现场复现**（需要先有「窗口里没有该站点页面」的现场）。

## [1.6.0] - 2026-09-23

把用户那句「**做不到自动登录吗？？？**」再往下做一层：登录入口从「一条写死的 URL」改成
**一组候选地址、逐条打开试到浏览器真的肯填为止**，并在**按下提交之前**加一道**身份守卫**
（填进来的账号不是这家店的 ⇒ 绝不提交）。真机上跑完了对照矩阵，其中两条结论**推翻了本仓
1.3.0 里我自己写下的判断**。

### 为什么必须改：旧形态把两个假设当成了事实

1. **「脚本固定打开的那一页」= 唯一入口。** `TAOBAO_LOGIN_URL` 是一个常量，而实测五家店
   各有各的凭据落点（`havanaone/login/login.htm` / `member/login.jhtml` / `mini_login.htm`）。
   一条 URL 承担不了五个落点。
2. **「密码库里有凭据 ⇒ 能自动填」。** 1.3.0 把它进一步写成「缺的是**那条 origin** ⇒
   补齐 origin 就能填」。真机对照矩阵把这条**证伪**了：**origin 相等是必要不充分** ——
   `havanalogin.taobao.com` 上的凭据，即使 `signon_realm` 就是它、`skip_zero_click=0`、
   `blacklisted_by_user=0`、密文合法（`v10`、40 字节）、页面就开在它上面，Chromium **也不填**
   （`:autofill` 恒 false，实测 0/3）。

### 实测矩阵（一次性实例，逐格都能指到 `evidence/login-candidate-loop-2026-09-23/raw/` 的原始输出）

| 打开的地址 | 里可林 | 网林 | 科塔 | 盖文天猫 | 商家 | 命中 |
| --- | --- | --- | --- | --- | --- | --- |
| `login.taobao.com/havanaone/login/login.htm?bizName=taobao` | ✓ | ✓ | ✓ | — | — | **3/3** |
| `login.taobao.com/member/login.jhtml` | ✓ | — | — | ✗ | ✓ | 2/3 |
| `havanalogin.taobao.com/mini_login.htm?...`（带参数） | — | ✗ ✗ | ✗ | — | ✗ ✗ | **0/5**（3 台机器各试了 1–2 次） |
| 对照 `github.com/login`（同一个 profile） | — | — | — | — | ✓ | 1/1 |

**决定性的一格是「商家浏览器 + `havanalogin`」那两次**：那台机器的凭据里**就有**一条
`signon_realm=https://havanalogin.taobao.com/`、`times_used=11`、`skip_zero_click=0` 的记录，
页面也开在它自己的 origin 上 —— **仍不填**。所以「同源就会填」在这条主机上不成立。

⚠️ **这张表在交付前被更正过一次，值得记下来**：初版 `member/login.jhtml` 那行写的是
「商家 ✓ 里可林 ✓ 网林 ✗ 科塔 ✗ → 2/4」，而那两次「网林/科塔 + member」**实际打开的是
`havanalogin` 那条地址**（命令漏传 `--url`，`--label` 却按 member 写了）⇒ 两个失败样本归错了行。
**回读原始输出里的「导航 → …」才发现**（标签是人手写的，地址是程序打的）。
更正**不改变任何结论**，但它是一条判据：**引用「哪次实验是什么结果」要读输出里的地址，不要读标签**；
跑这类实验时输出**按 run 命名**，别复用同一个临时文件名。

另：**方法**＝复制一份 profile 到临时目录 → 未登记端口（**19801**）起一次性实例 → 25ms 采样
`#fm-login-id` / `#fm-login-password` 的 `value.length` 与 `:autofill`，并用
`Page.addScriptToEvaluateOnNewDocument` 挂钩 `HTMLInputElement.prototype.value` 的 setter
（这是唯一能在页面脚本之前埋观察器的时机）；跑完 `taskkill /T` ＋ **端口回读** ＋ 删临时目录。
**六个生产 profile 全程没碰**（用户当时正在那些窗口里手工登录 ⇒ 扰动静默降到零）。

**判据是四条组合，不是「2 秒后读一次值」** —— `:autofill`（出手的唯一可观测痕迹、且只是预览态）
＋ `value.length`（值有没有落地）＋ 挂钩 `HTMLInputElement.prototype.value` 的 setter（谁在写、带调用栈）
＋ `elementFromPoint`（点击真落在框上）。单读值一定会漏：值可能从未出现，也可能出现过又被页面擦掉。
**原生密码下拉不在 DOM 里** ⇒ `[role=listbox]` 的个数**永远不可作判据**，唯一能看见它的是**截图**。
**不能拿「这台机器的填充坏了」当解释**：对照组用同一个 profile 打开 `github.com/login`，
真实点击后 17/14 字符落地。**`times_used` 不是「填进去了」的证据**（每次跑登录都被刷新，而值从未落地）。


### 本版改动

- **候选表 `LOGIN_URL_CANDIDATES`**（`login-merchant-core.mjs`，**顺序即优先级**）＝
  `[havanaone, member-login]`。**`mini-login` 已删除** —— 实测 0/3，它不是「还没试过的备选」，是死路。
  `TAOBAO_LOGIN_URL` 保留为 `LOGIN_URL_CANDIDATES[0].url`，只为**不改动**既有调用方与既有判据的语义。
- **主脚本逐条试**（`login-merchant.mjs`）：`for (const candidate of LOGIN_URL_CANDIDATES)`
  → 打开 → 读 `:autofill` → 是才补可信手势、等一拍、回读值；不是就换下一条。
  全试完仍不成立 ⇒ `NO_AUTOFILL`。每一步的 `attempt.outcome` 都进回执（「试过哪几条」必须可查）。
- **身份守卫（先于提交）**：`expectedMemberFor({shop})` 给出这家店**该有**的会员名
  （唯一来源 `shop-identities.mjs`；**不派生** `<店名>:阿彦` —— 实测已推翻这个假设），
  `judgeFilled({filled, expected})` 四个出口：`ACCEPT`（逐字相同，往下走）／`EMPTY`（换下一条候选）／
  **`WRONG_ACCOUNT`（填了别人 ⇒ 绝不提交，换下一条；都不行就 fail-closed）**／`UNKNOWN`
  （没有期望值 ⇒ 如实说「这条守卫没有依据」，不假装它过了）。守卫的位置**必须在 `centerOf(state,'submit')` 之前**。
- **读账号框的表达式单独一个**（`LOGIN_ID_VALUE_EXPRESSION`），**刻意不并进 `FORM_STATE_EXPRESSION`**：
  后者结果会进回执、还会被 `--shots` 写进证据目录，往里加 `value` 等于给**所有**回执开一条凭据外泄的口子。
  这个表达式**永远不许扩到密码框**（账号不是秘密，密码才是）。
- **`NO_AUTOFILL` 的人话重写**：原文案让人「登录时点浏览器提示里的『保存密码』」——
  在**错的登录页**上保存等于没修。改成明确要求**地址栏停在以 `login.taobao.com` 开头的登录页上**再保存。
- **`LOGIN_FAIL_TEXT` 补 `WRONG_ACCOUNT` 并导出**（`check-login-shops-core.mjs`），
  文案与 `NO_SAVED_CREDENTIAL` **刻意不同**：前者是「填进来的是**另一家店**的账号，系统没有替你提交」，
  人该做的是「用这一家的账号登一次、把多余的凭据清掉」，**不是**「去点保存密码」（那会把混着多家凭据这件事坐实）。

### 本版验证（分开说，别混成一句）

- **离线**（三个直接相关的文件，**87/87、exit 0**；原始输出 `evidence/login-candidate-loop-2026-09-23/raw/tests-adjacent-1.6.0.txt`）：
  `login-merchant-core.test.mjs` ＋ `check-login-shops-core.test.mjs` ＋ `runtime/version-consistency.test.mjs`。
  新增的判据：候选表顺序／id 唯一／每条都被认成登录页、**反向断言**「`havanalogin` 不许回到候选表」、
  `LOGIN_FAIL_TEXT` 对 `VERDICTS_NEEDING_HUMAN` **逐个覆盖**、`WRONG_ACCOUNT` 文案与「没凭据」不许共用一句。
  「覆盖」这件事**必须由判据守**：漏一条的现场表现只是运营看到一句内部代号，**不会报任何错**。
- **突变 9/9**：`evidence/login-candidate-loop-2026-09-23/mutate-login-guard-1.6.0.mjs`，
  报告 `raw/mutation-report-run2-final.txt`。九条**每一处都红在点名的那一条**、还原后 sha256 逐字节一致。
  上一版报告（`raw/mutation-report-run1-superseded.txt`）里有一条被标 `skip` —— 那条想验「候选表只剩一条」，
  但改法只改了一个 id、**改不坏任何判据**，等于一条没有判据的突变；本版换成真能改坏的写法（把第二条候选整段删掉），
  并顺带修掉原脚本把报告写进仓库根 `tmp/` 的问题（搬进证据目录后会因目录不存在而失效）。
- **真机**：上表矩阵（一次性实例）。**不是**「已经在生产窗口上跑通了」。
- **全量 `skills` 套件：838/838、fail 0、exit 0**
  （原始输出 `evidence/login-candidate-loop-2026-09-23/skills-full-2026-09-23.txt`，
  `--concurrency=1`，耗时 21 分 23 秒）。
  ⚠️ 这条是本版**提交并推送之后回头补的**：本条原先写的是「这一版没跑完、所以不引用任何全量分母」——
  那是当时的实话，但跑完之后它就成了过期的话，所以在这里改掉而不是留着。
  分母比上一版（`786`）多 52，**差额没有逐条归属**（既有本版新增的判据，也可能有同一工作区里
  其它会话的提交）。
- **没做**：在真实生产窗口上跑 `--commit --shop 盖文天猫` —— 用户当时正在那些窗口里手工登录，
  本轮**刻意不碰**（真机复核仍欠）。

### 本版仍然是欠账的（别当成已做）

- **盖文天猫的人工登录已经做掉了（2026-09-23 晚，用户本人手工登的）** —— 原先这条写着「仍要人工登一次」，
  理由（那台在 `login.taobao.com` 上一条凭据都没有）**在人工登完并保存密码之后就不成立了**：
  `gaiwen-flagship` 现在有 1 条同 origin 凭据（`member/login.jhtml` → `盖文旗舰店:阿彦`，用过 3，
  见 `evidence/login-blocker-probe-2026-09-23/credential-audit-all-profiles.txt`）⇒ 自动登录在这台
  **有了依据**。但「有依据」≠「已复核」：**在真实生产窗口上跑 `--commit --shop 盖文天猫` 仍未做**。
- **凭据收敛未做（清单已出，等授权）**：商家浏览器与盖文淘宝的密码库里各有**两条同 origin、分属两家店**的凭据
  ⇒ 浏览器自己挑一条、脚本控制不了 ⇒ 有可能**悄悄登成另一家店**（页面照开、导出照成、
  数字看起来都对，**链上没有任何一步会发现**）。动手给这两台自动登录之前必须先收敛成一条。
  逐条清单（六台 profile 全量审计：必删 2 条、可选删 3 条，并附「商家浏览器开着微软账号同步 ⇒
  直接改库会被拉回来，建议改用 Edge 自带的密码管理页删」这条坑）＝
  `evidence/login-blocker-probe-2026-09-23/CREDENTIAL-CONVERGENCE-LIST.md`。
- **熔断仍未实现**（1.2.0 就欠着）；**带 `--login` 的成功支路仍未在真机上验过**。
- **`mini_login.htm` 那条**：带参数顶层打开**是**活登录页（能被打开），但**不会被填** ——
  两条结论并存，别只留前一条（1.3.0 曾把「能被打开」误当成「能用」）。

## [1.5.0] - 2026-09-23

把用户 2026-09-23 拍板原话「**如果自动登录失败就飞书告警，但是前提是你要先自动登录**」落地：
跑前登录守卫**只有在真的去登过之后**，才允许为「登不进去」发飞书；只读档**一个字都不发**。

这一条同时是他第一问（「密码库里明明有保存，为什么你不去自动登录」）剩下的那一半 ——
本轮把两档口径彻底分开并各自写清：**只读＝碰都不碰、也不叫人；`--login`＝真的去登、登不进才叫人。**

### 为什么必须改：原行为不是「bug」，是「静默」

改之前 `check-login-shops.mjs` **两档都写死** `--notify off`：跑体检时五家店全掉登录，
群里也一个字都不会有。那不是「策略保守」，是把两件不同的事用了同一个值：

- 只读档**确实**不该叫人 —— 那一轮没有任何登录发生过，拿「结论看起来像失败」去叫人，
  是在为一件**没做的事**发告警；
- 但带 `--login` 的那一档是**真的开了登录页、补了手势、提交了表单**，然后才失败的。
  这一档正是「有人得去动一下手」的唯一情形，而它当时被和只读档一起静音了。

用户那两个问题就是这样来的：密码库里明明有记录（`login-merchant` 确实去登了，也确实失败了），
而群里没有任何消息 —— 现场表现就是「线断了」。**告警出口刻意只有一个**（链失败那一条）
这条既有纪律本身没错，错的是把「守卫这一层已经失败」这件事全押给链去报。

### 本版改动

- **新增纯函数 `notifyModeFor({ login })`**（`check-login-shops-core.mjs`）：
  `login ? 'auto' : 'off'`。取值算法刻意放在**纯函数**里，不在 IO 里拼字符串 ——
  拼字符串的话，「哪一档该不该发」这件事只活在 IO 脚本里，而 IO 脚本离线测不到。
- **接线**（`check-login-shops.mjs` 的 `probeShop`）：把写死的 `'--notify', 'off'` 换成
  `'--notify', notifyModeFor({ login })`。两种模式**仍然只在一处分叉**（`--commit` / `--check-only`），
  新增的这个开关跟在那处分叉后面走，不另开一条路。
- **告警收据透传**（`judgeShopReceipt` 新增 `notify: receipt?.notify ?? null`）：
  子进程报了 `SENT` / `DEDUPED` / `SKIPPED` / `NOT_CONFIGURED` / `FAILED`，这一层必须原样带上来 ——
  只报「掉登录」不报「叫没叫到人」，等于把「群里为什么没动静」这件事重新变成没人能答的问题。
- **报告里新增 `[告警]` 一段**（`renderNotifyLines`，只在 `--login` 档追加）：
  「已叫人」一行、需要人注意的逐条、**认不出来的状态显式说「认不出来，别当成发过了」**。
  词表 `NOTIFY_STATUS_TEXT` 覆盖 `SENT`/`DEDUPED`/`MUTED`/`DRY_RUN`/`NOT_CONFIGURED`/`FAILED`/`SKIPPED`。
- **两档的说明文案各自说实话**：只读档「不开页面、不点东西、**也不发任何告警**」；
  `--login` 档「**会碰页面**：掉登录的当场用浏览器密码库登一次；登不进去的**当场各发一条飞书告警**」。
  只读档那句刻意把「不发告警」写在明面上 —— 那正是回答「为什么群里没动静」的地方。
- **`runtime/daily-job-plan.mjs` 的 `note` 与注释同步两档口径**：`--print` 是运维真跑前唯一能核对的东西，
  它必须能看出「这一步会不会发告警」。守卫那一档补一句「它同时成了一个**写入方与投递方**」。
- **文档三处**：`skills/sycm-alimama-daily-report/references/sop.md`（§逐店登录态体检）、
  `skills/sycm-alimama-daily-report/SKILL.md`（英文段那句 `It never delivers an alert` 已不成立）、
  `docs/ops/LOGIN-STATE-MANAGEMENT.md`（新增「告警口径」整段）。
- **判据跟着改**（`runtime/daily-job-plan.test.mjs`）：原判据把只读档的说明文案**逐字钉到闭括号**为止，
  于是往文案里补一句真话就把它打红。改成钉**语义**：只读档必须同时说清「不开页面、不点东西」
  **和**「不发任何告警」；`--login` 档必须预告「会发飞书告警」。**改的是判据，不是把文案改回去。**

### 为什么「只读档一个字都不发」不是保守，而是这条授权的边界

用户给的是「自动登录失败 ⇒ 告警」，前提是「你要先自动登录」。把两件事拆开看：

- **没去登过 ⇒ 不许叫人。** 否则那条告警的正文会说「登录页已经开在窗口里了」，
  而那一轮连登录页都没打开 —— 照着做的人在窗口里找不到东西，且现场不报任何错。
- **去登过但没成 ⇒ 必须叫人。** 这才是「需要人来一次」的真实情形，也正是用户要的那一条。

所以 `notifyModeFor` 不是「保守取值」，它是把授权范围**逐字**翻译成代码：授权的那半是「去登+登不进叫人」，
没授权的那半是「没登也去叫人」。

### 本版验证（分开说，别混成一句）

- **离线**：`check-login-shops-core.test.mjs` **26/26**（净增 5 条：`notifyModeFor` 两档取值、
  告警收据透传、四种投递状态说得出区别、只读档报告里没有「已叫人」那段且明说不发告警、
  `--login` 档那一段出现在判据下面；另把原来那条「必须 `--notify off`」改写成
  「必须 `notifyModeFor({ login })`，且源码里不许再出现写死的档位字面量」）。
- **离线（相邻）**：`check-login-shops-core` ＋ `login-merchant-core` ＋ `daily-job-plan` 三个文件
  **88/88，exit 0**（含本轮新加的两条「说明必须跟着档位走」判据）。
- **离线（全量 unit）**：`node scripts/run-test-suite.mjs unit --concurrency=1` ⇒
  **`unit:skills 821/821/0`（58 文件）＋ `unit:runtime 912/912/0`（95 文件），EXIT=0**，用时 21m03s；
  原始输出 `evidence/auto-login-alert-2026-09-23/unit-full-2026-09-23.txt`（含末尾 `exit=0`）。
  跑在**最终树**上：本轮全部改动（含判据改写）在开跑之前已落盘。
- **真机（一次性实例，会真的发一条飞书）**：`evidence/auto-login-alert-2026-09-23/`，
  脚本 `rehearse-auto-login-alert.mjs`，日志 `rehearsal-log.txt`，结构与回执
  `rehearsal-auto-login-alert.json` / `login-commit-receipt.json` / `login-checkonly-receipt.json`。
  在**未登记端口 19933/19943 + 临时 profile（密码库必然为空）**上起一个一次性 Edge，
  两组对照都真跑：
  - **反面**：`--check-only --notify off`（＝只读档那条口径）⇒ 收据 `{"mode":"off","status":"SKIPPED",
    "reason":"mode_or_not_attempted"}`，**一个字都没发**。
  - **正面**：`--commit --notify auto`（＝`--login` 档那条口径）⇒ 结论 `NO_SAVED_CREDENTIAL`，
    收据 `{"mode":"auto","alertId":"sycm-login-盖文天猫-sycm-alimama-20260923","status":"SENT",
    "exitCode":0}` —— **消息真的发出去了**（`SENT` 是飞书接口自己给的应答，不是我们的推断）。
  - 跑完显式 `taskkill /T`，用**端口回读**确认两个端口都不再应答（自报「已释放」不算数），
    临时 profile 已删除。
  - 两条**刻意说明**，免得把这次证据读过头：
    1. 为什么用一次性实例而不是直接打那家店：用户此刻正在那几个窗口里手工登录，
       而带 `--login` 会去动那个窗口（开/复用登录页、补手势）。用一次性实例把扰动静默降到零。
    2. 因此那条告警里「登录页已经开在{窗口}了」指的是一次性实例那个窗口；**其余文案逐字就是真跑时那一份**。
  - 证据文件里的收件人 id / 应用 id 由脚本**在写盘前**打码（这条规则写在脚本头部）；
    独立的第二道自查是 `evidence/auto-login-alert-2026-09-23/scan-leaks.mjs`
    （路径按自身位置算，复制进 evidence/ 后仍可跑），输出 `leak-scan.txt`：**干净**。

### 欠账（如实写）

- **`--no-auto-login` 与熔断仍只有离线判据**，没有真机证据（本轮没跑）。
- 分批驱动（`run-batches.mjs`）那一遍守卫的真机行为未单独验证。
- 定时链本体（`run-daily-job.mjs` 真跑）仍**没有证据目录**（仓库里没有 `evidence/daily-job-*`）；
  定时任务排期与「每日 11:40」这个名字的口径仍未核（时区），未在本版处理。

## [1.4.0] - 2026-09-23

把用户 2026-09-23 的拍板原话「**有两个肯定不行只保留一个标识**」落地：同一个窗口里堆了多个
店铺标识页时，从**停手报错**改成**收敛成一个**。

同一轮还回答了他问的另一件事（「为什么要人工登录？没有保存密码吗？」）—— 那件事**没有改代码**，
所以不算本版的改动；结论放在本节最后一段，免得下次又从头查一遍。

### 本版为什么必须**推翻**一条写好的决定（不是「纪律可以破」）

原代码在这个分支上写的是：「堆了多个标签页时按纪律停手：navigate 哪个都不对，关掉哪个都是替人做决定」。
它保的是「不替人做决定」。但它守错了对象：

- **那些重复的标识页是同一个东西的多个副本**，不是不同的东西。留哪一个都对 ——
  因为留下来的那一个**紧接着会被重新导航到本次 URL**（店名/端口/登录态/实际会员名全部按当下重写）
  ⇒ 「留哪个」只决定哪个 targetId 活下来，**不决定窗口上写的是什么**。
- **停手的代价是真的**：这家店的窗口会**永久**停在两个标识页上，每轮都报同一句话，
  而用户要的恰恰是「只保留一个」。这里没有任何需要人来定的取舍。
- **它不是新增的能力面**：`PRUNE_POLICY.label` 早就写着「只留一个：堆了多个说明上一轮挂标签页时
  没按幂等走」，`--prune` 一直在做同一件事。本版做的是**同一决定的就地执行**，
  并且把「这条是兜底、正路在挂标签页那一步」写进了那张策略表。

### 本版改动

- **收敛**（`runtime/shop-window-label.mjs` 的 `ensureLabelTabOn`，`labels.length > 1` 分支）：
  留第一个 → 导航它到本次 URL → 钉住 → **关掉其余** → **回读确认恰好剩一个**。
  - **先更新留下的那个、再关多余的**：即使关不掉，窗口上那一页也是**新的**（可读），
    而不是「旧内容 + 一句报错」。
  - **判据是「回读后恰好剩一个标识页」**，不只是「关掉的那几个没了」—— 后者证不了留下来的那个还在。
  - **留第一个**这条必须与 `prunePlan` 的 `keepFirst` 一致，否则 `--label --prune --commit` 同一次
    下达里两边会指向不同的页签（prune 排在挂标签页**之前**，会把刚更新的那个关掉）。
    这条不变量现在有专门用例守着（「两个执行点必须留同一个标识页」）。
- **抽出「关页签 + 回读确认」共享助手**（`closeTabsAndConfirm`）：`pruneTabsOn` 与收敛原来是两份
  同样的逻辑。抄一份的后果不是多几行，是**两边各自演化** —— 而它们都建立在同一条最容易写错的判据上
  （不信 `/close` 的返回码；但回读也不能只读一遍，真机上 `about:blank` 从 `/close` 到消失要 270ms）。
  两个相反的坑与等待预算（3 次读 × 600ms）现在只有一份，写在那个助手上。
- **四条来源路径都显式带 `converged`**（复用 / 收敛 / 接管空白页 / 新建）：不靠「某个键不存在」反推
  是哪条路 —— 靠缺键反推的判据会在加字段那一刻**静默**失效，而本版刚刚加过一次字段。
- **CLI 报告把收敛结果**在**成败两种情形**下都打出来（`convergedClosed` / `convergedFailed` /
  `labelsAfter`）：原先 `!ok` 那一支只剩一句 `error`，而「关了几个、哪个没关掉」正是唯一能接着查的东西。
- **用法注释补一句**：挂标签页那一段**自带收敛**，不需要额外加 `--prune`；`--prune` 清的仍是**所有类别**
  的残留，两件事各自打印、各自可查。

### 本版验证（分开说，别混成一句）

- **离线**：`runtime/shop-window-label.test.mjs` **53/53**（净增 3 条：收敛成功、收敛遇到关不掉、
  两个执行点同口径；另把原来那条「堆了多个就停手」改写成收敛）；相邻五个文件
  （`arch-boundary`／`browser-ports`／`page-normalize`／`shop-pages`／`version-consistency`）**77/77**；
  各自 `exit 0`。
- **突变 12/12**：`evidence/label-converge-2026-09-23/mutate-1.4.0.mjs`，
  报告 `mutation-report-1.4.0.json` / `.txt`。十二条**每一处都红在点名的那一条**，还原后 sha256 **逐字节一致**。
  三条是本版新增判据（收敛改回停手／留第一个改留最后一个／把回读后的真实数量改成写死 1），
  九条是 1.3.0 的既有条目（那一份脚本仍是 1.3.0 的判据快照，只把「版本号三处一致」那条的 `from`
  跟着本版更新，并在头部注明新脚本是它的完整超集）。
- **真机（一次性实例）**：`evidence/label-converge-2026-09-23/`，脚本
  `rehearse-converge-throwaway-2026-09-23.mjs`，报告 `throwaway-rehearsal.txt/json`。
  在**未登记端口 19931/19941 + 临时 profile** 上起一个一次性 Edge（不碰任何已登记实例），
  造出「一个窗口两个标识页」，真跑收敛：**收敛成功、只发 1 次 `/close`、关掉的 targetId 真的消失、
  留下的那个被重新导航到本次 URL、其余页签一个都没变（前后逐字相同）**，再跑一次走「复用」且 0 次 `/close`。
  跑完显式 `taskkill /T` 并用**端口回读**确认释放（自报「已释放」不算数），临时 profile 已删除。
  - **真机上抓到两条原先没有的事实**（都不是代码错，是判据/注释里的想当然）：
    1. **`/targets` 的顺序既不是页签条顺序、也不是创建顺序，两次运行还不一样**（一次新建的重复页排在
       首屏那个前面、一次排在后面）。第一次按「留的必是首屏那个」写的断言当场变红 ⇒ **改的是断言，
       不是代码**：真正必须成立的是「与 `prunePlan` 同一口径」，那条由「两边都取 `/targets` 顺序」保证。
       这条事实已写进代码注释（否则下一个人会再想当然一次）。
    2. **回读确实需要「等一拍」**：两次跑 `reads=1`、一次 `reads=2`。收敛这条路同样会撞上
       270ms 那一拍 —— 这正是把它并进共享助手而不是各写一份的理由。
  - 第一次/第二次（断言写错的那次、中途中断的那次）的原始输出**一并留档**，文件名里就写着它们为什么废掉：
    `throwaway-rehearsal-run1-断言写错的那次.*`、`throwaway-rehearsal-run2-中断的那次.*`。
    （第二次那次还暴露了一个真问题：**中途崩溃时脚本的退出码是 0** —— 「崩了却报成功」。
    退出码已改成「每一项检查都过 **且** 没有致命中断」才为 0。）

### 关于「为什么还要人工登录」（本轮问的，本版**没有改代码**）

密码**确实存着** —— 五家 profile 的密码库里都有凭据（只读审计
`evidence/batches-release-and-label-2026-09-23/login-data-audit-0923.txt`）。
缺的不是密码，是**那条 origin**：浏览器的密码填充**按 origin 匹配**，而盖文天猫只存了
`havanalogin.taobao.com/mini_login.htm` 这一条，自动登录固定打开的是
`login.taobao.com/havanaone/login/login.htm` ⇒ 一次也填不上 ⇒ 报的是「没存凭据」
（`NO_SAVED_CREDENTIAL`，`login-merchant.mjs` 第 292 行）。
⚠️ **这一段里的「按 origin 匹配」在当日更晚被证伪**（origin 相等**照样不填**，
`havanalogin` 那条主机上的凭据实测 0/3）；「盖文天猫要人工登一次」这个**结论仍然成立**，
理由换成「它在 `login.taobao.com` 上一条凭据都没有」。详见 [1.6.0]。
**也不是** 2026-09-19 那种「主站会话有效被重定向到千牛」的假阴性：这次那两页的 URL 是真的登录页，
而那条形态已有 `detectLoginDetour` 处理。

处置（**未做，属于要授权的改动**）：让脚本的登录入口与密码库里的那条 origin 对齐。
在那之前，正确动作是**在盖文天猫自己的窗口里人工登一次并勾「保存密码」**（一次性）。
不改成「让脚本自己去猜账号密码」—— 项目纪律是**凭据不进任何仓库内的东西**。

### 本版仍然是欠账的（别当成已做）

- **盖文天猫要人工登一次**，之后才能重跑 2026-09-22 整轮日报（真写重跑要按 SOP §9.3 先删已写数据，未做）。
- **「同一账号连续 2 次失败当天不再试」的熔断仍未实现**（1.2.0 就欠着）。
- **冷启动恢复回来的 `about:blank` 仍是「空页」的一个来源**：本版把「首屏不再产生空页」做实了，
  没有做「上一轮的空页不会回来」（要动收尾侧与各 profile 的 `exit_type`）。
- **竞品链的浏览器（9222）首屏仍是 `about:blank`**：那条链不读店铺身份，刻意不动。
- **带 `--login` 的成功支路、`--no-auto-login` 仍未在真机上验过**；收敛这条路也只在这一档
  （店铺实例的窗口）验过，竞品/日报那两条链不挂标识页。

## [1.3.0] - 2026-09-23

把用户 2026-09-23 的原话「**每一轮跑完要释放浏览器资源／不要空页／每个店铺的浏览器要有标识页**」
落地，并修掉上一版（1.2.0）在真机上暴露的两处**「打印的与实际做的不一致」**。

### 本版为什么必须做（三条都有实测依据，不是推测）

- **「失败不释放」这条口径兑现不了**：批次的 `start` 走 `scripts/start-all.mjs`（**起完就退**），
  宿主在命令结束时回收的是**整棵进程树** ⇒ 那批窗口在命令结束 **0.26 秒**后就连同启动器一起消失，
  只剩代理。于是「失败不释放」的真实效果只有两个：**内存没省下来**、**排查现场也没留住**。
  取证：`evidence/batches-2026-09-22/batches.log`（那一次 13:29 的失败轮）。
- **登录守卫排在 `start` 之前 ⇒ 自动登录一次机会都没有**：1.2.0 给这一步加了 `--login`
  （掉了就自己登），它因此**会开页面**、需要那几家店自己的浏览器已经在跑。而旧位置排在所有
  `start` 之前 ⇒ 五个实例还没起 ⇒ 五家店代理全回 `HTTP 500 连不上浏览器调试端口 19xxx`
  ⇒ 五行 `UNREADABLE`、退出码 3，**表面上只看到一句「不是全在登录态」**（同一份证据）。
- **那个空白页是启动器的默认值**：`runtime/start-project-browser.mjs` 的
  `START_URL = process.env.PROJECT_BROWSER_URL || 'about:blank'`，而 `start-all.mjs` 从不设它
  ⇒ **每次冷启动都恰好留下一个空白页**（`prunePlan` 对 blank 的策略本来就是「永远关」，
  它没有任何用途）。标识页原先是靠起完之后再跑一遍 `shop-window-label.mjs --commit` 补的 ——
  那一步失败或没跑到时，窗口上**既没有店名、又留着那个空白页**。

### 本版改动

- **释放口径反转**（`runtime/batch-plan.mjs` 的 `releaseAfterBatch`）：三档
  （链成功／链失败／根本没跑到链）**一律 `release: true`**，三档「为什么放」的措辞**各自不同**
  （那一行是日志里唯一能复查这是哪种情况的东西）。旧口径的 `caveat` 字段**删掉** ——
  留着它，读日志的人会以为「不释放 ＝ 窗口还在」。要看现场得 `--no-release`
  **并且** `scripts/start-all-hold.mjs` 在后台托住，两件缺一不可。
- **店铺实例的首屏＝它自己的标识页**（`runtime/launch-plan.mjs` 的 `buildLaunchCommands`）：
  给店铺实例的 `PROJECT_BROWSER_URL` 填 `labelPageUrlFor({ shop: entry.key, port: entry.browserPort })`。
  **一次消掉两个问题且不新增任何页签**（页签条数不变、位置也不变），而且标识页从窗口开出来那一刻
  就在（`windowTitleFor` 的店名进标题）。
  - URL 的实现**只有一处**（`shop-window-label.mjs` 的 `labelPageUrlFor`），不在这里另拼一份：
    两处拼地址迟早漂成两个格式，症状是「窗口首屏那个页面点不动」而**不会报错**。
  - **竞品链与日报链不套**：日报链的商家浏览器已自带 `https://sycm.taobao.com/`，竞品链不读
    店铺身份。给它们套一个店铺标识页是**把标签贴错窗口** —— 比留一个空白页更坏。
- **登录守卫的位置与产物名**：`buildBatchSteps` 新增 `loginStep` 入参（插在 `start` **之后**）、
  新增 `batchLoginArtifactName(index)`；`scripts/run-batches.mjs` 逐批生成、逐批转发
  （`--shops` 只给本批）。共用一个文件名时后一批会盖掉前一批，而链读到的仍然是
  「某个存在的文件」⇒「这一批的链看的是另一批的登录态」在日志里完全看不出来。
- **打印口径跟着改**（本仓库反复在治「打印的与实际做的不一致」）：`--print` 里那句
  「整轮一次」改成「查的是这一批」；label 那一步的说明从「接管空白页」改成
  「已有就地更新；没有才接管空白页」（冷启动首屏已经是标识页，接管那条路不再是常态路径）；
  `run-batches.mjs` 与 `run-daily-job.mjs` 里「跑成才停／失败不主动释放」全部改成「一律释放」。
  - 还有一处**同一个词在一份日志里有两个意思**：逐批小结原先写 `释放=${stop 的退出码}`，打印出来是
    `释放=0`，与末尾那句「释放 1 批」并列时读起来像「一批都没释放」。这一行改成
    `stop（释放窗口）=退出码 0`；从此「释放」在这个文件里只有一个意思（末尾那个批数）。
    这条没有任何离线判据（`scripts/run-batches.mjs` 没有测试文件），是**读日志时被误读过**才发现的。

### 本版验证（分开说，别混成一句）

- **离线**（逐个报分母）：`batch-plan` **19/19**、`launch-plan` **20/20**、
  `daily-job-plan` **24/24**，另加与本次改动相邻的五个文件
  （`arch-boundary`／`browser-ports`／`shop-window-label`／`page-normalize`／`shop-pages`）
  合计 **121/121**，各自 `exit 0`。
  最后还有一处纯措辞改动（`run-batches.mjs` 的逐批小结）之后**复跑过四个文件**：
  `batch-plan`＋`daily-job-plan`＋`launch-plan`＋`version-consistency` **69/69**、`node --check` exit 0。
  （`scripts/run-batches.mjs` 没有测试文件 —— 那一处改动**没有离线判据**，这也是它当初能溜过去的原因。）
- **突变 9/9**：`evidence/batches-release-and-label-2026-09-23/mutate-2026-09-23.mjs`，
  报告 `mutation-report-2026-09-23.json` / `.txt`。九处**每一处都红在点名的那一条**、
  还原后 sha256 **逐字节一致**。四条是本版新增的判据（释放口径／首屏标识页／守卫位置／
  逐批产物名），另五条是既有判据（默认不启用分批／起停同组／版本三处／分批也要 `--commit`／
  分批宿主逐批读本批结论）—— **旧的突变脚本里有一条的期望标题已被本版改名，所以整份重写**，
  不是补一个脚本了事。
- **真机**：报告 `evidence/batches-release-and-label-2026-09-23/real-machine-rerun-2026-09-22.md`，
  现场产物 `evidence/batches-2026-09-22-rerun/`（`--batch-size 5`、排练档不写飞书，本地 13:41→13:45）。三条：
  1. **释放**：这一批**链失败**（走的正是旧口径「留着」那一档），新口径照样执行了 `stop` ——
     5 家代理 + 5 家浏览器逐个停掉，每家 `停后盘点到:missing`，`stop 退出码=0`，末尾「释放 1 批」。
  2. **不要空页 / 要有标识页**：跑中只读盘点（`tabs-probe-readonly.txt`）五家**空白页全 0**；
     标识页四家各 1 个、盖文天猫 2 个（见下条欠账）。首屏那次挂标是 `reused: true`＝原地导航，
     **没有新增页签**。
  3. **登录守卫的新位置真的生效**：这次查到了**本批**实例（1.2.0 那次是五家全
     `HTTP 500 连不上浏览器调试端口`），并带 `--login` 真试了一次自动登录；结论落在
     `login-preflight-b1.json`，链也读到了它。
- **没跑成的那一步是数据入口，不是采集逻辑**：整轮被链自己的第 1 步体检拦住
  （`TARGET_PAGE_MISSING：生意参谋工作页找到 0 个`），原因是**盖文天猫掉登录**。
  已确证不是脚本坏：只读审计五家 profile 的密码库（`login-data-audit-0923.txt`）显示
  **盖文天猫只有 `havanalogin.taobao.com` 那条 origin，没有 `login.taobao.com` 这条**，
  而自动登录固定打开后者 ⇒ 按 origin 匹配的填充无从发生 ⇒ `NO_SAVED_CREDENTIAL`。
  ⚠️ 其中「按 origin 匹配 ⇒ 换到凭据所属 origin 那条地址就能填」当日更晚被证伪，见 [1.6.0]；
  「要人工登一次」不变。
  人工登一次并勾「保存密码」即可（一次性）。

### 本版仍然是欠账的（别当成已做）

- **「同一账号连续 2 次失败当天不再试」的熔断仍未实现**（1.2.0 就欠着）。分批形态下登录
  守卫会按批跑多次，这条欠账比 1.2.0 时更该补。
- **分批形态下登录守卫会跑两遍**（整轮一遍 ＋ 逐批一遍）：整轮那一遍是
  `runtime/daily-job-plan.mjs` 在 `--batches` 档生成的，留它是为了定时日志里那一条
  「整轮视角」的记录。要收紧应当删掉**那一遍**，不是删分批那条。已在代码里注明是刻意留下。
- **竞品链的浏览器（9222）首屏仍是 `about:blank`**：那一条链不读店铺身份，本版**刻意不动**它。
  「不要空页」这句话目前只对**店铺实例**成立。
- **盖文天猫窗口里出现过两个标识页**（本版未处置）：冷启动首屏那一个 ＋ 上一轮留下来的那一个，
  于是 `shop-window-label.mjs --commit` 按既有决定**停手**（`这个窗口里堆了 2 个标签页…`，退出码 1，
  不阻断）。已查清的一条机制：**Edge 冷启动会恢复上一轮的页签** —— 证据是 13:29 那一轮五家全是冷启动、
  当时首屏还是 `about:blank`（旧代码），可其中三家的窗口里**已经有**一个只有
  `shop-window-label.mjs --commit` 才写得出的标识页。**这一轮为什么只有一家**出现两个 ⇒
  两次冷启动之间用户手动开关过浏览器，属于不受控的中间状态，本轮复现不出来。
  三条候选处置（收敛／批次里补 `--prune`／从源头掐掉会话恢复）见报告第五节，**未擅自动手** ——
  第 1 条会改掉一条写明的设计决定，第 3 条要动 `stop-all.mjs` 与各 profile。
- **恢复回来的页签本身就是「空页」的一个来源**：既然冷启动会恢复上一轮页签，那昨天留下的
  `about:blank` 一样会回来。本版把「首屏不再产生空页」这件事做实了，但**没有**做
  「上一轮的空页不会回来」—— 那要落到收尾侧（处置建议第 3 条）。

## [1.2.0] - 2026-09-23

把用户 2026-09-23 的拍板原话「**2.可以自动登录把项目规则改了**」落地。
这不是加了一个功能，是**改了一条非目标 ＋ 翻了一个默认值** —— 所以本版把「改了哪条规则、
谁默认什么」写清楚，其余照旧。

### 本版为什么必须做（真因是查出来的，不是猜的）

- **掉登录的成因**：淘宝/阿里妈妈的关键登录键（`cookie2` / `_tb_token_` / `.alimama.com` 的
  `sn`、`lgc`、`cookie2`）**全是会话级 cookie**（`session=true`、`expires=1969-12-31`）⇒
  **浏览器进程一结束就丢**。所以掉登录是**每次重启都会发生的常态**，不是偶发事故。
  取证：CDP `Storage.getCookies`（只读、不新建页签、不导航）读六个实例，
  产物 `evidence/auto-login-2026-09-23/cookies-cdp-out.txt`。
- **「密码都保存着」与这条不矛盾**：`Login Data`（磁盘上的密码库）和 `Cookies`（运行期会话）
  是两件事。用户看能自动填账号密码 ⇒ 密码库在（正确），但登录态已经丢了。
- **「不能自动登录」的真相**：能力早就造好了（`login-merchant.mjs --commit`，实测四家全自动登成、
  零验证码），但**从来没有接进任何自动化路径**（日报链 11 步里没有这一步），默认值也是关的。
  所以「昨天那轮不用人工」是**会话恰好还在**，不是「不需要登录」。

### 本版新增

- **跑前登录守卫**（`check-login-shops.mjs --login`）：掉登录的当场自己登一次，没成才叫人。
  - *两种模式只在一处分叉*：`login ? '--commit' : '--check-only'`。写成两份调用的话，
    漂移的症状是「自动登录打到了另一个实例上」，日志里看不出来。
  - *权威字段是 `loggedInAfter ?? loggedIn`*：子进程回执里 `loggedIn` 是**登录之前**那一眼。
    只看它会把「刚登成功」报成掉登录 ⇒ 白叫人一趟。**假红比不报更坏**，所以这条单独立了用例。
  - *措辞跟着开关走*：只读模式**不许**出现「自动登录」字样与 `NO_SAVED_CREDENTIAL` 代号
    （那一轮根本没有登录发生）；守卫模式才说「自动登录也试过了、没成」并把子脚本的结论翻成人话
    （`loginFailReason`，认不出一律「内部结论：X」，不猜）。
- **默认值落到正确的层**（这是本版最容易写错的一处，所以进 CHANGELOG）：

  | 层 | 默认 | 为什么 |
  | --- | --- | --- |
  | `runtime/daily-job-plan.mjs` | `autoLogin` **关** | 纯函数会被直接调用，且带 `--login` 会碰页面 —— 不该有副作用默认值 |
  | `scripts/run-daily-job.mjs`（定时链宿主） | **开**，`--no-auto-login` 可退 | 自动化入口，授权就是针对它 |
  | `scripts/run-batches.mjs`（分批驱动） | **开** | 同一条链的另一个宿主，口径必须一致 |

  ⇒ 出厂配置里没有它、模块被单独调用时行为不变；**只有自动化宿主显式打开了它**。
  与 1.0.0 那条「默认关闭的 `--batches`」是同一个手法。
- **风控边界没有被忽略**：带 `--login` **强制串行 + `LOGIN_GAP_MS = 20000` 静默期**；
  只读体检仍是 `Promise.all` 并行。同一个出口 IP 上短时间内连打多次登录是风控最敏感的形状，
  最坏结果不是「跑失败」而是一批账号被保护性锁定。20 秒是**工程选择、不是实测最优值**，
  改小它之前先想清楚这是在拿账号安全换轮次时间。
- **规则文档同步改写**（用户要求的「把项目规则改了」）：
  - `docs/ops/LOGIN-STATE-MANAGEMENT.md` §8 第一条补 2026-09-23 段：谁默认什么、四条边界一条没放宽、
    并且**如实点名哪一条还是欠账**。
  - `docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md` §5.1 新增默认值表（更正原先
    「自动登录默认关闭、不改变今天的默认行为」这句与代码的打脸）＋ §7 状态表与 B 项；
    「我不会自己改这条。要你明确说一句「允许」，我才动它」已标注**授权已给**。
  - `docs/ops/LOGIN-RECOVERY-OPTIONS.md` §0 结论、§3.5 风险、§7「不承诺什么」同步：
    「现在不开工」更正为「已开工并接线」，且写清 A1 仍然不落地。

### 本版修掉的一处假红

- 带 `--login` 时若只读 `loggedIn`：机器人刚把两个后台都登进去，报告仍写「掉登录」⇒
  收信人被叫去窗口里做一件**刚做完的事**。这是本次改动里唯一一处「错了不报错、只是白叫人」的地方。

### 本版验证（四类分开说，别混成一句）

- **离线**（逐个报分母，不给合计数；原始输出 `evidence/auto-login-2026-09-23/t-*.txt`）：
  `check-login-shops-core` **21/21**、`daily-job-plan` **24/24**、`batch-plan` **17/17**、
  `version-consistency` **6/6**、`run-multi-shop-day` **55/55**、`arch-boundary` **3/3**，
  六个文件各自 `exit 0`（合计 126/126/0）。
- **真跑宿主 `--print`**（不是源码扫描；三份产物都在证据目录，都不起任何进程）：
  默认那一档打出 `check-login-shops.mjs --login --json`；`--no-auto-login` 后变成
  `check-login-shops.mjs --json`（`--json` 不能跟着一起丢）；分批驱动那一步带
  `--login --shops …--json`。
- **突变 10/10**：脚本 `run-mutations.mjs`，产物 `mutation-report.json` / `.txt`。
  每一处都**红在点名的那一条**、还原后 sha256 逐字节一致。覆盖的错误形态都是
  「错了也不抛错」那一类：权威字段退回 `loggedIn`／两个措辞约束被拿掉／入口开关消失／
  两种模式不再分叉／静默期消失／带 `--login` 走并行／计划层不带 `--login`／
  `--no-auto-login` 失效／分批口径分叉。
- **真机：本版没有。** 取证当天六个实例的淘宝会话全部失效（`inv-now.txt` / `tabs-now-1229.txt`），
  「掉登录 ⇒ 自己登回来」这条成功支路要等人先登一次、或等下一轮自然重启后才走得到。
  ⇒ **本版读作「接线完成、仅离线判据 ＋ 真机现场快照」，不读作「真机验过」。**

### 本版仍然是欠账的（别当成已做）

- **「同一账号连续 2 次失败当天不再试」的熔断没实现**，今天靠「一天最多一轮」的调度兜着。
  将来要一天多轮，先补这条，而不是把 20 秒调小。
- L0/L2 判据仍未做 ⇒「未登录」还不能被**提前**查出，只能等采集撞到登录墙。
- 交付专用 profile 的密码库是空的（刻意，只有 `--disable-sync` 拦得住个人密码库同步进来）
  ⇒ 客户机上会落 `NO_SAVED_CREDENTIAL` 并走叫人。**本机能用 ≠ 客户机能用。**

## [1.1.0] - 2026-09-23

收口 1.0.0「已知未完成」的第 3 条。用户对这一条的拍板原话是「**1.改**」。

### 本版新增

- **失败告警带上了跑前登录态结论**（`--login-preflight`，一条从第 ② 步到告警正文的路）。
  - *为什么*：链的第 0 步体检只答「页面够不够」，而「页面被弹回登录页」与「页签被关掉」
    在它眼里**同形**（都是「目标页不在」）。于是掉登录那天发出去的告警是
    **「把这两页各开一个」** —— 而掉登录时开几个都会被平台送回登录页，**收信人照着做无效**。
    真因判据本来只有一处（`login-merchant-core.mjs` 的 `SITES`：站点词表 / 未登录 URL 判据 /
    探针地址），而它从前只活在链的第 ② 步日志里、传不到告警。
  - *形态（生产者 → 消费者，四段）*：
    1. 第 ② 步加 `--json`，stdout 落成 `<本轮证据目录>/login-preflight.json`。
       `scripts/run-daily-job.mjs` 起了一个**通用**机制：计划里哪一步带 `artifactPath`，
       就把它的 stdout 单独接出来写成文件、并回显进 job.log（两条都要 —— 文件会被后一轮覆盖，
       日志是「当时到底打了什么」的唯一留档）。
    2. 链新增 `--login-preflight <文件>`（`skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`）。
       **读不到不抛错、也不拦采集**：它是诊断层、不是闸门；但它会被说成
       「这一轮本来要查、结论没读出来」，不许静默折成「都不缺」。
    3. 新增第 6 个失败结论 `NEEDS_LOGIN`，**两个层次**都改判：整轮被挡住的
       （`ROUND_BLOCKED`）与店里那一层的（`SHOP_BLOCKED`）—— 前提是那家店**确实**掉登录了。
       三张表（`FAILURE_CAUSES` / `REASON_BY_CAUSE` / `ACTION_BY_CAUSE`）在**加载期**互锁，
       漏一张模块直接起不来（这条互锁是 1.0.0 就有的，本版正好用上）。
    4. 每条告警都多一句登录态旁注，**四种情形各说各的**：没查（说「没查过」，并给出一条
       收信人自己能判的判据）/ 结论丢了 / 谁掉了（**按平台分别说名字**，如
       「里可林淘宝（生意参谋、阿里妈妈）」）/ 都在（「问题不在登录上」—— 省掉一趟白跑的浏览器）。
       结论只保留**本轮要跑的那几家**：分批时体检一次查五家，不筛就会点名跟这一批无关的店。
    - 分批那一路（`scripts/run-batches.mjs` ＋ `runtime/batch-plan.mjs`）**整轮跑一次**体检、
      把同一份结论交给每一批的链（链内部按本批 `--shops` 筛，所以共用一份不会串店）。
  - *验证*：
    - **离线分母**（逐个报，不给一个合计数）：
      `skills/…/run-multi-shop-day.test.mjs` **55/55**、`runtime/daily-job-plan.test.mjs` **23/23**、
      `runtime/batch-plan.test.mjs` **17/17**，三者 exit 0。原始输出
      `evidence/login-preflight-2026-09-23/unit-full-2026-09-23.txt`（全量 `unit` 套件）。
      其中两条**不是**源码扫描而是真跑宿主：`run-daily-job.mjs --print` 与
      `run-batches.mjs --print`（不起任何进程）必须打出带着真实结论路径的那一行 ——
      「函数全绿、没人调」是这个仓库吃过三次亏的形态。
    - **突变**：**9 处，全部如期望变红、且红在点名的那一条上**，每处还原后 sha256 逐字节一致
      （脚本 `evidence/login-preflight-2026-09-23/run-mutations.mjs`，产物
      `mutation-report.json` / `.txt`）。9 处覆盖：调用点漏传 / `null` 被当成普通入参 /
      两层改判各自失效 / 结论文件被折成「没查」/ 没按本轮的店筛 / 两个宿主各自漏接线 /
      第 ② 步不出 JSON / 「没查过」那句不承诺的话被删掉。
      ⚠️ 其中 M3 第一次跑是「**红了没红**」—— 它暴露出一个真实缺口：**店里那一层**的改判
      当时一条判据都没有。是补了判据之后才红的（这条记在这里，因为「突变没红」本身就是发现）。
    - **真机**：**本版没有真机整条走通**。写飞书那条正常路径昨天有真跑记录
      （`evidence/daily-job-2026-09-22/job.log`：五家店 11 步全绿、`chain 退出码=0`），
      但**带 `--login-preflight` 的那一版定时链没跑过**；而现场（`tmp/tabs-inventory-0930.txt`）
      六个实例的淘宝会话全部失效、需要人登录一次 —— 那正是这条修复要处理的情形，
      但它也意味着「掉登录 ⇒ 告警点名」这件事的真机验证要等人登录之后才有机会做到。
      所以本版**只有离线判据 ＋ 真机取到的现场快照**，别读成「真机验过」。
    - **一处刻意没改**：`runtime/sop-runtime/round-notify-policy.mjs` 里也有一个同名的
      `TARGET_PAGE_MISSING`，但那是**另一条链**（sop-runtime）的策略表，收信人与动作都不同
      （`needs: ONSITE`、动作是「按 SOP 重开目标页面」）。核对过，本版不动它。

### 本版修掉的告警文案（改前 → 改后）

- 改前（掉登录时）：`下一步：打开那个开着飞书「各店铺日报」的浏览器窗口，把这两页各开一个…`
- 改后（同一现场）：`（跑前先查过登录态：里可林淘宝（生意参谋、阿里妈妈）掉登录了 ——
  上面那条「页面不齐」就是这么来的：掉登录时采集页面会被平台送回登录页，开几个都一样。）`
  ＋ `下一步：…用这家店自己的账号重新登录一次 —— 只在这一家店自己的窗口里登…`

## [1.0.0] - 2026-09-23

第一个版本。在此之前的所有改动没有版本号，历史留在 `evidence/`（每批一个目录，含原始产物）
与 `.workbuddy/memory/YYYY-MM-DD.md`（逐日工作记录）里，不在这里补写。

### 本版新增

- **跑前登录态体检**（`skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs`），
  并接进定时链第 ② 步。
  - *为什么*：链的第 0 步体检只看「端口/页面/出网」，**不看登录态**（该预检里 IDENTITY / SESSION
    两层明写未实现）。于是掉登录这件事从前只能等采集阶段炸，炸出来的告警还是
    「没跑完，但记录里没写停在哪一步」——要人自己去翻是哪家店的哪个后台。
  - *判据*：五家店 × 两个平台逐个问一遍；**退出码分四档**（0＝全在登录态 / 2＝有后台明确掉登录 /
    3＝没结论或读不到 / 2＝用法错误），2 与 3 **刻意分开** ——「确认掉了」与「读不到、不知道」
    要人做的事完全不同。只读：不开页面、不点任何东西。
  - *验证*：离线用例全绿；**真机跑过**（五家店 10 个平台全绿、单店 `--json`、
    连跑前后逐窗口页签条数不变），证据 `evidence/login-preflight-2026-09-23/`。
    全量 `unit` 套件 skills 802/802 + runtime 870/870，exit 0（约 21 分钟）。

- **版本号机制**（`VERSION` ＋ `runtime/version.mjs` ＋ `runtime/version-consistency.test.mjs`）。
  - *为什么*：两处已经在要求版本号 —— 诊断包规格第一条是「版本 ＋ 最近回执 ＋ 关键日志 ＋ 截图」
    （`docs/ops/CLIENT-DESKTOP-DELIVERY-PLAN.md` P0-6），架构提案 §4.3 也写着 Decision 段
    「必须引用输入证据与版本」。而本仓库此前**三处都没有**：无 git tag、无 `VERSION`、
    `package.json` 无 `version` 字段。
  - *判据*：读不到或格式不符**当场抛错，不回落成 `unknown`**（一个写着「版本：unknown」的诊断包
    与没有版本一样没用，而且会让人以为读过了）。定时任务那类长跑入口走 `versionLineSafe()`，
    落 `unknown（原因）`——记账问题不该升级成业务停摆，但原因必须跟在同一行里。
  - *验证*：`runtime/version-consistency.test.mjs` 断言 `VERSION` / `package.json.version` /
    本文件首条三者一致，并断言非法格式（`v1.0.0`、`1.0`、空）会被拒。

- **跑完释放浏览器 ＋ 空白页改成店铺标识页**（批次驱动，一个批次 = 起这批 → 挂标识页 →
  跑这批 → 停这批）。
  - *为什么*：① 全店常驻不释放撑不住 —— 实测每实例 0.9–2.0 GB、约 15 个进程，
    瓶颈是内存不是 CPU，且**清页签省不了内存**（实测 6297→6726 MB），所以「一轮几家」
    不是旋钮、「同时开着几个实例」才是；② 一个窗口对应一家店，业务人员要能一眼看出
    哪一屏是哪家店，登录失败转人工时才好定位。
  - *形态*：切批与「该不该释放」是**纯函数**（`runtime/batch-plan.mjs`）；IO 层是
    `scripts/run-batches.mjs`（每批四段：`start` → `label` → `chain` → `stop`；
    整轮只起一次共享实例「商家浏览器」且**永不停它**，因为推送段与回读段跑在它上面）；
    接进定时链的是**默认关闭**的 `--batches N` —— 不带它时三步与从前逐字相同，
    这一条由 `runtime/daily-job-plan.test.mjs` 逐字守着。
  - *验证（三件事分开说，别混成一句）*：
    - **离线**：四个判据文件**逐个报分母** —— `batch-plan` 15/15、`daily-job-plan` 16/16、
      `version-consistency` 6/6、`arch-boundary` 3/3（合计 **40/40、0 失败、exit 0**）。
      其中 `daily-job-plan` 那 16 条里有「启用分批时 `--commit` 必须显式传下去」——
      它守的是「默认排练（不写飞书）」与「定时任务得真写」之间那条静默降级的缝。
    - **突变**：5 条（默认不启用分批 / 起停同一组目标 / 失败不释放 / 版本号三处一致 /
      分批也要 `--commit`）**全部如期望变红，且红在点名的那一条上**；每条还原后 sha256
      逐字节一致。脚本与原始产物随证据提交：`evidence/batches-2026-09-22/` 下的
      `mutate-batch-2026-09-23.mjs` ＋ `mutation-report-2026-09-23.json` / `.txt`。
    - **真机**：跑通的是**失败支路**（证据 `evidence/batches-2026-09-22/`）—— 链在第 0 步
      体检失败 ⇒ `stop` 被跳过并把「处理完怎么释放」的那条命令如实落进日志；标识页那一步
      成功且留下正面证据（**原地接管**空白页 `adoptedBlank:true`、`pinned:true`、
      窗口标题「里可林淘宝 · 日报采集窗口」）。
      **成功支路（链成功 → 真停 → 回读确认）没能在真机上整条走通**，卡在「商家浏览器的
      生意参谋会话已失效，要人登录一次」；它的两半各自有真机证据 ——
      链能真跑到拿退出码（这次拿到了 1），以及 `stop-all --yes` 的「5/5 已停 ＋ 盘点到
      missing」见 `evidence/cold-start-rehearsal-2026-09-23/`。
    - **一条实测边界**（已写进判决文案与运维文档）：本层 `start` 走 `scripts/start-all.mjs`
      （起完就退），而宿主要在命令结束时回收整棵进程树 ⇒ **这批窗口活不过本轮命令**，
      「失败不释放」只等于「我不去停它」（实测：命令结束后 0.26 秒浏览器与启动器一起消失、
      代理还在，很像「停了一半」）。要让窗口真的留到人来看，必须用
      `scripts/start-all-hold.mjs` 在后台托住。

### 已知未完成（本版不含，别误以为有）

- **一键诊断包**（P0-6）：规格里要「版本 ＋ 回执 ＋ 日志 ＋ 截图」，本次只把**版本**这一项
  造好了出口，打包本身还没做。
- **自动更新与回滚**（P2-1）：版本号是它的前置，本版只做前置。
- **告警文案没带上登录态结论**（2026-09-23 实测撞到）：定时链的三步里，第 ② 步
  `login-preflight` 会给出准确的「哪家店哪个后台掉登录」，但它 `blocking: false`、结论只落日志；
  而随后链在第 0 步阻断时发出去的那条**告警**，文案是「页面不齐，把这两页各开一个」。
  **真因是掉登录时，开页面不会好** —— 收信人会去做无效动作。
  另外第 ② 步与链第 0 步看的是同一件事的两面（掉登录 ⇒ 目标页被弹到 `custom/login.htm`
  ⇒ 被归位判成 `ambiguous-drift` ⇒ 体检报 `TARGET_PAGE_MISSING`），只是**报出来的那句话不对**。
  修法要动告警载荷的传递路径（把第 ② 步的结论带进链的告警），**等口径确定后再做**。
  **（已在 1.1.0 修掉 —— 用户拍板「1.改」，见上。）**

## 仓库级已知未做（不挂在某个版本上）

- `runtime/durable/crash-child.mjs` 由用例每次重新生成却被 git 跟踪，跑一次 durable 用例
  工作区就脏一处；建议 gitignore ＋ `git rm --cached`（**未做，等授权**）。
- 数据库迁移 `008` 尚未 apply 到生产库（迁移只在隔离库验过；apply 生产要单独授权）。
- 竞品链、尺寸链挂进排期前必须先造能力（manifest ＋ adapter ＋ 登记 ＋ 用例），
  `runtime/` 下的入口**不算能力**。
