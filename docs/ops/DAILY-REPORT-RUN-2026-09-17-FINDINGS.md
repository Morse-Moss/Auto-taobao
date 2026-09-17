# 运营日报 2026-09-16 全链实跑记录（2026-09-17）

- 目标：按 `skills/sycm-alimama-daily-report/` 真实跑一遍完整日报链（生意参谋 + 阿里妈妈 + 飞书），带证据。
- 目标日：**2026-09-16**（`new Date()` 判定为「昨日」）。
  注意：本次会话提示里的 `2026-09-16 15:20` 是上一次会话的残留时间戳，真实时钟是 09-17 08:00。
  本项目规则「日期以 `new Date()` 为准」在这次直接改变了目标日 —— 若按提示走会去写一个已经存在的日期。
- 证据目录：`evidence/daily-report-2026-09-16/`

## 0. 结论

1. 2026-09-16 的店铺 + 推广数据已写入「各店铺日报 副本 / 总数据来源底单」：记录数 **6 → 7**，`recordId recvvqPBEP0cMe`，239 个写入字段逐字段回读一致，场景 371/372、统计日期 2026-09-16。
2. 询单量已回填到「各店铺数据日报」：`询单量 13` / `同层同行询单量 39`（预设模式，同行基准行在）。同参数复跑返回 `ALREADY_VERIFIED`。
3. 全链没有出现缺陷级问题；本轮的价值在**三处交互陷阱**（已写进 `references/sop.md`）与**一处环境偏离**（见 §3）。

## 1. 执行序列与关键回执

| 步 | 动作 | 结果 |
| --- | --- | --- |
| 1 | 起日报浏览器 `start-daily-report-browser.mjs` | **失败**：同 profile 已有实例在跑，见 §3 |
| 1b | 代理按登记表起在 `19023`，`CDP_BROWSER_PORT=9223` | `/health` → `connected:true`、`browser.id=edge-daily-report`、`chromePort:9223` |
| 2 | `date-picker.mjs --site alimama --date 2026-09-16` | `APPLIED`，回显 `昨日` → 解析 2026-09-16，5 个筛选断言全过 |
| 2b | `date-picker.mjs --site sycm --date 2026-09-16` | `APPLIED`，`统计时间 2026-09-16`（动作前已是该值 → 也说明页面被上次运行留在正确位置） |
| 3 | 推广报表：下载报表 → 确定 → 下载任务管理 → 下载 | `营销场景报表_20260917_080428.zip`；自证 71 列 / 371·372 / 内部日期 09-16 |
| 4 | 店铺报表：自助分析 → 公共空间 → 日报 → 预览 → 下载报表 | `日报_20260917_…xlsx`；自证单 `data` sheet / 119 列 / 30 行 / 09-16 唯一一行 |
| 5 | 导入 dry-run | `DRY_RUN_READY`，底单 6 行、无 09-16 重复行、265 可见字段、239 写入字段 |
| 6 | 导入 commit | `COMMITTED_AND_VERIFIED`，`derivedReadbackAttempts:3` |
| 7 | 询单回填 commit | `COMMITTED_AND_VERIFIED`，`13 / 39` |
| 8 | 幂等复跑 | `ALREADY_VERIFIED` |
| 9 | 独立回读（不走脚本自证） | 底单 7 行；询单 `2026-09-16 / 盖文天猫 → 13 / 39` |

## 2. 本轮新发现的三处交互陷阱

都属「点击/查找静默失效，但不报错」，与 09-14 那轮记的三条同类；已写进 `references/sop.md`：

1. **文案尾部带 iconfont 私有区字符。** 阿里妈妈侧栏的 `下载管理` 实际是 `下载管理` + `U+E617`，`textContent === '下载管理'` 命中 0 个，读起来像「元素不存在」。排查手法：把命中文本逐字符打 `codePointAt(0)`。
2. **侧栏是固定高度的独立滚动容器。** 窗口 `window.scrollTo` 带不动它，`下载管理` 永久停在视口下方（视口 691，它在 y≈712），真实鼠标点击落空。要滚它自己的滚动祖先；更省事的是直接导航子项 `href` ＝ `#!/report/download-list`。
3. **ZIP 压缩长度要读中央目录。** 流式生成的 ZIP 本地头里压缩长度是 0、真值在 data descriptor 里，按本地头切会报 `unexpected end of file`（第一次解析就踩到了）。

