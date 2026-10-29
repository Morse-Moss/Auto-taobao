# 修复规程（REPAIR-PROTOCOL）

生效：2026-10-23（用户拍板「立」）。适用范围：本仓所有修复类改动——无论由哪个会话、哪个 agent、哪条链的故障触发。

## 0. 为什么需要这个规程

本仓至今的返工史里，最贵的一类损失不是「缺陷难修」，而是「同一个缺陷修了多次」。三个铁证：

1. 同 URL navigate 是空操作：09-21 date-picker、10-12 提交确认、10-22 共享取件 openTaskList 等，前后发作 4 次，每次只修当次那一个点。而同一个仓库里，提交段 openFreshTaskList 早就带着正确实现（navigate + reloadAndSettle）——正确答案一直在旁边放着。
2. 询单词表双拷贝（1.12.16）：core 收窄成 `['询单人数']`，采集脚本里还留着一份 `['统计时间','询单人数']`，次日 8/8 家全灭。
3. 守卫钉字面量不钉行为：`includes('...')` 断言源码里出现过某字符串，而不是断言行为正确——同族形态发作 4 次，其中 10-23 那次守卫断言的正是 bug 本身（没插值的字面量才在），把 bug 当成了合规证据。

共同病根：修复的单位是「当次报错的那一行」，而缺陷的单位是「机制在全仓的所有实例」。本规程把修复的单位纠正过来。

## 1. 什么叫做「修完」（门禁）

一次完整修复 = 改动 + 三问全答 + 攻击包全过 + 验证状态明示。

四样缺任何一样都叫「未完」，只能显式挂起并写明欠什么。汇报时必须分别报这四样，不许把「报错消失了」当「修完了」。

## 2. 修复后三问

问一（同族清单）：把这个缺陷抽象成机制谓词后，全仓有多少个点满足它？每个命中点的处置是什么（已修 / 不适用+理由 / 挂起+欠什么）？
问二（新条件组合）：这个修复本身在什么条件下会引入新失败？（先例：1.12.14 的修复引入了双引号不插值 bug。修复是代码变更，变更就是新条件组合。）
问三（调用侧契约）：调用侧真传了什么、被调侧真认不认？（先例：纯函数用例全绿但调用侧没接上，发作 4 次。判断接没接上要看调用侧的实参，不是看被调侧的实现。）

三问答不上来就不算修完。这是对 agent 和人同样生效的硬门禁。

## 3. 同族扫描五步法

「同族」的定义：同一个机制缺陷在不同调用点的实例。判断标准不是「报错字面一样」，而是「把缺陷抽象成一个谓词后，全仓有多少个点满足这个谓词」。

步骤 1：提取模式签名。从机制层面描述，不是字面报错。对照：
- 字面签名（没用）：`找不到下载按钮`。
- 机制签名（有用）：`navigate 之后固定 sleep 固定秒数，然后单次读取 DOM 并据此下结论`。
另一个对照：
- 字面签名：`expected one 当日询单人数 table, got 0`。
- 机制签名：`同一判据字符串（列名/词表/选择器）存在多份手工拷贝`。

步骤 2：把签名翻译成可搜索的结构特征。真实例子：
- 词表拷贝族：直接搜判据字符串本身（如 `询单人数`），看它出现在几个非 import 的位置。
- 固定 sleep 族：搜 `(delay|sleep)\(\d{4,}\)`（四位数毫秒以上的等待）。
- 重载缺失族：搜 `reloadAndSettle` 的使用点，与 `navigateTo|navigate(` 的调用点做差集。

步骤 3：全仓扫描列命中点。用 Grep 工具（本机 bash 无 coreutils，别用命令行 grep），结果落成清单：文件、行、上下文一句话。

步骤 4：逐点分类处置，三选一，不许空：
- 修：与本缺陷同机制、会被同样条件触发。
- 不适用：写明理由（例：该 sleep 在轮询循环体内，是合法的轮询间隔）。
- 挂起：写明欠什么、什么时候补。

步骤 5：守卫钉出现次数。断言「N 处全部满足某属性」，不是「出现过某属性」。先例：10-23 缺口文案守卫第一版用 includes，突变「只改回一处」漏过——多拼接点的守卫必须数出现次数（见 `.workbuddy/memory/` 2026-10-23 记录）。

## 4. 攻击包

定义：每个修复携带 2-3 个构造出来的反例场景，要求「旧代码在该场景失败、新代码通过」。这是对抗式审查的最小落地——测试的价值在于它能推翻什么，不在于它能确认什么。

