# 架构落地实录 · 2026-09-19（夜）

**这份文件是什么**：`docs/architecture/EXTENSIBILITY-AND-DEPLOYMENT-PROPOSAL.md` §9 那张阶段表里
**当晚真正落地的部分**的逐条实施记录，含时间、背景、改了什么、影响范围、验证结果，以及
**明确没做的部分与原因**。目的是「以后出问题时能追溯，而不是重新推理一遍」。

**怎么读**：先看 §1 的对照表（哪些已完成、哪些没做），需要细节再看 §2 的逐条记录，
要查某个数字的出处看 §5 验证总账。**这份文件里每一句「已完成」后面都跟了一条可复跑的命令或一个数字**；
找不到命令或数字的句子，就不该被当成已完成。

---

## 1. 结论与对照表

当晚从提案的推荐顺序出发，落了 **6 个阶段**（S-0 / S-1 / S-2 / S-3 / S-6 / S-7），
**另有 4 个阶段没做**（S-4 / S-5 / S-8 / S-9），原因逐条写在 §7。

| 阶段 | 内容 | 状态 | 一句话判据 |
| --- | --- | --- | --- |
| S-0 | 文档同步与提案落点 | **已完成** | 4 份文档改动，提案 12 个相对链接全部可达 |
| S-1 | 实例登记 + 孤儿对账（BR-1/BR-2） | **已完成** | `runtime/browser-inventory.mjs` 对 7 个声明实例给出判决；17 条离线判据全绿 |
| S-2 | 一键起停（BR-3） | **已完成** | `scripts/start-all.mjs` / `stop-all.mjs`；`stop-all` 默认只打印；38 条离线判据全绿 |
| S-3 | 缺页自愈收进仓库 | **已完成** | 仓库外两个探针收编为 `runtime/shop-pages.mjs`，安全默认反转；8 条判据全绿 |
| S-4 | 二次导出一致性判据 | **未做** | 只有设计，链里没有实现（见 §7） |
| S-5 | 体检 L2/L3 | **未做** | 仍只有 L1 |
| S-6 | 常驻定时 + 诊断包 | **半完成** | 入口与注册脚本已建；**注册被本机黑名单挡住**；诊断包未做 |
| S-7 | 反向依赖守卫 | **已完成** | 双向白名单守卫 + 突变验证通过 |
| S-8 | lane 与并发 | **未做** | —— |
| S-9 | 形态 C 前置 | **未做**（明确非目标） | —— |

**验证总账**：`runtime` 套件 **644 → 701 全绿**；`skills --skill=sycm-alimama-daily-report` **171 全绿**；
两条关键判据做了突变验证（§5.3）。

**一句话风险**：明早能跑起来的前提是**先补页**（3 家店两个页面全缺），
而定时任务**还没挂上**（`schtasks.exe` 在本机黑名单里，注册得由人做）。

---

## 2. 逐条实施记录

### S-0 文档同步与提案落点 —— 2026-09-19 22:5x

- **背景**：提案要能被引用，先得让 `docs/architecture/README.md` 的边界规则容纳「提案类文件」；
  同时 `docs/ops/SYSTEM-OVERVIEW-AND-DEPLOYMENT.md` 的 §7 有三处状态已经与实现漂移。
- **改了什么**：
  - `docs/architecture/README.md`：新增第 7 行边界段（提案类文件规则：文件名带 `-PROPOSAL`、
    首段以「状态：提案（PROPOSAL）」开头、引用时必须带状态、批准后拆进 `decisions/NNNN-*`），
    交接包清单新增一行登记提案文件。
  - `docs/architecture/EXTENSIBILITY-AND-DEPLOYMENT-PROPOSAL.md`：新建（§0~§11）。
  - `docs/ops/SYSTEM-OVERVIEW-AND-DEPLOYMENT.md`：§7 的 M3 行补「同夜接进体检段 ⇒ 十一阶段」；
    M4 行从「未开始」改为「各完成一半」；偏差说明第 1 条从「体检段未接线」改为「体检的深度仍未到」。
- **影响范围**：只动文档，不动任何运行态。
- **验证结果**：`node D:/Retire/probe-live/md-link-check.mjs` → 提案 12 个相对链接全部 `ok`，
  README 6 个全部 `ok`，输出末行「全部链接可达」。

### S-1 实例登记 + 孤儿对账（Browser Broker 的 BR-1/BR-2）—— 2026-09-19 22:5x–23:0x

- **背景**：「这台机器上现在活着几个浏览器实例、分别是谁」这个事实**系统自己不知道**，
  一直靠仓库外探针人工盘点；换个人上手、换台机器就要重做一遍，而且做错了不报错。
- **改了什么**：新建 `runtime/browser-inventory.mjs`（358 行）与 `runtime/browser-inventory.test.mjs`（220 行）。
  三条设计约束：① 不新增第二份真相（声明表从 `runtime/browser-ports.mjs` 推导，不持久化）；
  ② 只读，不启动/不关闭任何进程；③ 「探针没读到」只报 `unconfirmed`，不判 `foreign`、不判 `missing`。
  判决分桶按**下一步做什么**划：`ready / proxy-missing / browser-missing / missing / foreign / unconfirmed`。