另外一条口径提醒：店铺 xlsx 的文件名里那个哈希**随报表定义走、不随内容变**（09-16 与 09-17 两次下载哈希相同），不能拿文件名判断是否新数据，必须读内部 `统计日期` 列。

## 3. 环境偏离（未做任何进程操作）

日报浏览器这次没有用 `19022`，而是复用了上一次遗留的实例 —— 它跑在迁移前的旧端口 **9223**（profile 与账号都对）。原因是 Edge 按 `user-data-dir` 单例：新起的进程会把请求交给已有实例后立即退出（`msedge exited code=0`），新端口上永远不会有调试端点。

处置：**没有杀任何进程**。代理按登记表起在 `19023`（脚本只认这个），只把内部那一跳用 `CDP_BROWSER_PORT=9223` 指到活着的浏览器。代价是登记表的 `dailyReportBrowser=19022` 与本轮实际用的 9223 不一致；下次干净重启后两者才会重新一致。

顺带发现 `3458` 上还留着上次的旧代理（这也是被迁移掉的一对端口）。这两处都属于「历史遗留实例没退」，不是配置错误。

## 4. 三条待决策项的解释（2026-09-17 补）

按「指什么 / 现在缺什么 / 不做的后果 / 做了的收益」重写一遍。

### 4.1 D1 固化两个只读校验器 —— 准确的说法是「缺时效校验」

> **本节有一处已被纠正**：下面说的「推广 ZIP 完全不校验内部日期」是**错的** ——
> `daily-report-core.mjs` 的 `buildPromotionFields` 就在校验它。真实缺口是「报错不点文件名」＋
> 「证据不进收据」。纠正过程与依据见 §7.1。保留原文是为了留下「我当时的判断错在哪」。

- 指什么：本轮跑完，我临时写了两个只读脚本 —— 一个打开阿里妈妈下载的 ZIP、读里面那份 CSV 的「日期」列；一个打开店铺 xlsx、读「统计日期」列与目标日行数。用完都删了。
- 已经覆盖的（结构层）：`skills/sycm-alimama-daily-report/scripts/extract-sources.py` 对**结构**有硬断言 —— 店铺表必须只有 `['data']` 一个 sheet、首行必须 119 列、目标日必须**恰好 1 行**；推广 ZIP 必须只含 1 个 CSV、首行 71 列、每行列数一致。不符即抛错。
- 现在缺什么（时效层）：**推广 ZIP 侧完全不校验内部日期**。列数 71 对、日期不对，解析器不会报。
- 不做的后果：下载到的是前一天的 ZIP，全链照样跑到底，昨天的数字被写成今天的，收据一路全绿。
- 店铺侧解析层已经够（「恰好 1 行」兜着），它缺的只是**下载新鲜度**的旁证：文件名里的哈希随**报表定义**走、不随内容变（09-16 与 09-17 两次下载哈希相同），光看文件名分不出新旧。
- 收益：把「这轮人工读了一遍」变成「每轮自动读」。成本约 40 行只读代码 + 2 个测试。
- 结论修正：与其说「固化脚本」，不如说**在链路上加一个正式阶段**「下载后置时效校验」，fail-closed，不通过就不进 runner。

### 4.2 D2 启动器自解释提示 —— 原说法要修正

- **修正**：`runtime/start-project-browser.mjs` 现在已有四个分支（`ours` / `free` / `foreign` / `unknown`），同 profile 占着**同一个端口**时会打印 `REUSE ...（profile 与期望一致，无需重复启动）` —— 这一支本来就处理好了。我原来的说法（「只报端口超时」）不准确。
- 真正的缺口是**已有实例挂在另一个端口上**：本轮实例在 9223，脚本要 19022，19022 空闲 ⇒ 走 spawn 分支 ⇒ Edge 按 `user-data-dir` 单例把请求交给已有实例后立即退出 ⇒ 输出只剩两行：`msedge exited code=0` 与 `调试端口 19022 在 30000ms 内没有就绪（最后错误：ECONNREFUSED）`。单看任一行都像「端口没起来」。
- 可用判据：Chromium 会往 profile 目录写 `DevToolsActivePort`（内容是实际端口 + ws 路径）与 `SingletonLock`。启动器目前完全不读 profile 目录。
- 修法：spawn 前先读 `<PROFILE>/DevToolsActivePort`，存在且端口 ≠ 期望 ⇒ 直接给一句可执行的提示并 `exitCode=1`；spawn 后 `child.on('exit')` 若 code=0 且端口始终没起来，补印同一句。
- 收益：把「等 30 秒再猜」变成一行字。客户交付侧价值更大 —— 运营看到 `code=0` 会以为成功。