本仓已有的武器（继续用，不必新造）：
- 突变脚本：放 `tmp/mutate/` 目录（2026-10-23 起），命名 `mutate-YYYY-MM-DD-<主题>.mjs`；2026-10-23 之前散落在 tmp/ 根下的旧脚本留在原地参考、不搬迁（避免碰相对路径）。写法上要钉：spawnSync 必须 `stdio:['ignore','pipe','pipe']`；替换前后逐字比对（差一个字=replace 空转=全假绿）。
- 桩化现场：构造一个复刻故障页面的最小桩，让旧判据当场放行/拦截。先例：`skills/sycm-inquiry-data/scripts/inquiry-core.test.mjs` 的「业绩总览页现场」（2026-10-23），用总览页也带「统计时间」这一事实构造出旧词表的失败现场。
- 反向自证：守卫删掉判据那行必须转红（先例：promotion-fetch-wait.test.mjs）。
- 通用轮询原语：`collect-core.mjs` 的 `readPageValueSettled(read, { isPresent, ... })`（2026-10-24 从 readAlimamaIdentitySettled 泛化）。「读不到就重试」一律用它，不再各写一份循环；判据（isPresent）由调用方给，fail-closed 断言仍归调用方。
- 攻击包本身也要被攻击：2026-10-24 M5 首轮 GREEN_BAD 证明「memberId 单独在场」这一语义从无覆盖——突变没抓红不是修复没问题，而是测试有盲区，必须补用例后复验到 RED_NAMED 才算过。

攻击包的最低配置：一个「旧代码失败」场景 + 一个「新代码不引入新失败」场景（对应问二）。真机不可用时允许用桩化现场顶替真机验证，但必须写明「桩化已验、真机未验」，真机首跑后补判。

## 5. 第一份同族存量清单（2026-10-23 首扫结果）

这是规程生效当天的第一次扫描，作为示例和欠账登记。后续每次修复按第 3 节五步法更新本节。

族 A：判据字符串多拷贝（机制：同一判据知识存在多份手工字面量，改一处漏一处）
- `当日询单人数`（列名判据）至少分布在：`skills/sycm-alimama-daily-report/scripts/inquiry-core.mjs`（exactIndex 两处）、`run-inquiry-backfill.mjs`（页面表达式内字面量一处）、对应测试文件多处。**2026-10-24 已收敛（1.12.19）**：唯一来源 `DAILY_INQUIRY_COLUMN`，消费方全部展开常量，`inquiry-core.test.mjs` 有单一来源守卫（突变 M3 RED_NAMED）。
- `询单人数`（页面词表）跨两个 skill：`skills/sycm-inquiry-data/scripts/inquiry-core.mjs`（单一来源 `INQUIRY_PAGE_MARKERS`，已修）与 `skills/sycm-alimama-daily-report/scripts/`（另一套询单知识，职责不同但共享知识域）。
- 风险：平台改列名时需改 N 处，漏一处即静默漂移（本项目已有「一个分类值活在四处」的先例）。处置：登记待修，修法=收敛到各自 core 的单一常量并让页面表达式展开该常量（参照 1.12.16 对 inquiry-data 的修法）。
- 复现扫描：Grep `询单人数` glob `*.mjs`。
- **2026-10-26 追加实例（已收口）**：推广轮的内存闸阈值曾以手工字面量活在 5 处 —— 推广自动化提示词、`docs/ops/DAILY-FLOW-SCHEDULE.md`、`docs/ops/DELIVERY-2026-10-25.md`、`.workbuddy/memory/MEMORY.md`、以及各轮执行记录。改阈值那天只改提示词与调度文档，MEMORY.md 仍写着「<4GB 跳过」，下个会话读记忆就会按旧口径判。处置：现行数值只在 `DAILY-FLOW-SCHEDULE.md` 一处定义，提示词引用它，日期化文档保留旧值但加一行指向现行口径，MEMORY.md 同步为 2026-10-26 的四档（<2GB 跳过 / 2–4GB 用 2 / 4–8GB 用 3 / >=8GB 用 5）。复现扫描：Grep `<4GB|4–8GB|FreePhysicalMemory` glob `*.md` 与自动化提示词。