- **影响范围**：新增只读命令，不改任何既有行为。退出码：`0`＝全部就位；`1`＝有确定性的不对；`unconfirmed` 不停线。
- **验证结果**：
  - 离线判据 **17 条全绿**（含「读不出来绝不被判成 missing 或 foreign」「声明表只从登记表取」「无重复端口」）。
  - 真机只读跑 `node runtime/browser-inventory.mjs --listen` →
    **声明 7 个 / 就位 6 个 / 缺 1 个（竞品链：浏览器 9222 free、代理 3457 连不上）/ 无孤儿浏览器**
    （另有 48 个非浏览器监听未列出）。原文留档 `evidence/architecture-rollout-2026-09-19/inventory.txt`。
  - 开发过程中修了一个**有价值的红**：`--listen` 首次真跑吐出 48 条噪声（Windows 服务 135/139/445/5357、
    RPC 动态端口 49664+、数据库 3306/6379/5432）⇒ 判据从「在被监听」收紧为「CDP 能读出 Browser 产品名」，
    并补一条单测。**这种清单不会被读，只会训练人忽略它。**

### S-2 一键起停（Browser Broker 的 BR-3）—— 2026-09-19 23:0x–23:2x

- **背景**：`run-multi-shop-day.mjs` 已经是「一条命令跑完全链」，但**实例得先有人在**；
  而本项目进程绑会话（会话结束可能被回收），所以「起实例」必须也是一条命令、而且幂等。
- **改了什么**（6 个新文件）：
  - `runtime/launch-plan.mjs`（286 行）——起停共用的**唯一口径**。「哪个实例配哪两条启动脚本」
    写成显式表（不按 kind 拼文件名）；`INSTANCE_ENV_KEYS` ＋ `buildChildEnv` 负责清环境；
    `planInstanceStop` 是停机的纯判决；`matchInstances`/`onlyHelpText` 让 `--only` 收**可读名**。
  - `runtime/launch-plan.test.mjs`（217 行，**19 条判据**）。
  - `scripts/start-all.mjs`（204 行）——幂等起齐；判据是回头再盘一遍（用 S-1 的同一套探测），
    不 ready 就把该实例的日志尾巴打出来。
  - `scripts/stop-all.mjs`（180 行）——**默认只打印**，`--yes` 才真停；每个待杀进程都带证据。
  - `runtime/start-competitor-proxy.mjs`（25 行）——补上竞品链缺失的代理启动器
    （此前只能手打 `CDP_PROXY_PORT=… CDP_BROWSER_PORT=…`，端口靠人抄 ⇒ 抄错是**静默串店**）。
- **影响范围**：`start-all` 会真起进程（默认动手）；`stop-all` 默认不动任何东西。
  两者都**不重启**任何已存在的实例（`ready` 桶一律「已就位，不动」）。
- **验证结果**：
  - 19 条判据全绿；`runtime` 套件 667 → 691 → 701 全绿。
  - `node scripts/start-all.mjs --dry-run` → 7 个实例、6 个「已就位，不动」、1 个「两样都没有，起一整套」。
  - `node scripts/stop-all.mjs`（只打印）→ 6 个实例 × 2 个目标 = **12 个候选 pid**，每个都带证据：
    代理按「端口在听 ＋ 进程命令行是 `start-shop-proxy.mjs <店名>`」，浏览器按「CDP 自证 profile 一致
    ＋ 杀掉启动器 pid（连带整棵浏览器进程树）」。
  - **突变验证通过**（§5.3）：把 `PROJECT_BROWSER_PORT` 从清单里拿掉 → 判据红且点名；还原后哈希一致。

### S-3 缺页自愈收进仓库 —— 2026-09-19 23:0x

- **背景**：补页此前靠仓库外两个探针（`D:/Retire/probe-live/135-…` / `86-open-shop-pages.mjs`），
  其中 `86` **不带 `--dry-run` 就会真开页**。这是「同一件事两处实现」＋「默认值的失败方向朝危险侧」。
- **改了什么**：新建 `runtime/shop-pages.mjs`（214 行）与 `runtime/shop-pages.test.mjs`（112 行）。
  期望页面清单**与驱动同源**（`buildPagePlan()` 取自 `expectedPagesForShop()` / `expectedPagesForDailyBrowser()`）。
  **安全默认反转**：不带 `--open` 只盘点，不写。退出码 `0`＝每页恰好一个；`2`＝有缺口；`3`＝有多于一个需人决定。
  `skills/sycm-alimama-daily-report/references/sop.md` §13 的补页段改成指向仓库内工具并说明这次反转与理由。
- **影响范围**：新增只读命令；`--open` 会动存活浏览器（**当晚没有执行**）。
- **验证结果**：8 条判据全绿；真机只读盘点（原文 `evidence/architecture-rollout-2026-09-19/shop-pages.txt`）→
  **6 个后台，5 个有缺**：商家浏览器缺飞书底单页；盖文淘宝／盖文天猫各缺阿里妈妈报表页；
  里可林淘宝／网林天猫／科塔淘宝**两页全缺**。

### S-6 常驻定时（半完成）—— 2026-09-19 23:2x–23:3x

- **背景**：SOP §13 说「任务计划到点敲**一条**命令」，但真实要做的有两件（保实例在 ＋ 跑全链）。
  两件都塞进 `/TR` 由 shell 拼，三个月后没人能说清当时跑的是什么。