### 4.3 D3 9223 / 3458 的处置 —— 不只是「不好看」

只读端口快照（2026-09-17，未碰任何进程）：

| 端口 | 状态 | 归属 |
| --- | --- | --- |
| 9222 | free | 竞品浏览器（登记表值） |
| 9223 | **LISTEN** | 遗留的日报浏览器（已被 19022 取代） |
| 3457 | free | 竞品代理（登记表值） |
| 3458 | **LISTEN** | 遗留的旧日报代理（已被 19023 取代） |
| 19022 | free | 日报浏览器（登记表值，实际没用上） |
| 19023 | LISTEN | 日报代理（本轮按登记表起的） |
| 19024 | LISTEN | 运营台 |

两个洞：

1. 只要 9223 上那个实例不退出，每次干净启动都会撞上 §4.2 的场景。
2. **它给一颗雷上了膛**：`runtime/isolated-proxy/browser-discovery.mjs` 第 1–3 行至今是
   ```js
   const ISOLATED_PORT = Number(process.env.CDP_BROWSER_PORT || 9223);
   const ISOLATED_BROWSER_ID = process.env.CDP_BROWSER_ID || 'edge-isolated';
   const ISOLATED_BROWSER_LABEL = process.env.CDP_BROWSER_LABEL || 'Microsoft Edge (isolated)';
   ```
   该模块被 `runtime/isolated-proxy/cdp-proxy.mjs:12` 真实 import。裸跑 cdp-proxy（不传 `CDP_BROWSER_PORT`）⇒ 它对外自称**竞品买家浏览器** `edge-isolated`，实际连的是 **9223 上的日报商家浏览器**。而导出侧的安全校验是「`XWS_BROWSER_ID` 与 `/health` 的 `browser.id` 一致」—— 两边都是 `edge-isolated` ⇒ **校验会过**。这正是 `runtime/browser-ports.mjs` 头部 6–8 行自己记下的 1 号风险，代码未改。
   守卫抓不到它：`runtime/browser-ports.test.mjs:170-181` 那条「生产代码不得写死端口」只扫 `Object.values(PROJECT_PORTS)` ＝ 9222/3457/19022/19023/19024；**9223 是退役值、不在表里**，因此不在扫描范围内（坑 35 的变体：退役值不在守卫视野内）。

- 三个选项：a) 停掉 9223 / 3458（需用户点头，且 9223 那个窗口可能用户自己在用）；b) 不停，先修 `browser-discovery.mjs` 让它从登记表取，并把**退役端口**纳入守卫；c) 不停也不修，只登记（雷还在）。
- 倾向：**b 立即做**（不动进程），a 等用户明确说停。

## 5. 改进分析（按价值排序）

### I1 缺的不是「校验」，是「时效校验」——并入链路一个阶段

见 §4.1。同类问题在本项目是主流失败模式：结构对、内容错。建议把「下载后置校验」做成链路阶段：推广 ZIP 读内部「日期」列、店铺 xlsx 读内部「统计日期」列，与目标日不一等 ⇒ fail-closed，且**不进入 runner**。

### I2 日报链没有登录态判定（缺口 G2）—— 比 D1/D2 都值钱

- 证据：`skills/sycm-alimama-daily-report/scripts/` 全目录零登录判定。
- 失败形态：页面能打开、元素能点到、导出能成功，但数据来自登录墙或旧缓存。
- 本轮的一个具体信号：`date-picker --site sycm` 回显「动作前已是 `统计时间 2026-09-16`」—— 那只说明页面被上次运行留在正确位置，**不等于这次真的登录着**。
- 建议：进链第一步做一次登录态体检（生意参谋首页 + 阿里妈妈后台 + 飞书），结果写进收据；未登录直接停在门口。这条同时是用户提的「运营统一登录页面」交互设计的技术前提。

### I3 收据缺两个字段：环境与自证