族 B：navigate 后固定 sleep 单次读（机制：对异步页面做快照断言，无等待到稳定）
- 确认未修实例：`skills/sycm-alimama-daily-report/scripts/collect-shop-report.mjs` 的 `await delay(6000)`——navigate(SYCM_APP_URL) 之后固定睡 6 秒，然后单次读页面认店铺。与 10-21 修掉的 produceTask sleep(6500) 同机制。**2026-10-24 已修（1.12.19）**：改 `readPageValueSettled` 有界轮询，守卫钉「delay(6000) 零出现 + 导航→轮询→断言顺序」（突变 M1 RED_NAMED）。
- **2026-10-24 复核（1.12.19/1.12.20）**：collect-shop-report.mjs 的 delay(2500)/delay(3000)/delay(1200)、readback-daily-report.mjs 的 delay(2000)×2/delay(1500)、run-promotion-daily-report.mjs 的 sleep(2500)/sleep(1800)/sleep(5000) 均为轮询间隔或动作缓冲，不适用；collect-product-report.mjs 的 sleep(5000) 属导航封装等待、读取侧已有轮询，sleep(2000) 在下载等待循环内，也不适用。collect-product-core.mjs 因他人会话未提交且缺真机故障现场，仍挂起。
- 判断规则：在 for/while 轮询循环体内的 sleep 是合法轮询间隔；不在循环内、睡固定秒数后紧跟一次性读取并据此下结论的，是本族命中。
- 复现扫描：Grep `(delay|sleep)\(\d{4,}\)` glob `*.mjs` path `skills`。

族 C：reloadAndSettle 覆盖面（机制：读页面前不做真重载，读到旧渲染）
- 现有覆盖点：`collect-core.mjs`、`collect-promotion-report.mjs`（openTaskList 已修）、`navigate-read-guard.test.mjs`（1.12.15 登记制）。
- 未覆盖：其他 navigate 后直接读的点（与族 B 大量重叠，可合并清算）。**2026-10-24 第一轮收口（1.12.19）**：NAV 扩到本地 `navigate(` 封装（此前 collect-shop-report 的 run 从未被扫到，属扫描盲区），新扫出的 4 个函数全部登记表态；`collectProductReport` 的 knownRisk 仍挂起（他人会话文件）。剩余方向=按路由特征选 `reloadAndSettle` 或有界特征轮询，并数出现次数；hash 路由有重载丢 hash 前科，不能一刀切强刷。
- 复现扫描：Grep `reloadAndSettle` glob `*.mjs` 与 `navigateTo\(|navigate\(` 的调用点做差。

族 D：把浏览器内部页当成业务页（机制：只用 `type=page` 选操作对象，没有校验 URL 类型）
- 真实现场：Edge 下载浮窗 `edge://downloads-hub/` 也是独立 page target，且 `/targets` 顺序不保证；浮窗排第一时，视口闸门把 360x154 当成采集页，窗口归位也可能拿错窗口 ID。
- **2026-10-24 已修（1.12.20）**：`runtime/browser-ports.mjs` 新增唯一判据 `isWebPage` / `pickWebPage`；`shop-viewport-gate.mjs` 与 `browser-window-bounds.mjs` 两处都改走它，只剩内部页时 fail-closed。视口证据新增 pageUrl/pageTitle。
- 攻击包：M6/M7/M8 均 RED_NAMED；仅离线与桩化现场已验，真机首跑待补。

族 E：CI Python 解释器漂移与覆盖参数错接（2026-10-24）
- 真实现场：windows-latest 的 `py -3` 选到 3.15，Pillow 11.3.0 无对应 wheel；skill job 又用 `python` 二次安装掩盖首个失败，测试仍回到 `py -3`，最终缺 openpyxl 并触发长时下游等待。
- 机制签名：安装命令与测试命令各自选择解释器；或调用方已给 `PYTHON=python`，被调侧仍把启动器专用 `-3` 交给 python.exe。
- 已修：fast-gate / skill-tests 都用 setup-python 固定 3.12；安装后同命令导入 openpyxl / PIL / docx；`PYTHON` / `SYCM_PYTHON` / `XWS_PYTHON` 显式指向同一 `python`。四个技能导入解析点 + `check-fast` + `run-affected-tests` 共 6 处改为“未覆盖时才补 `-3`”。未覆盖的本机默认 `py -3` 行为不变。
- 守卫与攻击包：`runtime/ci-matrix-coverage.test.mjs` 发现式扫描全部 `PYTHON` 调用点；`tmp/mutate/mutate-2026-10-24-ci.mjs` M1/M2 验证新配置过、旧配置与旧调用点转红。