- **改了什么**：
  - `runtime/daily-job-plan.mjs`（105 行）+ `runtime/daily-job-plan.test.mjs`（89 行，**10 条判据**）
    ——到点跑什么、默认值是什么，全在这里且被断言。
  - `scripts/run-daily-job.mjs`（128 行）——**唯一入口**：先 `start-all`，再跑全链；输出落一份 `job.log`。
  - `scripts/schedule-install.mjs`（168 行）——注册到任务计划；**默认只打印**，`--install` 才真挂；
    `--time` 早于 `11:20` 当场拒掉（`11:20` 是 sop §13 实测的 CSV 静止点）。
- **影响范围**：新增命令；`run-daily-job.mjs` 默认会真写飞书（它是定时任务的职责）。
  **告警默认 `--notify-print`**：文案落日志、一次投递都不发生；要真发飞书必须显式 `--notify`。
- **验证结果**：
  - 10 条判据全绿；`node scripts/run-daily-job.mjs --print` 打印出的两条命令与预期逐字一致。
  - `--notify --notify-print` 同时给会被当场拒掉（驱动那边 `--notify-print` 会赢，
    「我要发飞书」这层意图会被**静默丢掉**）。
  - **硬约束（重要）**：本机把 `schtasks.exe` 列进了安全策略的程序黑名单，`--install` 与 `--query`
    在我这边**都执行不了**。脚本会如实报「**读不出来**」而不是「没挂」——
    后者是**假阴性**（任务可能好端端挂着）。实测证据：`spawnSync` 返回 `error.code === 'EPERM'`、
    无输出、退出码为 null。原文 `evidence/architecture-rollout-2026-09-19/schedule-query-blocked.txt`。
  - **所以定时任务目前是「入口已建、注册待你来做」**，三条路径见 §9。

### S-7 反向依赖守卫 —— 2026-09-19 23:0x–23:2x

- **背景**：`skills/` 与 `runtime/` 是**双向**依赖，实测规模远超此前笔记的估计。
  后果不是「不好看」，而是**交付形态被锁死**：任何一条链都不能靠「只拷 skills/」跑起来。
- **改了什么**：
  - `runtime/arch-boundary-scan.mjs`（85 行）——跨目录依赖的**唯一测量口径**（守卫与探针共用）。
  - `runtime/arch-boundary.test.mjs`（135 行）——双向白名单守卫，`added` 与 `removed` 都必须为空。
  - `docs/architecture/EXTENSIBILITY-AND-DEPLOYMENT-PROPOSAL.md` D3 记下这个结论。
- **影响范围**：新增守卫；**纠正了一条错误笔记**：`runtime → skills` 不是「约 10 处」而是
  **37 个文件（32 个生产）**；`skills → runtime` 是 **35 个文件（18 个生产）**。
- **验证结果**：3 条判据全绿（两个方向各一条 ＋ 「守卫本身是活的：扫到 >200 个 .mjs」）。
  **突变验证通过**（§5.3）：注入一条 `import '../skills/…'` → 守卫红且点名；
  还原后 `sha256` 与基线逐字节一致。**这次突变验证本身发现了一个真 bug**：第一版扫描器只认
  `from '…'` 与 `import('…')`，**漏了副作用 import `import '…'`** —— 注入后判据全绿而依赖已经加上了。

---

## 3. 决策记录（承接提案的 D1–D7，从 D-08 续号）

每条五段：决策 / 为什么 / 否掉的替代 / 代价 / 何时重审。

**D-08 起停共用一个计划模块，而不是两个脚本各写一份清单**
- 为什么：起与停必须作用在**同一组**目标上。两份清单迟早出现「起的时候知道 7 个、停的时候只认 6 个」，
  第 7 个会永远活着，且没有任何一处会报错。
- 否掉的替代：`start-all` / `stop-all` 各自内联自己的实例表（少一个文件，但两处会漂）。
- 代价：多一个模块；改起停口径时要同时想到它对两侧的影响（这正是要的）。
- 何时重审：出现第二种「起法」（例如托盘程序）时 —— 那时计划要能表达「谁来起」。

**D-09 起默认动手、停默认只打印**
- 为什么：不是「起比停安全」，而是**错误的代价落在哪一边**。起错了＝多一个连不上的进程，看得见、能停；
  停错了＝别人的活进程没了（项目最高优先级纪律，不可撤销）。
- 否掉的替代：两侧都默认只打印（安全，但定时任务没法用）；两侧都默认动手（危险且不可撤销）。
- 代价：两个脚本的默认值不对称，得靠文档和注释解释清楚（已写进两个文件的头部）。
- 何时重审：如果将来有了「回滚停」的能力（能确定性地把停掉的实例原样起回来），可以重新评估。

**D-10 起子进程前，把「身份类」环境变量全部清掉**
- 为什么：这些启动器都用 `||=` 取默认值（为「临时换端口排查」留的口子）。如果 shell 里残留一个
  `PROJECT_BROWSER_PORT`，一键起齐会把**每一家店都指向同一个端口** —— 每家店的启动器都 READY、
  一键起齐报「全部就位」，而实际只有一台浏览器。**这种故障的表现是全绿。**