- 证据：`receipt.json` 现有键 `mode / reportDate / target / source / checks / fields / status / recordId / recordCountBefore / recordCountAfter / verifiedFields / derivedShop / derivedReadbackAttempts / derivedReadbackTrace`。
- 缺 `browserPort` / `browserId` / `proxyPort`：所以本轮「浏览器在 9223 而不是 19022」这个偏离**无法从任何产物自证**，只能靠口头交接。下次复盘看到的收据是干净的，会以为一切按登记表跑。
- 缺数据源自证结论：`source.promotionSha256` 只说明「是这个文件的哈希」，不说明「这个文件是 09-16 的」。我的两个自证结果是另写的 JSON，没进收据链。
- 建议：收据加 `environment`（端口与 id 从登记表读，不写死）＋ `sourceSelfChecks`（每个源的时效断言结果）。成本极低，收益是「给未来的自己留证据」。

### I4 收据里 `sha256` 的语义被高估

`promotionSha256` / `shopSha256` 只是**文件字节哈希**。文件名里的哈希（`日报_20260917_adc987ef…xlsx`）随报表定义走、不随内容变，两天的下载可以同名同哈希。把哈希当「这份数据是这一天的」是错的。建议：哈希旁配 `sha256Scope: 'file-bytes-only'`，时效结论单独放。

### I5 把「静默落空」从文档升级成工具

09-14 记了 3 条、09-17 记了 3 条，全是「点击/查找静默失效但不报错」：iconfont 私有区字符让精确匹配命中 0；侧栏是独立滚动容器、真实鼠标点击落在视口外；ZIP 压缩长度读错偏移（报的是 `unexpected end of file`，像个文件损坏、其实是解析姿势错）。这些现在只写在 `references/sop.md` 里靠人记。可复用的部分应该进共享探针：匹配前剥 `U+E000–U+F8FF`、点击前用 `elementFromPoint` 复核命中链、点击后必须回读目标状态而不是只看点击返回值。

### I6 「临时探针用完就删」在漏资产

本轮我写了 `runtime/tmp-daily-probe.mjs`（17 个子命令：pages/info/read/eval/nav/open/shot/click/clickText/aim/clickPoint/key/paste/scroll/label/close/help）等一串临时文件，用完全删，下一轮还会重写一遍。其中 `aim`（按文本找唯一可见元素 + `scrollIntoView` + `elementFromPoint` 复核）是 `/clickText` 做不到的（后者 fail-closed，同名节点 ≠ 1 就 400）。建议把通用部分固化成 `runtime/cdp-probe.mjs`，进版本库、进测试 —— 与 D1 同一条道理，对象是「操作侧」。

### I7 端口登记表只完成了「防漂移」，没完成「防僵尸」

`browser-ports.mjs` 把 5 个值收成唯一来源、测试盯着「不许写死」；但**退役值**（9223/3458）既不在表里、也不在守卫扫描范围内，于是它能在生产代码里活下来（§4.3）。同时僵尸实例会让「表里写的端口」与「实际在跑的端口」长期分叉。建议登记表加 `RETIRED_PORTS`（9223→19022、3458→19023）并让同一个守卫扫它，出现即红。

### I8 「日期以 `new Date()` 为准」还是口头规则

本轮会话提示里的 `2026-09-16 15:20` 是上次会话残留，真实时钟是 09-17 08:00；若按提示走会去写一个已存在的日期，而幂等复跑只回 `ALREADY_VERIFIED`（看起来像成功，当天数据其实永远没写）。建议：runner 在收据里记 `computedAt`（真实时钟）与 `reportDate`；当两者同日时打一条警告（日更语义是「昨天」）。成本一行。

## 6. 决策清单（可直接拍板）

| 编号 | 待决 | 选项 | 建议默认 |
| --- | --- | --- | --- |
| Q1 | `browser-discovery.mjs` 的 9223 默认值 | 改成从登记表取 / 保持不动 | 改（不动任何进程） |
| Q2 | 退役端口守卫（I7） | 加 `RETIRED_PORTS` 并扫 / 不加 | 加 |
| Q3 | 启动器读 `DevToolsActivePort`（D2） | 做 / 不做 | 做 |
| Q4 | 链路加「下载后置时效校验」（D1/I1） | 加 / 不加 | 加 |
| Q5 | 9223 / 3458 两个遗留实例 | 停 / 保留 | 先保留，等明确指令 |
| Q6 | 收据加 `environment` + `sourceSelfChecks`（I3/I4） | 加 / 不加 | 加 |
| Q7 | 登录态体检（I2，缺口 G2） | 本轮做 / 排后续 | 排后续 |
| Q8 | 固化 `runtime/cdp-probe.mjs`（I6） | 做 / 不做 | 做 |