族 F：源码扫描测试把宿主的 CRLF 当成 LF（2026-10-24）
- 机制签名：`readFileSync(..., 'utf8')` 后直接拿字面 `\n` 做函数边界或反向自证匹配；本机 LF 绿，CI checkout 成 CRLF 后红灯或判据范围失真。
- 已修：`promotion-fetch-wait.test.mjs` 4 处源码读取统一先 `.replace(/\r\n/g, '\n')`；`date-picker.test.mjs` 的 aim 边界扫描同步归一化，并新增 `aimEnd > aimStart`，防止找不到边界时退化成扫整份文件。
- 同族分类：其余已扫点若只用不含换行边界的字面判据，或正则已经用 `\s*` 吸收 `\r\n`，不属于本次故障实例，不做无差别改写；全仓 LF 重归一仍按 AGENTS.md 挂起到没有其他会话在途文件时。
- 攻击包：M3/M4 复现取件守卫旧代码 CRLF 红、新代码绿。M6 首轮 **GREEN_BAD**，证明遮挡守卫缺“边界必须找到”断言；补断言后，撤掉归一化的突变体转 RED_NAMED，M5/M6 复验通过。

族 G：新能力已进套件/告警链，但登记表没跟上（2026-10-24）
- `qianniu-kefu-chat` 自带 24 条离线测试却不在 CI 矩阵，且 `KEFU_WEEKLY_OK/FAILED` 未进告警 type 闭集；两处均已修。矩阵仍由 `discoverSkillTests()` 推导期望值，不另抄一份名单；告警标题继续由调用方显式给，不向通用标题表加第二份真相。

族 H：判据有结论、但没有统一出口（机制：同一判据的「结果」由各调用侧各写一句话，改一处漏一处，且每份文案指点下一步动作的方式还不一样）
- 真实现场（2026-10-26）：全局锁的判据本身正确（活人的锁绝不被抢），但三个启动脚本各写各的冲突文案 —— `run-batches.mjs` 有一句带解释的话，`run-daily-job.mjs` 只有 `JSON.stringify(lock)`，`run-product-data-job.mjs` 没有专门分支、冲突走通用 catch 只剩 `workflow lock busy`。当天推广轮被**同一任务触发两次**，到场的那一路读到「同机另一条采集流程正在跑（日报/商品/推广），等它结束再试」，正确动作（别起第二条、去看在跑那轮）一个字都没有。
- 机制签名：判据函数返回一个异常或布尔，调用侧各自 `log(...)` 拼描述；描述里没有「持有者是谁」「下一步做什么」。凡「同一结论在 N 处被重新表述」即为命中。
- 已修（1.12.22）：`runtime/workflow-lock.mjs` 新增 `describeWorkflowLockConflict(error, { selfOwner })`，三态输出（同链重复触发 / 别的链在跑 / 读不出持有者）；三个调用侧全部改走它；`run-product-data-job.mjs` 只加日志、不改 error 传播，分类与告警行为不变。
- 同族分类：`runtime/workflow-receipt.mjs` 把 `WORKFLOW_LOCK_BUSY` 归 `HUMAN_REQUIRED` **本次不动** —— 该路径在 run-batches 里不可达（抢锁失败早于收尾写回执），而失败分类是闭合集，改它要同步文档与下游告警口径，属人工决策项。其余 `inspectWorkflowLock` 的只读消费方（预览、诊断）只读 `locked/stale` 字段、不产出面向人的文案，不命中。
- 攻击包：M1 把 `if (selfOwner && owner === selfOwner)` 短路成永不成立 ⇒ 同链用例 RED_NAMED；M2 把 `run-daily-job.mjs` 的调用换回旧 `log(...)` ⇒ 接线守卫 RED_NAMED 并指出「实际 0」。接线守卫断言**每个文件恰好一处**调用，不用「全仓至少一次」—— 那个写法会在「改两个漏一个」时照样绿。仅离线已验，真机判据要等下一次真撞锁。

族 I：判据建立在「DOM 父子关系」假设上（2026-10-29）
- 真实现场：2026-10-28 商品链推广段 3 家全卡在弹窗上。阿里妈妈的掩膜
  `DIV#wrapper_dlg_1351`（全屏、z=99999）**子树是空的**，弹窗内容写在它的兄弟节点里；
  `overlayScanExpression` 只遍历「最高 z 层」的子树 ⇒ 读到 `0/0` ⇒ 判成「没有可安全点击的关闭控件」
  ⇒ fail-closed，而屏幕上「取消」「立即体验」都在（截图见 `evidence/product-data-job-2026-10-28/`）。
  同日另一形态：盖文淘宝点「下载报表」后那枚「确定」被另一个弹窗吃掉，流程点到**弹窗的**确定
  而误判 `confirmed=true`，错误拖到下游「提交任务无法唯一确认」才暴露。
- 机制签名：**判据依赖「某容器内含一切相关元素」，而平台只保证视觉结果**。
  与族 D（把下载浮窗当业务页）、族 B（navigate 后单次读）同属「对页面做结构假设」一支，
  但这一族的判据本身不报错，只静默返回空集 —— 更难发现。