- 否掉的替代：信任调用方的环境干净（不可验证）；不用 `||=`（会破坏排查时的临时覆盖能力）。
- 代价：`INSTANCE_ENV_KEYS` 是一份需要维护的清单（漏一个就等于少清一个）⇒ 补了一条判据盯住它。
- 何时重审：新增启动器读取新的「身份类」变量时（那条判据会红）。

**D-11 停机必须有正面证据，否则拒停**
- 为什么：这台机器上有别的项目在跑。杀错是不可撤销的。三类证据各证不同的事，不许互相顶替：
  浏览器的 profile（CDP 自报）、代理的命令行（认得出启动脚本与店名）、启动器 pid（父子关系）。
- 否掉的替代：「尽力而为」地停（凭端口在听就动手）；用 pidfile（第二份真相，重启即陈旧）。
- 代价：有些情况会拒停并要求人处理（例如端口在听但读不出 profile）。**这是设计目标，不是缺陷。**
- 何时重审：如果出现「大量拒停且都是同一原因」，说明判据本身需要改（而不是放宽）。

**D-12 定时入口收敛成一个 `/TR`，告警默认只落日志**
- 为什么：`/TR` 里塞两条 shell 拼的命令，三个月后没人能说清到点跑的是什么；而告警的默认值
  决定了「会不会在没人的时候真发飞书」——默认必须是安静。
- 否掉的替代：`/TR` 里直接 `A & B`（省一个文件，但无法回溯、也没法断言默认值）。
- 代价：多一层进程（`run-daily-job` 的退出码＝链的退出码，`start-all` 只记录不阻断）。
- 何时重审：接进 `sop-runtime` 的排期/幂等体系时（那时「该不该跑」会有另一个权威），
  或需要「多台机器」时。

**D-13 「跑不起来」不许报成「没挂」（假阴性与假阳性都要防）**
- 为什么：`schtasks` 被本机黑名单挡住时 `spawnSync` 以 `EPERM` 失败、无输出、退出码 null。
  若把它当成「查询失败」就报「没挂」，那是一条假阴性：任务可能好端端挂着。
  这与项目里反复出现的那条纪律同源：**读不出来 ≠ 缺失**。
- 否掉的替代：`status !== 0` 一律报「没挂」（代码更短，但会骗人）。
- 代价：多一个退出码 `3`（＝读不出来）与一段提示文案。
- 何时重审：黑名单被调整后（那时「读不出来」这一档会自然消失，但不要删掉判据）。

**D-14 收编仓库外工具时反转安全默认（不带 `--open` 只盘点）**
- 为什么：这一步会动存活浏览器，而「忘了加 `--dry-run`」比「忘了加 `--open`」容易得多。
  默认值的失败方向必须是「什么都没发生」。
- 否掉的替代：保持与旧探针逐字一致（对老用户友好，但把危险默认带进仓库）。
- 代价：老命令不能直接复制粘贴（SOP §13 已同步改掉，并写明这次反转的理由）。
- 何时重审：不需要重审（这是一条单向的安全改进）。

**D-15 扫描口径抽成唯一实现，守卫与探针共用**
- 为什么：守卫与一次性盘点脚本都要报同一个数，各写一份迟早给出两个数 ——
  而「同一个事实两处实现」正是这套系统一直在治的病，**守卫自己先犯就没说服力**。
- 否掉的替代：守卫内嵌一份、探针内嵌一份（省一次 import，但会漂）。
- 代价：多一个模块；好处是扫描器改了（例如补上第三种 import 形态）两处会一起生效。
- 何时重审：不需要。

---

## 4. 变更清单

新增 15 个文件（2526 行）＋ 修改 4 个文件（1 个新建）：

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `runtime/browser-inventory.mjs` | 358 | 实例「声明 vs 存活」对账；进程表（父子关系）读法 |
| `runtime/browser-inventory.test.mjs` | 220 | 17 条判据 |
| `runtime/shop-pages.mjs` | 214 | 补页/盘点（`--open` 才写） |
| `runtime/shop-pages.test.mjs` | 112 | 8 条判据 |
| `runtime/arch-boundary-scan.mjs` | 85 | 跨目录依赖的唯一测量口径 |
| `runtime/arch-boundary.test.mjs` | 135 | 双向白名单守卫 |
| `runtime/launch-plan.mjs` | 286 | 起停共用的计划与判决 |
| `runtime/launch-plan.test.mjs` | 217 | 19 条判据 |
| `runtime/daily-job-plan.mjs` | 105 | 定时任务跑什么、默认值 |
| `runtime/daily-job-plan.test.mjs` | 89 | 10 条判据 |
| `runtime/start-competitor-proxy.mjs` | 25 | 补上竞品链缺失的代理启动器 |
| `scripts/start-all.mjs` | 204 | 一键起齐（幂等） |
| `scripts/stop-all.mjs` | 180 | 停机（默认只打印） |
| `scripts/run-daily-job.mjs` | 128 | 定时任务的唯一入口 |
| `scripts/schedule-install.mjs` | 168 | 注册到任务计划（默认只打印） |
| `docs/architecture/EXTENSIBILITY-AND-DEPLOYMENT-PROPOSAL.md` | 新建 | 架构提案（D1–D7 ＋ S-1~S-9） |
| `docs/architecture/README.md` | 改 | 边界段容纳提案类文件 ＋ 登记 |
| `docs/ops/SYSTEM-OVERVIEW-AND-DEPLOYMENT.md` | 改 | §7 三处状态漂移 |
| `docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md` | 改 | §3 三层状态的当晚更新 |
| `skills/sycm-alimama-daily-report/references/sop.md` | 改 | §13 补页口径收进仓库、定时入口与实测约束 |
| `evidence/architecture-rollout-2026-09-19/*` | 新建 | 8 份当晚实测原文 |