Q1–Q4 已按建议执行，Q5 按建议保留现状；执行结果与验证见 §7。

## 7. 执行结果（同日，用户回「按你推荐的改吧」之后）

### 7.1 一处自我修正：D1 的前提说错了一半

我原来写「推广 ZIP 完全不校验内部日期」——**这是错的**。核代码后：

- `daily-report-core.mjs` 的 `buildPromotionFields` 第一件事就是 `if (row[0] !== reportDate || …) throw`，两行（371/372）都要过这道；
- 店铺侧日期由 `extract-sources.py`（目标日**恰好 1 行**）＋ `toFeishuValue`（date 字段等值断言）双重锁定。

所以「下载到前一天的包会被静默写成今天」这个后果**不成立** —— 链上一直是 fail-closed 的。我把「临时脚本做了一次人工核对」误读成了「链上没人核对」。

真实缺口是另外两件事：

1. **报错不点文件名**：拦截发生在字段映射那层，消息是 `unexpected 关键词推广 identity/date: …`，不说是哪个源文件；
2. **证据不进收据**：`source.shopSha256 / promotionSha256` 只是**文件字节哈希** —— 能证明「是这个文件」，证明不了「这个文件是这一天的」；而文件名里的哈希随报表定义走、不随内容变（09-16 与 09-17 两次下载同名同哈希）。

所以 D1 落地的形态是「**下载后置自证 ＋ 进收据**」，不是再补一道重复校验。

### 7.2 已做（Q1–Q4）

| 项 | 改了什么 | 验证 |
| --- | --- | --- |
| Q1a | `runtime/isolated-proxy/browser-discovery.mjs`：三个默认值改为从登记表取（competitor 买家链，与它自报的 `edge-isolated` 同链），端口走 `resolvePort`（非法值抛错而不是静默回落成 NaN） | §7.3 |
| Q1b | `runtime/browser-ports.mjs` 新增 `RETIRED_PORTS`（9223→`dailyReportBrowser`、3458→`dailyReportProxy`，带退役日期与原因）＋ `retiredPortNumbers()` | 新增「退役端口留档」测试 |
| Q1c | `runtime/isolated-proxy/cdp-proxy.mjs`：监听端口默认值从**外来端口** `3456` 改为 `PROJECT_PORTS.competitorProxy`；「未开启远程调试」那段提示不再教人写死 `9222`，改为指向本项目的两个启动器 | §7.3 |
| Q1d | `runtime/browser-ports.test.mjs`：`SKIP_DIRS` 移除 `isolated-proxy`（它已不是原样 vendored）；新增「退役端口与外来端口都不得出现在本项目代码的默认值里」 | **突变验证**：临时放一个含 `9223` 的文件 → 守卫变红并点名 `runtime\tmp-mutation-check.mjs -> 9223`（已删） |
| Q2 | `runtime/start-project-browser.mjs`：起浏览器之前先找「同 profile 但在别的端口上」的实例，找到就拒绝启动并说清原因与两种处置；端口始终没起来且子进程 `code=0` 时补印同一句 | §7.3（真实入口 1） |
| Q3 | `daily-report-core.mjs` 新增 `summarizeSourceDates()`；`extract-sources.py` 输出两侧日期列；`run-daily-report.mjs` 在 **`buildCombinedFields` 之前**跑 `assertSourceDates()`，不通过即停并点名两个文件 | 4 条新单测（含 3 条反例）＋ 真实入口 4 |
| Q4 | 收据新增 `environment`（`computedAt` / `node` / `proxyUrl` / 浏览器与代理的端口、id、label，各带 `source: env \| registry-default \| env-invalid`）与 `sourceSelfChecks` | 真实入口 2/3 |

未做（按批准保留）：Q5 的 9223 / 3458 两个遗留实例仍未退，**全程没有停任何进程**。

### 7.3 验证方式（都是真跑的）