- 已修（1.12.28）：
  ① 候选改为两层口径 —— 层内优先，层内为空时按整页找（`docFallback`），
     兜底只收关闭语义 / 消失类确认词 / 无文字右上角图标，尺寸上限从图标 48px 放宽到按钮 200×64；
  ② `pressEscape` 补进商品链推广采集器（日报链三个早就注入了，商品链一直没注入，
     而它自己在日志里写着「跳过 ESC 这一步」）；
  ③ `submit()` 点「下载报表」之前先查遮挡，关不掉带 `OVERLAY_NOT_DISMISSED` 报错，不再盲点确定。
- 同族分类：命中点只有 `collect-core.mjs` 候选收集一处（其余 `document.querySelectorAll`
  本来就是文档级，不适用）。挂起两项：`sycm-product-data` 的商品底单采集完全没有遮挡处置
  （无现场，商品段一直全绿）；日报链提交段无前置守卫（改它要碰每日主链，属人工决策项）。
- 攻击包：`tmp/mutate/mutate-2026-10-29-overlay.mjs` 四个突变体（退回只看子树 / 兜底尺寸退回 48 /
  去掉 ESC 注入 / 守卫不查）全部 `RED_NAMED`，还原 sha 一致。用例：`collect-core.test.mjs` 新增
  3 条（兄弟节点现场、掩膜真吃点击仍 fail-closed、层内有候选时不启用兜底）；
  `download-entry-wiring.test.mjs` 新增 2 条计数守卫（`pressEscape` 恰好 1 处、守卫在点击之前，
  锚点用 `const clicked=await` 而不是「下载报表」四个字 —— 守卫自己的注释里也有那四个字，第一版因此假绿）。
- 验证状态：**离线 + 桩化 + 真机注入已验，真机真实弹窗未验**。真机注入用真实布局引擎造出
  「掩膜 + 兄弟节点」形态（`tmp/probe-new-scan-live.mjs`），新判据 `blocked=true`、层内 0、
  兜底拿到 `BUTTON:取消`、`立即体验` 被排除、清理后 `blocked=false`。真机判据=2026-10-30 10:00 那轮。
- 规则沉淀：`docs/ops/PAGE-JUDGEMENT-FAILURES.md`（判据只认几何与命中 / 0 不是结论 / 失败落到动作级）。

## 6. 故障现场库（回放桩基建第一步）

登记本仓六类故障模式与已知现场。规则：每次修复必须引用库中一个现场（给证据路径），或把新现场登记入库。目标是把「生产踩的坑」变成「测试可加载的资产」——新平台/新流程开发时直接拿这些现场打自己的新代码，这就是「经验」的工程化形态。

1. 页面时序类。已知现场：询单总览页误判（inquiry-core.test.mjs 2026-10-23 现场用例）、promotion 下载任务表格异步渲染（evidence/daily-job-2026-10-22 科塔淘宝）。
2. 宿主资源类。已知现场：10-20 与 10-23 两次内存枯竭（0.3-1.4GB 区间 CDP 全超时），RUN-REPORT 存 evidence。
3. 状态泄漏类。已知现场：日期残留（evidence/product-data-job-2026-10-21 的 2026-10-23 补跑失败）、死锁残留（自动回收已解）、Edge 冷启动恢复旧页签（1.4.0 收敛）。
4. 判据缺陷类。已知现场：词表双拷贝、双引号不插值（均有测试用例钉住）；Edge 下载浮窗被当成业务页（2026-10-24 真机证据见 `.workbuddy/memory/2026-10-24.md`，桩化用例见 `runtime/shop-viewport-gate.test.mjs`）。
5. 分类误诊类。已知现场：UNREADABLE 升格 HUMAN_REQUIRED（10-20 商品链）、gaps 复读（1.12.13 按段取原因已修）。
6. 工具链类。见 TOOLING-NOTES.md（沙箱、编码、push 代理、spawnSync stdio）。

建设路径：现阶段手工登记+桩化复刻（零新基建，先让「每个修复有现场」的纪律跑起来）；库内现场积累过十个后，再评估录制回放自动化（把真实 CDP 响应录下来做回放桩）。

## 7. 与现有门禁的关系

本规程不替代 `npm run check:staged` / `test:staged` / AGENTS.md 的 failure-exit gate（四问）。它是它们的上游：定义「修复」这个动作本身是否完整。规程不新增测试文件；它要求每次修复产出的反回归用例进对应 skill 既有的测试文件，突变脚本按惯例放 tmp/ 用完保留复用。