---

## 5. 验证总账

### 5.1 套件

| 命令 | 结果 |
| --- | --- |
| `node scripts/run-test-suite.mjs runtime --concurrency=1` | **701 / 701 通过，exit 0**（当晚起点 644） |
| `node scripts/run-test-suite.mjs skills --skill=sycm-alimama-daily-report --concurrency=1` | **171 / 171 通过，exit 0** |
| `node D:/Retire/probe-live/md-link-check.mjs` | 提案 12 个 ＋ README 6 个相对链接全部可达 |

### 5.2 真机只读实测（原文留档在 `evidence/architecture-rollout-2026-09-19/`）

| 命令 | 结论 |
| --- | --- |
| `node runtime/browser-inventory.mjs --listen` | 声明 7 / 就位 6 / 缺 1（竞品链）/ **无孤儿浏览器** |
| `node runtime/shop-pages.mjs` | 6 个后台、**5 个有缺页**（明细见 S-3） |
| `node scripts/start-all.mjs --dry-run` | 6 个「已就位，不动」＋ 1 个「起一整套」 |
| `node scripts/stop-all.mjs` | 12 个候选 pid，每个都带证据；**没有执行任何停止** |
| `node scripts/run-daily-job.mjs --print` | 两条命令与预期逐字一致 |
| `node scripts/schedule-install.mjs` | 打印出 `/TR` 与等价 schtasks 调用 |
| `node scripts/schedule-install.mjs --query` | **3 ＝ 读不出来**（`schtasks.exe` 被黑名单拦），刻意不报「没挂」 |

### 5.3 突变验证（绿灯不算证据）

两条关键判据都做了「改坏 → 确认红且点名 → 还原 → 逐字节一致」：

| 判据 | 探针 | 结果 |
| --- | --- | --- |
| 跨目录依赖守卫能拦住悄悄新增的依赖 | `D:/Retire/probe-live/mutate-arch-boundary.mjs` | 基线 exit 0 → 注入后 **exit 1 且点名 `runtime/notify-feishu.mjs`** → 还原后 exit 0、sha256 一致（`82be267e3560bebe…`） |
| 身份类环境变量漏清会被判据抓住 | `D:/Retire/probe-live/mutate-launch-plan-env.mjs` | 基线 exit 0 → 摘掉 `PROJECT_BROWSER_PORT` 后 **exit 1 且点名到该键** → 还原后 exit 0、sha256 一致（`dcb666ac7ac63e7d…`） |

---

## 6. 单点真相清单（本轮之后）

「确保各处引用一致、不再重复冲突」在代码层的落点：每个事实只有一个来源，其余都是引用。

| 事实 | 唯一来源 | 谁引用它 | 守卫 |
| --- | --- | --- | --- |
| 端口 / 浏览器身份 / 店铺实例 / 路线表 | `runtime/browser-ports.mjs` | 启动器、代理、驱动、体检、实例对账、起停计划 | `browser-ports.test.mjs` 扫 `runtime/` `skills/` `scripts/` 三处的端口字面量 |
| 「应该活着哪些实例」 | `runtime/browser-ports.mjs`（经 `buildDeclarationPlan()` 推导） | `browser-inventory` / `start-all` / `stop-all` | `browser-inventory.test.mjs`（声明表不许另抄一份） |
| 「哪个实例配哪两条启动脚本」 | `runtime/launch-plan.mjs` 的 `LAUNCHERS` | `start-all` / `stop-all` | `launch-plan.test.mjs`（脚本必须真实存在） |
| 跨目录依赖清单 | `runtime/arch-boundary-scan.mjs` | 守卫 ＋ 仓库外盘点探针 | `arch-boundary.test.mjs`（双向白名单不许腐烂） |
| 期望页面清单 | 驱动（`expectedPagesForShop` / `expectedPagesForDailyBrowser`） | `runtime/shop-pages.mjs` | `shop-pages.test.mjs`（同源 ＋ URL 形态） |
| 飞书 base / 表 id | `runtime/feishu-targets.mjs` | 推送段、回读段 | 既有判据 |
| 定时跑什么 | `runtime/daily-job-plan.mjs` | `run-daily-job` / `schedule-install` | `daily-job-plan.test.mjs`（三条不变量） |
| 触发时刻 | `sop.md` §13（`11:40`；`11:20` 是实测静止点） | `schedule-install.mjs` 的默认值与拒绝判据 | 脚本里对 `< 11:20` 的 upsert 拒绝 |

**本轮消掉的两处重复**：① 竞品链代理的启动方式（从「注释里的手打命令」变成 `start-competitor-proxy.mjs`）；
② 补页工具（从仓库外两个探针变成 `runtime/shop-pages.mjs`，SOP §13 同步改指）。

---

## 7. 未做项与原因（照实记，别把计划读成现状）