| 验证 | 命令 / 入口 | 结果 |
| --- | --- | --- |
| 单元 | `node --test runtime/browser-ports.test.mjs runtime/isolated-proxy/browser-discovery.test.mjs` | 20 / 20 |
| 套件 | `scripts/run-test-suite.mjs runtime` | **532 / 0 失败**（69 文件） |
| 套件 | `scripts/run-test-suite.mjs skills --skill=sycm-alimama-daily-report` | 28 / 0 失败 |
| 真实入口 1 | `node runtime/start-daily-report-browser.mjs` | EXIT=1，自己说出「同一个 profile 已经有一个实例在跑，它在端口 9223」＋两种处置；**没有启动任何进程** |
| 真实入口 2 | dry-run（`--date 2026-09-16` ＋ 09-16 的两个源文件） | 走到重复行检查被拦（底单已有 09-16，属预期）；拦之前已写出 `plan.json`，内含 `environment` 与 `sourceSelfChecks`，`visibleFields 265 / payloadFields 239` 与上次一致 |
| 真实入口 3 | 同上但 `CDP_BROWSER_PORT=9223` | `environment.browserPort = {"port":9223,"source":"env","registryDefault":19022}` —— 本轮那条**一直无法自证**的环境偏离，现在收据自己会说了 |
| 真实入口 4 | `--date 2026-09-15` ＋ 09-16 的两个源文件 | 新闸门报错，点名两个文件与两侧观察到的日期（`observedDates:["2026-09-16"]`）；堆栈落在 `assertSourceDates` ⇒ 证明它在字段映射**之前** |
| 整合路径 | 真实文件 → `extract-sources.py` → `summarizeSourceDates` | 正确日 `allMatchDate:true`（工作簿覆盖 09-16…08-18 共 30 天、推广 2 行同日）；错误日 `allMatchDate:false`；Python 的 `dates` 两侧都在 |

为跑通真实入口 2/3/4，在日报浏览器里打开了飞书底单页（`https://kcne618basvj.feishu.cn/base/X02Xb7fHba7mU9sr8uIcRlExn6b?table=tbl84ZGwLQKyLxV3&view=vewwg0rhjo`，域名取自既有收据，不是猜的）。只读页面，代理会在闲置 15 分钟后自动关掉这个受管 tab；期间没有停任何进程。

### 7.4 执行过程中另行发现的三件事（都未擅自处理）

1. **`runtime/isolated-proxy/` 整个目录被 gitignore**（`.gitignore:50`，与 `runtime/edge-isolated-*/` 等运行产物归在同一组注释下）。
   后果：本次对 `cdp-proxy.mjs` / `browser-discovery.mjs` 的修复**进不了版本库**，只活在这台机器上；新机器上那四个文件根本不存在，而守卫测试对不存在的目录是**静默通过**的 —— 正是本仓库 `.gitignore:44-46` 自己写过的那个坑（「被吞的后果是新机器上根本没有这份配置，而『没有配置』会被读成『不用跑』」）。
   建议：把 `runtime/isolated-proxy/` 从 ignore 里拿出来（它已不是上游原样，是被本项目改过的工具链）。**要不要动，需要拍板。**
2. **`cdp-proxy` 的 `--browser` 契约是死的**（坑 38 的又一例）：`discoverChromePort` 处理 `result.kind === 'mismatch'`、`result.source === 'override'`、`findFallbackPort()` 兜底三条分支，而 `browser-discovery.selectBrowser` 是**无参**、且永远返回 `{kind:'ok', source:'isolated-runtime'}` ⇒ 那三条分支（含「连不上时给 Agent 的处理顺序」提示、「pin 之后不许 fallback」的保护）**永远不会执行**；`--browser <名>` 传了也不起作用。未修（超出批准范围）。
3. **`isolated-proxy` 的测试不在离线套件里，理由已经不准**：`scripts/test-suite-discovery.mjs:30-31` 写的理由是「探的是本机 CDP 代理/浏览器端口；本机没开那两个端口时它的结论没有意义」，但 `browser-discovery.test.mjs` 全程 mock `fetch`、不碰真实端口（今天新加的三条同样）。并进套件会改动基线数字，需要拍板。

## 8. 「飞书数据顺序乱了」的定位（2026-09-17，用户贴截图追问）

用户看到的是底单 `tbl84ZGwLQKyLxV3`（视图 `vewwg0rhjo`「表格」）的第 5/6/7 行：

| 行号 | 店铺 | 统计日期 | 店铺名称 |
| --- | --- | --- | --- |
| 5 | 盖文天猫 | 2026/09/15 | 盖文旗舰店 |
| 6 | 盖文天猫 | 2026/09/14 | 盖文旗舰店 |
| 7 | 盖文天猫 | 2026/09/16 | 盖文旗舰店 |

**结论：不是数据错位，是「行序 = 记录创建顺序」，而 09-15 比 09-14 先进表。**