| 项 | 为什么没做 | 要动它需要什么 |
| --- | --- | --- |
| **S-4 二次导出一致性判据** | 它要在链里加一个阶段（同目标日再导一份推广、解出的 CSV 与手上那份逐字节相同才写）。**真正的验证必须跑一次真实的二次导出**，而那会动存活浏览器并产生两次下载 —— 当晚没有授权，也不该在没验证的情况下把它接进写路径。所以它的**设计**留在提案 §9 S-4 与 sop §13，**代码里没有**。⇒ 在它实现之前，**触发时刻本身就是唯一的安全边界** | 一次真实的二次导出（要跑采集段） |
| **S-5 体检 L2/L3** | 需要有判据的会话层与端到端层，属于新判据开发 | 单独的开发窗口 |
| **S-8 lane 与并发** | 当前是「按店铺串行」，并发会引入 19022 上飞书页的竞争点（一条链跨两个浏览器）。在串行还没稳定的阶段上并发，会把两类问题混在一起 | 串行跑稳一段时间之后 |
| **S-9 形态 C 前置** | 提案里就标注为明确非目标 | —— |
| **诊断包（P0-6）** | 排在定时之后；先把「能按时跑」做出来 | 下一个窗口 |
| **客户端容量文档修订** | 本轮两次口径的资源实测数字（6416 MB / 13 页签 / profile 9076 MB / 本机余量 7.3 GB）还没并进 `docs/ops/CLIENT-MACHINE-CAPACITY.md` | 20 分钟 |
| **冗余清理（机械冗余）** | 只做了**语义**去重（§6 的两处 ＋ 文档同步），**没有删任何文件**。`runtime/` 下的一次性脚本与历史产物目录只是候选，删除属于不可逆动作，按纪律要点名批准 | 你点头后分批做（建议每批 ≤10 个并先出清单） |

---

## 8. 明天验收的操作顺序（照着做即可）

```bash
# 0) 先看现状（只读，全绿才往下）
node runtime/browser-inventory.mjs --listen

# 1) 补页（会动存活浏览器；先看要开什么，再真开）
node runtime/shop-pages.mjs          # 只读：谁缺哪一页
node runtime/shop-pages.mjs --open   # 真开（只开缺的，一律钉住）
node runtime/shop-pages.mjs          # 复核：应当每个后台都「恰好一个」

# 2) 起齐实例（幂等；已就位的一个都不碰）
node scripts/start-all.mjs

# 3) 干验证一次：只读、不写、不投递
node scripts/run-daily-job.mjs --print
node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date yesterday --notify-print

# 4) 挂定时（默认只打印；注册见 §9 第 1 条）
node scripts/schedule-install.mjs
```

每一步的退出码：`browser-inventory` 0＝全就位；`shop-pages` 0＝每页恰好一个 / 2＝有缺口 / 3＝有多于一个；
`start-all` 0＝目标全就位；`run-daily-job` 非 0＝链失败；`schedule-install` 3＝读不出来。

---

## 9. 需要你点头的五件事

1. **定时任务怎么挂**（本机 `schtasks.exe` 在黑名单里，我这边执行不了）——
   推荐：先在「安全中心 → 命令安全 → 程序黑名单」里移出 `schtasks.exe`，然后跑
   `node scripts/schedule-install.mjs --install`；不方便改黑名单就用 `taskschd.msc` 手工挂
   （`node scripts/schedule-install.mjs` 会打印要填的程序与参数）；两条都不想动就用平台定时任务每天跑
   `node scripts/run-daily-job.mjs` 兜底。
2. **现在补页吗**——5 个后台缺页（3 家店两个页面全缺），这是明早能跑起来的硬前提。
   推荐：现在跑 `node runtime/shop-pages.mjs --open`。不说就等你明天过来再跑（我不擅自动存活浏览器）。
3. **第一次定时跑要不要真发飞书**——推荐先按默认（`--notify-print`，文案落日志、不投递）跑一两天，
   确认告警文案没问题再改成 `--notify`。
4. **要不要现在把竞品链也起起来**——`start-all` 现在只会补它缺的那一套（9222/3457），
   不影响已经就位的 6 个。推荐：不急，竞品链这一轮验收用不到。
5. **冗余清理要不要现在做**——推荐先不动：我出一份候选清单（带大小与「为什么可以删」），你圈定后我分批做。


---

## 10. 09-19 深夜第二轮：授权「全部杀了重跑」＋ 三个缺陷（2026-09-19 23:44 ~ 23:55）

### 10.1 背景与授权

用户 2026-09-19 23:44 原话：「**给你权限，按你推荐的来，本周的周报链也可以跑了，还有我发现现在还有七个浏览器进程全部杀了重跑**」。
这条同时解除了 §9 第 2、4 条的等待（补页、起实例），并明确授权停掉全部实例。

### 10.2 动手前的只读盘点（没猜）

- `node runtime/browser-inventory.mjs --listen` → 声明 7、就位 6（缺竞品链）、无登记表解释不了的浏览器。
- 自写只读探针数了**全部** msedge 顶层进程：9 个。其中
  - 6 个是我们的（19022 / 19031 / 19032 / 19033 / 19034 / 19035，profile 逐一自证）；
  - 2 个是系统组件（GameViewer、Windows CBS 的 `msedgewebview2.exe`）；
  - 1 个是 `msedge.exe --no-startup-window`（无 profile、无调试端口）= **Edge 自己的后台进程**。
- 结论：用户说的「七个」= 我们的 6 个 ＋ 这 1 个后台进程。**后者一个都没动**，也没被算进停机计划。

### 10.3 停机与重启

- 先打印计划核对（`stop-all` 只打印模式）：6 个实例 × (启动器 + 浏览器 + 代理) = 12 个 pid，每条都带正面证据。
- `--yes` 执行：12 个全部停掉，停后 CDP 回读全部 `missing`。
- 留证：`evidence/browser-restart-2026-09-19/stop-all-print.txt`、`stop-all-executed.txt`。

### 10.4 三个缺陷（都是「排练全绿、真跑才现」）

#### 缺陷 1（P0）：start-all 真跑必崩 —— 从条目上读了一个不存在的字段

- **现象**：`node scripts/start-all.mjs --timeout 60` 立刻
  `TypeError: Cannot read properties of undefined (reading 'find')` at `start-all.mjs:145`。
- **根因**：它调的是 `buildDeclarationPlan()`，而那个函数的条目上**没有** `launch` 字段
  （`launch` / `stopOrder` 是 `buildFullPlan()` 补的）⇒ `item.launch.find(...)` 必崩。
- **为什么一直没被发现**：唯一的验证方式是 `--dry-run`，而排练模式只走打印分支，
  压根不进 spawn 循环。**排练路径全绿 ≠ 真路径能跑。**
- **修**：改用 `buildFullPlan()`。
- **判据**：`runtime/start-all-launch-source.test.mjs`（3 条）。其中一条是**数据层**的：
  六种判决（含未知判决）下 `selectActions` 要起的每个角色，都必须能在该条目自己的 `launch` 里找到
  —— 这正是崩溃的直接形状；另有一条把「`buildDeclarationPlan` 的条目不带 `launch`」这个差别本身钉住。
- **突变验证**：把 `buildFullPlan()` 改回 `buildDeclarationPlan()` → 退出码 1、点名到期望的那一条、还原后 sha256 一致。

#### 缺陷 2（P1）：stop-all 的「停后还活着吗」用的是**杀之前**的快照

- **现象**：同一次执行的输出里同时出现两句互相矛盾的话 ——
  `停后盘点到:missing`（CDP 端口回读，浏览器确实没了）
  `（这些 pid 仍在进程表里：33812, 32464）`（拿循环开始前那份进程表过滤出来的）
- **根因**：`stillAlive` 拿 `processRows`（杀之前读的那份）去 filter ⇒ **每一个** pid 都会被报成「仍在」。
  与「HTTP 200 假成功」同一形态：回读必须回读到**当下**。
- **修**：停后重读一次进程表；读不出来时记 `null`（＝没有证据，不参与判决），
  并把 `stillAlive` 计入退出码（「说停掉了其实还活着」不再退出 0）。
- **判据**：`runtime/stop-all-release-readback.test.mjs`（4 条，扫源码、复用 arch-boundary 的 stripComments）。
- **突变验证**：改回快照过滤 → 红且点名；还原 sha256 一致。

#### 缺陷 3（P1）：进程表里的中文命令行是乱码 —— 一条证据永久为假，且不报错

- **现象**：店铺代理的命令行读回来是 `node …\start-shop-proxy.mjs ������è`。
- **根因**：那个查询用的子 shell 在 stdout 被重定向时按**控制台代码页**（本机 GBK/936）写，
  而读侧按 UTF-8 解码 ⇒ 任何中文参数都变成 `�`。
- **影响**：stop-all 里「店铺代理还要认得出店名」这条证据**永远为假**；
  而它仍会凭「命令行里有 start-shop-proxy.mjs」放行 ⇒ 症状是**守卫比设计的弱**，没有任何一处会报出来。
- **修**：查询前强制 stdout 用 UTF-8。
- **实测对照**：修复前 `start-shop-proxy.mjs ������è` / `�����Ա�`；
  修复后 `start-shop-proxy.mjs 网林天猫` / `里可林淘宝` / `科塔淘宝` / `盖文淘宝` / `盖文天猫`（5/5 认得出）。
- **消费端证据**：`stop-all` 打印里出现 `端口在听、进程命令行是 start-shop-proxy.mjs 里可林淘宝`
  （修复前那条只有脚本名，没有店名）—— 见 `evidence/browser-restart-2026-09-19/stop-all-print-after-fix.txt`。
- **判据**：`runtime/browser-inventory.test.mjs` 第 18 条（钉住那句强制 UTF-8 的指令）。
- **突变验证**：摘掉那句话 → 红且点名；还原 sha256 一致。

### 10.5 新增：让实例活过「发起它的那条命令」

- **根因（实测，与沙箱无关）**：命令结束时被回收的是**整棵进程树** —— 只要一个进程还挂在
  发起它的那条命令的祖先链上就会被带走。而 `start-all` 的设计是「起完就退」（定时任务要它这样），
  于是它起的 7 个浏览器 + 7 个代理在命令结束那一刻全部消失。
- **对照实验**（`D:/Retire/probe-live/spawn-diag.mjs` 等）：同一条命令里，
  一个**已被父进程抛弃**的 node 心跳进程活得好好的（3 秒 3 个 tick、后续复查 34 个 tick），
  而 start-all 起的实例全没。单独用 `detached + unref` 不足以活下来 —— 差别在「父进程还在不在」。