### 8.1 证据（全部来自既有收据，可逐条复核）

`receipt.json` 里的 `recordCountBefore/After` 就是该记录被追加时的**落位下标**，把它们按时间排开，与屏幕上看到的行号逐一对应：

| 收据 | reportDate | recordId | before → after | 落位 |
| --- | --- | --- | --- | --- |
| （历史种子） | 08-31 / 09-01 / 09-02 / 09-03 | recvtVyQ33clAW … recvud6lJRJGve | — | 1–4 |
| `daily-report-2026-09-15` | 09-15 | recvvm3aVD7u1I | 4 → 5 | **5** |
| `daily-report-2026-09-14` | 09-14 | recvvmYaNKfac0 | 5 → 6 | **6** |
| `daily-report-rerun-2026-09-16/import-2026-09-15` | 09-15 | recvvnjYo7bMpv | 4 → 5 | **5** |
| `daily-report-rerun-2026-09-16/import-2026-09-14` | 09-14 | recvvnkcL1DPUo | 5 → 6 | **6** |
| `daily-report-2026-09-16` | 09-16 | recvvqPBEP0cMe | 6 → 7 | **7** |

两代记录（重跑前 `recvvm*`、重跑后 `recvvn*`）的落位完全一致：**每一次都是 09-15 先进、09-14 后进**。原因是日期口径 —— 09-16 当天先按「昨日」预设跑 09-15，再回填 09-14；回填的日期越老，越晚落位。

重跑那次的下载时间戳也独立佐证了这个先后：09-15 用 `营销场景报表_20260916_121308.zip`，09-14 用 `…_150325.zip`。

### 8.2 视图配置（2026-09-17 现场只读读到的）

对 `19023` 的 `/eval` 读 `view.property`：

```
viewName = 表格
group    = [{ field: 店铺, desc: false }]      ← 按「店铺」分组（单选/Lookup，fldsPXWgqt）
sortInfo = []                                  ← 没有任何排序
recordCount = 7
```

即：**组内没有任何排序规则 ⇒ 飞书按记录创建顺序排列**。这不是缺陷，是当前视图配置的必然结果。

### 8.3 「本地有没有数据库保存」的确切边界

| | 有 / 无 | 说明 |
| --- | --- | --- |
| 本项目 PG `xws_automation`（PG17，127.0.0.1:5432，迁移 001–006） | 有，但**与日报链无关** | 它服务 sop-runtime / 竞品采集链（运行、attempt、账本、durable_*）。`db/` 下没有任何日报相关表。 |
| 日报链读 PG | **无** | 在 `skills/sycm-alimama-daily-report/` 里 grep `postgres\|Pool\|xws_automation` 零命中。 |
| 日报链的本地落地 | 只有过程文件 | 源文件在 `C:\Users\Administrator\Downloads`（xlsx / zip）；产物在 `evidence/daily-report-*/{plan.json,paste.tsv,receipt.json}`。 |
| 「某天推过没有」的判据 | 问飞书，不是问本地 | 链上靠 `listRecords` 查「统计日期 + 店铺名称」是否已存在（`duplicates`），没有本地台账。 |

所以现状是：**飞书底单是唯一的数据落地处；本地只有收据，没有数据副本、也没有已推送索引。** 底单表 id 在本仓库只出现在 `runtime/feishu-targets.mjs` 与收据/计划文件里，没有任何脚本回读它 —— 下游（月份数据表、仪表盘）都是飞书原生公式/引用。

### 8.4 建议（按代价排序）

1. **只改视图排序**（零代码、不动数据）：在底单视图加一条排序「统计日期 升序」。视图属性，与记录本身、与下游公式/引用无关。**属于在用户 base 上的可见改动，未擅自执行。**
2. **回填写入按日期升序提交**（小改）：回填多天时先补最老的。只在「连续补一段更早的日期」时有效，补中间空缺依旧会落在末尾，治标。
3. **给日报链加本地台账**（需要拍板，涉及新迁移）：在 `xws_automation` 建一张 `daily_report_push`（日期 + 店铺 + recordId + 源文件 sha256 + 推送时刻 + 环境），收益是「不查飞书就知道哪天推过」「重推/覆盖有审计」，代价是多一份要与飞书对账的状态（多一个可能失同步的权威）。
   真正的顺序问题，方案 1 就解决；方案 3 解决的是另一个问题（本地可追溯），不要为了治顺序去建库。