- **新增 `scripts/start-all-hold.mjs`**：把 start-all 起完后的进程**托住**（自己不退出），
  参数原样透传给 start-all；start-all 非 0 退出时**不进入托住状态**（托一个空壳会被读成「实例在跑」）。
- **刻意不做成 start-all 的默认值或开关**：定时任务路径由 `scripts/run-daily-job.mjs` 驱动，
  start-all 必须能自己退出，否则链走不到下一步。行为差异写进脚本头部注释，名字也直说它干什么。
- **生产路径不受影响**：计划任务不在任何 shell 的命令树里，本来就不会被回收。
- **实测**：`node scripts/start-all-hold.mjs --timeout 60` → 7 个实例全部 `ready`；
  独立回读 `browser-inventory` → **全部 7 个就位**；探针看到 7 个浏览器 + 7 个启动器 + 7 个代理，
  启动器都挂在托住进程下。

### 10.6 补页（§9 第 2 条，已执行）

`node runtime/shop-pages.mjs --open` → 6 个后台、每个期望页面**恰好一个**，退出码 0；
再跑一次只读盘点复核同样结论。留证 `evidence/browser-restart-2026-09-19/shop-pages-open.txt`。

### 10.7 定时注册：仍被本机黑名单挡住（当晚复现）

`--query` 与 `--install` 都是 **exit 3**，脚本如实报「**读不出来**」（不是「没挂」）并给三条可行路径。
`schtasks.exe` 被安全策略拦这件事**无法从命令内绕过**（系统明确提示不要用别的 shell 或脚本绕）。
⇒ 注册这一步只能由人做，见 §9 第 1 条。留证 `evidence/browser-restart-2026-09-19/schedule-*.txt`。

### 10.8 周报链的现状（当晚查证，未写任何东西）

用只读接口探针（`D:/Retire/probe-live/probe-weekly-state.mjs`）读了竞品 base 与关键词库 base：

| 事实 | 读数 |
| --- | --- |
| 竞品 base | 11 张表；周表 7 张（08-23 起每周期一张） |
| 本周期竞品周表 | `竞品周_2026-09-13_2026-09-19` `tbllWI45sK0DfHpr` → **1417 行（已存在且完整）** |
| 本周期问题库表 | `问题库_2026-09-13_2026-09-19` → 已建 |
| 竞品历史总表 V1 | 5763 行 |
| 问题主库 | 2073 行 |
| 关键词库 base | 8 张表；最新一张是 `关键词分析 V1（2026-09-12）`；最近一次 `pre-ai-manifest` 停在 2026-09-13T01:38Z |

结合 `docs/ops/WEEKLY-SUPERVISION-2026-09-13_2026-09-19.md` 与
`docs/ops/WEEKLY-RUN-2026-09-13_2026-09-19-FINDINGS.md`：**本周期（09-13~09-19）的竞品周更第 1~8 步
全部有终态**（采集 09-15、导入 1417 行、属性写回、FAQ 发布、历史总表重发布都已 APPLIED_AND_VERIFIED）。
⇒ 同一周期**再跑一次不会成功**：周表名已存在，链会按设计 fail-closed（这是保护，不是故障）。
所以「周报链」指哪一条、要不要现在跑，需要一句确认（见回复里的问题 1）。

### 10.9 决策记录（续 D-16 ~ D-19）

| 编号 | 决策 | 一句话理由 | 代价 / 何时重审 |
| --- | --- | --- | --- |
| D-16 | 在 agent 会话里起实例要用「托住」而不是「起完就退」 | 命令结束会回收整棵进程树，起完就退＝白起 | 多一个常驻进程；定时任务路径不用它，等真机定时跑通后复审 |
| D-17 | 停后判存活必须**当场重读**进程表 | 用杀之前的快照会让每个 pid 都报「仍在」，与旁边的 CDP 回读自相矛盾 | 多一次读表开销（可忽略）；读不出来时必须如实标「没有证据」 |
| D-18 | 那个查询必须强制 stdout UTF-8 | 本机控制台是 GBK，中文参数会读成乱码；乱码不报错，只让一条证据永远为假 | 无；若哪天换到英文/UTF-8 控制台也仍然正确 |
| D-19 | **排练路径不能当作真路径的证据** | 当晚三个缺陷里有两个（缺陷 1、2）都是「dry-run 全绿、真跑才现」 | 以后新增带副作用的脚本，必须在真机上至少跑通一次并留证，不能只跑排练 |

### 10.10 本轮的验证总账

- `runtime` 套件：**701 → 709 通过 / 0 失败**（新增 `start-all-launch-source.test.mjs` 3 条、
  `stop-all-release-readback.test.mjs` 4 条、`browser-inventory.test.mjs` +1 条）。
- 三条突变验证全部通过（均可复跑，还原后 sha256 一致）：`mutate-start-stop-guards.mjs`、
  `mutate-encoding-guard.mjs`。
- 真机只读证据：实例盘点前后各一份、补页前后各一份、停机计划与执行各一份、定时注册两份。
- 未被验证的（如实记）：`start-all-hold.mjs` 托住的进程**能否活过一次会话结束**，当晚没验过
  （上一轮那批活了，是因为它们属于一个一直没结束的后台任务）。

