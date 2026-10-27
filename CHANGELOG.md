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

## [1.12.24] - 2026-10-27

保拉淘宝第 10 步（询单回填）每天必挂的修复：`--source-shop` 取的是平台店铺全称，而断言对面读到的是被平台截断的页头文本。

**为什么改**

- 2026-10-27 08:00 那轮 13 家全采，12 家成功、保拉淘宝停在 `backfill`，退出码 1。原始报错是「生意参谋店铺身份对不上：期望 `Paola Lenti保拉伦蒂`，页面实际 `Paola Lenti保拉伦...` —— 这就是一次串店，已停手」。
- 这不是串店，也不是登录或平台没出数：失败现场 `98-failure-state.json` 里表格有 `2026-10-26` 那一行、`当日询单人数=8`，数据本来就在页面上，被断言拦下了。
- 根因是同一实体的两种表示串了：`--source-shop` 是**比对物**（对面观测值来自 `sycmShopIdentityExpression()`，与登记表 `sycmHeader` 同源同值），而驱动给的是 `identity.fullName`。平台会把长店名截断（省略号在文本节点里、DOM 无 title/aria-label 可取全名），登记表因此专门记了 `sycmHeader`；于是同一张页面上 `shop-report` 用截断值通过、`backfill` 用全称必然不通过。
- 旧用例一直是绿的，因为它只踩 `SHOP = 里可林淘宝`，而那家两个值恰好相等 —— 断言形状写对了，却只落在没有漂移的店里（GREEN_BAD）。

**改了什么**

- `skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`：`backfill` 的 `--source-shop` 由 `identity.fullName` 改为 `identity.sycmHeader`，并在原处写明「它是比对物不是标签」以及这次故障的现场证据路径。
- `skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs`：原钉 `fullName` 的断言改钉 `sycmHeader`；**新增**一条专门遍历「页头与全称不相等」的店铺的用例，断言 `--source-shop === sycmHeader`、`!== fullName`，且与同店 `shop-report` 的 `--expect-shop` 同源同值。
- 同族扫过：仓库里其余 `fullName` 用法都不是页头比对（`run-daily-report.mjs:416` 比的是底单「店铺名称」；`qianniu-kefu-chat` 拿它拼千牛账号），本处是唯一取错表示的点。

**验证到什么程度**

- 离线：`run-multi-shop-day.test.mjs` 153/153。突变验证（把改动还原成 `fullName`）→ 新增用例变红，152 pass / 1 fail，还原后文件逐字节复原。
- 真机 + 飞书回读：起保拉淘宝实例、落位 2026-10-26、单跑 `run-inquiry-backfill --commit` → `COMMITTED_AND_VERIFIED`（询单量 8 / 同层同行询单量 41），OpenAPI 独立回读询单表 2026-10-26 由 12/13 变为 **13/13**。实例跑完已释放，19053/19063 两遍回读全 free。
- **未跑 `npm run test:staged` 全量**（已知该命令可能触发约 7.6 小时 e2e），本次没有完整回归结论，只有上述定向与真机判据。

## [1.12.23] - 2026-10-26

详情页自采从「能采几个」走到「30 个商品采完并落进 SKU明细、主表 Lookup 出值」，期间纠正了一个会污染整表的判定口径错误。

**为什么改**

- 详情页采集器此前只有一条成功路径：一旦撞上滑块，剩下的商品继续硬撞，失败原因只剩一句「超时」，既分不清是页面没打开还是接口被挂住，也拿不到现场。更坏的是收尾阶段的异常会把「数据已写好」变成「退出码 1」——上游会把有效结果整批丢掉，而且没人会查，因为回执看着像正常采集失败。
- 「卡在滑块」一度被当成账号风控。实际 18:48 撞上、20:02 无人干预自己恢复，滑块一动没动、反馈码都没变 ⇒ 是**频率窗口**，不是账号锁。被挂住的是 mtop 接口（页面完整渲染、`hasSdk=true`、`hasPuzzle=true`、pending 请求攥住 25 秒），被弹的那个标签页已废但不拦新会话。定性错了，后续所有处置都会错。
- 周表「尺寸 / 适用空间」的源是 `SKU明细.SKU尺寸 / 适用空间`，而自采侧一直没有映射。第一版映射按**标题词**判空间（小户型|小空间 → 小户型），跑真实数据才发现那是周表那层的分类器；SKU 级线上生效的是按 **SKU 尺寸数值区间**判。同一批 30 个商品：标题词版全判「小户型」，真规则版是常规卫生间 1036 / 小户型 433 / 需人工核验 191。照错的那版写进去，等于把周表的适用空间整体污染。

**改了什么**

- `runtime/collect-taobao-detail.mjs`：撞验证即停并把剩余商品记成 `skipped`（不再硬撞）；失败时抓 `readyState / hasSdk / hasPuzzle / loginWall / bodyText` 与截图；`writeCsvFile` 默认拒绝写 0 行（`--allow-empty` 才写）；收尾清理段的异常一律吞掉，不再覆盖业务结果；`findReusableTab` 排除污染页（`punish|login.taobao|havanaone|login_jump|_____tmd_____`）；关闭决策抽成纯函数 `closeDecision`。
- `runtime/taobao-sku-dimension-core.mjs`：尺寸取 `长度` 原始值；空间判定**直接 import** `competitor-v2-core.classifySkuSpace`，不再自己写一套；`parseAttrsCell` 区分空单元格（`{}`）与脏数据（`null`）并单列计数。
- `runtime/apply-collected-sku.mjs`（新）：自采 → SKU明细 的写入链。默认只出计划，`--commit --confirm-record-count N` 才写；唯一键已存在一律跳过、绝不覆盖；分批 400；写完按唯一键独立回读；`--repair-class` 修单列。
- 三个字段取值的坑一并修掉：飞书**公式/查找字段读回来是对象数组**（`[{text:"无分类"}]`），`String()` 会得到 `[object Object]`；URL 字段读回来是 `{link,text}`，取 `text` 会拿到显示文案；写空串进飞书会存成 `null`，比较时不归一就会虚报差异。
- `docs/ops/XWS-CAPABILITY-MAP.md`：新增 §4.2（风控定性、不做自动过滑块的三个理由、实测节奏 3–4 个/轮、间隔 8–12 秒）、§4.3（尺寸/适用空间真实口径与主表 Lookup 公式原文）。

**验证到什么程度**

- 真机 + 飞书回读。30 个商品 / 1660 个 SKU（按 SKU ID 去重，跨轮重复 60 个）全部落库：新建 1618 行、5 批，回读 2448 行、缺失 0；主表 Lookup **尺寸 24/30、适用空间 27/30 出值**，余下为空的是 `SKU尺寸` 整家缺失（6 个）与三无（3 个），原因逐个对得上。回执 `evidence/collected-sku-2026-10-26/receipt.json`、`lookup-verification.json`。
- 幂等成立：同一条命令重跑，新建 0、同值 1618、内容不同 42。那 42 行是小旺神先前写的旧数据，只在 `商品链接/竞品分类/SKU名称/SKU规格` 上与自采有差异，`SKU尺寸 / 适用空间 / 空间判定状态 / 空间判定依据` 完全一致 —— 这一致本身就是字段装配正确的证据。
- 一次真实数据事故已在本次收口：`--commit` 首写把 1618 行的 `竞品分类` 写成了 `[object Object]`（公式字段返回数组）。已 `--repair-class` 全部改回（无分类 592 / D-价格流量型 1008 / B-高价值 18），回读零残留，回执 `repair-receipt.json`。取值加了闭集校验，非闭集或未展开一律抛。
- 离线：`taobao-sku-dimension-core` 20 条 + `apply-collected-sku` 12 条 = 32/32；告警/架构/端口/导航/路径五个守卫 42/42。**未跑 `npm run test:staged` 全量**，本次没有完整回归结论。
- **没验到的**：`竞品周_2026-10-11_10-17` 与 `10-18_10-24` 两张周表上的 `尺寸/适用空间/数据状态/待补数据项` 实测是 TEXT（type=1）而非 Lookup(19)，与 `COMPETITOR-FIELD-REFERENCE.md` §4.5 不符 —— 所以本次端到端只证明了主表出值，没有证明周表出值。另：主表 Lookup 按 `商品标题` 匹配，标题一改就断，现有 882 个主表↔周表同商品里已有 67 个标题漂移，属结构性风险，未处理。



## [1.12.22] - 2026-10-26

两件事：①运行锁冲突的文案从「一句忙」改成三态判读（区分「本任务被重复触发」与「别的链在跑」，三个启动脚本走同一层文案）；②销售2部接入推广日报链（推广明细），部门不再由链的身份写死。

**为什么改**

- 2026-10-26 11:00 推广轮出现**同一任务被触发两次**：11:01 那一路已起跑并持有 `merchant-automation` 锁，同一时刻另一路会话到场。旧文案是「同机另一条采集流程正在跑：日报/商品/推广共用浏览器资源，等它结束再试」——把「你自己已经在跑」说成了「别的链在跑」，正确动作（别起第二条、去看在跑那轮的证据）一个字都没写出来。人读日志会去等一条根本不存在的日报链。
- 三个启动脚本各写各的：`run-batches.mjs` 有一句带解释的文案，`run-daily-job.mjs` 只有 `JSON.stringify(lock)`，`run-product-data-job.mjs` 根本没有专门分支 —— 冲突走通用 `catch`，只剩一句 `workflow lock busy` + 分类 `HUMAN_REQUIRED`。同一件事三种说法，读的人每次都要重新推。
- 判据本身没有缺陷，**本次不动判据**：`acquireWorkflowLock` 只在锁里 pid 确证已死（ESRCH）或已有 `releasedAt` 时回收，活人的锁绝不被覆盖写；`run-batches` 在起任何进程之前就抢锁、抢不到退 1，所以误起第二条不会双写飞书。缺的只是「把判据的结果说清楚」。

**改了什么**

- `runtime/workflow-lock.mjs` 新增 `describeWorkflowLockConflict(error, { selfOwner })`：owner 与 selfOwner 相同 ⇒ 点名「本任务被重复触发，不要起第二条、不要杀那一条，去看它已在跑的证据」；不同 ⇒ 点名持有链与 pid、要求等它结束；读不出 owner/pid ⇒ 按「有人在跑」fail-closed 表述。只做文案，不参与任何决策。
- 三个调用侧接上：`scripts/run-batches.mjs`（selfOwner=`run-batches:<workflow>`，保留 `return 1`）、`scripts/run-daily-job.mjs`（selfOwner=`daily-report`）、`scripts/run-product-data-job.mjs`（单独 try/catch 只加一句三态日志，error 照旧抛出，分类与告警行为不变）。
- 故意没改：`runtime/workflow-receipt.mjs` 把 `WORKFLOW_LOCK_BUSY` 归 `HUMAN_REQUIRED`。该路径在 `run-batches` 里不可达（抢锁失败早于收尾写回执），而失败分类是闭合集、改它要同步文档与下游告警口径，收益小于风险 —— 留作人工决策项。

**验证到什么程度**

- 仅离线判据。`node --test runtime/workflow-lock.test.mjs` 13/13 绿（原 9 条 + 新增 4 条：同链/跨链/读不出三态文案 + 三个脚本的接线守卫，守卫断言每个文件**恰好一处**调用且旧文案已删净）。
- 突变验证两条都转红：把 `if (selfOwner && owner === selfOwner)` 短路成永不成立 ⇒ 同链用例红；把 `run-daily-job.mjs` 的调用换回旧 `log(...)` ⇒ 接线守卫红并指出「实际 0」。
- 真机判据要等下一次真撞上锁才成立（本版没有主动制造冲突）。未跑 `npm run test:staged`（预算未申请），因此本次改动**没有**完整回归结论。

**追加（同日第二件）：销售2部接入推广日报链**

**为什么改**

- 用户 2026-10-26：「按你推荐的执行，二部要全面接入系统已有的流程，推广明细链也要接」。此前 11:00 推广链只服务销售1部：`PROMOTION_DAILY_MONTH_BASES` 只有 `2026-10:sales1`，`promotionDailyTargets` 的 `department` 参数带 `= 'sales1'` 默认值，链入口里还有一份 8 家的字面名单。
- 默认值那一条最贵：二部接入后任何一处调用漏传部门，数据会**静默写进一部的表**，而写后回读与对账门读的也是那张表 —— 收据全绿、无人发现。两张 base 字段签名逐项一致，恰恰让「抄了 1 部那条、忘改 token」在写入侧无法自证。
- 目标表不是猜的：用户当天 10:17 那版《店铺账号信息表.xlsx》G/H 两列写着「10月推广数据-销售2部」= `RWuxbD8I3aFBkus3On8cn3sGnBe`。用接口读出三个页签（关键词 `tbl8XlaVkRtWoi5i` / 人群 `tbln0U2ocO3MvSIn` / 商品信息底单），逐字段（含顺序）与 1 部完全一致（78 / 74）⇒ 只换 token，写入逻辑不动。与商品链 2026-09-30 换 base 同一条纪律。

**改了什么**

- `runtime/feishu-targets.mjs`：登记 `2026-10:sales2`；**删掉** `department` 默认值（漏传当场抛，报错点名该传什么）；`assertPromotionDailyBaseCoverage` 新增「不同部门不许指向同一个 base／同一张表」的跨条目检查。
- `runtime/batch-plan.mjs`：`WORKFLOW_DEPARTMENTS` 从 `SHOP_DEPARTMENTS` 推导全部部门（原先写死 `['sales1']`，是因为二部 base 还没登记；现在登记了，收窄就没有理由）。
- `skills/…/run-promotion-sales1.mjs`：`SALES1` 字面名单 → `collectingShopKeys()`（字面名单是第二份真相源，加店/换店时它不会自己变，症状是「新店永远不在推广链里」且不报错）；判据改成「在采集范围里」，仍 fail-closed 并点名是哪几家。
- `skills/…/import-promotion-daily-report.mjs`：按 `departmentOfShop(--shop)` 解析部门再查 base；回执新增 `department` 与 `baseToken`（出事时第一眼看这两个字段）。
- `skills/…/check-promotion-completeness.mjs`：对账门改成「按部门各读一张表再合并」。原实现只读一张表，二部接入后那些行在另一张里，只读一张会把二部每个单元判成「飞书里没有」—— 这种假缺口会让人去重跑已经写对了的数据，而重跑因幂等键一行都不写，看起来像又失败了一次。
- `scripts/run-batches.mjs`：不点名时按 `batchableShopKeysFor(workflow)` 切批的那一行保留，并更正它的注释 —— 它管的是「哪条 workflow 认哪些部门」，不是「推广链恰好只跑一部」。

**验证到什么程度**

- 真机：5 家店铺全部解析成 `sales2`；目标三项与 1 部全部不同；两张表用 rcnb 凭据可读 78 / 74 字段；`19063` 保拉淘宝 `--locate-only` 身份校验 + 关键词报表页 + 人群报表页双过（不提交）；真实 zip 打二部 base 的 dry-run —— `department=sales2`、关键词 68 行/75 列、人群 83 行/73 列、11 个主体ID（回执 `evidence/promo-dryrun-sales2-2026-10-26/receipt.json`）；`--plan` 展开 13 家且顺序与 `SHOP_BROWSERS` 一致。
- 离线：日报技能 27 个文件 **661/661**（改动前后同数）；runtime 相关 8 个文件 62/62，另 6 个编排/告警/端口/汇总契约文件 156/156；`arch-boundary` / `workflow-catalog` / `hold-and-resume-plan` 共 65/65。
- **没验到的**：真写一行 —— 二部两张表各只有 1 行 2026-09-28 的试写数据（花费 0.46 元、1 次点击），真实业务日首写要等下一次 11:00 轮自己证明；五家里只逐个验了保拉淘宝一家的报表页。
- 详情：`evidence/promotion-sales2-wiring-2026-10-26/RUN-REPORT-2026-10-26.md`（同文另记「三链共用 `evidence/batches-<日>`，轮级文件后写覆盖先写」的现场量测，以及停掉 10-25 那一轮驻留的过程与判据）。

## [1.12.21] - 2026-10-24

CI 连续红灯分层修复：统一 Python 解释器、补齐千牛登记、修 CRLF 守卫，并清掉依赖恢复后才会暴露的下一层测试缺陷。

**为什么改**

- 最新 CI 的表层是 Pillow 安装失败，实际机制是 `py -3` 随 runner 漂移到了 Python 3.15；skill job 又用另一个 `python` 二次安装，安装步骤假绿，测试仍回到缺依赖的 3.15。搜索排行因此缺 openpyxl，竞品 Python 用例失败后还引发长时下游等待。
- 历史红灯里还压着三个独立缺口：`qianniu-kefu-chat` 有测试但没进 CI 矩阵、`KEFU_WEEKLY_OK/FAILED` 没进告警闭集、日报取件守卫在 CRLF checkout 下反向自证失效。只修依赖会把这些红灯留到下一轮。
- 本地放大验证又发现：1.12.20 的 window-bounds 两条旧夹具仍假设 `about:blank` 是业务页；审计守卫先把全部证据文件名读进默认 1MB 缓冲区再过滤，证据较多时以 ENOBUFS 假红。它们属于依赖恢复后必会遇到的下一层问题，本版一并收口。

**改了什么**

- 两个 CI Job 都用 `actions/setup-python` 固定 CPython 3.12；只执行一次 `python -m pip install`，随后用同一 `python` 真实导入 openpyxl / Pillow / python-docx。workflow 显式给 `PYTHON` / `SYCM_PYTHON` / `XWS_PYTHON=python`。
- 四个技能导入解析点、`check-fast`、`run-affected-tests` 共 6 处：显式覆盖 `PYTHON` 时不再附加 `-3`；未覆盖的本机默认 `py -3` 行为不变。新增发现式守卫扫描全部同类调用点。
- CI 矩阵加入 `qianniu-kefu-chat`；告警闭集登记两个客服周采集 type，标题仍由调用方显式给，不新增第二份通用标题。
- `promotion-fetch-wait.test.mjs` 4 处源码读取统一 LF 归一化；`date-picker.test.mjs` 的 aim 扫描同步归一化，并补 `aimEnd > aimStart`，防止边界没找到时退化成扫整份文件。
- window-bounds 夹具改用一个真实业务 URL 走 websocket 失败分支，并直接覆盖“只剩 edge:// 内部页”分支；审计守卫改用 `execFileSync` + Git pathspec，在 stdout 生成前排除 evidence，不改变“已跟踪 + 未跟踪非忽略代码”的扫描口径。

**同族与攻击包**

- `docs/ops/REPAIR-PROTOCOL.md` 新增族 E（解释器漂移与覆盖参数错接）、族 F（CRLF 源码扫描）、族 G（新能力登记缺口），逐点写明已修与不适用边界。
- `tmp/mutate/mutate-2026-10-24-ci.mjs` 6/6 通过：新配置 + CRLF 全绿；旧 CI、旧 Python 调用点、未归一化守卫均 RED_NAMED。M6 首轮 GREEN_BAD，暴露遮挡守卫缺边界存在断言；补断言后复验才通过。
- `tmp/mutate/mutate-2026-10-24-viewport.mjs` 复验 3/3 RED_NAMED；window-bounds 新夹具没有削弱原攻击面。

**验证到什么程度**

- 本地全量语法：831 个 JavaScript 文件 + 16 个 Python 文件 PASS（显式使用 CPython 3.12.9 覆盖，输出 `tmp/ci-check-fast-python-override.log`）。首次 120 秒预算截断记为 INCOMPLETE，延长到 2 分 12 秒跑完后才记通过。
- 按 CI 入口：runtime **1434/1434**；日报技能 **651/651**；商品 **16/16**、询单 **32/32**、推广 **60/60**、搜索排行 **42/42**、千牛客服 **24/24**；竞品 Python 定向 **8/8**。原始 TAP 在 `tmp/ci-*-after.tap`。
- 定向基线最初为 39/41，两个失败分别是千牛告警与矩阵漏项；修后相关定向 96/96。新暴露的 window-bounds / 审计 / date-picker 复验 64/64。
- 以上是本地离线判据，不含真机，也不预写 GitHub Actions 已通过；远端结论以本提交推送后的实际运行记录为准。未把竞品完整技能套件写成本地已跑，本轮只跑了上述 8 条 Python 定向用例。

## [1.12.20] - 2026-10-24

交付前收尾：视口「读错对象」族（㊽）修复 + 商品推广采集脚本剩余固定 sleep 点判定完毕。

**为什么改**

2026-10-24 11:35 推广补跑批次 viewport-gate 退 2（盖文天猫视口宽 360）。当日 17:05 定因：Edge 的「下载」浮窗 `edge://downloads-hub/` 是独立的 `type=page` target（视口恒 360x154），取件段每次真点下载都会留下它，而 `/targets` 顺序不保证——旧判据「第一个非 devtools 的 page」在浮窗排第一时把它当成采集页。同族第二处在 `browser-window-bounds.mjs`（会拿浮窗的窗口 ID 去 setWindowBounds）。这是「读错对象」族：不是视口真的窄，是读的根本不是那张页。

**改了什么**

- `browser-ports.mjs` 新增共用判据 `isWebPage(target)` / `pickWebPage(targets)`：排除 `devtools://` `edge://` `chrome://` `about:` 与空 URL；`file://` 店铺标识页与业务站保留（否则冷启动首屏读不到视口）。
- `shop-viewport-gate.mjs`：页签选择改走 `pickWebPage`；读数新增 `pageUrl`/`pageTitle` 落证据（再出问题不靠复现定因）；只剩内部页时判 `VIEWPORT_UNREADABLE` 且一次 /eval 都不打。
- `browser-window-bounds.mjs`：选页改走同一份 `pickWebPage`（同族第二处，不许只修闸门）。
- `collect-product-report.mjs` 剩余 sleep 点逐个上下文判定：`navigateDownloadList` 的 `sleep(5000)` 属导航封装内等待（读取侧已由 `pollReportReady`/`pollNewProductTask` 轮询覆盖），`sleep(2000)` 在下载等待 while 循环内，均**不适用**，无代码改动。

**没动什么（交付前夜的刻意保留）**

- `collectProductReport` 的 knownRisk（重试第 2 次起导航空操作）：文件属另一会话未提交改动，且改商品链行为需要真机证据；有 clickDayExpr 轮询兜底，非交付阻断项，列交付后第一批。
- 登录链、驻留恢复闭环、run-batches 欠账、内存闸进代码：架构项，全部列交付后 roadmap，不在交付前夜动。

**验证到什么程度**

- **仅离线判据，真机未验**（下一轮三链首跑即判据）。相关用例全绿：shop-viewport-gate 16（新增 4）、browser-ports 22、start-all-launch-source 3、stop-all-release-readback 4、launch-plan 20、browser-inventory 18、arch-boundary 3、head-loadable 1，合计 87；交付前复验另含 version-consistency 6，总计 **93/93**，原始输出 `tmp/verify-1.12.20-targeted.tap`。
- 攻击包 `tmp/mutate/mutate-2026-10-24-viewport.mjs`：M6（闸门退回第一个非 devtools page）/ M7（window-bounds 退回第一个 page）/ M8（isWebPage 不再排除 edge://）全部 **RED_NAMED**，复验输出 `tmp/verify-1.12.20-viewport-mutations.txt`。
- 未跑 `npm run test:staged`：AGENTS.md 明确机器即将交付时不启动该长时套件；本轮以上述定向用例与攻击包为判据，不把它写成全量通过。

## [1.12.19] - 2026-10-24

读侧收口第一批：同族三族（固定 sleep 单次读 / 判据字符串多拷贝 / 导航后读页面的扫描盲区）合并清算，全程按 `docs/ops/REPAIR-PROTOCOL.md` 的四件套执行。

**为什么改**

- 首扫确认 `collect-shop-report.mjs` 回位后 `delay(6000)` + 单次读身份，与 10-21 修掉的 produceTask `sleep(6500)` 同机制：页头 SPA 异步渲染，固定 6 秒在慢现场读到空 ⇒ 身份断言 fail-closed 拦下，整店失败。
- `当日询单人数` 列名至少 3 处手工字面量（inquiry-core 两处 + backfill 页面表达式一处），平台改列名漏一处即静默漂移。
- `navigate-read-guard` 的 NAV 只认 `navigateTo(` 与 `/navigate?target`，本地 `navigate()` 封装调用不算导航点 ⇒ `collect-shop-report` 的 `run()` 从未被要求表态。扫描盲区比漏登记更危险：它让「没表态」看起来像「没这个问题」。

**改了什么**

- `collect-core` 新增通用 `readPageValueSettled(read, { isPresent, attempts, intervalMs, delay })`；`readAlimamaIdentitySettled` 改薄封装（行为逐字不变，含原参数校验措辞）。
- `collect-shop-report` 回位读身份改有界轮询（12×1s），**不做真重载**（hash 路由页有丢 hash 前科，依据写在代码注释）；`assertShopIdentity` 的 fail-closed 语义不变。
- `inquiry-core` 新增 `DAILY_INQUIRY_COLUMN` 唯一来源；`run-inquiry-backfill` 页面表达式与产物 `column` 字段全部展开常量，不再抄字面量。
- `navigate-read-guard`：NAV 扩到本地 `navigate(` 封装；新扫出的 4 个函数逐个登记（`run` 主修 + `readback main` / `run-promotion-daily-report main` / `date-picker resolveTarget` 各写依据）；新增 `run` 扫描用例防 NAV 回退。
- `report-ready-core` 注释里的旧代码示例改为非调用形态（避免被当成顶层导航点）。

**同族清单（规程三问之一）**

- 固定 sleep 族：`collect-shop-report delay(6000)` 已修；`readback-daily-report` 的 delay(2000/1500)、`run-promotion-daily-report` 的 sleep(2500/1800/5000)、`collect-shop-report` 其余 delay 经逐个上下文核对为轮询间隔或动作缓冲，**不适用**；`collect-product-core`（他人会话在改，未碰）与 `collect-product-report` 的剩余点**挂起待判**。
- 判据拷贝族：`当日询单人数` 已收敛；`询单人数`（sycm-inquiry-data）1.12.16 已收敛；其他词表未扫。
- 重载缺失族：本版本以「导航+读」全量表态替代逐点重载；`collectProductReport` 的 knownRisk 仍未修（他人会话文件）。

**新条件组合（规程三问之二）**

- 轮询预算内若页面始终无页头，失败时机从约 6s 推迟到约 12s；报错仍由 `assertShopIdentity` 抛出，措辞不变。
- 身份读取前新增一行日志（第 N 次读到 / 仍读不到），不改任何收据字段。

**验证到什么程度**

- **仅离线判据，真机未验**。下一轮 08:00 日报链首跑即判据；身份轮询段新增日志可直接核对。
- 用例（定向，全绿）：collect-core 52、inquiry-core 21、navigate-read-guard 9、report-ready-core 13、promotion-fetch-wait 7、collect-failure-scene 5、date-picker 44、run-multi-shop-day 152、daily-report-core 11、promotion-daily-report-core 22、collector-arg-contract 7、head-loadable 1、arch-boundary 3，合计 **347 条**（含跨文件合计口径；单文件顶层 test 数逐文件如上）。
- 攻击包 `tmp/mutate/mutate-2026-10-24-read-side.mjs`：5 个突变全部 **RED_NAMED**。其中 M5（阿里妈妈身份判据丢掉 memberId 那一半）首轮 **GREEN_BAD**，暴露「只有会员 ID 没有会员名」这一语义从无覆盖，已补用例并复验转 RED_NAMED。
- 未跑 `test:staged` 全量（skill 实现变更会拉起含长时 e2e 的套件，本机历史实测 7.6h）；以定向套件为判据。

## [1.12.18] - 2026-10-24

修「推广取件段把『没读到列表』当成『列表里没有这个任务』」—— 第三次同族缺陷（前两次是 ㊹ 询单页判据、㊹b 词表两份）。

**为什么改**

2026-10-24 11:00 轮（目标日 2026-10-23）盖文天猫整店 STAGE_FAILED，报
`取件前核对未通过：--task 指定的 关键词报表_20261024_111611 不在列表里（列表里没有任何任务名形状的条目）`。
真机复核：该任务在「下载任务管理」里「生成成功 / 2026-10-23至2026-10-23」，台账两笔（keyword 03:16:30、audience 03:16:49）
都是提交段确认「多出一条」之后才记的 —— 任务存在，是取件段读不到。

根因在判据层，不在平台、不在提交：`reloadAndSettle` 只等到 `readyState=complete`，而任务表格是**那之后**异步拉的；
`openTaskList` 上一版只补了「hash 路由丢了」这一种情形，其它 0 行在 5×2s 预算耗尽后把空数组交出去，
`judgeFetchCandidates` 于是把空集说成「没有任何任务名形状的条目」。**空集与「真的没有」被混为一谈。**

**改了什么**

- `openTaskList` 每轮先探一次页面就绪状态（`probeListPage`：tr 数 / 表头文案 / 报表任务名种类直方图；
  判据只用页面文案，不碰 webpack 哈希 class 名），再交给纯函数 `classifyListRead` 出三种结论：
  `not-ready`（表格没渲染）/ `empty-of-kind`（就绪但这一类 0 条）/ `ready`（有行）。
- 预算 5×2s → 8×2.5s（约 20s）；表格迟迟不渲染时点**一次**「刷新表格」（`!nudged` 钉住只点一次）。
- 收尾：`not-ready` / `unknown` 一律**抛错**，措辞自证「这是没读到，不是列表里没有这个任务」，并带上
  href / title / tr 数 / 种类直方图；只有 `empty-of-kind` 才老实返回空数组。
  **这条链不再替平台下「任务不存在」的结论。**
- `run-promotion-sales1.mjs`：失败阶段的 stdout/stderr 落 `<--logs>/<店>/stage-<kind>-<phase>.txt`。
  本轮根因之所以只能靠复现，是因为失败店的阶段输出被 `spawnSync` 吞掉、证据目录从来没建过
  （只有 importer 会建目录，失败的店永远到不了 importer）。

**验证到什么程度**

- 跑过真机：11:27 用链路原样参数单跑盖文天猫 keyword-fetch，成功落到 `关键词报表_20261024_111611.zip`；
  11:35–11:47 补跑 4 家（盖文天猫 / 网林淘宝 / 里可林天猫 / 网林家居），2/2 批全绿、整轮退出码 0，
  证据 `evidence/promotion-batches-2026-10-23-resume/`，回执 `execution=SUCCEEDED`。
- 独立回读：317 条 recordId 全部命中、缺失 0、日期不符 0（keyword 177 / audience 140）。
- 离线定向用例 122/122 绿（promotion-fetch-wait / navigate-read-guard / promotion-task-ledger /
  collect-core / collector-arg-contract / promotion-daily-report-core / failure-perception）。
- 突变 3/3 转红：M1 去掉「没渲染就抛」、M2 去掉 not-ready 分支、M3 删掉循环里那次重探。
  其中 M3 第一次**没有转红** —— 守卫只查 `includes('probeListPage(')` 没数出现次数，
  已改成数次数（与「多拼接点的守卫必须数出现次数」同一条教训）。
- 未跑 `npm run test:staged`：选到这个 skill 的实现改动会连带跑整套 e2e（AGENTS.md 记 7.6 小时），
  本轮只跑上面那组定向用例。

## [1.12.17] - 2026-10-23

修「推广收据被批覆盖」，并给一条**既有红灯**补登记。这一版不改采集行为，改的是「写进去多少行」这件事**能不能被读对**。

**为什么改**

1.12.16 那轮 8 店 3 批跑完，完成提醒写「商品推广 17 行」，而独立回读三张表真值是 117 行。
差的 100 行不是没写进去 —— `import-promotion-data.mjs` 把收据固定写成 `--evidence` 下的 `receipt.json`，
而分批形态下**每批都用同一个部门目录** ⇒ 后一批覆盖前一批，只剩最后一批（`sources` 里只有里可林天猫 17、网林家居 0）。

收据内容是对的、落点错了，两头都静默：写的时候不报错，读的时候也不报错，只是数字变小。
而完成提醒是给业务人员看的唯一数字来源。

**改了什么**

- 链（`scripts/run-product-data-job.mjs`）在分批时把推广的 `--evidence` 下沉一层 `b<N>`
  （与 `collection-b1.json` / `release-b1.json` 同一套命名）：`promotion-import/<部门>/b<N>/receipt.json`。
  两条支路（部门批量、逐店兜底）都走同一个 `promoEvidence()`，不许各拼一份。不分批时不加这一层（一次性运行没有覆盖问题，也不动既有证据布局）。
- 取数（`runtime/flow-ok-facts.mjs`）新增 `promotionReceiptFiles(dir)`：目录直下的 `receipt.json`（老工件）
  与 `b<N>/receipt.json`（分批）都认；逐店收据多份时求和，部门收据逐个文件按 `sources[].shop` 归属。
  老工件没有 `sources` 时整份算一次，键里带批次目录名 —— 否则 b1/b2/b3 撞同一个键、只算第一份。

**顺带**

- `runtime/arch-boundary.test.mjs` 的 `RUNTIME_TO_SKILLS` 补登记 `runtime/daily-job-plan.test.mjs`。
  这条是**既有红灯**：该文件自 2026-10-20 起没动过，`--allow-empty-promotion` 那次加参数时漏登记，
  此后 arch-boundary 一直是红的（本轮开始修时就复现了，不是新改动引入）。理由写进登记处：
  它取 `buildShopStages` 当**裁判**，验「链传的参数对面真的收下」。

**验证到什么程度**

- 新增用例：`flow-ok-facts.test.mjs` 加两条（三批 16+30+28+15+11+0+17+0 = 117 必须读成 117；
  同一家出现在两份收据时不翻倍）；`product-data-import-outcome-wiring.test.mjs` 加两条接线判据
  （分批时 `--evidence` 必须带批次段、两条支路都要走它；读取侧必须认得 `b<N>` 这一层）。
- 突变：M6（去掉 `tag` 段）+ M7（读取侧不认 `b<N>`）⇒ 三条用例变红并点名（共 28 条里 3 红）。
- 离线：`flow-ok-facts` 17/17、`flow-ok-notice-wiring` 6/6、`product-data-import-outcome-wiring` 11/11、
  `arch-boundary` 3/3。
- **真机未验**：下一轮 10:00 定时任务是这条改动的第一次真跑（判据＝完成提醒的推广行数与独立回读一致）。

## [1.12.16] - 2026-10-23

把询单采集的**判据**从「文案在不在」改成「报表在不在」，并且**收掉了词表的第二份拷贝**。
这一轮询单在 2026-10-22 的目标日上从 0/8 走到 8/8，商品/推广同时补齐。

**为什么改**

1.12.14 引入的插值 bug（`READ_PAGE_STATE` 写成双引号）已在 `03b1e9c6` 修掉，但修完之后询单**仍然 8/8 失败**，
报「页面状态不满足：`{"hasInquiry":true,"link":"","downloadBtn":0}`」。三个原因叠在一起，每一个单独看都像「页面没渲染」：

| # | 现象 | 真因 |
|---|---|---|
| ① | 轮询 21 次、`link` 恒空，从没点过「商品分析」 | 进循环前那道闸门用的词表里还有 `统计时间`，而**每个生意参谋业绩页都有「统计时间」** ⇒ 总览页就被判成「已在询单页」⇒ 循环一次都没进 |
| ② | 父菜单展开后仍判 `done` | `isInquiryPage` / `planEntryPollStep` 把 `hasInquiry`（左侧「商品咨询分析」文案）当「报表已加载」，而父菜单一展开这行文案就在，报表还没拉 |
| ③ | 同一实例里两个 sycm 页签，读到哪个不确定 | 「取第一个 sycm 页签」会读到商品排行 `/cc/item_rank` —— 它左侧导航同样有「商品分析 → 商品咨询分析」，但没有导出按钮 |

**改了什么**

- 词表只有一处：`collect-inquiry-report.mjs` 不再自己写一份 `PAGE_MARKERS`，改为导入 `inquiry-core.mjs` 的
  `INQUIRY_PAGE_MARKERS`（收窄为 `['询单人数']`）。①的直接成因就是两份拷贝不同步。
- `isInquiryPage` 只承认两件报表级事实：专属列名「询单人数」、`a.lowcode-service-download-btn` 在场。
  `statDate` 与 `hasInquiry` 退出判定（前者总览页也有、后者父菜单展开就有）。
- `planEntryPollStep` 增加 `click-entry` 三态：文案在但报表没加载时**必须真点开子项**，不再 `done` 收工。
- 新增 `pickWorkPage()`，任何读页面处都锁 `/performance` 业绩页，找不到才退回第一个 sycm 页签。
- 导出地址的取法改了：平台不再把 URL 放在 `props.link` 上，真机只读探针在祖先 `cacheParse` 里找到
  `/csp/api/cst/item/shop/list/export.json?...startDate=...`，改为沿祖先链扫字符串 props。
- 新增纯函数 `alignExportUrlDate(url, date)`：页面带的是「当时页面那一天」，补跑别的日期时必须把
  `startDate/endDate` 对齐到目标日，否则导出的是错日文件，而导入端去重键是（统计日期+商品ID）⇒ 写进错日。

**守卫（都做过突变验证）**

- 上一版守卫断的是「源文件里有 `${PAGE_MARKER_EXPR}` 这串字」—— 而双引号里那段字**正因为不插值才原样存在**，
  等于把 bug 当合规证据（㊹）。现在取字面量 → 真绑定求值 → `new Function` 解析 → 逐词核对正文变量名。
- 这一轮又抓到同族的第二个洞：守卫只查「词表里每一项在源文件出现过」（单向 `includes`），
  **查不出多出来的项**。新增两条：① 采集脚本不许再声明本地 `PAGE_MARKERS` 字面量、必须导入；
  ② 真去执行脚本里 `markersExprOf` 的定义体（把 `INQUIRY_PAGE_MARKERS` 绑成标准值），比对它算出的表达式
  与标准词表逐字一致。突变 M5（把 `['统计时间','询单人数']` 抄回去）⇒ 第 14 条 RED_NAMED。

**验证到什么程度**

- 离线：`skills/sycm-inquiry-data/scripts/*.test.mjs` 32/32、`runtime/product-data-collect-gap-reason.test.mjs` 8/8。
- 真机（构造失败现场）：起里可林淘宝实例 → 把页签导航到业绩总览页 → 直接跑采集器。
  第 1 轮读数 `pageMarker:false / downloadBtn:0 / statDate:2026-10-22`（旧判据会在这里直接放行）⇒ 进循环；
  第 2 轮 `pageMarker:true / downloadBtn:1` ⇒ 落盘 14848 字节，`startDate=20261022`。
- 真机（整链）：`2026-10-22-20261023065935071-57adaa13`，8 店、3 批、退出码 0，
  三段各 8/8，独立回读新增 询单 45 行、推广 117 行，26 个店铺端口两遍回读全 free。

**已知未修（本轮记录，未擅动）**

- `promotion-import/sales1/receipt.json` 是**单个文件按批覆写** ⇒ 只留最后一批（本轮 `plannedRows=17`），
  完成提醒里的「商品推广 17 行」因此比真实写入（回读 117 行）小。判写入只认独立回读。

## [1.12.15] - 2026-10-23

把「导航之后读页面」这一族事故**盘一遍并钉成守卫**。这不是一次 bug 修复，是一次把反复重查的东西变成机器能拦的检查。

**为什么现在做**

同一个坑（同 URL 的 navigate 是同文档导航、浏览器什么都不做）本项目已经踩过五次，每次表现都不同：

| # | 时间 | 现场 | 当时怎么发现的 |
|---|---|---|---|
| ① | 2026-09-21 | date-picker 设完日期再读，读到的还是旧日期 | 手工核对导出区间 |
| ② | 2026-10-12 | 提交确认循环反复读到同一屏 | 日志里同一行重复 |
| ③ | 2026-10-22 | 共享取件 `openTaskList` 判无候选 → 换通道补提交 → 「核不清」→ 整店 STAGE_FAILED | 五条证据链（见 1.12.12） |
| ④ | 2026-10-23 | 重载有效但表格是**重载之后**异步拉的，紧接着读得 0 行；偶尔重载还丢 hash 路由落回首页 | 科塔淘宝真机两次（`ffa39c60` 补的） |
| ⑤ | 2026-10-23 | 本次盘点新发现：`collectProductReport()` 每次 attempt 都导航到同一个 `ITEM_RANK_URL`，第 2 次起 URL 已相同 ⇒ 空操作 ⇒「重试换一张干净的页」这个设计目的不成立 | 静态盘点 |

每次都在「重新查一遍这个坑」上花时间，因为没有任何东西会提醒下一个人「这里也要想一遍」。

**改了什么**

新增 `runtime/navigate-read-guard.test.mjs`（8 条用例）。它**不判断「该不该重载」** —— 那需要运行时的当前 URL，静态判不了。它管两件能机器核对的事：

1. **表态完整性**：扫全仓生产 `.mjs`（排除 test / node_modules / evidence / tmp / `*-runs`），凡「函数体内既导航又读页面」的函数，必须在 `REGISTRY` 里有一条。新增同类函数忘了想 ⇒ 直接红，报错里点名文件:行号 + 函数名，并现场教五种登记形式（`reload` / `poll` / `why` / `wrapper` / `knownRisk`）。
2. **声明与代码一致**：`reload: true` 的必须真有 `reloadAndSettle`/`reloadListPage`；`poll: 'xxx'` 的必须真调那个轮询；`why` 少于 8 字视为没写；`knownRisk` 必须带盘点日期。登记表过期（函数改名/删掉）也红。

同时钉住扫描器本身的两个坑，各一条用例：① 必须**先跨过参数列表**（参数里 `{ settleMs = 7000 } = {}` 这种解构默认值会让「从第一个 `{` 起算」切出参数当函数体 —— `openTaskList` 因此从这个清单里整个消失过一次）；② 必须认字符串与注释（模板串里的 `}` 会让切体提前收尾）。

**盘点结果（22 个含 navigate 的函数）**

- 6 个纯导航封装（各 skill 的 `navigate()` / `navigateTo()` / `navigateDownloadList()`）⇒ 登记 `wrapper`。
- 3 个已修或有替代：`openTaskList` 真重载（③）、`submit` / `produceTask` 用 `pollNewProductTask` / `pollReportReady` 有界轮询。
- 7 个只读 `location.href` / `/targets` 列表 / HTTP status，不读页面内容 ⇒ 重载是多余副作用，登记 `why` 写清依据（`siteLoggedIn`、`ensureLoginPage`、`parkTabOn`、`resetSycmPage`、`ensureTable`、`ensureLabelTabOn`、`sendRequests`）。其中 `parkTabOn` 已显式跳过同 URL。
- 1 个自带一致性检测：`searchKeyword` 反复读输入框值与关键词比对，不匹配就重设。
- **1 个真实风险，未修**：`collectProductReport()`（⑤），登记为 `knownRisk` 并把理由写在表里 —— 写下来是为了不让它消失，不是为了把它标成没问题。

**验证到什么程度**

- 守卫 8/8 全绿。
- 突变 M1（在 `skills/` 下建一个临时文件，造一个未登记的「导航 + 读页面」函数）⇒ 第 4 条转红并**点名到该文件:行号 函数名**；删掉临时文件后回绿。
- 突变 M2（按行号删掉 `openTaskList` 里那行 `reloadAndSettle`）⇒ 第 5 条（声明与代码一致）与第 8 条（反向自证）同时转红；`git checkout` 还原后回绿。
- 突变 M2 第一次跑时暴露出守卫自己的一个耦合：第 1 条「切体自证」原来断言 body 里有 `reloadAndSettle`，于是「删掉业务代码」会顺带把「切体对不对」也判红。已改成断言 `readTaskRows`（函数体自己的调用），重做 M2 后第 1 条保持绿、只第 5 条红。**这一步是这次唯一被自己的验证改到的地方，记在这里免得以「一开始就写对了」的口气糊过去。**
- 仅有离线判据。`knownRisk` 那条（⑤）需要真机证据才能改，不能拿离线绿当修好了。

**升级提示**：往仓库里新增「导航后读页面」的函数时会多一条红，这不是误报 —— 它是要求你在 `REGISTRY` 里写一句依据。

## [1.12.14] - 2026-10-23

询单链两处判据修复：**「在不在询单页」不再靠 Tab 文案**、「导出链接」不再只读一次。加上同一天商品链那批（1.12.13），本项目「把读不到当成没有」这一族的四个出口全部拆掉。

**改了什么**

1. `skills/sycm-inquiry-data/scripts/inquiry-core.mjs`：
   - `INQUIRY_PAGE_MARKERS` = `['统计时间', '询单人数']`，`hasInquiryPageMarker` / `isInquiryPage` / `readStatDate`。判「到没到询单页」只认**报表本身的结构特征**（任一出现即可），Tab 文案「商品咨询分析」保留但只是其中一条、不再单独承担判定。
   - `planLinkPollStep` + `pollInquiryLink`：导出链接改**有界轮询**（20s / 1s），`done` 拿到即结束、`wrong-date` 立刻失败（真错，等下去不会变）、`wait` 继续等。超时不抛，把最后读数与读次数交回。
2. `skills/sycm-inquiry-data/scripts/collect-inquiry-report.mjs`：
   - 入口判定改调 `isInquiryPage`（进循环前 + 循环体内每轮各一次），「要不要点父菜单」仍由 `planEntryPollStep` 决定 —— 两件事分工不同，不再共用一条判据。
   - `READ_PAGE_STATE` 与 `READ_ENTRY_STATE` **共用同一份结构词表**（`PAGE_MARKER_EXPR` 由 `PAGE_MARKERS` 展开）。
   - 身份判据用 `String(state.shop ?? '')` 兜住：轮询可能一次都没读到页面（页签消失），原写法会抛 `TypeError`，把「页签没了」伪装成脚本崩溃。
   - 轮询读次数进报错文案，把「根本没读」和「读了十几次还是空」分开。

**为什么改**

- **入口判据测的不是位置**。2026-10-22 里可林天猫的失败现场（`inquiry.xls.failure.png`）证明：页面**已经进了「商品咨询分析」标签、数据也渲染了**（统计时间 2026-10-21、三个 Tab 都在、下载按钮在、表格 4+ 行），而整页 `innerText` 里**一次「商品咨询分析」都搜不到** ⇒ 判据自己判负、轮询空转 30 秒，失败文案还写「找不到商品咨询分析入口」，把人指到「入口没渲染」上。平台一改文案或改成图标+tooltip，这条判据就静默失效。
- **同一病根有两个出口**。`READ_PAGE_STATE` 里也写着 `hasInquiry:text.includes('商品咨询分析')`；只修入口那处，入口放行后会立刻在「页面状态不满足」上再红一次，看起来像换了个新毛病。
- **「入口 DOM 出现」≠「数据请求完成」**。2026-10-20 网林家居：入口找到、身份对、统计日期对、「日」按钮也在，唯独 `link` 是空串，而原脚本只读一次就判死。`link` 取自 React fiber 的 `memoizedProps.link`，要等报表数据请求回来才会被填。**19 分钟后同一家店、同一条命令就成功了（link 有值、8 行写入）** —— 这是竞态而不是配置问题的铁证。

**验证到什么程度**

- 离线判据：询单链定向 **48/48** 全绿（`inquiry-core` + `inquiry-link-poll` + `inquiry-link-wiring` + 失败感知）。
- 四条守卫钉的是**调用侧**，不是纯函数自己：① 页面侧词表与 node 侧 `INQUIRY_PAGE_MARKERS` 逐字互锁；② `READ_PAGE_STATE` 不许退回只认文案的旧写法；③ `isInquiryPage` 至少要在「进循环前」和「循环体内」各调用一次（这条是 2026-10-22 突变验证 M1 暴露的洞 —— 把调用点改回 `planEntryPollStep(...) !== 'done'` 时，纯函数用例照样全绿）；④ 循环体每轮必须重判。
- **仅离线判据**：本版提交时未重跑真机。上面引用的两处现场都是失败当时的取证，不是修复后的验证。

## [1.12.13] - 2026-10-23

商品数据链的一批**判据修复**：把「读得太早 / 读得太窄」当成「平台上没有」的四处病根逐个拆掉，并把告警业务段改成点名到店到段。这批改动发生在 2026-10-19 ~ 10-22，此前一直留在工作区未提交、也未登记版本；本版一次性收口。

**改了什么**

1. `skills/sycm-promotion-data/scripts/report-ready-core.mjs`（新）：报表页就绪判据 + 有界轮询 `pollReportReady`。`ready` = `.mx-trigger` 里已能看到「维度」触发器（就是要点的那个元素本身），`table` = 骨架在长，`empty` = 还没开始画。**不要求表格有行** —— 某店当日 0 投放是合法形态，要求有行会把「确实没数据」判成「没就绪」。
2. `skills/sycm-promotion-data/scripts/download-entry-core.mjs`（新）：下载入口候选的**排序 + 失败描述** `rankDownloadCandidates` / `describeDownloadFailure`。文字「包含」下载即算候选，精确相等只用于排序；尺寸 >0 且中心点在视口内才入选；命中判定一律交给浏览器 `elementFromPoint`，不在 node 侧做几何推算。
3. `skills/sycm-promotion-data/scripts/product-report-core.mjs`：新增 `pollNewProductTask` —— 提交后**有界轮询**（30s / 2s）等新任务出现，一出现立刻返回，超时不抛、把最后读数交回调用方。把「读得太早」这一种成因从根上去掉。
4. `skills/sycm-promotion-data/scripts/promotion-core.mjs`：`validatePromotionReport` 认「每一行都是空行」为**合法的零数据形态**，返回 `{rows:0, empty:true, blankRows}`，不再抛「行列数与表头不一致」。只要出现一行既有长度又不等于表头，仍走原抛错分支 —— 截断的坏文件拿不到这张免死金牌。
5. `runtime/product-alert-copy.mjs`（新）：告警业务段文案抽成纯函数（`describeGapsByStage` / `describePhenomena` / `describeNextAction` / `plainFailureClass`），由 `scripts/run-product-data-job.mjs` 接线。业务段从「一句兜底 + 整段缺口原文」改成**按段点名「哪几家缺哪一段」**，动作段按失败分类给不同下一步。
6. `skills/sycm-alimama-daily-report/scripts/failure-perception.mjs`：`captureFailureState` 落盘前先 `mkdirSync(dirname, {recursive:true})`。商品链的 `logDir` 是 `<shop>/promotion-collect`，那个目录只有采到文件之后才会存在 ⇒ 提交阶段失败时根本不存在，`writeFileSync` 直接 ENOENT，现场 JSON 与人读文本一起丢。
7. `skills/sycm-promotion-data/scripts/import-promotion-data.mjs`：认第 4 条的 `verdict.empty`，写入 0 行并记 `emptyReport`，汇总时单独列 `emptyReports`（不算缺口）。

**为什么改**

四处现场各不相同，但病根同一条 —— 把「我们的读法不够宽/不够久」当成「平台上不存在」：

- 2026-10-20 里可林天猫报「商品报表任务下载入口不可见」，同一份现场里报表已渲染 35 行、URL 日期正确、遮挡层 0。旧判据压了三个窄条件（叶子节点 + 文字恰好等于「下载」+ 宽度>0），antd/React 页面把文字包进 span 就不成立。
- 2026-10-22 网林天猫：URL 日期完全正确，但整页只剩 257 个 DIV、1 个 TR、0 个「维度」字样 —— 报表骨架还没渲出来，就被「固定睡眠 6.5 秒 + 判据只跑一次」判死。
- 2026-10-19 网林家居：提交后只读一次列表，`before` 与 `after` 逐项相同、`added=[]`，链判「平台没生成新任务」。而「读得太早」与「平台真没受理」在那一刻长得一模一样，现场取证又恰好因目录不存在而失败（第 6 条）⇒ 这个判断当时谁也无法复核。
- 2026-10-20 网林家居：推广 ZIP 只有 596 B，解包是「78 列表头 + 一个空行」，Python `csv.reader` 为那个空行产出空数组 `[]` ⇒ 被「行列数不一致」判成坏文件，而批量导入会把整批（另外两家有数据的店）一起打掉。**平台导出零数据是合法形态，不是文件损坏。**
- 告警文案：用户原话「告警文案需要更加符合问题，而不是卡在第几步」⇒ 业务段点名到「哪几家缺哪一段」，动作段只在**确定**不用人动手时才说「这一轮不需要你在浏览器里做什么」（`HUMAN_REQUIRED` 时人恰恰得去点一下，那句安慰会把人拦住）。

**验证到什么程度**

- 离线判据（本次提交前在 2026-10-23 重跑，全绿）：`product-report-core` + `promotion-empty-report` + `download-entry-core` + `download-entry-wiring` + `report-ready-core` = **57/57**；`product-alert-copy` + `product-report-reuse-wiring` = **15/15**。
- 接线核对（不是只靠用例绿）：`download-entry-core` / `report-ready-core` 真被 `collect-product-report.mjs` import 并调用；`product-alert-copy` 真被 `run-product-data-job.mjs` import；`pollNewProductTask` 真在 `submit()` 里调用；`verdict.empty` 真在 `import-promotion-data.mjs` 里被认。
- **仅离线判据**：本版提交时未重跑真机。各条的现场证据在上面逐条指向的 `evidence/` 目录里，但「修完之后真机还犯不犯」要靠下一轮定时任务验证，不能拿离线绿当结论。
- 顺手清掉一处改动尾巴：`collect-product-report.mjs` 里新判据之后原有的 `if(!point)throw Error('商品报表任务下载入口不可见')` 已成不可达死代码，删除（行为不变，两行都在判同一个 `!point`，留着只会让下一个读代码的人不知道哪个生效）。

## [1.12.12] - 2026-10-22

修掉「推广取件段读到陈旧任务列表 ⇒ 假判无候选 ⇒ 走换通道补提交 ⇒ 判核不清 ⇒ 整店 STAGE_FAILED」这条链。核心只有一句：**同 URL 的 navigate 是同文档导航，浏览器什么都不做**。

**改了什么**

1. `skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs`：`openTaskList`（共享取件段读下载任务列表的唯一入口）在 `navigateTo` 之后、`readTaskRows` 之前补一次 `reloadAndSettle`，与提交段 `openFreshTaskList`（navigate + 真重载）对齐。
2. `skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs`：提交段 `recordSubmitted` 补传 `at`。此前两处都不传，`recordSubmitted` 的缺省是 `null`、取件段 `recordConsumed` 的 upsert 也落 `submittedAt:null` ⇒ 台账上「提交段写过」与「只取过件」长成同一张脸。

**为什么改**

2026-10-22 11:00 轮，8 家里 7 家成功，网林淘宝（目标日 2026-10-21）失败。提交段已确认 `关键词报表_20261022_113048`、`人群报表_20261022_113102` 生成成功并写进台账；取件段进来后只 navigate，读到提交后第一次渲染的旧列表 ⇒ 判「没有日期范围等于 2026-10-21 的任务」⇒ 走换通道补提交 ⇒ 补提交的差集基线同样是旧列表 ⇒ 抛「补提交结果核不清（看了 10 次）」⇒ 整店失败，飞书一个字没写。

四条证据把它钉死在取件段：① 报错来自补提交分支而非首提；② 同轮里可林淘宝在 b1 抛过一模一样那句、重试就过，所以「平台不接受补提交」不成立；③ 台账形态用真实模块复跑，唯一来源是驱动第 218 行不带 `at`，而它只在 `confirmSubmittedTask` 非空（要求 `status==='生成成功'` 且范围等于目标日）时才执行；④ 提交段有真重载、取件段没有；`git log -S` 追到 `59e418d`（2026-09-21）引入即无重载。

同一个坑本项目已踩四次：09-21 date-picker、10-12 提交确认循环、10-22 共享取件，加上本次。前三次修的都是「当时出事那条路」，共享取件这条没修 —— 这是「只在出事时才走的路径等于没修」的样本。

**验证到什么程度**

- 真机：平台上两条任务的现场核对为 `2026-10-21~2026-10-21`、状态**生成成功**（起窗口 + navigate + 真重载后读，17 行里两条都在）。
- 真机补跑：`run-promotion-sales1.mjs --date 2026-10-21 --shops 网林淘宝 --commit --notify` 退出码 0，五阶段全过，写入 kw 51 / au 33（证据 `evidence/promotion-sales1-2026-10-21-backfill/`）。
- 独立回读飞书：补跑 kw 51/51、au 33/33 日期全落 2026-10-21；当天 8 家合计 kw 303 / au 218，与 10-20 轮的 303 / 213 量级吻合。
- 离线判据：该技能定向 `644/644` 全绿。新增守卫两条 —— `promotion-fetch-wait.test.mjs` 断言 `openTaskList` 里 `reloadAndSettle` 必须落在 `navigateTo` 之后、`readTaskRows` 之前（带反向自证：删掉那行判据必须转红）；`collect-core.test.mjs` 把阿里妈妈侧 `reloadAndSettle` 计数从 2 改到 3 并写清第三条的理由。
- 突变验证：删掉新增的 `reloadAndSettle` ⇒ 上述两条守卫同时转红，还原后回到 644/644。

## [1.12.11] - 2026-10-20

把 1.12.10 的 `--allow-empty-promotion` **接进整条定时链**（此前只到叶子脚本 `run-daily-report.mjs`：命令行给不给它，整链都收不到，遇到 0 行仍停在第 7 步 push）。

**改了什么**

按 `--auto-repair` / `--relogin-on-wall` 走过的那条多跳链，逐跳接上：

1. `scripts/run-daily-job.mjs`：收下 `--allow-empty-promotion`，默认**关**，透传进计划。
2. `runtime/daily-job-plan.mjs`：加进 `CHAIN_FLAGS`（不分批那一路靠它自动生效）+ `buildBatchChainArgs` 显式转发（分批那一路不遍历 `CHAIN_FLAGS`，因为它只认其中一部分开关）。
3. `scripts/run-batches.mjs`：`parseArgs` 认它；`chainArgsFor` 转发给链；`buildBatchHoldArgv` 转发给驻留。
4. `scripts/hold-and-resume.mjs`：`parseArgs` 认它，`resumeArgvFor` 传给两个续跑出口。
5. `runtime/hold-and-resume-plan.mjs`：`buildResumeArgv` / `buildBatchResumeArgv` 都带上它。
6. `skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`：`parseArgs` 认它，`buildShopStages` 把它放进 `push` 步骤的 argv。

**为什么改**

1.12.10 只修到叶子。生产形态是 `--batches`，于是「命令行给了它、真正跑的那条路上一次也没生效」——这正是 `--auto-repair`（2026-09-29 补）与 `--relogin-on-wall`（2026-10-10 补）已经各栽过一次的同一种漏接，且症状都是静默的：日志里没有一行提示，表现只是「那一行永远缺着」，人会以为平台又没数据。

续跑这一跳也刻意接上：驻留续跑若不带同一口径，同一家店会在续跑里再撞一次同一道闸门 —— 而那一轮之所以进驻留，往往正是因为差这一下。

**默认仍关（三处都写了为什么）**

0 行有两种成因 ——「这家店当天真的没投」与「平台数据还没出／还没静止」——在 CSV 层面同形；同日早跑写进飞书的低值当天无法重推（只能先删那一天）。所以放行必须是人看过平台报表页之后的**说出口的决定**，程序不替人默认。

**验证到什么程度**

- 离线用例：`runtime/daily-job-plan.test.mjs` 86/86（新增 8 条接线判据）、`hold-and-resume-plan` + `run-batches-cli` + `batch-plan` 合计 166/166。
- 三条新判据的形状（不是「自己这边传了就算」）：
  · 计划层真调 `buildJobPlan`，断言 chain / batch-chain 的 argv 含/不含它；
  · 续跑层真调三个构造函数，并把 `buildBatchHoldArgv` 的输出**喂给 `hold-and-resume.mjs` 自己的 `parseArgs` 当裁判**（㊴ 那个坑的判据 —— 当年 `--notify` 就是「自己传了、对面不认」，驻留一个状态都没打印就退 2）；
  · 末跳真调 `buildShopStages`，断言 `push` 步骤的 argv 含它。
- 突变（证明判据不是空断言，两次都当场红、都已还原）：
  · 删掉 `run-multi-shop-day.mjs` 里 pushArgs 那一行 ⇒ 末跳用例 `not ok 66`；
  · 删掉 `run-batches.mjs` 的 `chainArgsFor` 那一行 ⇒ 第二跳用例 `not ok 63`。
- **真机命令行证据**（`--print`，打印出来的就是真正会执行的）：
  · `run-daily-job.mjs … --batches 5 --allow-empty-promotion --print` ⇒ batch-chain 那行结尾是 `… --auto-repair --relogin-on-wall --allow-empty-promotion`；不带时逐字不含。
  · `run-batches.mjs … --allow-empty-promotion --print` ⇒ 两批的 `run-multi-shop-day.mjs` 命令行都带 `--allow-empty-promotion`。
- 未跑 `npm run test:staged`（选中该 skill 的实现变更会跑整个 suite，7.6 h 且本机已知「跑完不退出」）；用上面的定向组 + 真机 `--print` 证据替代，没有用 `--no-verify` 绕过任何检查。

## [1.12.10] - 2026-10-20

推广 CSV **0 行**从「结构性拦死」变成「可由人显式放行并按实际留空」—— 业务口径：平台上确实没有推广数据，就留空，不写 0。

**改了什么**

1. `daily-report-core.mjs` 的 `summarizeSourceDates` 把推广侧拆成**三种态**：`empty`（只有表头、0 条数据行）/ `mismatched`（有行但日期不等于目标日，或跨多天）/ `matched`。此前两种都表现为 `matches:false`，证据里分不出「平台当日没有」和「下错文件」。
2. `buildCombinedFields(source, visibleFields, reportDate, options)` 新增 `options.allowEmptyPromotion`（默认 `false`）：
   0 行 + 未放行 ⇒ 照旧 fail-closed；0 行 + 放行 ⇒ 关键词推广／人群推广两段**整段不写**（留空，不写 0、不写空串），店铺段照常映射，并打一条 `[留空]` warn 留痕。
   同时把「缺某个场景」那条 warn 收在 `rowsById.size > 0` 里 —— 空报表不再额外喊一遍「缺 371 和 372」。
3. `run-daily-report.mjs` 新增 CLI 开关 `--allow-empty-promotion`；`assertSourceDates` 只在「空 + 显式放行」时放行，**有行但日期不对时加不加开关都拦**；放行结论写进 `plan.checks.promotionEmptyAllowed` / `promotionState`，收据可独立读出这一行是「按实际留空」写进去的。

**为什么改**

2026-10-20 08:00 那轮日报，8 家里 7 家写成，`网林家居`（网林定制家居）卡在第 7 步 push，报 `source date self-check failed`：店铺工作簿 `matches:true`，推广 CSV `rowCount:0`。
人工核查确认平台上确实没有：两次独立生成的任务（08:33:52 / 08:47:09）导出同一份 577 字节 zip、CSV 只有表头、解包 sha256 相同；只读回读阿里妈妈报表页显示「暂无数据 共 0 项数据」、账户总花费 0.00、各场景全 0.00。
用户拍板口径：**关键词推广确实没有，按实际记录，没有就留空**。而原实现两道闸门都会拦（日期自证 + 「一个场景都没有」），这一行结构上写不进去。

**刻意没有做的**

- **没有把放行改成默认**。0 行有两种成因 ——「这家店当天真的没投」与「平台数据还没出／还没静止」——在 CSV 层面同形；同日早跑写进飞书的低值当天无法重推，只能先删那一天。所以必须人先看过平台报表页，再显式放行这一次。
- **没有填 0**。0 行时推广族字段没有任何可信来源，写 0 等于把「不知道」写成「当天花费 0 元」，且是改口径。
- 注意：店铺段自己的 `关键词推广花费` / `精准人群推广花费` 是**店铺报表源值**（本次为文本 "0"），与推广段留空是两件事、两列（推广段那几列带 ` (1)` 后缀），未做改动。

**验证到什么程度**

- 定向用例：`daily-report-core.test.mjs` 11/11、`collector-arg-contract.test.mjs` 7/7、`daily-report-runtime` + `daily-report-audit` + `repair-actions` 45/45。
- 突变：把 `allowEmptyPromotion` 改成恒 `true` ⇒ 第 9、10 条用例当场变红（证明「默认仍拦」这条守卫是活的，不是空断言），已还原。
- **真机证据**（不只是离线）：对 `网林家居 / 2026-10-19` 用 0 行 zip 先跑不带开关的 dry-run ⇒ 退出码 1、同一条报错、证据里已经带 `"empty":true,"state":"empty"`；再加 `--allow-empty-promotion` ⇒ 退出码 0、`promotionEmptyAllowed:true`、`payloadFields:116`（推广段 0 字段）。随后 `--commit` 真写：`COMMITTED_AND_VERIFIED`、`recordId=reczz28PTwFh3QVB`、2425→2426。独立回读（不经收据）：底单 2026-10-19 的 8 家参与采集店齐了，网林定制家居那一行即 `reczz28PTwFh3QVB`；逐字段读该记录，推广段 `关键词推广日期`／`关键词推广花费 (1)`／`关键词推广展现量`／`人群推广日期`／`场景ID`／`场景ID (1)` 全部「未设置」，字段数 118。
- 证据目录：`evidence/daily-report-2026-10-19-网林家居/`（plan.json / receipt.json / paste.tsv）。

## [1.12.9] - 2026-10-19

客服聊天记录链加**自动登录**：接口不再认会话时，自己调一次仓库既有的登录流程，然后回过头再问一次接口。

**改了什么**

1. 新增 `--no-auto-login`（关掉，默认是开）与 `--rehearse-login`（强制走一遍登录流程，用来证明接线通）。
2. 采集脚本在探测到 `ok !== true` 时，以子进程调
   `skills/sycm-alimama-daily-report/scripts/login-merchant.mjs --proxy <该店代理> --shop <该店> --target both --commit --notify off`，
   回执落到证据目录 `login-<店铺键>.json`，结论进 `summary.json` 的 `shops[].login`。
3. 纯判据进 core：`loginCommand`（拼那一跳）、`planLoginAttempt`（回执 → 下一步），各带用例。

**为什么改**

用户 2026-10-19 要求「要加自动登录的流程」。这条链此前掉登录只有一个出口：报 `NEEDS_LOGIN` 等人，
而它跑在没人看着的时段，等于「掉一次就要人来一趟」。

**这里唯一重要的取舍：登录脚本说成了，也不等于聊天记录能用**

那条登录流程只验「生意参谋」和「阿里妈妈」两个后台（它的 `SITES` 里就这两个键），
而聊天记录页在 `market.m.taobao.com` —— 不在其中。所以：

- `LOGGED_IN` / `ALREADY_LOGGED_IN` 只被解释成「**再去问一次**」，不解释成「已经好了」；
- 重问之前**先重新加载聊天记录页**（登录换的是 cookie，已跑起来的单页应用会把旧会话留在内存里）；
- 重问仍不认 ⇒ 报 `NEEDS_LOGIN` 并写明「自动登录报了成功但接口仍拒绝」，**绝不继续采**
  —— 否则会采出 0 场，而交付物看起来像「这一周没人聊天」；
- 它说要人（滑块 / 没存凭据 / 填成别家 / 提交没生效）⇒ 原样把结论带进 `error`，**只试一次不重试**（连试会锁号）。

子进程固定带 `--commit`（不带就只是只读排练，看着跑过其实一个键都没按）与 `--notify off`
（不让它绕过本链的告警策略自己发飞书）。这两条都用例钉住了。

**同时补上了新链的登记（不登记就是四条守卫同时红）**

新增 skill 目录会触发仓库里的登记类守卫，逐条补：

- `runtime/browser-ports.mjs`：`SITE_ACCOUNT` 加 `market.m.taobao.com`（merchant）；
  `BROWSER_ACCOUNT` 加第三类 `shop` —— 它**不是一台**浏览器，而是「一店一浏览器」那一族（13 家店各自身份）。
  不并进 `dailyReport`：并进去就等于宣称客服聊天记录跑在那台共用商家浏览器上，而事实是跑在各店自己的 profile 里。
- `ROUTES` 加 `kefuChat` 路线（browser: shop，sites: market.m.taobao.com，skills: qianniu-kefu-chat）。
- `runtime/arch-boundary.test.mjs` 的 `SKILLS_TO_RUNTIME` 加 `export-kefu-chat.mjs`
  （它 import `browser-ports.mjs` 的 `SHOP_BROWSERS`）；只登记这一个 —— 打包与验收脚本一个 runtime 都不碰。
- `runtime/operator-console/state.mjs`：`SITE_PLATFORM` / `PLATFORM_LABELS` 加 `kefuChat` 卡片。
  刻意**不**复用挂着 `reserved`（「仓库内暂无调用方」）的千牛那张卡，否则那张卡就开始说假话。

守卫结果：`browser-ports.test.mjs` 22/22；`arch-boundary.test.mjs` 与 `operator-console` 两个测试
合计 37/37；另外 9 个引用端口模块的测试文件全绿。

**验证到什么程度**

- 离线：`kefu-chat-core.test.mjs` **24/24** 绿（新增 4 条）。
- 对端参数实测：把 `loginCommand` 拼出来的那串参数原样喂给真实登录脚本，
  它**没有报 Unknown argument**，stdout 是纯 JSON，`--notify off` 生效（回执 `notify.status=SKIPPED`），
  退出码 3、`verdict=STOP_AND_ALERT, detail=fetch failed`（当时四家店浏览器/代理均已退出，端口全 DOWN）。
- 用这份**真实回执**喂 `planLoginAttempt`：exit 3/0/2 三条都判 `HUMAN`（退出码 3 那条原因是
  「登录脚本自身没跑通」），换成 `ALREADY_LOGGED_IN` 才判 `RETRY` —— 与设计一致。
- **未验证（如实写在这里）**：「掉登录 → 登录成功 → 聊天记录会话恢复」这条端到端路径，
  当时没有活着的店铺浏览器可动，一次都没真跑过。留给 `--rehearse-login` 在浏览器起着的时段验：
  账号本来就登着时它只会判 `ALREADY_LOGGED_IN`，然后照常重探、照常采集，不改任何状态。
- 本版**不发飞书**（用户明确「飞书先不发」）；`--notify` 的投递路径本次未改动。

## [1.12.8] - 2026-10-19

新增 `skills/qianniu-kefu-chat/`：把「下载各店客服聊天记录」从一次性人工探索，沉淀成**可以每周手工执行**的一条链。

**改了什么**

1. **核心判据** `kefu-chat-core.mjs`（纯函数，无 IO）：周口径（+08、周一起）、会话列表 7 天切块、
   会话去重、消息半开窗口过滤、方向判定（买家/客服/系统）、客服署名与转交名、机器人会话识别、
   店铺统计、以及「把告警交给共享通知模块」那一跳的拼装（`notifyCommand`）。
2. **周采集入口** `export-kefu-chat.mjs`：`--week last-week|--date` / `--shops` / `--lookback-days` /
   `--out` / `--evidence` / `--notify｜--notify-dry-run`。一次 eval 只推进一个会话（超出就返回
   `pending` 留在页内续跑），整遍结束后对 `failedCids` 再跑一遍，吃掉瞬时抖动。
   状态机：`OK` / `BROWSER_DOWN` / `PAGES_ABSENT` / `NEEDS_LOGIN` / `LIST_FAILED` / `COLLECT_FAILED`，
   退出码 0/3/1；单店异常只落自己的记录，不拖垮整轮。
3. **打包** `package-kefu-chat.mjs`：每店 txt（人读）/ csv（BOM，Excel 直开）/ 全量 json（留 raw），
   外加 `总览.html` 与 `manifest.json`。
4. **通知**：`--notify-dry-run` 只渲染报文不发送，用来在「第一次真发」之前给人过目；
   真发送仍是 `--notify`，并把 `sent.error` 暴露进输出，避免只看到一句 FAILED 却不知道为什么。

**查明的三条平台语义（决定采集策略，写在 SKILL.md 里）**

- 会话列表按**会话创建时间**过滤，不是最后消息时间；宽区间会被截断（上限约 200~240 行）⇒ 必须 ≤7 天切块。
- **创建于本周之前、本周有消息的会话，单周查询不会返回**（实测占活跃会话 22.6%）⇒ 必须回溯 30 天。
- 消息接口 `cursor` 是起始时间戳、`forward:true` 向后翻页且**没有结束边界**，会一直翻到现在
  ⇒ 取回后按窗口过滤，某页越过末尾即停。

**为什么改**

2026-10-19 运营要 9 月四家店（盖文旗舰店、里可林旗舰店、网林家居旗舰店、里可林家居）全部客服的聊天记录，
平台不提供批量导出。第一次是分店人工探索（`tmp/kf-*` 探针），第二次就得能重复 ⇒ 固化成 skill。
运营侧要的是**每周一份**，所以默认口径就是「上一自然周」。

**踩过并修掉的两处**

- 首轮把会话行的 `userID.appUid` 当买家，方向全错（客服仅 5%、系统 47%）。实际那是**店侧账号**
  （如「里可林家居:小俊」）；改为「会话行店账号 ∪ 昵称带冒号的发送方」定店侧，再用昵称对得上优先、
  非店侧众数兜底推买家。
- 通知那一跳 `spawnSync` 没给 `stdio`，本机沙箱下 stdin 管道直接 EBUSY：**报文是空的、status 为 null**，
  看起来像通知模块自己坏了。改为 `['ignore','pipe','pipe']`，并把这两条写进用例。

**验证到什么程度**

- 离线：`kefu-chat-core.test.mjs` **20/20** 绿（含新增 2 条通知跳用例）。
- 突变：`--dry-run` 不传、`stdio` 改回管道，两处都被**点名抓红**（第 19、20 条），还原后复跑绿。
- 真跑 2026-W42（10-12 ~ 10-18）四家全 `OK`、`error` 为 null、`failedCids` 空：
  盖文旗舰店 176 场/4777 条、里可林旗舰店 56 场/665 条、网林家居旗舰店 55 场/1376 条、里可林家居 42 场/972 条。
  耗时 11 分 37 秒。
- **独立回读**（另一条代码路径重取，不信打包脚本自报）：里可林家居抽 6 场，5 场同屏回读条数/首末时间完全一致，
  第 6 场因回读脚本自己撞 30 秒上限，改逐页回读后 131 条一致；跨店再抽盖文旗舰店最大一场 157 条一致。
- 结构验收 0 问题：每个 shop 的 sessionCount/messageCount 与 manifest 自洽、每条消息都落在窗口内、
  无跨会话重复 msgId、CSV 带 BOM 且行数＝会话数+1、txt 会话块数＝会话数。
- **成本构成如实记录**：盖文旗舰店这一轮抓了 541 场，其中 365 场（67%）在窗口内 0 条。
  这不是浪费可省的：`modifyTime` 已被证伪（可能比真实末条早最多 17 天），拿它做「早于周一就跳过」会漏数据。

**这一版没做（第二步，等手工跑稳两周再动）**

`runtime/workflow-catalog.mjs` 登记 `kefu-chat`、接 `run-batches` 批次壳与定时 —— 见
`docs/ops/KEFU-CHAT-WEEKLY.md` 末节。

## [1.12.7] - 2026-10-18

修**完成提醒里的数字**：同一轮里「没写的表被说成 0 行」＋「推广写了多少根本不进统计」。

**改了什么**

`runtime/flow-ok-facts.mjs` 的 `productOkFacts`：

1. 不再**无条件** push `商品底单`。旧实现是 `tables = [{ name:'商品底单', rows: productRows }]`，
   0 行也照报；现在只有这一轮真的写了行才出现（与同文件 `dailyOkFacts` 早就写明的那条口径一致：
   「0 行的『底单 0 行』出现在完成通知里是一句误导」）。
2. 推广段补进统计。收据有两种落点：整批齐 ⇒ `promotion-import/<部门>/receipt.json`
   （一份覆盖多家，`sources[]` 逐家带 `rows`）；有店缺 ZIP ⇒ 退成逐店 `<店>/receipt.json`。
   先读逐店，再扫「名字不是店名」的部门目录并按 `sources[].shop` 逐家归属；同一家只算一次。
   老部门收据没有 `sources` 时整份算一次（用不与店名冲突的键）。
3. 一行都不写时 `tables` 是空数组 ⇒ `buildFlowOkAlert` 会把「写了：」整行省掉
   （它本来就这么设计），不会出现「写了：商品底单 0 行」。

**为什么改**

2026-10-18 10:59 那条「【商品数据】采集完成（统计日 2026-10-17）」写的是：
「3/3 家全部收齐。写了：**商品底单 0 行**。」而那一轮真实写入是 底单 0 / 询单 0 / **推广 53 行**
（同日重跑，前两张被去重闸门正确拦成 0）。两个错叠在一起，收信人只会读到「这一轮什么都没写」。

**验证到什么程度**

- 离线：`flow-ok-facts.test.mjs` 新增 4 条（0 行不出现 / 部门收据按 sources 求和 53 / 逐店与部门不翻倍 / 顺序），
  **15/15** 绿。
- 突变：`恢复无条件 push`、`推广段不参与统计` 两处都被点名抓红，还原后 sha256 逐字节一致。
  第三条「同一家重复计入」是**双保险实现**（先判 has 再 set），单点突变打不穿 —— 如实记在这里，
  该性质由「逐店 + 部门同时存在 ⇒ 40 而不是 56」那条用例端到端钉住。
- **真机工件复算**（不重跑采集，直接拿本轮证据目录算两遍）：
  补跑轮 `2026-10-17-20261018025002770-725e38f9` ⇒ `3/3 家全部收齐。写了：商品推广 53 行。`；
  定时轮 `2026-10-17-20261018020412776-7f2b2a36` ⇒ `8/8 家全部收齐。写了：商品底单 236 行、商品询单 34 行、商品推广 84 行。`



把**推广段「换通道」补提交**从日报推广链搬到商品链，并补上推广段一直缺的失败现场。

**改了什么**

1. `skills/sycm-promotion-data/scripts/product-report-core.mjs` 新增 `pickFetchCandidates` /
   `taskDateRangeOf`：取件候选从「本次提交的那**一条**任务」变成**候选集**。判据只有两条 ——
   ① 任务行里的**日期范围列**等于目标日（首选）；② 读不到这一列时退回「任务名里的提交日＝提交当天」。
   列表里只要有一行读得出日期范围，就**一律**按日期范围判（哪怕一条都不匹配 ⇒ 候选为空 ⇒ 走补提交），
   绝不退回「今天交的」去猜。本次提交当场确认过的任务名恒排第一。
2. `collect-product-report.mjs`：`fetchTask` 拆成 `fetchOneTask`（对一条任务做一次完整取件）＋
   `fetchCandidates`（按候选集逐条试，每条之前重载列表页）。候选全取不到 ⇒ **补提交一条同目标日任务**，
   重读列表再逐条试一次；仍不行则 fail-closed。上限：一次运行最多补提交 1 次，`--no-resubmit` 可关。
3. 同一条任务失败后**不再原地重试 3 次**，改为换下一条候选；唯一例外是「被遮挡层拦住」——
   那条路在抛之前已把遮挡层关掉（日志「全屏层剩 0 个」），所以允许刷新后重试同一条一次。
4. `scripts/run-product-data-job.mjs`：推广段调用补传 `--log-dir <证据目录>/<店>/promotion-collect`。
   之前只传 `--shop/--date`，采集器打印「整轮跑时由编排层统一采」然后什么都不采，而编排层也没有那一步
   ⇒ 推广段的失败现场从来没落过盘。

**为什么改**

2026-10-18 10:00 定时轮：商品 8/8、询单 8/8 全成，**推广只有 5/8**（盖文淘宝、科塔淘宝、里可林天猫），
退出码 1。三家都通过了身份/页面校验并成功提交，死在取件：盖文淘宝第 1 次是「点了下载 60s 无文件」，
三家后续是「任务操作行未显形（找不到下载入口）」。而商品链当时把全部希望押在**一条**任务上，
那条坏了整家就判死。这正是业务方 2026-10-05 就说过、日报推广链 2026-10-05 就已落地的形态：
「最新那条点了不落盘，紧挨着另一条能下，两条数据等价」—— 通道坏了换一条，不要和通道绑死。

**验证到什么程度**

- 离线：`product-report-core.test.mjs` 新增 6 条候选集用例（含「拿业务日当提交日筛」这个反面），
  定向 4 份 + arch-boundary 共 **26/26** 绿。
- 突变验证 **3/3** 被抓且点名（放宽日期范围判据 / 候选排序反过来 / 退回判据改用业务日），还原后 sha256 逐字节一致。
- **真机**（`evidence/product-data-job-2026-10-17/2026-10-17-20261018025002770-725e38f9/`）：
  三家补跑 **退出码 0**，日志逐家显示 `[候选] 判据=date-range`（各排除 10-11 条别天任务）
  → 首条候选被遮挡层拦下 → 旧任务「操作行未显形」→ `[换通道] 补提交` → 新任务当场下载成功。
  独立回读推广底单 2026-10-17 由 **84 → 137 行**（+53，与收据 `plannedRows=53` / `duplicateRows=0` 逐值一致）。
  注意：本次真机跑的是第 1-3 项；第 3 项里「遮挡层重试同一条」这条分支是跑完后补的，**仅离线判据**。



补上一个**已经发生过两次、每次都被判成「运营侧权限问题」而没人修**的坑：
阿里妈妈的会话掉了，但页签 URL 还停在报表路由、**页面内容**被平台换成了兜底页
（「抱歉，您查看的页面不存在或无权访问……子账号权限不全」）—— 补登闸门认不出这种形态，
于是「就地补登」这条修复从来没被触发过，只剩两个页面级候选动作去撞，必然修不动。

1. **判据补齐（`run-multi-shop-day.mjs`）**：`--relogin-on-wall` 原判据是 `loginWallOf()`
   —— 它只认 `login/index` / `member/login` / `login.htm` 这类**地址**。兜底页是**同一地址换内容**，
   地址判据永远命中不了，`wall=null` ⇒ 整段补登被跳过。现在改成三步：
   ① 先照旧读页签 URL；② 判不出、且这一步属于某个登录站点（`reloginSiteForStage`，
   唯一来源＝`repair-actions.mjs` 的 `STAGE_PAGE_HINT`）⇒ 跑一次**只读探针**
   （`login-merchant.mjs --check-only --target <站点>`）；③ 只有在 `verdict==='NEEDS_LOGIN'`
   **且该站点明确 `loggedIn===false`** 时才补登（`reloginWallFromProbe`）。
   刻意不凭页面文案直连补登：真·子账号场景权限墙（2026-09-21 科塔那次）页面文案一模一样，
   直连补登会把它当掉登录反复试、锁号；而「读不到」（`loggedIn===null`）也不算掉了。
   探针结论落进 `summary.json` 的 `record.reloginProbe`，补登的判定来源落进 `record.relogin.source`
   （`tab-url` / `read-only-probe`）——事后复盘「这次为什么补登/没补登」只认这两个字段。
2. **两次真实事故的依据**：2026-10-04 盖文天猫、2026-10-18 里可林淘宝，同一天同一形态。
   10-04 那次事后查到该店阿里妈妈页签停在 `#!/login/index`（`login-merchant-core` 的未登录签名），
   当时却被写成「运营侧账号/权限问题」；10-18 这次用补充取证推翻同一假设：跑前预检 07:03 判
   `alimama: LOGGED_IN`、07:05 阶段失败时已是兜底页；`--check-only` 报 `alimama.loggedIn=false`
   且落 `#!/login/index`；补登**一次**后同一条 `date-picker --site alimama --date 2026-10-17`
   直接 `exit 0 / status=APPLIED / settled 2026-10-17`（证据：
   `evidence/batches-2026-10-17/b1/里可林淘宝/97-repair-agent-report.md`）。
3. **改正一处写反的注释（`login-merchant.mjs`）**：文件头原写「`--check-only`：纯读，连登录页都不开」
   「一个页面都不碰」，实际 `siteLoggedIn()` 会把该站点**已有的页签** `navigate` 到 `probeUrl` 再读
   `location.href`。10-18 那次就是照这句话用的，结果把失败现场那页从报表路由挪成了 `#!/login/index`
   （现场事实已先被感知层落盘，所以没丢，但事后无法再从那一页复读原始失败形态）。本次只改注释，
   **不改行为**：改成「不开登录页、不量坐标、不提交，但会导航已有页签」。
4. **验证（仅离线判据，未真机重跑）**：定向 `node --test skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs`
   ⇒ **152/152**，其中新增 5 条（阶段→站点映射、三分叉决定、回执→登录墙、探针命令形状与回执解析、
   源码级接线）。突变验证 5/5 全部被点名抓住（去掉 probe 分叉 / 把读不到当掉了 / 探针结论不落证据 /
   不记判定来源 / feishu 阶段也去探针），还原后源码 sha256 逐字节一致
   （`40b9578e…3aba70`）。真机行为由 10-18 那次 agent 的手工等价操作间接证明（同一命令形状），
   但**新版脚本本身没有在真机上跑过一轮**。

## [1.12.4] - 2026-10-17

修两件「自己人骗自己人」的事：**收据在写入中途抛错时会整份消失**（于是「写了多少行」只能靠事后回读才知道），
以及**同一个业务日的失败告警会发好几遍**（于是收信人分不清「要不要动手」和「最后好没好」）。

1. **背景（两条都是 2026-10-17 真机形态，不是推理）**：
   ① 商品链补跑 10-16 那轮，推广段 sales1 三家 **46 行已经写进飞书**，批量接口随后抛错。
   三个导入器原来的写法是「ids 攒在局部变量 → 全部写完才赋值给收据 → 再落盘」，于是这批的收据
   **一个文件都没生成**（`promotion-import/sales1/` 是空目录），主链记 exit 1、逐店重试（幂等 0 行），
   逐店收据全是 `plannedRows=0`。事后只有独立回读知道真写了 46 行（逐店收据求和 91 vs 真实 137）。
   —— 上一版把这条诊断成了「回读失败没落盘」「收据被重试覆盖」，**两处都不准**，本次一并更正。
   ② 同一个业务日发了**两条失败告警**（02:24 停在 `product-import`、03:31 停在 `promotion-import`，
   指纹不同 ⇒ 旧口径「算新信息」），补齐后又发一条「已恢复」。收信人看到三条消息讲同一件事。
2. **改动**：
   ① 新增 `runtime/import-write-ledger.mjs`：`batchCreateWithLedger()` 先落「准备写 N 行」草稿、
   **每批成功立刻落盘**、多组共用一个 `recordIds` 时只追加不重置；`writeFailureIsCertain()`
   把「确定性拒绝（4xx/权限/限流）」与「可能已写入（5xx/超时/网络/读不懂）」分开。
   ② **四个**导入器全部接入（商品底单 / 询单 / 推广 / 推广日报的关键词+人群）——
   写 `const ids=[]` 这件事从此在四处都禁掉了，由结构守卫盯着。
   ③ 写入阶段的异常也按 1/2 分类：确定没写成 ⇒ 1；可能已写入 ⇒ 2（UNKNOWN_WRITE，与写后回读失败同一处置）。
   推广日报导入器此前把「写入已发生」之后的任何异常都报成 1，一并改掉。
   ④ `resolveAlertDedup` 新增 `ignoreFingerprintChange`（默认 false，不动其它链）；
   商品链的失败告警传 true ⇒ **同一业务日只报一次**，指纹仍记进 throttle 供排查。
   例外照留：已发过 `<flow>-ok-<日>` 且晚于最近一条失败 ⇒ 是新故障，照发（`recoveredSinceLastFailure`）。
3. **验证**：① 定向 664/664（四个导入器所在技能组）；② runtime **分 5 批**共 1348/1348 全绿、130 个文件全覆盖
   —— 一次性 `node --test "runtime/*.test.mjs"` 在本机这次**跑完不退出**（子进程全部结束、父进程挂着，
   TAP 只输出到 663 条），改用分批跑取分母，**这个僵死本身没有定位**（见 `docs/ops/DAILY-FLOW-SCHEDULE.md` 末节的同类提醒：
   别把「跑完了」和「进程退了」当一回事）。
   ③ 新增用例 8 条（写入账本 7 条：逐批落盘/中途炸保留已确认行/0 行也落草稿/共用收据不重置/4xx 与 5xx 分类；
   告警 1 条：同业务日只报一次 + 过了窗口仍发）。
   ④ 突变 4/4 真红且点名到期望那条：账本改回「写完再落」、5xx 判成确定失败、商品链不再传该档、
   推广导入器改回自己攒 ids。
   **仅离线判据**：没有在真表上制造「写入中途抛错」，那条路径不敢拿生产 base 试。
4. **未做（需拍板，没有偷偷改）**：日报链与推广日报链仍是「指纹变了就再发」，且它们的
   `hold-resume-failed` 常与 `round` 相隔 3 分钟成对出现（10-14 六条、10-16 七条）；
   更根本的是日报链顺序反了（先报后挂），见 `docs/ops/FEISHU-ALERT-UNIFIED-DESIGN.md` §7.2.1 / §7.4。

## [1.12.3] - 2026-10-17

修「同一业务日重跑时推广段必然失败」：商品链的阿里妈妈商品报表提交改成**复用平台已在册的当日任务**，
并由导入器的逐行日期校验兜底。

1. **背景**：阿里妈妈对**相同参数**的重复提交**不再生成新任务**。2026-10-17 11:09 补跑 10-16 那轮时，
   里可林淘宝/推广 死在 `商品报表提交任务无法唯一确认: {..."added":[]}`
   （`evidence/product-data-job-2026-10-16/2026-10-16-20261017030520521-6570da99/RUN-REPORT.md`）。
   这不是采集失败，是平台「早就把这份报表交过了」；当时的处置是人工拿 10:09 那份 ZIP 补导，
   意味着**同一天只要重跑一次，就必须有人手工救一次**（定时任务撞上重跑时无人可救）。
2. **改动**：① `product-report-core.mjs` 新增 `reuseCandidateTask({ after, submittedOn })`：
   按任务名里的**提交当天**前缀（`商品报表_YYYYMMDD_`）筛同日候选、取最晚一个；今天一份都没有 ⇒ `null`，
   调用方抛**原来那条错**（不许拿昨天的顶，也不许把「真的没交成」伪装成成功）。
   ② `collect-product-report.mjs` 在 `uniqueNewProductTask` 抛错的那条 catch 里接自愈；
   `submittedOn` 由 `new Date(Date.now()+8*3600*1000)` 算**提交当天**，**不是** `--date` 的业务日
   （业务日是「昨天」，拿它筛永远筛不到，自愈永不触发 —— 而代码看上去「明明接了」）。
   ③ 复用**不保证**数据就是目标日（任务名看不出参数）⇒ `validatePromotionReport(headers, rows, { date })`
   增加**逐行**日期校验，`import-promotion-data.mjs` 把 `--date` 传进去。这条是自愈的安全网：
   少了它，一次复用就能把 10-15 的推广数据写成 10-16 的，而幂等键含日期、错日期的行会被当成
   「新数据」整批写进去，收据上看不出任何异常。
3. **验证**：① 定向用例 664/664（四个写入口所在技能组，含新增 2 条：`reuseCandidateTask` 只认同日候选、
   取最晚；逐行日期不符即抛）+ `runtime/*.test.mjs` 1338/1338（含新增 `runtime/product-report-reuse-wiring.test.mjs`
   4 条**接线**守卫）。② 突变 5/5 真红且点名到期望那条：拆掉 catch 里的自愈 / 拿 `o.date` 顶替提交日 /
   导入器漏传 `--date` / 调换 `submit()` 形参顺序 / 调用点改传 `o.date`。
   **仅离线判据** —— 没有真机重跑过同日第二次提交（下一次定时轮跑在同一业务日重试时才是首次真机验证）。

## [1.12.2] - 2026-10-17

修「凭据地雷」：商品链（含推广段）与推广日报链的四个写入口改为**按目标取凭据**。
2026-10-17 10:04 那一轮是这个缺陷的第一次真机发作：8 家店铺三段采集 15 分钟全部成功、
24 次导入全部 403/91403、飞书零写入，退出码 1，而收据把它归成 `FAILED/UNCLASSIFIED`
（告警里还写着「这一轮不需要你在浏览器里做什么」）。

1. **背景**：1.11.0/1.12.0 把 10 月的商品 base（1 部/2 部）与推广 base 换到外组织 rcnbpuvafkct，
   目标 token 换对了、**凭据没跟着换** —— 四个写入口仍 `loadFeishuCredentials('kcne')`。
   实测两套凭据对三张商品表：kcne 连 `listFields` 都 403/91403，rcnb 组织应用读 3486/774/1916 行全通。
   环境预检没拦住，因为它只验「凭据文件存在」，不验「这张 base 认不认这份凭据」。
2. **改动**：① `targetCredentials(target)` 成为「写某张 base 用谁的身份」的唯一入口
   （`dailyReportCredentials` 改成它的薄包装）；② 商品 × 月份×部门 与 推广日报 × 月份 两张注册表
   **每条都必须显式登记 `envFile`**（新增 `assertProductDataBaseCoverage` 的 envFile 检查与
   `assertPromotionDailyBaseCoverage`），漏写就在启动时红，而不是跑一小时才发现；
   ③ 四个写入口 + 推广对账器切到 `targetCredentials`，收据里记下 `credentialFile`；
   ④ 新增开工前「目标 base 连通性预检」`runtime/feishu-target-preflight.mjs`，接在商品链
   **起浏览器之前**：授权类拒绝（403/91403/1063004/Forbidden/无权限）当场拦下，
   网络类不可达只记一笔不拦路（否则一次抖动就让整轮不采数据）；
   ⑤ 导入失败的原因（子进程 stderr 那句原话）现在会落进缺口文案 —— 上一版只写「导入失败」四个字，
   分类器于是只能归 `FAILED/UNCLASSIFIED`；同时 `classifyWorkflowError` 认 403/91403/1063004/凭据。
   退出码 2（UNKNOWN_WRITE）**刻意不带原因**：它的文案本身已表达「不知道写没写」，
   掺进 stderr 会把「权限拒绝」和「回读失败」搅在一起。
3. **验证**：① 定向用例 662/662（四个写入口所在技能组）+ `runtime/*.test.mjs` 1332/1332，
   含新增 6 条（注册表必填 envFile / targetCredentials 按目标取 / 四个写入口源码接线守卫 /
   探针 AUTH vs UNREACHABLE / 授权类失败归 HUMAN_REQUIRED）；
   ② 幂等写探针（原值写回 + 独立回读，`evidence/credential-fix-20261017/probe.json`）：
   10月商品监控表-销售1部 商品底单 写回「商品ID」原值、回读一致；10月推广数据-销售1部 关键词
   写回「宝贝ID」原值、回读一致；商品/询单/推广/人群四张表读字段全通；9月商品监控表仍走 kcne 凭据。
   ③ 真机：`run-product-data-job.mjs --date yesterday --commit --notify --batches 5` 补跑 2026-10-16，
   证据目录 `evidence/product-data-job-2026-10-16/<runId>/`。

## [1.12.1] - 2026-10-16

修缺陷 ㊸：「挂住等人 ＋ 自动续跑」这条能力建成以来**一次都没真正发生过**（挂了 4 小时，第一次探测就续跑）。

1. **背景**：`scripts/hold-and-resume.mjs` 选探针那一行原是个三元表达式 ——
   `item.cause === 'PAGE_OBSTRUCTED' ? probeOverlay(...) : probeLogin(...)`，
   于是**除广告（弹窗）那一条外，所有成因都落登录探针**。而「脚本自修没救回来的店」那一路
   会把 `STAGE_FAILED` 也拉进驻留（`holdDecision` 的 `unfixableShops`），那种店的登录态本来就
   正常 ⇒ 登录探针恒 `ready` ⇒ **首次探测即「判据转正」**。
   实测（`evidence/batches-2026-10-11/batches.log`）：3 家 `STAGE_FAILED` 店，
   「截止 13:22（现在 09:22）｜从现在起挂 4 小时」的下一行就是「判据转正 ⇒ 开始续跑」。
   全仓搜驻留状态行（`[驻留] HH:MM:SS（已等 N 分钟…`）**0 条** ⇒ 8 次真实驻留无一活过 15 分钟。
2. **改动**：把「哪个成因该问哪一种探针」收进纯函数层做**唯一来源**
   （`hold-and-resume-plan.mjs` 的 `PROBE_KIND_BY_CAUSE` / `probeKindForCause`）：
   只有**真有只读判据**的两类给探针 —— `PAGE_OBSTRUCTED`→`overlay`（那层弹窗还在不在）、
   `NEEDS_LOGIN`→`login`（还停不停在登录页上）；其余成因一律 `null` ⇒ 落 `unknown`
   （`unprobedProbe`），而 `judgeProbes` 里 `unknown` 与 `waiting` 一样**不算 ready**。
   执行层只留一张 `PROBES_BY_KIND` 注册表，不再自己写三元、也不再回落到登录探针。
   口径的理由：那两类恰是 `HUMAN_REQUIRED_CAUSES` 那两个 ——
  「只有人能解除」与「有一个只读量能测出人做完了没有」是同一件事的两面（由用例互锁）。
   没有判据的成因**宁可等到截止时间如实收尾，也不拿一个猜的「好了」去写飞书**。
3. **验证**：① 新增 4 条用例（映射表 + 与 `DAILY_HUMAN_REQUIRED_CAUSES` 同集的互锁 +
   `unknown` 行为 + 源码级接线守卫），`runtime/hold-and-resume-plan.test.mjs` 47/47 全绿；
   ② 突变验证 4/4（执行层换回旧三元 / `unprobedProbe` 改成 `ready` / 删 `NEEDS_LOGIN` /
   给 `STAGE_FAILED` 加探针 —— 每一个都让**指定那条**用例转红，还原后 sha256 逐字节一致、复跑全绿）；
   ③ **仅离线判据**：真机「人处理完之后是否真的续跑成功」要等下一次真有驻留（且真有成因）才能验。

## [1.12.0] - 2026-10-16

店铺日报链对外组织 base 的写入通道打通（凭据层）。

1. **背景**：1.11.0 换到外组织（rcnbpuvafkct）的「各店铺日报」base 后，实测确认 kcne 应用对那张
   base 只有「获得链接的任何人可阅读」级别的读权限（链接分享设置实测 link_share_entity=
   anyone_readable；幂等写探针 403/91403），写入必须走对方组织的应用。对方管理员按
   `docs/ops/FEISHU-APP-ONBOARDING-RCNBPUVAFKCT.md` 的清单建了自建应用并加为该 base 的
   文档应用（可编辑），凭据已落地 `E:/小红书/.env.feishu-rcnb.local`（不进仓库）。
2. **改动**：`dailyReport` 目标新增 `envFile`（独立凭据文件）与新访问器
   `dailyReportCredentials()`（envFile 优先、缺字段当场炸、没配则回落 profile envFile）；
   三个写那张 base 的脚本（run-daily-report / ensure-inquiry-rows / run-inquiry-backfill）
   从 `loadFeishuCredentials('kcne')` 切到 `dailyReportCredentials('kcne')` —— 不改的话
   三个入口全部 403。其余链（竞品/关键词/商品/推广）不动，仍用 kcne 凭据。
3. **验证**：① 幂等写探针（店铺底单第一行原样写回）HTTP 200 / code 0，回读值未变；
   ② 真机排练：ensure-inquiry-rows --date 2026-10-16 连新 base 读回「各店铺数据日报」
   2026-10-16 的 8 家行骨架 ALREADY_PRESENT（对方已预铺，零写入）；
   ③ 相关 5 个用例文件 57 用例全绿（含 head-loadable、version-consistency）。
   待明天 11:00 定时真跑全链验证。

## [1.11.1] - 2026-10-16

1.11.0 发布后两小时内的口径修正：日报链采集范围从 13 家收回**销售1部 8 家**。
  用户 15:30 拍板「13 家全采集」、同日 16:22 改为「销售二部先暂停，只录入销售一部」。
  实测依据：销售2部 5 家 sycm＋阿里妈妈登录态全失效（新起实例读页签全部停在登录页，
  `D:/Retire/probe-20261016/probe-tabs.mjs`），且 2026-09-30 取证其生意参谋「日报」取数
  报表全不满足（保拉淘宝仅 6 指标、保拉天猫/安比龙头店无报表、科塔龙头店/安比淘宝找不到
  日报行）——恢复二部要等登录与报表配置补齐，届时删 `SHOPS_NOT_COLLECTING_YET` 那 5 行即可。
  `product-data-job-core.mjs` 的 `PRODUCT_DATA_STOPPED_SHOPS` 保留（与 browser-ports 的 5 行
  重叠但语义不同：将来放开日报链二部时商品链仍被它拦住）。测试口径同步收回。
  验证：受影响的 5 个用例文件全绿（140 用例）。

## [1.11.0] - 2026-10-16

店铺日报链换到外组织（rcnbpuvafkct 租户）的「各店铺日报」base，采集范围放开到 13 家（仅日报链）。

1. **换 base**：`PROFILES.kcne.dailyReport` 五值换到 `RqzrbD4zIalzjxsSGcbcUPTpnKc`（外组织
   「各店铺日报」），并新增 `host: 'rcnbpuvafkct.feishu.cn'` —— 跨租户 base 的浏览器侧底单页
   必须用它自己的 host 打开（`shop-pages.mjs` 的 `buildUrlByName` 优先取它），API 侧不受影响
   （永远走 open.feishu.cn，凭据仍是 kcne 应用）。判据＝底单行数与字段签名（265 字段逐字段
   相同、店铺底单 13 行逐行相同、询单表多一个不影响写入的「父记录」字段），不是名字。
   只读取证见 `D:/Retire/probe-20261016/`（跨租户应用可读已实测）。回滚＝五个值换回旧 base
   （RjKcb3isDaVn1GsoVJfc7Ykknyg 那组，留在 feishu-targets.mjs 注释里）。
   ⚠️ **写权限尚未验证**：协作者接口 403/1063004 ⇒ kcne 应用还不是该 base 协作者，切换真跑前
   必须让新组织管理员把应用（cli_a96ee8749078dbcf）加为可编辑协作者并重跑幂等写探针。
2. **13 家全采（仅日报链）**：`SHOPS_NOT_COLLECTING_YET` 清空（销售2部 5 家恢复采集）。
   目标 base 每天在采的口径是 12 家（销售1部 7 家不含网林家居＋销售2部 5 家），本次按用户
   拍板「13 家全采集」放开全部。商品数据链的销售2部维持 2026-10-05 停采 —— 停采名单挪到
   `product-data-job-core.mjs` 的 `PRODUCT_DATA_STOPPED_SHOPS`（两条链共用
   `collectingShopKeys()`，解耦后才做得到「只动日报链」）。
3. 验证：runtime 组（1322 用例）与日报 skill 组（634 用例）全绿；`daily-job-plan` 里写死的
   8 家视口闸门名单改为从 `collectingShopKeys()` 派生；`shop-pages` 用例补钉「底单页 host 必须
   是 base 自己的 host」。真机（浏览器开外组织底单页、写探针、13 家试跑）待切换日执行。

## [1.10.0] - 2026-10-16

10 月整月推广缺失的根因修复 + 补数前置改造。根因两条，同属「落点静默写飞」：

1. 商品数据链的推广段（`import-promotion-data.mjs`）长期读 profile 上那份**单对象**目标，
   永远指向 9 月已关账的 base。10 月跑它就会把 10 月数据写进 9 月表，而收据完全是绿的
   （同日去重闸门只管本表，拦不住跨表）。2026-10-05 因此加 `--skip-promotion` 闸门整体停跑，
   于是 10 月「商品推广数据底单」从建出来就是空表，看板引用它全是 0。
2. 推广日报链（关键词/人群报表）的 `promotionDailyTargets` 同样是单对象 —— 运营 11 月换 base 之后
   它会静默继续写 10 月那张，没有任何信号会响。

本版把两条推广链的落点统一到「月份 × 部门」注册表（商品数据链 2026-09-30 已踩过并修掉同一形态，
照同一模式办），`--skip-promotion` 从定时入口默认值去掉、降级为人工熔断；同时修掉商品报表校验器
只认「昨日」回显的问题——它挡住了 10-08～10-14 这些补数日（那些日子页面回显具体日期，不回显「昨日」）。

### 改了什么

- **推广日报落点按月注册（`runtime/feishu-targets.mjs`）**：新增 `PROMOTION_DAILY_MONTH_BASES`
  （当前仅 `2026-10:sales1` ＝「10月推广数据-销售1部」，含关键词/人群两张表）；
  `promotionDailyTargets(name, dateInput, department='sales1')` 传日期走注册表、**缺月抛错不回落**；
  不传日期走旧 profile 兼容路径（只给不按天跑的排查脚本）。
- **推广导入器按（店铺, 数据日期）解析落点（`skills/sycm-promotion-data/scripts/import-promotion-data.mjs`）**：
  `--date` 改为必填；一批多个 `--file/--shop` 按 baseToken 分组做「读既存/计划/写/回读」
  （修掉 2026-09-30 记录在案的缺陷：一次 CLI 调用只建一个 base 目标，跨部门混批会有一半写进另一张表，
  两边表结构逐字段相同、收据上看不出来）；dry-run 收据带 `observedDates`（从 ZIP 行内日期实测）
  与 per-base 的 existing/planned 行数。
- **闸门默认翻转 + 推广批量按部门分组（`runtime/product-data-job-core.mjs`、`scripts/run-product-data-job.mjs`）**：
  `renderProductJobEntry` 默认不再渲染 `--skip-promotion`（人工熔断时才传）；
  推广批量导入按 `departmentOfShop` 分组，组内同部门才共享一次调用。
- **推广日报链两个调用点传日期（`check-promotion-completeness.mjs`、`import-promotion-daily-report.mjs`）**：
  与导入器同一口径，缺月 fail-closed。
- **商品报表校验器接受补数日回显（`skills/sycm-promotion-data/scripts/product-report-core.mjs`）**：
  数据汇总周期的断言从「触发器必须含『昨日』」改为「含『昨日』或含目标日」。URL 里的
  `startTime/endTime` 早已把日期钉死，这一条只验「UI 真的反映了那个日期」——每日采昨日时页面
  回显「昨日」，补数日回显 `2026-09-14` 这样的具体日期（SOP §回填历史日、10-10 date-picker 探针
  判据 `/\d{4}-\d{2}-\d{2}|昨日|今日/` 两处都是这个形状）。补两条测试：回填日放行；
  「昨日」与目标日皆缺仍然 fail-closed。
- **文档同步**：`skills/sycm-promotion-data/SKILL.md`（`--date` 必填的命令示例）、
  `docs/ops/DAILY-FLOW-SCHEDULE.md`。

### 验证到什么程度

- 离线：`product-report-core` / `feishu-targets` / `product-data-job-core` / `promotion-completeness-core` /
  `promotion-daily-report-core` / `promotion-task-ledger` / `run-promotion-sales1` / `version-consistency` /
  `head-loadable` 单测全绿（`node --test` 逐文件跑，未跑 `test:staged` 全量——按 AGENTS.md 预算条款，
  它会选中 e2e 浏览器套件、长时间占用浏览器，故改为直接跑受影响单测）。
- 真机：盖文天猫 2026-10-14 **locate-only 通过**（阿里妈妈身份 盖文旗舰店:小瓜/2995200080 ✓；
  商品报表 URL/日期/30 天累计/商品+计划维度 ✓；未提交下载），证据 `evidence/locate-only-2026-10-16/`。
  同轮实测两条环境事实：① 本机沙箱在工具调用边界回收子进程树，「起实例」与「采集」必须同在单次调用内；
  ② 冷启动的店铺浏览器只有 label 页签，需先用代理 `/new` 开阿里妈妈页签再采。
- **未验证**：8 店 × 10-08～10-15 的补数采集与导入尚未开跑（本版之后的第一步）；
  定时任务命令的更新（去掉 `--skip-promotion`）在本版合并进 main 之后单独做。

## [1.9.9] - 2026-10-16

日报链（目标日 2026-10-15）补跑时，`里可林淘宝` 与 `科塔淘宝` 双双停在第 3 步 `promotion-submit`，
报「阿里妈妈会员名身份读不到」——而**失败后约 2.6 秒**拍的现场快照里，同一页页头恰恰写着期望的
会员名与 ID（里可林「里可林家居:小嘉 ID：2350600069」、科塔「j873522735:小瓜 ID：412070158」）。
判据读的是 `document.body.innerText`，页头是 SPA 异步渲染的，而身份读取是**单次读、无等待**、
紧随 `bringToFront` 执行 ⇒ 撞上「页已经在报表路由上、页头还没画进 innerText」的竞态，
把「读得太早」误判成「身份未知」fail-closed 抛掉。**这不是身份对不上，是读不到。**

### 改了什么

- `collect-core.mjs`：新增导出 `readAlimamaIdentitySettled(read, { attempts = 12, intervalMs = 1000, delay })`
  ——把「单次读」换成「读到 `memberName`/`memberId` 任一即停，读不到就重试」，读满 `attempts`
  仍读不到就把原值交回；`read` 抛错也计入重试，整轮都在抛则抛最后一次（区分「读不到页」与「身份未知」）。
- `collect-promotion-report.mjs`：`assertAlimamaIdentity`（:126）改走它读取身份。
  **闸门语义逐字未变**：仍由 `assertMemberIdentity` 在读到之后做 fail-closed 断言（身份未知照样停手）。
- `collect-core.test.mjs`：补两条守卫——一条行为用例（第 N 次读到即停 / 始终读不到原样交回 /
  read 抛错计入重试且全抛时抛最后一次 / 抛一次后读到仍成功），一条**源码守卫**
  （阿里妈妈脚本的身份读取必须走 `readAlimamaIdentitySettled`；`assertAlimamaIdentity` 里
  不许再出现裸 `await evalOn(... alimamaIdentityExpression())`）。

### 为什么这样改

- 「快照里有名字、判据读不到」说明问题在**读取时机**，不在判据本身 ⇒ 把等待加在读取侧即可，
  不必放宽任何断言。放宽断言会把「真读错窗口 / 掉登录」也一起放过——那正是本仓库反复吃过的
  「把读不到当成不存在 / 不匹配」病根的变体。
- 与 `date-picker` 的 `settle` 同一把尺子（同一族问题同一处口径）。
- 影响面只有这一处：读不到时的最坏等待由 0 变 12×1s，**失败方向不变**。兄弟脚本
  `run-promotion-daily-report.mjs` 有同形单次读，但不在本报链路径上，**本轮未动**（不扩大改动面）。

### 验证到什么程度

- **真机**：两店各自重跑全链、11 个阶段 all-ok、`batch-chain 退出码 0`；
  `03-promotion-submit.txt` 打出 `[身份] 阿里妈妈会员 = "里可林家居:小嘉" ID="2350600069"｜期望 … ✓`；
  独立探针回读底单 2026-10-15 由 5 行 → **7 行**（新增 `里可林家居`、`科塔全卫定制`）。
  动作台账与根因定位见 `evidence/batches-2026-10-15/b1/{里可林淘宝,科塔淘宝}/97-repair-agent-report.md`。
- 定向：`node --test "skills/sycm-alimama-daily-report/scripts/*.test.mjs"` **634/634** 退 0
  （净增 2 条）；会话侧独立复跑同数。
- 突变：把脚本临时还原成 HEAD 的单次读版本 ⇒ 源码守卫转红（点名「没有走 `readAlimamaIdentitySettled`」）；
  还原新版后恢复全绿 ⇒ 这条守卫确实在管事。

证据：`evidence/batches-2026-10-15/`、`evidence/daily-job-2026-10-15/`。


## [1.9.8] - 2026-10-16

本周竞品周表（`竞品周_2026-10-11_2026-10-17`）的正式导入卡在 dry-run：`extractManifest`
的 spawnSync 漏写 stdio ⇒ 宿主沙箱下 stdin 管道直接 EBUSY ⇒ status=null、stdout/stderr
全 undefined ⇒ `result.stderr || result.stdout` 取到 undefined，`.trim()` 把真因吞掉，
只剩一句「Cannot read properties of undefined」。这是同一病根的**第四处**
（1.7.1 notify / 1.9.2 supervise deliver / 1.9.4 合并），比前三次更早——dry-run 就崩。
同批把周采集驱动的「整轮续跑」能力补上：这是挂每周一定时的前置开发项
（提案 `evidence/weekly-scheduling-20261015/PROPOSAL.md` B 项）——否则定时跑崩一次
就要十段全重采，白烧整个采集周期。

### 改了什么

- **导入器 EBUSY 修复（`import-xws-to-feishu.mjs`）**：`extractManifest` 改为导出函数、
  单对象解构入参（`{ xlsx, outputDir, python, spawnImpl = spawnSync }`）、显式
  `stdio: ['ignore', 'pipe', 'pipe']`；spawn 失败/非零退出时报错携带
  `result.error.code`（EBUSY 形状须原样可见，不许再被 `.trim()` 吞）。
- **周采集驱动续跑（`run-weekly-collection.mjs`）**：
  - `parseDriverArgs` 新增 `--resume` 旗标（默认 false——不猜意图：新一周本来就要新快照）；
  - 新增导出纯函数 `planResume(ranges, { resume, prefix, receipt, exists })`，
    三条判据**缺一不复用**：显式 `--resume`、收执 `checkpointPrefix` 与本次逐字相同
    （前缀＝「哪一轮」的身份）、该段 csv/xlsx 此刻仍在盘上（被清过就重采，
    不许拿不存在的路径糊弄）；
  - 新增 `readPreviousReceipt()`；`main()` 里收执提前构造并**逐段**落盘
    （`runtime/.weekly-collection-receipt.json`）：驱动被 kill / 机器重启不丢已采成的段，
    重跑时 `--resume` 靠它跳段；收执新增 `checkpointPrefix` / `resume` 字段。

### 为什么这样改

- 四处的共同形状：`spawnSync` 默认 stdio 的 stdin 是管道，宿主沙箱下一律 EBUSY。
  前三处都是「跑通之后才炸」，这次是「门都进不去」——导入是周报链最后一环，
  它崩了等于十段全白采。
- 续跑判据故意收紧到三条全满足：前缀防「新一轮被旧收据带偏」；在盘判据防
  「产物被清理后拿路径糊弄合并」。两条都是这个仓库反复吃过的「读不到当成不存在」
  病根的变体。

### 验证到什么程度

- 定向测试：`runtime/run-weekly-collection.test.mjs` **18/18**（净增 7：
  planResume 六条 + `--resume` 旗标一条）；`skills/xws-to-feishu-base/tests/cli.test.mjs`
  **5/5**（净增 2：抽取子进程 stdio 形状、EBUSY 形状报错须带 `spawn failed: EBUSY`）。
- 突变验证 **4/4** 点名抓红（去前缀判据 / 去 `--resume` 判据 / 去「产物在盘」判据 /
  去「收执里有 csv/xlsx 路径」判据）：每次只有对应用例转红、其余不受影响，
  还原后逐字节一致、全量复跑全绿。⚠️ 第一版第 4 条突变锚点选错（把 `exists(...)`
  判据一起打掉，红了两条），修正锚点后 4/4——说明判据是真的在管事。
- 全量 runtime 套件 **1363/1363** 退 0（1.9.6 基线 1354，净增 9＝本批新增用例；
  与 1.9.7 同树跑过，编号不冲突）。
- ⚠️ **续跑能力未经真机**：下一期 2026-10-19（周一）00:00 定时轮即是首次真机。
- 本期竞品周表（`tblBowNVwjlj4MwG`）正式导入已过：26m37s、退出码 0、1540 行 /
  1538 附件、周期戳 2026-10-11→10-17，**独立回读三项全对**（不依赖导入器自己的报告）。

证据：`evidence/weekly-resume-20261016/`（README、两份定向测试原始输出、
突变验证输出）。

## [1.9.7] - 2026-10-16

目标日 2026-10-15 的日报定时轮（11:00）**只写成 1/8**。链崩在「自修救回后续跑余下阶段」那一段：
那次续跑写在失败处理那个 `catch` 的**块体内**，它再抛时没有第二层接住 ⇒ 异常穿透 `main()`，
**整批子进程当场崩** —— 该批剩下的店（b1 的盖文天猫／科塔淘宝、b2 的里可林天猫／网林家居）
一步都没跑，`summary.json` 一个字都没写。连带三件事：`escalation-plan.mjs` 退 1（三层降级第 1 步
直接瞎掉、本轮连派单都收不到）、释放判定把「读不到」读成「没人需要看现场」照旧释放（其中一家
其实是登录墙，按「Failure-exit gate」第 3 条不该释放）、店铺级告警根本没发（链在 `dispatchRoundAlert`
之前就崩了）。本批修掉这条穿透，并把「summary 读不到」这一档从 fail-open 翻成 fail-closed。

### 改了什么

- **㊷ 修异常穿透（`run-multi-shop-day.mjs`）**：续跑那一句 `await runStagesFrom(resumeStages)`
  原先裸露在 catch 体内，现在包进自己的 `try/catch` —— 续跑再失败**只带走这一家**
  （`status='failed'` + `rescueResume.error` 留痕），本批其余店照常跑。原注释「续跑段自己抛错
  就照旧走失败路径（下面那个 catch）」逐字写错了（下面没有 catch），已改。
- **失败登记抽成一处（`settleShopFailure`）**：现场事实（感知层）＋修复请求单原先只在首跑失败
  那条路径上做；现在两条失败路径共用它，且它自带一层兜底（失败只记
  `record.failureBookkeepingError`，**永不外抛**）。续跑失败时按**续跑段那个**失败重做一份 ——
  否则修复请求单指的是已经被修好的那一步，第 2 层 agent 会照着错的方向修。
- **fail-closed（`batch-plan.mjs` + `run-batches.mjs`）**：`releaseAfterBatch` 新增
  `summaryUnreadable`。链非 0 且本批 `summary.json` 读不到 ⇒ **不释放**，日志里说清「判不出来」，
  不再打出那句假话「没有需要人看现场的失败」。`--release-on-failure` 仍优先（显式要退回旧口径）。

### 为什么这样改

- 病根是「失败处理里的失败」：catch 块自己没兜底 ⇒ **一条失败路径的 bug 被放大成整批店的缺失**。
  与 ㊱（救回后不续跑）是同一处的两个面，但危害更大：㊱ 是静默缺行，㊷ 是整批连证据都不落。
- 「读不到」不等于「没有」：`unfixableShops` 是从 summary 里读出来的，读不到时的空数组**不是证据**。
  拿它打印「没有需要人看现场的失败」正是本仓反复吃过的那个病根（读不到 ⇒ 当成不存在）。

### 验证到什么程度

- 离线：`runtime/batch-plan.test.mjs` + `runtime/daily-job-plan.test.mjs` +
  `run-multi-shop-day.test.mjs` 共 **253/253** 退 0；全量 runtime 套件 **1363/1363** 退 0
  （`node scripts/run-test-suite.mjs runtime --concurrency=1`，2 分 12 秒）。
  ⚠️ **`npm run test:staged` 本轮没跑**：按仓库自己的记录，选中本 skill 的实现改动会跑**整份**
  skill 套件（含 7 个各自等 60 分钟下载期限的端到端用例，实测 7.6 小时），且现在正要起一条
  浏览器链。替代：直接跑了受影响的这两处（runtime 全量 + `run-multi-shop-day.test.mjs` 147/147）。
- 突变验证 **6/6** 点名抓红（续跑不在 try 里／接住后不置 failed／不重做现场事实／拆掉登记兜底／
  拆掉 fail-closed 分支／判出来但不传给判决函数），还原后 sha256 逐字节自证。
  脚本 `tmp/mutation-2026-10-16-fix-42.mjs`。
- ⚠️ **第一次写的两条守卫能被注释满足**（突变 M4 没变红：`record.failureBookkeepingError`
  在注释里也出现过）⇒ 已改成钉代码行。记在这里，因为「用例全绿＋突变过了 ≠ 接线接上了」
  在本仓已经发作过三次。
- 真机：修复后重跑目标日 2026-10-15 的 7 家店铺实例（网林天猫因滑块验证留人工），
  实测见当轮 `evidence/daily-job-2026-10-15/RUN-REPORT-*.md` 与 `evidence/batches-2026-10-15/`。

## [1.9.6] - 2026-10-15

平台（生意参谋「自助分析·公共空间」）在 2026-10-14 中午之后把日报导出改成「OSS 生成 +
Office Online Viewer 新标签页预览」，文件**永不落盘** ⇒ 采集脚本的文件系统判据永远超时：
目标日 2026-10-14 的日报链 8 家店 × 3 轮补跑全败在第 5 步（shop-report），飞书零写入。
本批给日报链的店铺报表交付层加一条「抓 URL 直取」通道，与老通道并行。
（1.9.5 推迟到本版的 run-batches 共享编排五项**仍未动**，明早定时轮验证后再排。）

### 改了什么

- **直下通道模块（新）**：`shop-report-direct-download.mjs` —— `fileNameFromDirectUrl`
  （百分号路径解码，不解码落盘的名字判据不认）、`isDirectDownloadCandidate`
  （唯一判据＝文件名过得去店家的 `reportPattern`，主机名一律不硬编码）、
  `pickDirectDownloadUrl`（多个候选取**最后一条**：签名有时效，实测约 20 分钟量级，
  旧签名直下只会 403）、页面仪表表达式（`anchor.click` / `window.open` /
  `MutationObserver` 三渠道；href 一律拿全不许 slice——根因探针第一版 slice(0,200)
  把 Signature 截掉；Viewer 地址从 `src` 参数取回 OSS URL）、`fetchDirectDownload`
  （落盘前三道门：文件名判据 / HTTP 200 / zip 头 PK；任何一道不过都抛错且不留半个文件）。
- **接线（collect-shop-report.mjs）**：点「下载报表」**之前**装仪表；等待循环改双通道
  并行——老通道（下载目录新文件，平台若回滚仍有效）＋ 新通道（Node 侧直取落盘）。
  直取失败不当场抛（继续等老通道），失败原因带进超时报错。两条通道都打同一句
  `shopXlsxPath`（下游 run-multi-shop-day 只认这一句）。

### 为什么这样改

- 判据太窄/太旧的代价这个项目已经付过三次（2026-09-18、10-02、10-05 的文件名判据），
  这次是同一个病根的第四次：**交付形态变了，判据没跟着变**。所以判据按店算、
  通道做并行而不是替换——平台回滚时老通道照旧有效，不把「将来会改回来」赌死。
- 只等老通道＝今早 8 家 × 3 轮全败；只等新通道＝平台一回滚就瞎。

### 验证到什么程度

- 日报 skill 套件 630/630（净增 14 条：真机捕获的 OSS 签名 URL 做 fixture、假 DOM 里
  真跑仪表表达式、fetchDirectDownload 四种形态 fail-closed 且不落盘、源码级接线守卫
  ×4）；全量 runtime 套件 1354/1354 退 0（arch-boundary 无新跨目录依赖）。
- 突变验证 5/5 点名抓红（取旧签名 / 去 PK 校验 / 不判文件名 / slice href /
  装仪表挪到点击后），还原后复跑全绿、sha256 逐字节自证。
  （tmp/mutation-verify-direct-dl-20261015.mjs）
- **真机排练**（网林天猫活窗口 19032/19042）：身份核对 ✓、统计区间含目标日 ✓、
  点击后秒级捕获 URL、直取落盘 19731 字节、PK 头、openpyxl 直读＝单 data sheet
  31 行 ×119 列、第 1 行即 2026-10-14 / 网林家居旗舰店。证据
  `evidence/direct-download-fix-20261015/REHEARSAL.md`。
- ⚠️ 只排练了网林天猫一家；其余 7 家的文件名形状由 `reportPattern` 按店放行但未经真机
  —— 明早 11:00 定时轮即是检验。

## [1.9.5] - 2026-10-15

推广日报链 07:00 轮（业务日 2026-10-14）暴露三处设计缺陷：批 1 两家冷页瞬态失败且链内
无重试；批 2 三家（网林淘宝、里可林天猫、网林家居）整批未跑，却被回执 SUCCEEDED、告警
「已恢复」、驻留 RESUMED_OK 三个**过程信号**接力洗绿——整条链没有任何一环对「目标日
数据在飞书到底齐不齐」做**结果核验**。本批只动推广链自身（`skills/sycm-alimama-daily-report/`），
11:00 日报链共享的 `run-batches.mjs` 等编排代码零改动（手术推迟到 1.9.6）。五项均用户拍板。

### 改了什么

- **对账门（拍板「要」）**：新增 `promotion-completeness-core.mjs`（纯函数判据：分母
  `collectingShopKeys()` 8 家 × 2 表 × 回执事实 × 飞书独立回读；verdict 闭合集
  VERIFIED／VERIFIED_BY_ROUND_COUNT／ZERO_CONFIRMED／MISSING／UNVERIFIED／MISMATCH）与
  CLI `check-promotion-completeness.mjs`（默认同时扫 promotion-batches-<日> 与驻留污染的
  batches-<日> 两个证据根；退出码 0 齐／1 缺口）。「真实为空」单列 ZERO_CONFIRMED，交人工
  确认一次，不算成功也不算故障（拍板「真实为空就为空」，不填 0 的纪律不变）。
- **店级有界重试（拍板「加」）**：`run-promotion-sales1.mjs` 新增纯函数 `runStageWithRetry`
  （最多 3 次、30s 同步退避），链内五阶段全部走它；重试痕迹落在 `record.retries`。
- **失败分类**：`promotion-daily-report-core.mjs` 新增 `PROMOTION_LOGIN_WALL_TOKEN` 与
  `promotionFailureClass`（登录墙 → NEEDS_LOGIN，其余 STAGE_FAILED）；驱动的 `findPage`
  在页数异常时检测登录墙并抛带 token 的错误——供 1.9.6 驻留触发收窄用。
- **空表放行（拍板「做」）**：导入器 `validateExportRows` 对两种报表都 `allowEmpty: true`
  （「平台显示暂无数据」是真实业务形态，空 ≠ 失败）。
- **日期时间戳同源**：`promotionDateTimestamp` 成为「日期」字段唯一算法来源
  （Date.UTC(y,m-1,d)−8h），写入侧不再各写各的。
- **人群归属修正（对账门首跑暴露）**：实测定死「主体ID 是**行级维度、一店多主体**」（5 家
  各 5-11 个、跨店不相交；按店主体集合求和逐家与回执吻合 13/20/80/18/18，总 149＝飞书当日
  行数）；阿里妈妈**会员ID 与主体ID 是不同标识空间**，用会员ID 归属把 5 家全判 MISMATCH。
  修法＝导入器从该店 CSV 实测捕获 `subjectIds` 落进回执（归属唯一真实来源）；对账门按
  「店主体集合」对当日行求和；旧回执无 subjectIds 时回退 recordIds 独立回读——顺带修掉
  该回退路径查错表的接线 bug（人群 recordIds 误拿去关键词表比对，恒 UNVERIFIED）。

### 为什么改

07:00 轮的失败链路＝冷页瞬态无重试可扛＋修复表无候选＋`unfixable 即 break`（批 1 两家
不可修 ⇒ 批 2 整批不跑）。更深的病根：execution、告警文案、驻留恢复判据全部建立在
**过程信号**上，而「收据 COMMITTED_AND_VERIFIED 也会假绿」是本仓已知纪律——只有
「分母 × 飞书独立回读」的结果对账才是可信判据。重试/分类器是对「瞬态失败」的第一道
防线，对账门是对「一切防线都漏了」的最后闸门，两者互补不互替。

### 验证到什么程度（说实话）

- 离线：推广 skill 全套 **616/616 绿**（从仓库根跑；含对账门 15 条判据用例与 2 条源码级
  接线守卫）；突变 3+3 全部被守卫**点名抓红**（`tmp/mutation-verify-1.9.5.mjs`、
  `tmp/mutation-verify-subjectids.mjs`，finally 逐字节还原 sha 一致）。
- 真机：对账门在真实 2026-10-14 数据上实跑（`--date 2026-10-14`，退出码 1）——已跑 5 家
  10 单元全 VERIFIED（关键词 199 行、人群 149 行，recordIds 独立回读全命中），并**正确点名
  批 2 三家 6 个 MISSING**（正是早上被三个过程信号洗绿的缺口）；人群归属修正后 MISMATCH
  全部消除，逐店主体集合行数与回执吻合。
- 未做（1.9.6，等 11:00 日报链跑完再动共享代码）：`run-batches` 逐店 unfixable 不再挡
  剩余批、驻留触发收窄到 NEEDS_LOGIN、对账门驱动轮终态与告警、店级 stop、
  `--resume-logs` 透传；双 fetch 合并发等另行立项。
- 证据：`evidence/promotion-batches-2026-10-14/`、`evidence/batches-2026-10-14/`。

## [1.9.4] - 2026-10-15

周报竞品链 2026-10-14 全量重跑（`run-weekly-collection.mjs`，十段 40 页）暴露的**第三处
EBUSY 调用点**：十段全部采成（`code=0`、合计 1634 行、带图 xlsx 齐），最后一步「合并」却
2 毫秒暴死、日志只打出「合并 失败：undefined」，整轮退出码 1 —— 采了半天判失败。

### 改了什么

- `runtime/run-weekly-collection.mjs`：把合并步骤从 `main()` 里内联的 `spawnSync` 抽成可测的
  `runMergeStep(collected, { mergedCsv, spawnImpl })`，并给它**显式** `stdio: ['ignore','pipe','pipe']`。
  原调用漏写 `stdio` ⇒ 默认 `stdio` 的 stdin 是**管道**（恰是宿主沙箱会掐断的那一形态）。
- `runtime/run-weekly-collection.test.mjs`：新增 3 条 —— ① 钉 `runMergeStep` 调用形状
  （`stdio` 显式、stdin 必须 `ignore`、不许用 `input:`、`--require-images` 不能省）；
  ② 合并非零退出 ⇒ `ok=false`；③ spawn 起不来（EBUSY 形状）⇒ `ok=false`、`json` 为空。

### 为什么改

同一病根第四次发作（1.7.1 日报链 5 处、1.9.2 supervise `deliver()`、本次合并）。宿主沙箱下
`spawnSync` 带 stdin 管道直接 `EBUSY`：`status=null`、`stdout/stderr` 全 `undefined` —— 于是
`String(merge.stderr || merge.stdout)` 只打出 `undefined`。1.9.2 修 notify 时只改了投递那一处，
合并这处**从未被任何用例钉过**（预检那处有、合并这处没有），所以漏网。

### 验证到什么程度（说实话）

- 最小差分复现（`tmp/merge-stdio-repro.mjs`）：同一条子进程命令，默认 stdio ⇒
  `status=null / error=EBUSY / stdout=undefined`；显式 `['ignore','pipe','pipe']` ⇒ `status=0`。
  两种形态唯一变量就是 stdio。
- 修复后按「修正路径」补跑合并（`tmp/merge-fixed-run.mjs`，镜像 `runMergeStep`）：十段产物合并
  成功，产出 `runtime/weekly-merged-1791994250176.csv/.xlsx`，**1540 行、带图 1538、缺图 2
  （在容差内）**。
- 定向用例 `node --test runtime/run-weekly-collection.test.mjs`：修后 11/11 通过；突变
  （stdin `ignore`→`pipe`）**只**第 9 条转红、还原后 11/11 —— 判据名精确命中，未误伤。
- ⚠️ 本次**未**重跑整条驱动（重跑＝重采，采集是实时快照）。合并这处修复的活体验证＝上面那次
  「按修正路径补跑」；下次整轮重跑会走这条路径。

## [1.9.3] - 2026-10-14

1.9.2 推上去后 CI 的 `fast-gate` 红了：**两条守卫**点名 1.9.2 的新代码没登记。
都不是新知识，是仓库既有的「新枚举/新跨目录依赖必须显式登记」规矩 —— 属于执行漏洞。
两条都在本机全量 `runtime` 套件上先复现（`not ok 35` / `not ok 80`）、修完复验（1351/1351）。

### 改了什么

- `runtime/notify-feishu-core.mjs`（`TITLE_BY_TYPE`）与 `runtime/alert-copy.mjs`（`ALERT_TYPES`）：
  登记 1.9.2 新引入的两个告警 type —— `XWS_WEEKLY_LOGIN_REQUIRED` / `XWS_WEEKLY_LOGIN_RESOLVED`。
  标题在通用表里**带链名**（「竞品周采集起跑前检出」），与 SKU 链同病的 `XWS_LOGIN_REQUIRED`
  分开：两条链的登录失效互不顶掉（竞品挂了不该顶掉 SKU 的恢复通知，反之同理），去重按 type 成对。
- `runtime/arch-boundary.test.mjs`（`RUNTIME_TO_SKILLS` 清单）：登记
  `runtime/xws-weekly-login-preflight.mjs`，理由写进注释 —— 它 import 的是
  `export-market-analysis.mjs` 的两个**判据函数**（平台知识只许有一份，runtime 重抄就会漂移，
   漂移症状是「预检说没掉登录、采集段却撞墙」），与 `escalation-plan.mjs` 复用
  `date-picker.resolveTargetDate` 同型：runtime → skills 是**复用**，不是业务倒灌；
  预检的投递/去重/退出码都是机制层，留在 runtime。

### 为什么改

守卫的原文要求：新告警 type 不进 `ALERT_TYPES` 就红（「否则它的标题没人管」）；
新跨目录依赖不登记就红（「新增应当先问一句该不该留在能力目录里，而不是直接登记」）。
问题问过了，答案写在注释里。

### 验证到什么程度（说实话）

- 本机全量 `runtime` 套件（`scripts/run-test-suite.mjs runtime --concurrency=1`）：
  修前 1349/1351（`alert-type-title-guard` 与 `arch-boundary` 各一条红，均点名新文件）；
  修后 **1351/1351 通过，退出码 0**。证据：`tmp/weekly-preflight/runtime-suite-192-20261014.txt`。
- 1.9.2 的 CI run `38541203330`：`fast-gate` failure（即本版本修的那两条），
  其余 job success。1.9.3 推完后看新 run 结论。

## [1.9.2] - 2026-10-14

周报竞品链「告警发不出去」与「登录态没有起跑前检查」两个病的同一次修复。
触发事件：2026-10-14 竞品周采 run4 —— 小旺神会话过期，十个段里跑完的六个全部人道中止，
而五条段级告警**一条都没到飞书**（spawnSync 带 stdin 管道在宿主沙箱下必 EBUSY）。

### 改了什么

- `runtime/supervise-collection.mjs`（`deliver`）：投递形状从
  `spawnSync(node, [NOTIFY_CLI], { input: payload })` 改为
  `spawnSync(node, [NOTIFY_CLI, '--alert-file', <临时文件>], { stdio: ['ignore','pipe','pipe'] })`。
  `input:` 隐含 stdin 管道、而 spawnSync 缺省 stdio 就是三根管道 ⇒ 宿主沙箱下必炸
  EBUSY（status=null、stdout/stderr=undefined）。这是 1.7.1 在日报链一次修掉 5 处的**同一款坑**，
  当时漏了本文件；run4 的代价是 5 次「告警未送达（exit=null）：undefined」。
  同时把 `result.error.code` 打进日志 —— 原来那行字把「通道坏了」伪装成「没配置」。
- `runtime/xws-weekly-login-preflight.mjs`（新增）：周报竞品链的起跑前登录态预检。
  只读（GET /targets + /eval 读可见文本，不点不导航），判据从
  `export-market-analysis.mjs` 导入（`isXiaowangshenLoginTarget` / `isLoggedInAccountText`，
  与 `ensurePluginSession` 同一对，不重抄）。登录墙 ⇒ LOGIN_REQUIRED（阻断＋飞书叫人，
  动作文案含「扫码后关掉残留登录页签」）；已登录账号页 ⇒ READY；没有小旺神页签 /
  页签读不到 / 代理读不到 ⇒ 非阻断放行并如实记账（「读不到」不冒充通过也不冒充登录墙）。
  去重与恢复通知按 SKU 链既有形状（同 type 同原因 DEDUPED，READY 后补 RESOLVED）。
- `runtime/run-weekly-collection.mjs`：段循环前插预检一步。LOGIN_REQUIRED ⇒ 不起任何段、
  写收据、退出 1，且**刻意不发**收尾告警（预检已经把人叫到了，同一次故障两条就是轰炸）；
  预检读不到（PREFLIGHT_UNREADABLE）⇒ 放行（宿主 health 与监督环兜底）。驱动 dry-run 时
  给预检传 `--no-notify`（彩排不许真发飞书）。`main()` 加 isMain 守卫（否则测试一 import
  就带着 node --test 的 argv 跑主流程、exit 1 把测试进程带走）。
- `skills/xws-export-market-analysis/scripts/export-market-analysis.mjs`：把
  `isXiaowangshenLoginTarget` 与登录态文本判据导出（`isLoggedInAccountText`），
  `ensurePluginSession` 改调它 —— 行为逐字不变，只为判据只有一份。

### 为什么改

- 告警链是建好的，但投递通道坏了：出事时飞书安静，人只能靠翻 `.collection-host.log` 发现。
- 登录态原来没有任何起跑前检查：会话过期后十段逐个白烧 20~60 秒才人道中止，
  run4 六个段全废就这么来的。

### 验证到什么程度（说实话）

- 离线：`supervise-collection.test.mjs` 22/22（新增 4 条钉投递形状：
  argv 必含 `--alert-file`、不许有 `input`、stdio 必为 `['ignore','pipe','pipe']`、
  EBUSY 形状返回 1）；`xws-weekly-login-preflight.test.mjs` 17/17；
  `run-weekly-collection.test.mjs` 8/8；`skills/xws-export-market-analysis/tests/adaptive.test.mjs` 64/64。
- 真机（只读，未发任何飞书）：对活体买家浏览器跑预检 ⇒ LOGIN_REQUIRED（2/2 登录页签是墙，
  与人工探针结论一致），退出码 2；驱动 dry-run 接线验证 ⇒ 0.4 秒判出、弃跑、一段未起、
  收据落盘。**这一轮还抓到一个真 bug**：预检 CLI 打的是 pretty 多行 JSON，驱动原只取最后一行
  ⇒ LOGIN_REQUIRED 被误判成 PREFLIGHT_UNREADABLE、照样起段白烧一段；已修（整块优先解析），
  并用多行形状的用例钉住。
- `prepare-flow.test.mjs`：子用例 16/16 通过；文件级在本机沙箱超时属**既有环境问题**
  （HEAD 原版同样超时，已对照；单跑末用例 41s 通过）。
- **没有**真发过飞书（对外发送未获授权）；登录态恢复后的真实投递待用户扫码后随重跑验证。

## [1.9.1] - 2026-10-14

1.9.0 推上去之后 CI 红了：`fast-gate` 与 `skill-tests (sycm-alimama-daily-report)` 各挂一条。
两条都不是新知识，而是**已经写在 `AGENTS.md` 里、这一批却没照做**的规矩 —— 属于执行漏洞，不是设计漏洞。
修完在**真 CRLF 检出**里先复现、再复验。

### 改了什么

- `skills/sycm-alimama-daily-report/scripts/stage-browsers.test.mjs`：剥注释的分行改成
  `split(/\r?\n/)`（原先写的是 `split('\n')`）。这是仓库里**已有**的写法 ——
  `runtime/browser-ports.test.mjs` 的 `stripComments()` 就是这么写的，本批次没有沿用它。
- `runtime/hold-and-resume-plan.test.mjs`：把新增的第 0 步 `viewport-gate` 补进被钉住的步骤序列
  （1.9.0 加了这一步，只改了 `runtime/daily-job-plan.test.mjs`，漏了这一处）。
- 上一条的两个文件里各加一段指向对方的注释：同一份步骤序列**钉在两处**，加/挪步骤时两处都要改。

### 为什么改

- **① EOL（`AGENTS.md`「Line-ending note」明文要求：每个源码级断言都必须在匹配前
  `replace(/\r\n/g, '\n')`）。** CI 的 Windows runner 以 **CRLF** 检出，而本机工作区是 LF。
  用 `split('\n')` 配 `/\/\/.*$/` 时，行尾那个 `\r` 会让 `$` 失配 ⇒ **注释压根没被剥掉**，
  而注释里恰好写着端口号 `19060` ⇒ 「代码里不许出现端口字面量」这条断言**本机绿、CI 红**。
  实测对照（同一个文件、同一段代码）：LF 下 `MATCHES null`，CRLF 下
  `MATCHES ['19023', '19060', '19060']`。这类断言唯一的自动发现者就是 CI 本身，本机看不见。
- **② 同一份事实钉在两处，改一处就会红在另一处。** 步骤序列在
  `runtime/daily-job-plan.test.mjs`（含分批形态，多条）与 `runtime/hold-and-resume-plan.test.mjs`
  （单跑形态，一条）里各钉一份。1.9.0 只改了前者 ⇒ CI `Full unit tests (main)` 红在
  `not ok 509 - 接线：定时计划里真的有「驻留」这一步…`（差集就是多出来的 `viewport-gate`）。
- 两条合起来的教训与前一批同一族：**「本机全绿」不是判据，「在被验收的那个环境里全绿」才是**。

### 验证到什么程度

- 用 `git worktree` 拉了一个**全新检出**做排练（本机 `core.autocrlf = true` ⇒ 该检出是纯 CRLF，
  与 CI 同条件；已实测确认 `runtime/daily-job-plan.mjs` 883 处 CRLF、0 处裸 LF；并给该检出接上
  `node_modules` 联接，免得「裸检出缺依赖」混进结果里）：
  - **先复现**（在未修的 1.9.0 内容上跑）：红的两条**用例名与 CI 报的逐字相同** ——
    `接线：定时计划里真的有「驻留」这一步，且它只在链失败时才执行`、
    `接线：共用端口来自 browser-ports，本文件里不许出现第二个 19023`。
    序号不同（排练里是 `not ok 29` / `not ok 52`，CI 里是 `not ok 509` / `not ok 594`），
    因为排练只跑了那两个文件、CI 跑的是整套 —— 序号是整套里的位置。**判据是名字，不是编号。**
  - **再复验**（把修好的文件按 CRLF 放回）：日报技能集整集 **594 tests / 594 pass / 0 fail**；
    `unit` 套件 **1322 tests / 1321 pass / 1 skipped / 0 fail**（`UNIT_EXIT=0`）——
    同一套在 CI 上是 `1322 / 1320 / 1 fail`，那一条就是上面这个 `viewport-gate`。
  - 原始输出：`crlf-rehearsal-before.txt`（修前两条红）、`crlf-rehearsal-after-tests.txt`、
    `crlf-rehearsal-after-skills.txt`、`crlf-rehearsal-unit.txt`；过程与踩坑见 `CRLF-REHEARSAL.md`。
- **仍未做**：仓库级 `.gitattributes` 统一 EOL —— `AGENTS.md` 明确要求等工作区干净后再做，
  且有别的会话在改文件时重归一化会吞掉他们的改动，不在本批。
- **未加自动化守卫**：这类「只在 CRLF 下红」的断言目前**没有**静态守卫，唯一能抓到它的是 CI。
  要不要补一道守卫，列进待决问题。
- 本批没有真机运行、没有真发过飞书。

## [1.9.0] - 2026-10-14

目标日 2026-10-13 那一轮日报连发两条告警、其中一家店停在第 11 步。查下来不是四个故障点，
而是**四个「本该有人保证、却没有任何一步负责」的环节**：共用商家浏览器的窗口被挤小之后没有人
负责把它摆正；登录这条路在点下去之前不问「点得到吗」；修复动作落在**另一页**上却报 `applied:true`；
告警去重看的是「停在哪儿」而不是「要做什么」。本批次逐个补上保证人。

### 改了什么

- **第 0 步新增视口闸门**（`runtime/shop-viewport-gate.mjs`、`daily-job-plan.mjs`、`batch-plan.mjs`、
  `run-batches.mjs`）：每一批在 `start` 之后、登录之前量一次窗口视口，低于 1200×600 就停下并说清
  「太窄」还是「太矮」，不再往下跑。**读不到按红处理**（`VIEWPORT_UNREADABLE`）——
  「读不到」不等于「达标」。非分批形态把共用商家浏览器与 8 家店铺实例一起量；分批形态量共用那台。
- **共用商家浏览器启动后归位窗口**（新增 `runtime/browser-window-bounds.mjs`，由
  `start-project-browser.mjs` 在 REUSE 与 READY 两条分支上调用）：CDP
  `Browser.getWindowForTarget` / `setWindowBounds` 把它摆回登记尺寸（容差 16px）。只对共用商家浏览器
  生效；它与竞品浏览器的 argv **逐字未变**（`browser-ports.test.mjs` 守着）。
- **登录前先量视口**（`login-merchant-core.mjs` / `login-merchant.mjs` / `check-login-shops-core.mjs`）：
  `judgeViewportForClick()` 排在**所有**坐标点击之前（手势、协议勾选、提交、确认页）；不达标就退 2、
  一个点都不发，并把实测读数写进收据。两个新结论词 `VIEWPORT_TOO_NARROW` / `VIEWPORT_TOO_SHORT`
  同时登记进词表、要叫人表、下一步表、原因表。阈值**不在这里重抄**，从机制层 import（有源码层断言钉住）。
- **修复层作用域对齐**（新增 `stage-browsers.mjs`；改 `repair-actions.mjs`、`expected-pages.mjs`、
  `repair-shop-stage.mjs`、`run-multi-shop-day.mjs`）：`push` / `readback` 的作业对象是共用那一页
  飞书底单、跑在共用商家浏览器上 —— 这条事实原先只活在驱动的 stage 表里，而链**外**还有三处
  （派单单子的 `execHint`、`instancePrecondition`、自动修复的 `execRepair`）各自按「店名 ⇒ 这家店的
  代理」取实例；`resolveProxy` 的一致性闸门又**无条件**禁止「`--shop X` + 共用代理」这一组 ⇒
  修复动作永远指不到真正出问题的那台。现在答案只有一处（`proxyForStage`）。同一批还有两处：
  `locateStagePage` 改走 `runtime/target-url-match.mjs` 的 `pagesMatching`（结构判据，不再整串
  `includes`）；`buildShopStages` 加一条互锁 —— 阶段表的 `CDP_PROXY_PORT` 与 `stageUsesSharedPage()`
  的声明不一致就**当场抛**，而不是让修复层悄悄落回店铺实例。
- **`planRepair` 不再把「认不出成因」当成「不知道修哪一页」**（`repair-actions.mjs`）：
  未登记成因那一支原先也把 `stageHint` 写成 `null`。两者是独立事实 —— 候选仍然为空（**不猜动作**
  这条安全方向逐字未变），但阶段提示照给。注意**这条今天只用于诊断与请求单定位**：
  指导书写着「候选菜单为空 ⇒ 转人」，所以它不会让 agent 多执行一个动作。
- **告警指纹改成根因集合**（`run-multi-shop-day.mjs`）：`ROUND_BLOCKED:<轮级成因>` / `SHOP_LEVEL`
  ＋ 去重排序的成因集合，替掉原先的 `店@阶段`。理由：这条告警的「下一步」是按**成因**给的
  （`ACTION_BY_CAUSE`），所以「要做的事有没有变」只能由成因集合回答。代价写在代码注释里：
  同一个成因换一家店发作，6 小时内不再发一条。
- 新增两个用例文件：`runtime/browser-window-bounds.test.mjs`、
  `skills/sycm-alimama-daily-report/scripts/stage-browsers.test.mjs`；`arch-boundary.test.mjs` 的
  `SKILLS_TO_RUNTIME` 登记表补 3 条（两个新叶子与两个新用例文件）。

### 为什么改

- **视口**：`evidence/daily-job-2026-10-13/job.log` 里那次登录失败，量到的窗口是 692×307
  （视口 670×216），而脚本按坐标点 `[535,499]` 提交 —— 那个点落在窗口外面，所以「点了」等于没点。
  收据写的却是「可能是密码不对」，**密码、滑块、协议三样都是好的**。而窗口怎么变小的？没有任何一步
  负责它：`SHOP_BROWSER_EXTRA_ARGS` 只管店铺实例，共用商家浏览器从一开始就没有尺寸保证人。
- **修复层**：`evidence/batches-2026-10-13/b2/网林淘宝/97-repair-agent-report.md` 里，agent 复现了
  三处框架缺口（缺 `STAGE_PAGE_HINT` 条目、三处按店名取实例、`resolveProxy` 禁止共用代理组合），
  并**明确声明**它自己那次 `RELOAD_PAGE` 不是救回原因（它落在店铺标识页上）。
- **告警指纹**：`evidence/batches-2026-10-13/batches.log` 里同一天两条 `daily-round-20261013`
  共用一条锚、各发一次 —— 那两条的成因**确实不同**，所以当时发得对；但旧指纹的第一段是笼统的
  `ROUND_BLOCKED`（不带成因），意味着「共用窗口掉登录」与「页面真的不在」这两种要人做的事完全不同的
  情形会落进**同一个指纹**、第二条被静默挡掉。漏发比刷屏坏，而且从日志上看不出来。
  指纹的「位置」那一半同样要收：同一个根因换一家店、换一个步骤发作，不该算新信息。

### 验证到什么程度

- **仅离线判据**：定向组 **642 pass / 0 fail**（`evidence/viewport-and-repair-scope-2026-10-14/targeted-tests.txt`，
  末尾 `EXIT=0`）；三个突变台共 **20 处变异全部按预期变红**、且每次都在断言之前把源文件
  **逐字节还原**（`mutations-login-window-gate.txt` 7 处、`mutations-repair-scope.txt` 9 处、
  `mutations-alert-fingerprint.txt` 4 处，三份末尾都是 `EXIT=0`）。
- **本批次没有真机运行**：视口闸门与窗口归位**一次都没在真机上跑过**，登录侧闸门也一样
  （`--dry-run` 不做任何点击）。按约定，驻留窗口期不手工重跑日报链、也不起停任何进程。
  **下一个 11:00 定时轮是这套改动第一次真机接触**，要盯 `evidence/daily-job-<日>/viewport.json`
  与 `job.log` 里那一行闸门输出。
- **没有真发过飞书**：指纹改判只用临时节流文件离线验过（`dispatchRoundAlert` + `mkdtemp`），
  刻意不写 `runtime/alert-throttle.json`（那会让真跑的那一轮被自己的测试挡住）。
- 现场证据、未修清单（`readback` 仍无 `ensureTargetPage` 自愈等）与可重跑的复核命令：
  `evidence/viewport-and-repair-scope-2026-10-14/VERIFICATION.md`。目标日 10-13 那一轮的证据同批提交。

> **更正（2026-10-14，见 [1.9.1]）**：上面「642 pass / 0 fail」是在**本机（LF）**工作区跑的，
> 推上去之后 CI 红了 —— `fast-gate` 与 `skill-tests (sycm-alimama-daily-report)` 各挂一条，
> 两条都是**只在 CRLF 检出下才发作**的问题（一处 EOL 脆弱的源码级断言、一处漏改的步骤序列钉子）。
> 结论：本条的「定向组全绿」**不构成交付判据**，交付判据是在 CI 那个环境里全绿。已由 [1.9.1] 修复。

## [1.8.14] - 2026-10-13

修 CI 那个「3 小时被 cancel」的长杆作业。根因一句话：**Python 在非中文区域的 Windows 上
按 cp1252 输出，打不出中文**；校验器一崩，CLI 就把候选判成失败，然后一直等到 60 分钟的下载
deadline —— 每个这样的用例烧掉一小时，整条作业在 180 分钟超时被 cancel。

### 改了什么

- `skills/xws-export-market-analysis/scripts/validate-output.py` 与 `merge-market-analysis.py`：
  模块头部把 `sys.stdout` / `sys.stderr` 显式 `reconfigure(encoding="utf-8")`（`import sys` 同步补上）。
  这两处末尾都用 `print(json.dumps(..., ensure_ascii=False))` 输出含中文的 JSON。
- `skills/xws-export-market-analysis/scripts/export-market-analysis.mjs` 的 `runPythonValidation`：
  补上 `env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }`。
  同一个 skill 里 `merge-market-analysis.mjs:139` 与 `run-adaptive-export.mjs` 早就这么写了，
  只有这一个调用点漏了 —— 同一类缺陷活了第三处。
- 新增 `skills/xws-export-market-analysis/tests/validator-encoding.test.mjs`：把「子进程被强制成
  cp1252 时，两个校验器仍必须吐出可解析、中文未被降级的 JSON」钉成判据。

### 为什么改

CI（GitHub 的 windows runner，英文区域）上三条红，全是同一个编码问题：

| CI 用例 | 现象 | 修复前耗时 |
| --- | --- | --- |
| #136 rebuilds an XLSX with images ... | python 校验器直接抛 `'charmap' codec can't encode characters` | 1.3 s（快红）|
| #154 full flow retries a missed start click ... | 校验器崩 ⇒ 候选被拒 ⇒ 等到 deadline | **3635 s** |
| #155 adopts a complete live result ... | 同上 | **3602 s** |

链路是：下载采纳路径（`export-market-analysis.mjs:1813` 的 `runPythonValidation`）抛错以后被
`waitForDownload`（`:1720`）记为 `EXPORT_CANDIDATE_REJECTED` 并继续轮询，直到模块常量
`EXPORT_SETTLEMENT_MS = 60 * 60 * 1000` 耗尽才报 "Timed out waiting for .csv download"。
本机（默认 utf-8）不复现，所以本地一直绿 —— 这是**只在非 utf-8 默认编码的 Windows 上才发作**
的真缺陷，客户的机器若是英文区域同样会中招，不只是 CI 的事。

### 验证到什么程度

- **本地复现（决定性）**：把父进程环境设成 `PYTHONIOENCODING=cp1252` 即可复刻 runner。
  修复前 `node --test .../merge-market-analysis.test.mjs` 的 #3 报出与 CI 逐字相同的
  `'charmap' codec can't encode characters`；修复后同一命令 **3/3 过**。
- 两条长挂用例在**有界**子进程里重跑（同样 cp1252）：#154 **44.6 s 通过**（原 3635 s）、
  #155 **11.2 s 通过**（原 3602 s）。
- 整个 skill 套件（`run-test-suite.mjs skills --skill=xws-export-market-analysis`，cp1252）：
  **206 / 206 / 0**，1268.3 秒。新增的 `validator-encoding.test.mjs` 在套件启动后才创建，
  未进这一轮，单独跑 **2/2 过**。
- 突变验证：把两个脚本的 `reconfigure` 改成 no-op ⇒ `validator-encoding.test.mjs` 两条
  **按预期红**并打出 `charmap` 错；还原后 sha256 逐字节一致、复跑全绿。
- 真机判据＝push 后的 CI run（见提交）。

## [1.8.13] - 2026-10-13

把「调度时间」在文档里对齐到宿主实际登记值：推广 07:00 / 商品 10:00 / **日报 11:00**。
**不改任何运行时代码，也不改宿主配置** —— 只改两份文档与文档生成脚本。起因是 1.8.11 那条
完成提醒里我把日报时间写成了工作记忆里的旧值（15:30），顺藤查出同一件事在仓库里还漂着三种写法。

### 改了什么

- `docs/ops/DAILY-FLOW-SCHEDULE.md`：日报行 `11:30` → `11:00`（与上一条间隔 1 小时 30 分 → 1 小时），
  「日报放 11:30」的理由段同步改写为 11:00；并**新增一条如实口径**：11:00 早于阿里妈妈推广 CSV
  静止点（11:20 硬边界），附 2026-10-13 二次导出实测作安全证据（同一业务日两次导出「营销场景报表」，
  11:15:08 早于静止点 / 11:48:11 晚于静止点，两份 ZIP 内 CSV 的 sha256 逐字节相同、数值逐字段一致；
  证据 `evidence/daily-job-2026-10-12/VERIFICATION-1100-FIRST-RUN.md`）。
- `scripts/build-workbuddy-manual.mjs`（生成客户手册 docx）：时间表 `每日 15:30` → `每日 11:00`
  （店铺数据日报）、`每日 18:00` → `每日 10:00`（商品数据日报）；商品行的依赖说明由「依赖日报释放
  商家浏览器」改为「三条早间流程里排第二」（10:00 早于 11:00，原时序已反）；「五店」/「五家店」→
  「销售1部 8 家店铺」；日报提示词命令由 `--batches 1` → `--batches 5 --auto-repair --mode apply`；
  商品提示词补 `--batches 5 --skip-promotion`、去掉已不属本流程的推广阶段描述、依赖改为「先确认推广
  日报已结束」；周报提示词首段 `每周一 09:30` → `每周一 09:00`（对齐 `runtime/round-schedule.json` 的
  `weekly-keyword`）；表后加一段说明：早间三条流程权威时间表见 `DAILY-FLOW-SCHEDULE.md`、推广日报不在
  本文档三套流程范围内、周报链路当前未挂宿主定时任务（`weekly-keyword` 的 `enabled=false`，启用前须人工触发）。
- 手册 docx 重新生成并改名（`-2026-09-27` → `-2026-10-13`），旧文件删除。

### 为什么改

「日报几点跑」这件事在仓库里同时存在三种写法：宿主自动化登记的是 **11:00**（权威，
`~/.workbuddy/logs/automation.log` 的 `nextRunAt=1791860400000` = 11:00:00 +08）、
`docs/ops/DAILY-FLOW-SCHEDULE.md` 写 **11:30**、`scripts/build-workbuddy-manual.mjs` 写 **15:30**
（客户手册还同时写商品 18:00，与实际 10:00 相差 8 小时）。同一件事三种写法，谁照文档去核对都会
被误导 —— 1.8.11 那次就是这么错的。用户 2026-10-13 拍板：**保持宿主 11:00 不动，把文档同步到 11:00**。

### 验证到什么程度

- **无运行时代码改动** ⇒ 不跑测试套件；本次只跑版本一致性与暂存语法预检
  （`runtime/version-consistency.test.mjs`、`check:staged`）。
- 手册 docx 由脚本重新生成成功（产物存在，12739 字节）；三处版本号（`VERSION` / `package.json` /
  本条标题）逐字一致由守卫覆盖。
- 未做：宿主端不做任何改动（rrule 与 `enabled` 都不动）。

## [1.8.12] - 2026-10-13

修 1.8.11 完成通知的一个**对数不上现场**的数字：底单行数从「跨店求和」改为
「跨店按 recordId 去重取并集」。一句话：**全店共一张的表，一家读到就是全体读到，
求和等于把同一个事实数 N 遍**。

### 改了什么

- `runtime/flow-ok-facts.mjs` 的 `dailyOkFacts`：底单与询单表都是**全店共一张**
  （底单＝「总数据来源底单」tblIuAX4nPc1zDOO；询单表按日期 × 店铺一行），一家店的
  回读读到的是**整张表在该日的行**（子集，里面躺着别家店的行）。口径改为跨店按
  `onDateRows` 的 recordId 取并集；老工件没有 `onDateRows` 时退回 `onDateCount`
  取最大值（仍不求和）。`onDateCountIsLowerBound` 整家不计入、缺文件不计入两条不变。
- `runtime/flow-ok-facts.test.mjs`：dailyOkFacts 一组重写，新增两条钉口径的用例 ——
  ① recordId 重叠时取并集不求和；② **2026-10-12 实测形状回归**（8 家读数
  1/3/4/8/7/6/2/5，求和 36、并集 8）。

### 为什么改

1.8.11 当天真发了一条「【店铺日报】采集完成…底单 36 行」，而底单该日实际只有 8 行
（一家一日一行，VERIFICATION 报告亦为 8）。根因：各家回读时页面模型加载进度不同
（`loadedRows` 不同）⇒ 同一张表的 `onDateCount` 各家读数不同，求和把同一个事实
数了 8 遍、每遍数量还不一样。完成通知的数字是收信人判断「今天是不是真收全了」的
唯一依据，口径错一条，整条通知的可信度就没了。

### 验证到什么程度

- 定向：`node --test "runtime/*.test.mjs"` 1259 过 0 挂（比 1.8.11 多 2 条，即新增
  回归用例）；`arch-boundary` 3 过。
- 突变：把并集逻辑改回 1.8.11 的求和老路 ⇒ 3 条用例按预期红（含实测形状那条：
  期望 8 实得 36），恢复后复跑全绿。
- 真机口径核对：按修正口径重算 2026-10-12 事实 = 底单 8 行、询单表 8 行，与
  VERIFICATION 报告一致；商品数据完成提醒已按修正后的代码路径真发一条
  （`product-ok-20261012`，SENT，数字来自两个导入器收据：商品底单 239 行、商品询单 51 行）。
- 未决：店铺日报那条**带错数字**的消息已在 1.8.11 发出（`daily-ok-20261012`，
  6 小时去重窗口内）。是否按修正口径重发/更正，待用户拍板后执行。

## [1.8.11] - 2026-10-13

统一飞书预警机制（设计文档 `docs/ops/FEISHU-ALERT-UNIFIED-DESIGN.md`，用户 2026-10-13 五问定稿）。
一句话：**四条流程各叫各的名字，成功只提醒业务查收，失败才带技术定位块**。

### 改了什么

- 新增 `runtime/alert-copy.mjs`（全仓统一提醒词表）：`FLOWS` 四条流程登记（店铺日报／推广日报／
  商品数据／周报，标题方框词 + 周期叫法 + 编号前缀）、`buildFlowOkAlert`（完成通知，纯业务）、
  `buildTechBlock`（技术定位块，5 键白名单、**不放机器名**）、`dailyCauseCopy` 与从日报链
  **原样并入**的三张词表（11 类结论各有各的措辞，重写只会引入漂移）、其余三链的兜底文案、
  加载期三张表互锁。日报链 `run-multi-shop-day.mjs` 保留同名 re-export。
- 渲染层 `runtime/notify-feishu-core.mjs`：`TITLE_BY_TYPE` 补四项（`DAILY_ROUND_FAILED` /
  `DAILY_HOLD_TIMEOUT` / `PROMOTION_ROUND_FAILED` / `ROUND_RESOLVED`）；`renderAlertText` 新增
  技术段 —— `alert.tech` 存在时输出固定小标题「以下是给技术同学的定位信息」+ 白名单 5 键，
  整个块无值时不挂空段。
- 四条链接线：日报链四条告警构造器标题统一加【店铺日报】、`capability` 改运营叫法、
  失败告警挂 tech 块（`roundTechBlock`，不含机器名）；推广链 reason 不再裸塞 `record.error`、
  action 去掉 `start-all` 命令；商品链修已知缺陷 ㉒（去盘符路径／job.log 文件名／机器名／
  机读码，业务段＝人话＋现场原话截断）；周报链 `capability` 与 `alertId` 归一
  （`weekly-collect-<时间戳>` → `weekly-round-<业务日>`，接进去重与记账）。
- 新增收集完成提醒（用户定稿第 1/5 条）：四条链收尾各挂一处，**只在整轮成功时**发、
  纯业务不带技术块，数字来自**独立回读工件**（`runtime/flow-ok-facts.mjs`：日报＝各店
  `independent-readback.json`，推广＝导入器 `receipt.json` 写后回读，商品＝两个导入器收据），
  读不到工件的店不计入也不补 0，一家读不到就整条不发。投递走新公共出口
  `runtime/deliver-alert.mjs`（`dispatchAlert`：去重 → `--alert-file` 不走 stdin → stdio 显式
  → 只认真送出去才记账）。
- 驻留/续跑两条通知（`runtime/hold-and-resume-plan.mjs`）按流程取口径之外，标题也加流程名前缀。

### 验证

- 定向组全绿：`runtime/*.test.mjs` 1251 过、`skills/sycm-alimama-daily-report/scripts/*.test.mjs`
  563 过（版本 1.8.11 工作区）。新增 4 个测试文件：`alert-copy.test.mjs`（24）、
  `flow-ok-facts.test.mjs`（9）、`deliver-alert.test.mjs`（10）、
  `flow-ok-notice-wiring.test.mjs`（6，源码级接线守卫）、
  `alert-type-title-guard.test.mjs`（6，全仓 type 标题闭集守卫）。
- 突变验证 4 条全红后恢复：删词表一项（加载期互锁抛）、删 `TITLE_BY_TYPE` 一项（新守卫与
  XWS 守卫双红）、去掉日报标题流程名（链用例 3 红）、摘掉日报完成提醒分支（接线守卫红）。
- **仅离线判据**：完成提醒与两段式告警尚未在真机发过；下一次定时跑（15:30 日报）是第一场
  真机验收，证据看 `evidence/daily-job-<日>/` 的 `completionNotice` 与 job.log。
  - **更正（2026-10-13 晚，用户当场质疑后核实）**：这条里有两处错。①「15:30 日报」是 2026-10-10
    之前的旧排期 —— 宿主自动化的实际登记是「sycm 日报定时（**每日 11:00** · 销售1部 8 家）」，
    `automation.log` 里 `nextRunAt=1791860400000` 实测为 11:00:00（写这条时引的是工作记忆里的
    旧值，未核实宿主，是我的错）。②「下一次定时跑是第一场真机验收」也没发生 —— 当天 11:00
    那轮跑的是 1.8.10（`evidence/daily-job-2026-10-12/job.log` 首行「版本：sycm-automation
    1.8.10」可证），当时完成提醒尚未接线。首条真机消息实际是 1.8.11 提交后按用户要求手工
    触发的三条流程完成提醒；其中日报那条的底单数字口径有误，已在 1.8.12 修正并重发。

## [1.8.10] - 2026-10-13

`check:head` 补上 `sycm-export-search-rank` 组。1.8.9 修的那个「生产代码从来没成功过」的
静默失效正好落在这个 skill，而它此前**不在闸门覆盖范围内**——一个刚证明过会静默坏的组
没进门，闸门就留着洞。该组一轮约 6 秒，没有理由不跑。

### 改了什么

- `scripts/check-head.mjs` 的 `GROUPS` 加 `skills:sycm-export-search-rank`（`--skill=` 等号形式，
  与另外三组同一写法）。它需要的 `verify-export-pair.py`／`write-workbook.py` 均已被 git 跟踪，
  干净检出自给自足（`git ls-files` 已核）。

### 验证

- 该组可被单独选出：`run-test-suite.mjs skills --skill=sycm-export-search-rank --dry-run`
  ⇒ `skills: 4`，四个文件全在该目录下（预检可通过）。
- 对 1.8.10 的全量 `check:head`（五组）见当次 evidence 目录。

## [1.8.9] - 2026-10-13

`check:head` 自己的一个静默失效 ＋ 三个叶子测试的 EBUSY 假红（其中一个往下挖出一个真生产 bug）。
起因是给 1.8.8 的 `check:head` 跑第一次全量验证：它跑了 20 分钟、1143 条，报出来 3 红 ——
而那 3 条**不在它声明要跑的那一组里**。

### 改了什么

- **`check:head` 的 `--skill` 写成空格形式 ⇒ 静默不过滤（1.8.8 自带缺陷，已修）**。
  `run-test-suite.mjs` 的解析是 `argv.find((v) => v.startsWith('--skill='))`，只认等号形式；
  空格形式（`'--skill', 'X'`）被静默忽略，那一组把**全部 75 个 skill 测试**都跑了。
  症状不只是慢：混进别家 skill 的红，报出来却像「这一组红了」—— 正是本仓反复吃亏的
  「把读不到/跑多了当成没问题」家族。三处已改回 `--skill=<名字>`。
- **每组开跑前加 dry-run 预检（防复发，不只是修这一次）**。用对面的 `--dry-run` 列出
  这一组真正会跑的文件：计数为 0 ⇒ 硬失败；`--skill=` 组的文件出现目录外杂项 ⇒ 硬失败，
  并直接点明「最可能是 --skill 写成了空格形式」。预检秒回，失败时一个测试都不跑。
- **三个测试文件的 spawnSync 补 `stdio: ['ignore','pipe','pipe']`**（EBUSY 假红）。
  本机宿主对「给子进程管道 stdin 的同步 spawn」确定性回 EBUSY（`status` 变 `null`，
  实测：关掉会话沙箱也一样，所以不是沙箱问题）。仓库早有此惯例与带日期的注释
  （`import-promotion-daily-report.mjs:41`，2026-10-11），这两处是漏网的。
- **`source-period-proof.mjs` 的真生产 bug（往下挖出来的，已修）**：`verifyExportPair` 的
  spawnSync 同样没给 stdio ⇒ 在这台机器上**从来没成功过**；更糟的是失败路径
  `result.stderr.trim()` 在 spawn 失败时 stderr 是 `undefined` ⇒ 错误处理自己抛 TypeError，
  把「为什么没验成」埋得一个字节不剩。两处一起修：补 stdio，消息改为兜住 undefined 并带上
  `result.error.code`（EBUSY 会原样出现在消息里）。

### 为什么这样改

`check:head` 是 1.8.8 新加的闸门，它的全部价值在于「可信」—— 一次 20 分钟的误导性红，
比没有闸门更糟（训练人忽略它）。所以修的不只是那三个字符，而是把「筛选没生效」变成
跑之前的硬失败。EBUSY 三处则是同一家族的第 N 次发作：错误路径自己先死、成因被埋。

### 验证

- `skills/sycm-export-search-rank` 42/42（修前 39/42；三条红同根，前两条 EBUSY、
  第三条是 EBUSY 治好后往下漏出的 `verifyExportPair` 真 bug）。
- 预检行为实测：等号形式 ⇒ `skills: 23` 全在对的目录下、通过；空格形式 ⇒ `skills: 75`
  混进别家、被前缀检查硬拦（消息里直接点明写法问题）。
- 同步 spawn 的 EBUSY 边界实测：默认 stdio / `input:` 选项都中招；`stdio:'ignore'` 与
  `['ignore','pipe','pipe']` 均正常；`execSync`/`execFileSync` 同样中招。
- 全仓扫描（`git ls-files --cached --others --exclude-standard`）：80 处 child_process
  调用没显式 stdio，其中同步的约 15 处 —— 除已修的 3 处外均**未被离线用例执行到**
  （本次误跑的全量 skill 套件 1143 条只红这 3 条即证），列为待办不在本轮动。
- `check:head` 对 1.8.9 提交的全量复跑见当次 evidence 目录。

## [1.8.8] - 2026-10-13

失败现场「拍错页」的根修 ＋ 三个叶子采集脚本补现场 ＋ 两条新闸门（`check:head`、参数契约守卫）。
这一版的定位是「把三类静默失效各自变成一个会红的东西」——它们的共同病根是同一个家族：
**把「读不到」当成「不存在」**。现场采错页 ⇒ 看着像页面正常；参数收了不用 ⇒ 看着像传过了；
测试跑在工作区 ⇒ 看着像全绿。

### 改了什么

- **感知层选页：按站点提示取页（缺陷⑤的第一块拼图）**。`failure-perception.mjs` 新增
  `pickFailureTarget(targets, { pageHint })` 与 `siteFragmentFor(site)`：给了站点标签就用
  `runtime/target-url-match.mjs` 的 `pagesMatching` 挑那一站的页，挑不到才退回「第一个非 `about:`
  页签」（历史行为逐字不变）。`how`（`pageHint` / `firstNonAboutPage` / `none`）一路带进返回值与人读版，
  读的人从此能说清「这一页是怎么选中的」。`run-multi-shop-day.mjs` 传
  `pageHint: STAGE_PAGE_HINT[record.failedStage] ?? null`（认不出来的阶段给 null ⇒ 退回历史行为）。
  为什么要修：10-10 那次 `promotion-fetch` 失败的现场，URL 是**店铺标识页**
  （`runtime/shop-window-label.html`）而不是阿里妈妈页 —— 现场文件在、`ok:true`、内容却与出事那一页无关
  （`evidence/batches-2026-10-10/b1/里可林淘宝/98-failure-state.txt`）。缺陷⑤「未定位」不是因为没人查，
  是**现场本来就没对准页**。
- **三个叶子采集脚本补「失败现场」（待修清单 ㊶）**。新增 `collect-failure-scene.mjs`：把三个代理调用
  （`/targets`、`/eval`、`/screenshot`）接上 `captureFailureState`，**永不抛**（连 `log` 自己抛了都兜住 ——
  stdout 管道被关时 `console.log` 真的会抛 EPIPE，那不是假想）。`collect-shop-report.mjs`、
  `collect-promotion-report.mjs`、`sycm-promotion-data/collect-product-report.mjs` 的 CLI 入口改成
  「解析 → 跑 → **先采现场再抛**」：采现场要 `proxy` 与 `logDir`，而那两个在入口里才算出来；
  顺序理由与编排层同一条（抛出去之后页面可能被导航走，那一刻的 DOM/截图就没了）。
  `--log-dir` 不给 ⇒ 不采，且打印一句说明（整轮跑时编排层自己会采，别重复拍一遍）——
  静默跳过会让「没现场」与「不需要现场」长得一样。
- **新闸门一：`check:head`（干净检出下真跑一遍）**。`scripts/check-head.mjs` ＋ `npm run check:head`：
  临时 `git worktree add --detach` 出 HEAD 的干净副本 → 在**那个目录**里跑定向组（runtime ＋ 日报链 ＋
  商品链 ＋ 询单链）→ 删掉。一个字节都不碰正在编辑的工作区（本仓常有未提交改动，那是别人或我自己
  正在做的事）。`node_modules` 默认用 **junction** 链进去（不需要管理员权限、离线可用、秒级）；
  `--npm-ci` 可真装一遍。它补的缺口写清楚：`runtime/head-loadable.test.mjs` 只挡「缺导出」那一类
  （那一类在模块链接期就炸），而「参数收了却不用」「三态没认全」「步骤顺序反了」要跑起来才暴露，
  而跑起来跑的永远是工作区。
- **新闸门二：参数契约守卫（契约第 2 类）**。`collector-arg-contract.test.mjs`：拿 `buildShopStages`
  **真实传的 argv**，逐个核对「对面认得吗、真的用吗」。判据取真实 argv 而不是「被调方声明的参数表」——
  声明表答的是「我能收什么」，契约要答的是「你传给我的每一个我都处理了」；拿声明表核对会让
  `collect-shop-report.mjs` 背上一堆共用 parser 里它根本用不到的参数，那是假红。
  首跑抓到一个真事并登记在白名单里：`collect-promotion-report.mjs` 收了 `--expect-shop` 却只有一处赋值
  （`if (args.reportKind) args.expectShop = args.shopKey;`）、无人读 —— 阿里妈妈那一页不显示店铺名，
  这一侧的闸门是会员名，那行赋值因此是死代码（**候选清理项，本轮未改行为**）。
- `collect-core.mjs` 的 `parseCollectArgs` 新增可选 `--log-dir`（失败现场产物目录；不给＝不采）。
- `runtime/arch-boundary.test.mjs` 显式登记两条新的 skills → runtime 依赖（`failure-perception.mjs` 引
  `target-url-match.mjs` 挑页；`collector-arg-contract.test.mjs` 引 `browser-ports.mjs` 取参与采集名单），
  各带理由。

### 验证

- 新增/改动用例：`failure-perception.test.mjs` 11 → 18；`collect-failure-scene.test.mjs` 5 条
  （**起真 HTTP 服务当代理**，钉住 URL/方法/body/挑中的页签，而不是把三个调用点 mock 掉 ——
  mock 只能证明「调用侧以为自己在传什么」，证明不了「对面真认不认」）；
  `collector-arg-contract.test.mjs` 7 条（5 条合成样本钉判据本身 ＋ 真文件核对 ＋ 一条**反面对照**：
  拿真文件喂一个对面不认的参数，证明守卫真能红）。
- 日报链 ＋ 商品链既有用例 **565/565 绿**（`node --test skills/sycm-alimama-daily-report/scripts/*.test.mjs skills/sycm-promotion-data/scripts/*.test.mjs`）。
- `runtime/arch-boundary.test.mjs` 3/3 绿。
- **仅离线判据**：感知层选页与失败现场出口都没有真机验证 —— 要等下一次 `promotion-fetch` 失败自然发生
  （那时 `98-failure-state.txt` 的「现场页签」一行会直接说明挑对没挑对）。

## [1.8.7] - 2026-10-12

10-10 17:13 起休眠的 xws 链整批落地（19 个工作区文件，两日未提交）＋落地过程里挖出的两处真缺陷修复。
这一版的定位是「把工作区与 HEAD 对齐」：落地前 HEAD 上 `product-data-import-outcome-wiring` 与
`arch-boundary` 两个守卫在干净检出下是红的（用例已提交、实现半边在工作区——半提交的又一次发作，
这次在 push 前抓住）。

### 改了什么

- **xws 链失速阈值统一 300→180 秒**：`SKILL.md`、`run-collection-host` 默认值、`supervise-collection`
  注释、exporter/runner 的 `--stall-seconds` 默认值全部对齐；单跑默认 120 秒不变，文档同步。
- `supervise-adaptive-export` 新增 `cleanupSearchTargets()`：多遍回收**无主**的淘宝搜索页（异常终止或
  旧版本遗留），收完复核、残留记 failed；事件 `STALE_SEARCH_TARGETS_CLEANED`／并入 `TARGETS_CLEANED`。
  运行锁仍保证同一买家浏览器不并发采集。
- `export-market-analysis` 的 XLSX 校验器：校验器紧跟合并进程启动时可能读到**写了一半的 ZIP** 而吐
  traceback ⇒ 先等产物尺寸稳定（settle）再跑；失败隔一个 settle 窗口**重试一次**。python 子进程统一
  `PYTHONIOENCODING/PYTHONUTF8`（`PYTHON_UTF8_ENV`）。
- `feishu-client`：非 JSON 响应（网关 5xx／限流拦截页这类 HTML）不再走 `response.json()` 抛「Unexpected
  token '<'」——先取正文再解析，错误信息保留 **HTTP 状态码**＋160 字符正文摘要（2026-10-06 盖文淘宝/
  底单 写后回读收到 HTML、判因只剩一句语法错误的实证）。
- `import-product-data`：**写已发生 ⇒ 立刻落收据**，再做写后回读；回读失败退 **2（UNKNOWN_WRITE）**
  与退 1（真没写成）分开——修「数据一行不少、却一个收据都没有、调用方只能记失败」（2026-10-06 实测）。
- **`spawnSync` 全量补 `stdio: ["ignore","pipe","pipe"]`（15 处）**：裸 `spawnSync`（默认全管道）在受限
  环境（宿主沙箱）必炸 EBUSY——实测校验器全部拒跑、每个下载落盘用例被迫烧满 1 小时 deadline；与
  2026-09-27 商品导入真机事故同型。覆盖 4 个脚本（exporter 校验器、adaptive 合并器、merge、
  runtime-lock）与 5 个测试文件。
- **修休眠流自己引入的契约破坏**：`cleanupSearchTargets` 原被插在 `runUnlocked` 第一行——在 /health
  闸门**之前**就碰 /targets，且异常路径 finally 里也无条件清扫 ⇒ 「坏代理必须零目标发现退出」的
  prepare-flow 契约红（非 Edge／断连两个守卫用例实测 /targets 被调 4 次）。修＝清理挪到 PROXY_READY
  之后＋`proxyAccepted` 旗标护栏（闸门没过，finally 也不许碰 /targets）。
- **恢复被误删的配置守卫**：休眠流曾删掉「推广日报目标指向销售一部已确认 Base 与两张表」用例且无
  迁移去向（HEAD 上该用例本为绿）——恢复，防止 `feishu-targets.mjs` 与断言漂移。

### 验证

- `xws-export-market-analysis` 全量（skills 离线套件，2026-10-12 主树）：快文件 6 个 112 用例
  104 过／0 挂／8 跳；`prepare-flow` 38/38（约 20 分钟）。修复过程定点验证：毒跑用例
  （下载落盘全流程）补 stdio 后 45 秒过（修前同用例烧满 60 分钟 deadline）；非 Edge／断连
  两个守卫用例修挪位＋旗标后过（修前 /targets 被调 4 次）。
- 其它腿（同日主树）：`xws-to-feishu-base` 103/103、runtime 三件 39/39（含恢复的推广日报目标守卫，
  22/22）、`sycm-product-data` 12/12、`version-consistency` 6/6、`check:fast --all` PASS。
- 干净 worktree 复现（b558c86，装齐依赖）：`check:fast` PASS、`test:offline` 零 not-ok、
  `test:runtime` 1240 用例仅剩 2 失败，均为本批落地对象（`arch-boundary` 登记、商品收据时序）——
  主树以休眠版文件验证同两文件 9/9。
- **仅离线判据**；xws 链真机验收待下一轮真实导出任务。
- **追加提交（CI 首跑实证后补）**：CI（UTC runner）上 `login-merchant-core` 的 alertId 用例挂——
  `localDateStamp` 按机器本地时区取年月日，「23:59+08」与「次日 00:01+08」在 UTC 里落同一天、
  去重锚失效。修＝换算到东八区再取 UTC 年月日（统计口径一律 +08，与本机行为逐字一致）。
  `TZ=UTC` 模拟下全套 544/544。

## [1.8.6] - 2026-10-12

2026-10-12 07:00 推广定时轮真机事故（跑在 1.8.5 上）的三处根修。**这一版不引入任何新能力** ——
全是「上一版本该跑通、真机一跑就现形」的补丁：一处漏 import（整轮秒死、零写入）、一处把「同 URL
navigate 当刷新」（三家店被确认判据误杀）、一处告警口径写死「日报」（推广链驻留却发「日报补跑
失败」）。三处互不相干，可分别 revert。

### 改了什么

- `run-promotion-daily-report.mjs` 补 `reusablePromotionTask` 进 core import（**整轮秒死的根因**）：
  该名在第 167 行被调用、而 import 名单里没有它。`node --check` 只查语法，查不出「引用了没导入的
  名字」，于是 5 家店在真机上全部秒死在 `reusablePromotionTask is not defined`、零任务提交零写入。
  配套加**接线守卫**用例：runner 引用到的每个 core 导出，必须出现在它自己那条 core import 名单里。
- 列表页的「刷新」改成**真重载**：确认循环最后一步原来是 `await navigate(args.proxy, target, LIST_URL)`，
  而目标 URL 与当前 URL 相同时 navigate 是**同文档导航、浏览器什么都不做** ⇒ 列表永远停在提交后
  第一次渲染那一版，晚几秒才生成成功的任务一条都读不到 ⇒ 判「15 分钟未确认」⇒ 整家店误杀
  （10-12 盖文淘宝/盖文天猫/科塔淘宝 三家实证；平台侧任务其实早就生成成功）。改为复用项目已有的
  `collect-core.createPageReloader`（自带等就绪，免得重载打断 eval 上下文后读到空白页、把「还没
  渲染」误判成「控件不存在」），并抽出 `openFreshTaskList = navigate + 真重载`，统一三处「读列表」
  点（复用基线、提交前、提交后确认）—— 少走这一步的代价不是「慢」：基线读旧会漏掉已有同日任务、
  多做一次重复提交；确认读旧会误杀整家店。
- 驻留/续跑告警口径按**发起驻留的那条流程**取：新增 `noticeLabelsForWorkflow()`，`closeOutNotice`/
  `resumeResultNotice` 的标题/对象/任务/`capability` 按 workflow 换词，缺省日报口径逐字不变；
  `alertId` 一并分域（原来两条链共用 `daily-hold-*`）。顺带修掉一个真 bug：同一天里推广的驻留会
  把自己 6 小时去重窗里的**日报**那条（指纹同为 `HOLD_TIMEOUT`）压掉 —— 一条真正要人看的消息
  一个字都发不出去。调用侧 `hold-and-resume.mjs` 两处 dispatch 传 `...noticeLabelsForWorkflow(args.workflow)`。
- 测试：`promotion-daily-report-core.test.mjs` 新增 4 用例（接线守卫、确认循环真重载回归钉、真重载器
  行为、`openFreshTaskList` 三处读取点＋裸 navigate 计数），并把既有的 10-11 用例「提交入口按业务日
  确认生成成功任务」的钉法同步改到 `openFreshTaskList`；`hold-and-resume-plan.test.mjs` 新增 3 用例
  （口径函数缺省不变、推广口径与编号分域、调用侧源码级接线守卫）。

### 验证

- 定向组：`promotion-daily-report-core.test.mjs` 19/19、`hold-and-resume-plan.test.mjs` 44/44，全绿。
- 突变验证（离线，均以 sha256 还原核对逐字节一致）：去掉 `reusablePromotionTask` 的 import ⇒ 接线
  守卫红且点名该符号；把确认循环那句 `reloadListPage` 换回 `navigate` ⇒ 回归钉红。
- **真机部分验证**：漏 import 已由 08:29 手动重跑证明消除 —— 里可林淘宝全链 5 步写入飞书、网林天猫
  全链写入（证据 `evidence/batches-2026-10-11/b1/`）。真重载那处修复对**已启动**的驱动进程无效
  （node 启动即加载模块），故 10-12 那轮里 09:22 起的续跑仍跑旧码；真假两可的真机验收要等下一轮
  新起的驱动。
- **补齐（2026-10-12 追加提交）**：`ef629d0`（10-10「fix: stabilize promotion daily report collection」）
  是一次半提交 —— 消费侧进了 git、供给侧四件没进，导致 1.8.1 起 `HEAD` 上推广链
  `import { pendingForKind }` 链接期即 `SyntaxError`（干净 clone 不可运行；CI 10-11 run 38135519746
  的日报链 job 里白纸黑字）。本批把供给侧四件落库：`promotion-task-ledger.mjs`（`pendingForKind`/
  `taskPatternForKind` 导出＋kind 穿参＋`REPORT_TASK_PATTERN` 放宽到三类任务名）、`collect-core.mjs`
  （`--report-kind` 参数解析）、`collect-promotion-report.mjs`（keyword/audience 模式与校验）、
  `promotion-task-ledger.test.mjs`（kind 隔离用例）。逐字核对过与 `ef629d0` 消费侧严格配套、无夹带；
  定向组 544/544。

## [1.8.5] - 2026-10-11

三链对齐 P1 绞杀者迁移第 3 步：推广链并写统一字段＋写入时校验。**旧字段一个不动**
（batch/shop/status/stages/error/recovery/repairRequest.candidates 原样保留），单 commit 可
revert。真机验证窗口＝2026-10-12 07:00 推广定时轮（与 P0 四件真机验收同场）。

### 改了什么

- `run-promotion-sales1.mjs`（+50/-6，删改行全是构造表达式重写、旧字段语义零丢失）：
  buildPromotionSummary 并写统一字段——version 换 `unified-summary-v1`（旧串
  `promotion-sales1-summary-v1` 经 grep 全仓无生产读者，仅测试断言随本步更新）、
  workflow='promotion-daily'、逐店补 evidence（与 importer 落盘同款 `<--evidence 根>/<店>`
  拼法）；失败店补 failureClass='STAGE_FAILED'（**最小档分类器**，草案 6.1 允许——推广链尚无
  逐店分诊判据，不发明新业务判据，细化留后续）、noActionRequired:false（空菜单＝需要人看
  现场）、autoRepair:null（显式 null，区分「没跑过修复」与「跑过」）。签名新增 evidenceRoot
  必传参数（调用方仅 main＋测试，已全部核清无漏传）。
- 写入时校验（照第 2 步模式）：本地 warnSummarySchemaViolations（不 import skills 侧），
  main 收尾按「构造并写→校验→落盘」接线（:221-226）。
- 测试：run-promotion-sales1.test.mjs 新增 3 用例（validateSummary 全绿、并写自洽、
  **源码级接线守卫**：唯一落盘点＋窗口内三步顺序＋两函数须为函数声明防 TDZ）；
  unified-summary-schema.test.mjs 推广夹具换并写后形状，**欠 14 条断言清零**，日报夹具与
  rescued 用例零改动。

### 验证

- skills 定向组 540/540（基线 537＋新增 3）；runtime 全组 1178 用例 1177 绿，唯一红仍为
  arch-boundary 预存在欠登记（内容与动工前逐字一致，arch-boundary.test.mjs 未触碰）。
- 突变两处点名红：删 failureClass 物化（子代理）红在「全绿＋自洽」两用例；删 main 里
  校验调用（主线独立复核）红在源码级接线守卫用例——接线守卫真的在咬。均 sha256 还原
  核对逐字节一致。
- **仅离线判据**；真机验证＝10-12 07:00 轮产物应过校验且写入时零警告。

## [1.8.4] - 2026-10-11

三链对齐 P1 绞杀者迁移第 2 步：日报链并写统一字段＋rescued 豁免＋写入时校验。
**旧字段一个不动**（repairRequest.noActionRequired / repairRequest.cause / failedStage /
failureOutput 原样保留），九个消费方观察期内继续读旧路径；单 commit 可 revert。
rescued 豁免经用户拍板（2026-10-11「按推荐执行」）：自修救回店保留审计痕迹合法。

### 改了什么

- `run-multi-shop-day.mjs` **纯新增 84 行、零删改**：`applyUnifiedSummaryFields`（导出纯函数，
  顶层 version/workflow；逐店补 shop=键、evidence=证据目录相对路径；失败店物化
  failureClass＝shopFailureCause 写时算、noActionRequired 提升顶层与 repairRequest 内同源同值；
  autoRepair.attempted 显式布尔；pending 初值跳过）＋ `warnSummarySchemaViolations`（写入时
  校验，不过⇒照样落盘＋stderr 警告）。两个落盘点（整轮被挡 :2100 / 正常收尾 :2501）均按
  「先并写→再校验→再落盘」接线。waiting 店 evidence 在汇总处补（gates 构造器拿不到 logs 根，
  改它破坏面大且方向反）。
- `runtime/unified-summary-schema.mjs`：INV2 加 rescued 豁免——status='ok' 且
  autoRepair.rescued===true 时仅 repairRequest/autoRepair 的存在性检查豁免（豁免面按 b1 盖文
  淘宝实档划：error/failedStage 救回时已被链上删除、failureClass 从未落档，故照旧红）；
  INV4/candidates 检查照跑。
- 测试：unified-summary-schema.test.mjs 17 用例（日报迁移仪表欠 11 条断言→全绿清零；新增
  rescued 救回店夹具＋反例「不是救回的成功店带失败痕迹仍红」）；run-multi-shop-day.test.mjs
  新增并写自洽用例（物化 failureClass＝shopFailureCause 现算、顶层 noActionRequired＝
  repairRequest 内同值、构建输出过 validateSummary）＋**源码级接线守卫**（两落盘点前 800 字符
  内必含并写→校验→落盘三步——1.8.2 TDZ 教训的对策）。

### 验证

- skills 定向组 537/537（基线 534＋新增 3）；runtime 定向 17/17；runtime 全组 1178 用例
  1177 绿，唯一红仍为 arch-boundary 预存在欠登记（4 个推广链 skills 文件，内容与动工前
  逐字一致；arch-boundary.test.mjs 未触碰）。
- 突变两处点名红：failureClass 物化改坏（子代理）红在「写时算≠读时算」断言；rescued 豁免
  关闭（主线独立复核）红在救回店夹具 INV2。均 sha256 还原核对逐字节一致。
- 历史预检（主线独立复现）：applyUnifiedSummaryFields 喂三份真实历史 summary（b1 救回轮/
  b2 全 ok 轮/10-09 失败轮）再校验，三份全 GREEN。
- **仅离线判据**：并写逻辑未在真机跑过（无不起浏览器能到落盘点的形态）；真机验证窗口＝
  2026-10-12 11:30 定时轮，产物应过校验且写入时零警告。

## [1.8.3] - 2026-10-11

三链对齐 P1 绞杀者迁移第 1 步：统一 summary schema 校验器先行落库。草案七项待拍板
（`docs/ops/UNIFIED-SUMMARY-SCHEMA-DRAFT-2026-10-11.md` 第六节）经用户确认全按推荐：
failureClass 写时物化 / status 四值枚举 / noActionRequired 提升 shops[] 顶层 / 三链同串
`unified-summary-v1` / 不加顶层 rounds 聚合 / 商品链 summary 落 runId 目录 / 写入时校验
随迁移第 2 步上。拍板结果已写入草案第六节头部，草案状态改「已拍板，进入施工」。

### 改了什么

- 新增 `runtime/unified-summary-schema.mjs`（221 行）：`validateSummary(summary)→{ok,errors[]}`
  纯函数，**零 import**（不 import skills、不 import runtime 兄弟模块），fail-closed（任何
  坏输入返回结构化错误、绝不抛异常）。实现草案 3.4 七条不变量 + 字段表必填项；一处显式
  扩展：pending 初值与 waiting 同样豁免失败必填项（中断轮落下的 mid-run summary 是真实
  产物，不该红）。schema 内零业务判据（分诊表/修复表/店铺名单都不进）。
- 新增 `runtime/unified-summary-schema.test.mjs`（661 行、15 用例）：
  1. 真实历史样本迁移仪表 2 条——日报链（2026-10-11 b2 + 10-09 失败店 + waiting 形状）欠
     11 条字段、推广链（10-10 23:02 轮真实记录 + P0-3 包装）欠 14 条，**精确等式断言**；
     第 2/3 步并写后重跑同用例、清单清零才算迁移完成。
  2. 三链最小合法夹具 3 条全绿（含 ok/失败空菜单/waiting/pending 四形态）。
  3. 反例 7 条逐条点名红（INV1–INV6 各一条 + INV7 豁免钉住）+ fail-closed 2 条 + 词表 1 条。
- 已知冲突留第 2 步拍板（校验器文件头注记）：「自修救回」店 status='ok' 但保留
  repairRequest/autoRepair 审计痕迹，按不变量 2 字面口径红且并写后不清零——届时二选一：
  救回时清失败字段，或加 rescued 豁免。

### 验证

- 定向组 `node --test runtime/unified-summary-schema.test.mjs`：15/15 绿（主线亲跑）。
- 全定向组 `node --test "runtime/*.test.mjs"`：1176 用例 1175 绿，唯一红为 arch-boundary
  「skills→runtime 依赖清单」欠登记 4 个 skills 文件（run-promotion-sales1 等，P0-3 及
  在途工作所致的预存在红，与本交付的零依赖新文件无关，已独立核实其报错内容）。
- 突变三处点名红：短路 INV3（子代理）红在不变量 3 用例；日报夹具失败店补 failureClass
  （子代理）红在迁移仪表精确等式；短路 INV5（主线独立复核）红在不变量 5 用例。三处均
  sha256 还原核对逐字节一致，还原后 15/15 恢复全绿。
- 仅离线判据；不动任何生产代码（两个纯新增文件），无真机面。

## [1.8.2] - 2026-10-11

1.8.1 回归热修：两个 P0「接线」缺陷把日报分批链整条打灭（详见 `PROJECT-NOTES.md` ㊷㊸）。
触发＝11:30 定时轮首跑：`scripts/run-batches.mjs` 一进 `main()` 即抛 TDZ，整链一行未跑、
飞书零写入；根因修复后补跑，8 家全部写成（底单/询单表 2026-10-10 各 8 行）。
两个缺陷都在 1.8.1 自报的「定向 192/192 全绿」之下漏网 —— 判据全是纯函数/源码级，
没有一条钉到「`main()` 真跑时这段代码能否执行到」。

### 改了什么

**㊷ `scripts/run-batches.mjs`：互斥锁块排在 `const log` 声明之前（TDZ）**

- 现象：非 `--print` 真跑一进 `main()` 第 365 行即抛
  `ReferenceError: Cannot access 'log' before initialization`；`--print` 因在更早处 `return`、
  锁块又被 `if(!options.print)` 跳过 ⇒ `--print` 与纯函数用例都覆盖不到。
- 修法：把锁块下移到 `log` 就绪之后、批循环之前（它只需排在「起任何进程之前」，语义等价）。

**㊸ `run-multi-shop-day.mjs`：自修救回后续跑时源产物路径只填了一半**

- 现象：自修重试 `promotion-fetch` 成功后，续跑到 `push` 抛
  `源产物路径只给了一半（只有 --shop-xlsx）`（`withSourcePaths`），把整批链打断（第一批 5 家全没写）。
- 根因：`record.source` 回填只长在 `runStagesFrom` 循环体里，而自修重试走
  `runNamedStage → run()`，绕过回填 ⇒ `record.source.promotionZip` 恒空
  （10-10 `139c112` 修 ㊱ 那次续跑改造留下的接线缺口）。
- 修法：回填移进 `run()` 作单一实现（`!result.skipped && result.status === 0` 才记），首跑与重试共用。

### 验证到什么程度

- 定向离线用例：`runtime/run-batches-cli.test.mjs` ＋ `runtime/workflow-lock.test.mjs` 14/14；
  `skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs` 134/134；`node --check` 过。
- **真机过**：11:30 定时轮重跑 + 补跑第一批 5 家全绿（`evidence/batches-2026-10-10/batches.log`、
  `evidence/daily-job-2026-10-10/`）；盖文淘宝实证走通被修的续跑路径（自修救回 `sycm-date` →
  续跑 7 步含 `push`）。底单/询单表 2026-10-10 各 8 行（独立回读）。
- **未跑 `test:staged`**：本次改了 skill 的实现文件 ⇒ 按 AGENTS.md 会拉起该 skill 整套
  （含 7.6 小时量级的 E2E），且当天下午有客户演示、机器待交付 ⇒ 只跑定向用例，不盲等全量。
  需要该结论时单独 `npm run test:staged --budget-seconds=...` 跑。

## [1.8.1] - 2026-10-11

07:00 推广轮生产事故（缺陷㊶）止血批次。用户授权总执行人重构（「你现在就专心给我重构，
授权给你」），按三链对齐方案（`docs/ops/THREE-CHAIN-ALIGNMENT-AND-REFACTOR-PLAN-2026-10-11.md`）
执行 P0 四件＋验收门＋schema 蓝图。事故定性：推广链是「只接外壳、没接内核的薄壳链」——
已跑通的失败处理流程（感知→分诊→修复→转 agent→告警）一处都没复用，因为内核全部长在
日报链私有文件里，没有物理载体可 import。

### 改了什么

**P0-1 缺陷㊶ 根修：提交确认判据从「列表差集」改为「按业务日定位生成成功任务」**

- 事故现场：07:00 推广轮 8 家全报 `added=[]` 失败。实测提交一律真成功、任务生成成功，
  但新任务进列表视图要平台异步刷新（原 20×4s 等待窗不够，最长实测 13 分钟），差集判据
  把成功一律误报成失败。
- `promotion-daily-report-core.mjs` 新增 `confirmSubmittedTask`（复用 `reusablePromotionTask`
  口径：业务日 rangeStart/rangeEnd===date＋status==='生成成功'，多条取最新）。
- `run-promotion-daily-report.mjs` 确认循环重写：轮询任务列表→命中即记账；新增
  `--submit-confirm-timeout-ms`（默认 15 分钟，正整数校验），到点抛错并附最后读到的任务行；
  spawnSync 全部带 `stdio: ['ignore','pipe','pipe']`（EBUSY 假红防患，`import-promotion-daily-report.mjs`
  的 ZIP 解析同修）。

**P0-2 推广链接入告警（失败才投递）**

- `run-promotion-sales1.mjs` 新增 `buildPromotionRoundAlert` / `deliverPromotionAlert`：
  `--alert-file` 文件投递（不走 stdin 管道，EBUSY 教训）、`resolveAlertDedup` 指纹去重、
  投递成功才记账（送失败不记账防自挡）、source 只用 READABLE_SOURCE_KEYS 白名单键、
  不带机器名/盘符；`--notify` 开关。
- `scripts/run-batches.mjs`：apply 且 `--notify` 时向链转发（dry-run 不带且出声说明，
  删旧「不转发通知」警告）。

**P0-3 释放兜底：无托住信号的失败轮不释放改驻留**

- 推广链此前不落 summary.json ⇒ `unfixableShopsOf` 恒空 ⇒ 失败轮恒释放。修：
  `run-promotion-sales1.mjs` 每轮落 summary.json 到 evidence 目录（失败店带
  `repairRequest: { candidates: [] }`，语义＝脚本修不动、要人看现场）——
  unfixableShopsOf / failedShopsOf / hold 决策整条判据链自动归位。
- 驻留续跑修：`runtime/hold-and-resume-plan.mjs` 的 `buildBatchResumeArgv` / `buildBatchHoldArgv`
  透传 `--workflow`（原先缺省 daily-report ⇒ 推广链驻留续跑会跑成日报链）；
  `scripts/hold-and-resume.mjs` 加 `--workflow` 参数。

**P0-4 推广链互斥锁**

- `scripts/run-batches.mjs` 直连入口自己抢 `merchant-automation` 单锁（三条链共享浏览器
  资源，互斥单位是「机器上的采集」；直连原先绕过宿主层锁 ⇒ 手动并发会撞同店代理端口）。
  `SYCM_WORKFLOW_LOCK_HELD` 环境变量重入保护：抢到者与宿主 `run-daily-job.mjs` 都设，
  子进程/驻留续跑继承跳过；冲突退 1。

**验收门与蓝图（文档）**

- `AGENTS.md` 新增「Failure-exit gate」小节：任何链接入生产调度前必须答失败出口四问
  （会不会告警／会不会自修／修不动会不会托住／summary 有没有 unfixable 信号）＋
  机制/判据分离检查（新链自己实现 escalation/notify/repair 而非 import 即不过审）。
- `docs/ops/UNIFIED-SUMMARY-SCHEMA-DRAFT-2026-10-11.md`：三链统一 summary schema 草案
  （P1 蓝图：现状矩阵／统一字段表／绞杀者迁移／守卫设计）。

### 为什么改

- 四件都是 07:00 事故里「失败发生时系统什么都不做」的直接止血：误报（P0-1）、无告警
  （P0-2）、误释放（P0-3）、无互斥（P0-4）。内核抽取（把失败处理从日报链私有文件搬进
  共享层）走绞杀者模式放 P2，本批先把四个出口补上并用验收门挡住下一批薄壳链。

### 验证到什么程度

- 定向测试 192/192 全绿（推广链侧 22/22、runtime 侧 170/170；原始输出
  `.tmp-verify/skills-side.txt` / `.tmp-verify/runtime-side.txt`，node 22.22.2-6 仓库根跑）。
- 突变抽查两处均被精准击杀：`confirmSubmittedTask` 改坏 ⇒ 「㊶ 判据」用例红
  （actual 拿到非本业务日旧任务）；`buildPromotionSummary` 去掉失败店 repairRequest ⇒
  「跨模块对接」用例红（actual=undefined）。还原后 sha256 与留底逐字节一致，另复跑
  22/22 确认还原干净（`.tmp-verify/skills-side-post-restore.txt`）。
- **仅离线判据**：未做真机整轮验证——明日 07:00 定时轮即为真机验收（告警链路、
  释放驻留、互斥锁全部以真机轮为准）。

## [1.8.0] - 2026-10-10

架构优化执行规格（`docs/ops/SYSTEM-ARCHITECTURE-OPTIMIZATION-EXECUTION-SPEC-2026-10-10.md`）
P1/P2/P3 的统一入口与回执接线。三个新模块（workflow-catalog / run-receipt-v1 / run-root）由本轮
新增，本条记录把它们接进现有入口的最小接线改动。

### 改了什么

- **workflow-catalog 工作流登记契约（spec §4）**：`runtime/workflow-catalog.mjs` 登记四条主流程
  （daily-report / promotion-daily / product-daily / weekly-report），未登记的 workflow 立即硬失败、
  绝不回退 daily-report；`run-batches` 启动时自检登记表并从 `entry.batch` 解析链入口。
- **run-receipt-v1 统一回执与五条状态轴（spec §6）**：`runtime/run-receipt-v1.mjs` 落地
  execution / evidence / humanGate / lease / publication 五条状态轴的统一回执。如实表述：
  **execution / evidence / publication 三轴已落字段并被入口填写；humanGate / lease 两轴
  以闭合集常量占位、未接真实载体**。rounds → 回执的映射抽成纯函数
  `runtime/batch-rounds-receipt.mjs`（I/O 留在 scripts 薄壳）：驻留终态
  （TIMED_OUT / RESUME_FAILED / NO_HOLD / NO_VERDICT）⇒ FAILED —— **PAUSED 在 finalize
  时刻不可达**（run-batches 的驻留是同步子进程，finalize 时驻留必已终止）；RESUMED_OK ⇒
  SUCCEEDED；失败店清单只收逐店 unfixable 名单，读不到时 shops=[]（不把整批成功店伪标成
  失败店）；apply ⇒ chain 步 publication=UNKNOWN、dry-run ⇒ NOT_REQUESTED。取舍：回执
  生成失败只打 stderr 警告、不落盘、不改业务退出码（compat 优先）；`release.observed`
  永不写 true —— 释放只认独立两次端口回读，回执里没做就记 `observed:false + status:UNKNOWN`，
  不假装观察到。`validateRunReceipt` 补跨轴校验（SUCCEEDED ⇒ shops 空 + failureClass null）
  与 shops / artifacts 元素形状校验。
- **batches.json 入册带 size 与 sha256（spec §7.3）**：`run-batches` 落盘 batches.json 后
  回读真实字节计算 size 与 sha256，`appendArtifact` 只收结构化 `{path, size, sha256}`
  对象（裸字符串不再接受）；读文件与算哈希留在 scripts 薄壳。
- **dry-run 不再写飞书询单行骨架**：daily-job-plan 的 ensure-inquiry-rows 步改为
  `mode !== 'dry-run'` 才带 `--commit`（该脚本不带 `--commit` 时是只读核对，收据记
  DRY_RUN_READY、不报错、不落行）；apply / 缺省与旧输出逐字一致。
- **--notify 静默丢弃要出声**：promotion-daily 档链入口不转发通知开关，
  `run-batches --notify --workflow promotion-daily` 启动时打显式警告行（失败告警不会自动
  投递飞书，以运行汇报为准）；daily-report 档链会转发、不打警告。
- **启动自检缩小爆炸半径**：`run-batches` 启动只校验本次请求的 workflow（getWorkflow +
  entry.batch 文件存在性硬校验），全量 validateCatalogEntries 不再是启动硬门槛 —— 一条
  无关登记项的笔误不应拦下今天本可照跑的日报；登记表整体合法性由
  workflow-catalog.test.mjs 守。
- **help 修字**：run-batches usage 行加回 `[--commit]`（兼容期参数，漏印会让运维以为
  只剩 --mode）。
- **run-root 运行根目录治理（spec §7）**：`runtime/run-root.mjs` 落地
  `<run-root>/<workflow>/<target-date>/<run-id>/` 布局与 manifest；`run-batches` 新增
  `--evidence-root`（优先级：实参 > `SYCM_RUN_ROOT` > 机器级外部目录），manifest 记录实际证据根
  （兼容期旧路径）与保留级别（成功 30 天/失败 180 天/不自动删）。旧 evidence 路径照旧可读，不搬数据。
- **--mode 统一入口与 --commit 兼容转换（spec §5.1）**：`run-batches` 与 `run-daily-job` 均接受
  `--mode dry-run|apply`；`--commit` 等价 `--mode apply` 并打印转换提示；`--mode dry-run` 与
  `--commit` 同给矛盾 ⇒ 退 2；解析规则抽成纯函数 `resolveRunMode`（workflow-catalog）。
  `run-batches` 缺省模式为登记项 `manualDefault`（dry-run）；**`run-daily-job` 缺省维持
  apply（写）** —— 它是定时任务宿主，daily-job-plan 对链/分批一直无条件给 --commit，本轮不动这个默认。
- **推广日报不再被公共层隐式强制写入**：删掉 `run-batches` 原 L309-312 对 promotion-daily 的
  无条件 `['--commit']`；两档统一为 `mode==='apply' ⇒ 链参数含 --commit`。链子进程命令面不变
  （run-multi-shop-day / run-promotion-sales1 只认 --commit，--mode 不下传）。
- **run-batches 从 catalog 解析入口**：`buildBatchSteps` 新增可选 `chainFile`（缺省与旧硬编码
  逐字一致），`run-batches` 传 `getWorkflow(workflow).entry.batch`。
- 早间调度定稿：新增 `docs/ops/DAILY-FLOW-SCHEDULE.md`（**推广 07:00 / 商品 10:00 不动 /
  日报 11:30** —— 推广抢在最前出昨日数据，商品维持既有档位，日报避开前两条的浏览器与登录态
  争用）。

### 遗留

- **推广日报链侧无 apply 门控**：mode → `--commit` 的转换只发生在公共层
  （run-batches / run-daily-job），链入口 run-promotion-sales1 自身不感知 mode；
  绕过公共层直接调链时没有第二道门（回执的 publication 轴也只到 UNKNOWN 为止）。
- **promotion 档不转发 --notify**：链入口不转发通知开关，失败告警不会自动投递飞书；
  run-batches 已在该组合下打显式警告（以运行汇报为准），链侧转发待后续批次。
- **回执 artifacts 目前只登记 batches.json**（含 size 与 sha256）；各步骤的逐份证据
  文件（截图 / 收据 / summary）未逐一入册，level2 证据清单待后续批次补。
- **商品日报回执接线推迟**：`scripts/run-product-data-job.mjs` 当前被并行开发线持有（工作区
  modified，本轮禁碰），product-daily 仅在 catalog 登记，未做统一回执接线。
- `run-daily-job --mode dry-run` 只作用到链/分批与询单行骨架那一层；窗口标识页、商家登录
  守卫等前置步骤仍按各自默认执行。全链 dry-run 化待后续批次。
- run-batches 的统一回执里「失败店清单」点名到店依赖 summary 的 unfixable 名单，
  读不到时 shops=[]（不点名、不伪标）。
- 周报（weekly-report）登记入口指向被跟踪的 `runtime/run-weekly-collection.mjs`；并行线的
  `run-weekly-workflow.mjs` 合入后如入口切换，改 catalog 字符串即可。

### 验证

- 仅离线判据 + `--print` 基线对比：六组基线（rb-daily-noflag/commit、rb-promo-noflag/commit、
  rdj-noflag/commit）中，noflag 组逐字节一致；commit 组仅新增转换提示行；rb-promo-noflag 的
  差异仅为链参数不再含 --commit（即修复目标本身）。注意：rdj-commit 的**基线**是「未知参数
  --commit」退 2（run-daily-job 此前不接受该参数），新行为是转换提示 + 与 noflag 一致的计划。
- `node --test runtime/workflow-catalog.test.mjs runtime/run-receipt-v1.test.mjs runtime/run-root.test.mjs
  runtime/batch-plan.test.mjs runtime/daily-job-plan.test.mjs runtime/hold-and-resume-plan.test.mjs
  runtime/run-batches-cli.test.mjs runtime/batch-rounds-receipt.test.mjs runtime/version-consistency.test.mjs`
  全绿；版本一致性测试全绿。统一回执的真机落盘（run-root 目录、manifest）尚未在真实 apply 轮次验证。

## [1.7.22] - 2026-10-10

用户指令「按照你的推荐立刻去修复」。上一轮 5 家店全停在**第 2 步 `alimama-date`**，报的都是
同一句 `alimama filter bar not ready; triggers=4`。本轮把它复现、定性、修掉，并在真机上验证。

### 改了什么

**阿里妈妈报表页：从首页进报表路由会被 SPA 吃掉（缺陷 ㊵）**

- 现场：`one.alimama.com/index.html`（**首页**）上做 `/navigate` 到
  `…/index.html#!/report/account?…`，返回 HTTP 200，但 **SPA 把 hash 丢了** —— `href` 停在
  `…/index.html`、`hash` 为空、`title` 停在 `首页_万相台无界版`、`.mx-trigger` **连续 40 秒
  卡在 4**（逐秒探测）。而链条的 `READ_EXPRESSIONS.alimama` 要求 `triggers.length >= 6` ⇒
  第 2 步直接失败。**根因是「首页 → 报表路由」这第一次进入被 SPA 吸收，不是日期参数被平台废弃。**
- `date-picker.mjs` 新增 `enterAlimamaReportRoute()`：`navigate` →**回读 `document.title` 自证**
  → 若仍在首页则**页内改 `location.hash` 兜底** → 再回读。导航进入成功就不写 hash。
- 同时新增 **`mx-*` 日期面板兜底** `applyAlimamaDateViaPanel()`：阿里妈妈的日期面板是
  `mx-output-bottom` 组件（**不是**生意参谋那套 `.oui-date-picker-menu`），点日期触发器打开
  → 读「快捷日期」（昨日／过去 7 天／…）→ 点目标档 → 点「确定」。**已实测这条路
  能改 URL**：点「昨日」+「确定」后 `href` 变成 `startTime=2026-10-09&endTime=2026-10-09`、
  触发器变「昨日」、`数据范围为：2026-10-09至2026-10-09` —— 因果是**面板 → URL**。
- 页面创建地址修正：`SITES.alimama` 新增 `entryUrl = buildAlimamaUrl({requested: shanghaiToday()})`
  （**报表路由**），`runtime/shop-pages.mjs` 的 `阿里妈妈报表页` 改用 `siteAdapter('alimama').entryUrl`。
  原来它用的是 `login-merchant-core.mjs` 的 `probeUrl = 'https://one.alimama.com/index.html'`
  ——那是**登录探针用的首页**，新建出来的工作页天生停在首页，正是本缺陷的入口。
- ⚠️ **不要动 `SITES.alimama.urlFragment`**：`runtime/target-url-match.mjs` 的
  `urlMatchesFragment()` **刻意丢掉 `?`/`#` 之后的内容**，写 `…#!/report` 会被削成
  `…/index.html`、反而继续匹配首页。`expected-pages.mjs` 因此只加注释不改片段
  （「首页也算报表页在位」这个是**另一个改动**，要动 `target-url-match.mjs` 的口径）。

### 为什么改

- 连续两轮的失败签名一模一样（`triggers=4`），说明不是偶发。逐秒探测 40 条读数
  （`evidence/probe-alimama-2026-10-10/`）把它从「猜」变成「量出来的」。
- 一条**自我更正**记录在 `04-platform-change.md`：最初判「平台不再认 `startTime/endTime`」是
  **错的** —— 后续在**已在报表路由**的页签上测 10-05／10-06（`/navigate`）、10-01
  （`location.replace`）**都正确生效**。真正的缺陷面很窄：**只有「从首页第一次进报表路由」这一步**。

### 验证到什么程度

- **真机端到端**（里可林淘宝，proxy 19041／debug 19031）：从 10-10 那个失败状态出发，
  `date-picker.mjs --site alimama --date 2026-10-09 --proxy …:19041` ⇒ `status: APPLIED`、
  `observedAfter: 昨日`、trace 里 `enter-report-route.landed.t = 营销场景报表_万相台无界版`；
  **独立回读**（不看 summary）`数据范围为：2026-10-09至2026-10-09`。
- **页面创建那半边**：关掉旧页签、用新 `entryUrl` 形状新建 ⇒ 开页即落在
  `营销场景报表_万相台无界版`（报表路由），随后的 applyDate 作为**活 hash 变更**正确落日期。
- 离线：`date-picker.test.mjs` **44/44**（新增 4 条行为级：导航没进 ⇒ hash 兜底并回读自证／
  导航进了 ⇒ 不写 hash／单次读失败 ≠ 「还在首页」／`isAlimamaReportRoute` 正反）；
  `shop-pages` + `expected-pages` **45/45**；阿里妈妈 skill 组 **529/529**；runtime 全量 **1077/1078**
  （唯一 1 红是**别人的在飞改动**造成的 `arch-boundary` 基线，已复核不是本节改动）。
- **突变验证**：把 hash 兜底里 `const hashAt = -1` 写死 ⇒ **恰好**新增那条
  「整页导航没进 ⇒ 页内改 hash 兜底」变红且点名自己；还原后全绿。

## [1.7.21] - 2026-10-10

用户指令：「把 2026-10-10 的 8 家店常规日报也跑一遍」。这一轮**跑挂了**（5 家全停在
第 2 步 `alimama-date`），但它当场暴露了 ㊳ 的**第二半从来没生效过** —— 也就是用户前一天刚骂过
的那个问题（「你关了，人来了也不知道是什么问题」）**又原样发生了一次**。

### 改了什么

**驻留（㊳ 的执行那半边）：参数名传错，导致「不释放」等于「窗口全丢」（缺陷 ㊴）**

- `scripts/run-batches.mjs` 的 `runBatchHold()` 在开告警时给 `hold-and-resume.mjs` 传的是
  **`--notify`**，而对面**没有这个参数**（它只有 `--no-notify` 与 `--notify-print`，
  `notify` 默认就是 `true`）⇒ 驻留在参数校验那一行直接 **退 2**，一行状态都没打印。
- 后果链条：㊳ 的判断那半边说了「不释放，把窗口留给修复 agent／人」→ 但驻留没挂住 →
  这一轮命令随即结束 → 宿主回收整棵进程树 → **5 家店的窗口全丢**，人赶到机器前没有现场可看。
  **这正是用户说的「转人工等于没转」。**
- 修法：把参数构造抽成**导出的纯函数** `buildBatchHoldArgv()`，三种出口按对面的口径给 ——
  `notifyPrint` ⇒ `--notify-print`；`!notify` ⇒ `--no-notify`；**notify 为真 ⇒ 什么都不传**
  （退回它的默认＝真投递）。

### 为什么改

- 现场证据（`evidence/batches-2026-10-10/batches.log`）：
  ```
  --- hold-and-resume：… --resume-via-batches --batch-size 5 --notify
  未知参数 --notify（可用：… --no-notify --notify-print …）
  --- hold-and-resume 退出码=2
  驻留读不到结论 ⇒ 没有挂住（它不拿一个猜的结论把机器挂住）。
  ```
  而 `batches.json` 里 `hold.exitCode: 2`、`recovered: false` —— 同时 `decision.release: false`。
  **「说好不释放」与「实际一个窗口都没留」同时成立**，这就是这个 bug 的形状。
- 教训与 ㊲ 同源（这是同一类错误的**又一次**）：判据写对、纯函数用例全绿、突变也过了，
  **但没有一条用例钉住「调用侧真传了什么、对面真认不认」**。1.7.19 的 ㊲ 白修是这个形状，
  1.7.21 的 ㊴ 还是这个形状。所以这一条的用例不是再写一条源码正则，而是**把构造出来的参数
  喂给对面自己的参数校验器**，让对面当裁判。

### 验证到什么程度

- `runtime/hold-and-resume-plan.test.mjs` **39/39**（新增 1 条**行为级**用例：三种出口各构造一次
  → 喂 `hold-and-resume.parseArgs` → 断言「它认」且「意思对」；再钉一条反面
  「`--notify` 必须不在参数里」）；连带 `batch-plan` + `daily-job-plan` 定向组 **123/123**。
- **突变验证**：把 `buildBatchHoldArgv` 的出口改回 1.7.20 那个 bug 原样 ⇒ 恰好新增那一条变红、
  且点名自己；还原后全绿。
- ⚠️ **真机未跑**：本条同样是当场暴露、当场修的 —— **修完尚未再跑一次真机**。
  它的正确性要在**下一次真的整轮被挡**时才算验过（本轮那次就是它翻车的现场）。

### 连带记录（不是本条改的，但要留痕）

- 本轮 5 家店停在 `alimama-date` 的**根因不在上面这条**：登录预检结论是 `ALL_IN`
  （每家 `sycm: LOGGED_IN` / `alimama: LOGGED_IN`），页面在 `start` 后也在位，
  失败形态是**阿里妈妈页冷挂载后筛选栏只渲染出一部分**（`triggers=3/4`，判据要 ≥6），
  16×1200ms ≈ 19s 的 settle 预算没等到补齐。**5 家形态完全一致、每家 triggers 数还不一样**。
  该现场**没有被抓住**（因为 ㊴ 让窗口丢了）⇒ 尚未定因，留作下一轮的取证目标。
  取证办法已定：复现一轮，在页面仍挂着时直接读 `.mx-trigger` 的实时个数与 `document.readyState`。

## [1.7.20] - 2026-10-10

1.7.19 把 ㊲ 修成「`date-picker` 在抛错那一刻给「被全屏层压住」写上确定性标记、
`shopFailureCause` 认这个标记」。**补跑当场证明：判据写对了，但接线只接了一半。**

### 改了什么

**归因的输入取错了字段（缺陷 ㊲ 的「接线」那一半）**

- `buildRepairRequest()` 归类时读的是传进来的 `error`，而驱动那一次调用传的是
  `error.message` —— 它的真实形态只有驱动自己包的那一句 **`阶段 sycm-date 失败（exit 1）`**。
  那个 `[BLOCKED_BY_OVERLAY …]` 标记**只出现在子进程 stderr 里**（被 `record.failureOutput` 收走、
  也写进了 `04-<stage>.txt`）。于是分类器**根本看不到标记** ⇒ 落兜底 `STAGE_FAILED` ⇒
  候选还是 `[REAPPLY_DATES, RELOAD_PAGE]`、`DISMISS_OVERLAYS` 仍不在菜单里 —— **1.7.19 白修**。
- 修法：`buildRepairRequest` 新增 `failureOutput` 参数（归类用它；缺省回落到 `error`，
  只传 `error` 的老调用方与既有用例行为不变），驱动调用处传 `record.failureOutput ?? null`。

### 为什么改

- 现场证据（2026-10-10 17:47 补跑 盖文淘宝 2026-10-09）：`97-repair-request.json` 写的是
  `cause: STAGE_FAILED`、候选 `[REAPPLY_DATES, RELOAD_PAGE]`；而**同目录** `04-sycm-date.txt`
  的 stderr 里明明有 `[BLOCKED_BY_OVERLAY 遮挡层=DIV.ant-…]`。
  **「现场说遮挡、单子说 STAGE_FAILED」＝归因与证据不是同一个来源。**
- 这是本项目吃过四次的那一类（函数级用例全绿 ≠ 接线接上了）：㊲ 的判据有源码级与行为级用例、
  也过了突变，**但没有一条用例钉住「驱动调用时把哪个字段传下去」**。

### 验证到什么程度

- 本 skill **521/521**（新增 1 条：既断言「只给 error ⇒ 退回 STAGE_FAILED」、
  又断言「给了 failureOutput ⇒ PAGE_OBSTRUCTED 且菜单里有 DISMISS_OVERLAYS」，
  再钉住驱动调用处必须传 `failureOutput`）；定向驱动套件 **134/134**。
- **突变验证**：把调用处的 `failureOutput: record.failureOutput ?? null` 那一行删掉 ⇒
  新增那条用例**变红且点名**；恢复后全绿。
- ⚠️ **真机未跑**：本条是补跑当场暴露、当场修的，**修完尚未再跑一次真机**。
  （1.7.19/1.7.20 合计的效果要在下一轮真跑里才算验过。）

## [1.7.19] - 2026-10-10

用户指令：「全修复然后补跑」（承接前一条「1.救回后续跑后续的步骤 2.补跑」与四条吐槽：
「没有做到自动修复/自动记录失败」「卡住时不会自动截图吗」「为什么没有托住页面，而是全部关了」
「弹窗这个肯定可以自动关的，要分析清楚怎么解决这类问题」）。

修的是 **2026-10-09 盖文淘宝**那两个各自独立的缺陷：**归因错档**（唯一对症的动作进不了菜单）
与**失败就把现场拆掉**（转人工时人来了什么也看不到）。两者在同一次失败里同时发作，
所以放在同一个版本。**第一层的「几何判据看不见 portal 弹窗」是我自己的误判，已撤回**（见下）。

### 改了什么

**① 归因：给「被一个盖住视口的层挡住」一个确定性名字（缺陷 ㊲）**
- `date-picker.mjs` 新增 `BLOCKED_BY_OVERLAY_TOKEN = 'BLOCKED_BY_OVERLAY'`。`aim()` 在
  「命中点不是目标、也不是它的子孙」那一刻，从命中点往上找第一个 `fixed`/`absolute` 且
  **宽高都 ≥ 视口 0.85** 的祖先；找到就把 `[BLOCKED_BY_OVERLAY 遮挡层=TAG.cls]` 拼进**原来那句**
  `is covered by …` 里。找不到 ⇒ 旧措辞逐字不变（普通坐标竞态不许被报成「去关弹窗」）。
- 驱动 `shopFailureCause` 加**第二条** `PAGE_OBSTRUCTED` 判据读这个标记（第一条仍读
  `collect-core` 的 `OVERLAY_NOT_DISMISSED`——那一条只在采集段走完「扫-选-点-回读」时才写，
  而 `date-picker` 那一步不走那套流程，所以必须分开两条）。
- ⚠️ 那个标记是**插值**进注入页面的字符串（`${BLOCKED_BY_OVERLAY_TOKEN}`，`SYCM_PRELUDE` 是
  模板串），所以常量声明**必须排在 `SYCM_PRELUDE` 之前**，否则踩 TDZ。原先写成裸标识符 ⇒
  页面里是 `ReferenceError`，会把整段失败信息换掉。**这一条是行为级用例抓出来的，不是读代码看出来的。**

**② 失败不许拆现场：把「留窗口」这件事接上（缺陷 ㊳）**
- `runtime/batch-plan.mjs` 的 `releaseAfterBatch` 从「一律释放」改成：全绿放 / 没跑到链放 /
  失败但**没有**要人看现场的店放 / 失败且**有**「脚本自修没救回来」的店 ⇒ **不释放**
  （返回 `holdsForRepair: true`）。**同时撤回 2026-09-23 那条「一律释放」的理由** ——
  它当时的前提是「窗口留不住（宿主会回收进程树）」，而分批形态下那个 stop 是
  **我们自己发的** `taskkill /PID … /T /F`（证据 `evidence/batches-2026-10-09/batches.log`）：
  既然杀是我们发的，「留」就只要不杀即可。
- `scripts/run-batches.mjs`：新增 `batchUnfixableShops()`（判据**调用** runtime 侧的
  `unfixableShopsOf`，不另发明）；stop 决策把 `unfixableShops` 传给释放判决；**并且**把
  「逐店失败」那一支也接上驻留 —— 它原先只有一句「照常跑下一批」，正是用户点出的那一块。
  新增 `--release-on-failure` 作为退回旧口径的逃生阀。

### 为什么改
- **归因错档的代价**：归进兜底 `STAGE_FAILED` ⇒ 候选菜单只有 `REAPPLY_DATES`（设计上恒
  `applied:false`，是个报告者）与 `RELOAD_PAGE`，**唯一对症的 `DISMISS_OVERLAYS` 根本没进菜单**
  （它在 `REPAIR_TABLE[PAGE_OBSTRUCTED]` 里）⇒ `--auto-repair` 两轮全空、派 agent 也只能从同样的
  候选里挑 ⇒ 自动化对这类失败**无解**，每次都只能等人。弹窗**本身是可以自动关的**
  （`DISMISS_OVERLAYS` 的 `pickOverlayCloseCandidates` 按「关闭/取消」语义 + `atTopRight` 挑，
  那个弹窗右上角有 X）——失败纯粹是**归因**问题。
- **拆现场的代价**：驻留（`hold-and-resume.mjs`）与它的判据（`unfixableShopsOf`）**早就写对了**，
  但它只被「整轮被挡」那一档调起 ⇒ 单店失败一路走到「照旧释放」，`taskkill /T /F` 把窗口拆空，
  人到了只剩一张**不带任何证据路径**的告警文案。实测代价：`evidence/` 下 09-28~10-07 共 27 份
  修复报告里 **20 份**的结论是「现场已不在 ⇒ 未执行任何动作 ⇒ 转人」。

### 撤回（我自己说错的话，一并记下）
- 我曾断言「几何判据（≥85% 视口）看不见这个 portal 弹窗，它的可见框只有约 34%」，
  据此要改 `collect-core`/`failure-perception`/`repair-shop-stage`。**这是错的**：实测
  `98-failure-state.json` 里 viewport `1506×642`、dialog rect `1502×642` = **99.7%**，本来就能过 85% 那道门。
  我依据的是**肉眼看截图**，不是事实。四处改动已 `git checkout --` 撤回 —— 那会把判据放宽、
  引入误判风险，而根因只有「归因错档」一条。教训与仓里那条一致：**可核对的事实优先于听起来对的话**。

### 验证到什么程度
- **仅离线判据**（从仓库根跑，全绿）：`skills/sycm-alimama-daily-report/scripts/*.test.mjs`
  **520/520**；`runtime/*.test.mjs` **1076/1077** —— 那 1 条红是 `arch-boundary.test.mjs` 的
  `SKILLS_TO_RUNTIME` 少了三个 `promotion-*` 文件的登记，与本次改动无关（那三个文件是本工作区里
  **他人未提交的在途改动**，mtime 2026-10-10 17:13；本改动没有新增任何 skills→runtime 依赖）。
- **突变验证 7/7**（`.mutation-verify-2026-10-10.mjs`，跑完即删）：把每一条新判据的机制改坏，
  确认测试**真的变红、且点名到期望的那条用例**。其中「把插值改回裸标识符」这一突变抓到的是一个
  真 bug（见 ①），证明这套判据不是装饰。
- 新增了**行为级**用例：把 `SYCM_PRELUDE` 取出来在假 DOM 上**真跑一遍**，断言遮挡层盖住视口时
  报错里带标记、盖不住时不带、命中自己时不报错。它专门用来补源码级判据够不到的那一半 ——
  实测源码级三条在「标记永远不写」的突变下**照样全绿**。
- ⚠️ **真机未跑**：本次改动**尚未**在活体实例上验证（补跑盖文淘宝需要起实例，等用户放行）。
  真机证据将在补跑后补进 `.workbuddy/memory/2026-10-10.md`。

## [1.7.18] - 2026-10-10

> **版本记录更正（2026-10-12）**：本条当时只写了 CHANGELOG、代码与 VERSION 均未随 1.7.18 提交
> （git 历史里不存在 VERSION=1.7.18 的提交；1.7.19 的提交 `a5a52b2` 直接跳过了它）。代码于
> 2026-10-12 补交（见 1.8.6 节「补齐」后续提交），此前它一直只存在于工作区。今后规则：
> CHANGELOG 出现一个版本号 ⇔ 必须存在 VERSION 等于它的提交（已写入 AGENTS.md）。

用户指令：「原则是阿里妈妈那边有数据就填，没有就空着也可以，不用标记为失败需要补」＋「按你推荐的来执行」。
（口径澄清：日报「询单表」那两个字段来自**生意参谋「询单到付款」**，与阿里妈妈无关 —— 阿里妈妈只喂底单的推广列。
用户说的「阿里妈妈那边」指的就是这个平台侧数据源。）

### 改了什么：源表空态不再算失败
- `inquiry-core.extractInquiryMetrics` 新增**默认关**的 `sourceEmptyAllowed`。打开时「0 个日期行」
  返回 `{ inquiry: null, peerInquiry: null, peerBenchmark: 'SOURCE_EMPTY' }`，不再抛
  `SOURCE_NO_ROW_FOR_DATE`。**只放行 0 行**：「>1 个日期行」（日期筛选被选成区间的结构异常）照旧 fail-closed。
- `run-inquiry-backfill.mjs` 显式打开它。撞上 `SOURCE_EMPTY` 时**不读飞书、不写、退出码 0**，
  把事实落成 `inquiry-backfill-plan.json`（`status: 'SOURCE_EMPTY_LEFT_BLANK'` ＋ 现场行数）。
  收工点刻意放在读飞书**之前**：空态缺的是源数据、不是落点，为写两个空值去读一次远端表，
  只会把一个「已知无解」装扮成另一个失败。
- 分诊表 `SOURCE_NO_ROW_FOR_DATE` 保留为**兜底**并标 `retired: '1.7.18'`（旧版本产物、手工直跑脚本、
  将来某条新路径仍可能命中它），`notifyLevel` 仍是 `silent`（不叫人**也**不驻留）。

### 为什么改
- 空态是**数据源的事实**（表格显示「暂无数据」），不是「脚本读不到」：重试、修页面、人去平台都变不出来。
  原先它让回填那一步 exit 1 ⇒ 整链退出码 1、那家店被记成 failed。分诊表虽然早就把它归到 silent
  （不叫人、不驻留），但「不算失败」这一半一直没做到。用户口径：留空即可，不用标记为失败需要补。
- 这也是本项目那条老病根「把读不到当成掉了／不存在」的又一次收口：空态与真故障必须分开记。

### 验证到什么程度
- **仅离线判据**（从仓库根跑，全绿）：`inquiry-core.test.mjs` 20/20（含新增的 `sourceEmptyAllowed` 用例）、
  `remediation-table.test.mjs` 34/34、`run-multi-shop-day.test.mjs` 130/130，
  `collect-core.test.mjs` ＋ `daily-report-runtime.test.mjs` 全绿。
- ⚠️ 同一次运行里 `runtime/arch-boundary.test.mjs` 有 1 条红，**与本改动无关**：它报的是
  `SKILLS_TO_RUNTIME` 少了三个 `promotion-*` 文件的登记，而那三个文件是本工作区里**他人未提交的**
  在途改动（mtime 2026-10-09，且 `runtime/arch-boundary.test.mjs` 自身也是脏的）。本改动没有新增任何
  skills→runtime 依赖。
- 真机（2026-10-10 11:4x，两家各起一次实例、全程只读）：网林天猫 10-08 平台**有**数据
  （当日询单人数=3），网林家居 10-08 是平台**空态**（共 0 条）。此改动之前的实测与处置记录见
  `.workbuddy/memory/2026-10-10.md`。

## [1.7.17] - 2026-10-10

用户指令：「按你推荐的执行」（承接同一天上一条授权「你去删，然后你重跑这两家的登录」）。
修的是 **2026-10-08 网林天猫卡了半个月的那个真因**（缺陷 ㉟）：**滑块长在 iframe 里，脚本的判据看不见它**。

### 归因：验证码显形 ⇒ `CAPTCHA_REQUIRED`，不再写成「可能密码不对」
- **现场**：登录页顶层文档里有一个 iframe
  `https://login.taobao.com//havanaone/loginLegacy/password/login.do/_____tmd_____/punish?x5s=…`，
  `<title>验证码拦截</title>`，**与登录页同源**（`contentDocument` 可读）；
  iframe 内手柄 = `SPAN#nc_1_n1z.nc_iconfont.btn_slide`，提示「向右滑动验证」。
- **为什么原先判不出来**：`FORM_STATE_EXPRESSION` 只在**顶层文档**查
  `#nc_1_wrapper, .nc-container, .nc_scale` ⇒ iframe 内的滑块**一条都命中不了**
  ⇒ `captchaVisible()` 恒 false ⇒ 不报 `CAPTCHA_REQUIRED`，而是继续提交、被平台静默拒掉，
  最后归因成 `LOGIN_NOT_CONFIRMED`（「可能是密码不对，也可能是平台要求额外验证」）
  —— **一条把排查方向指反的归因**（围着密码查了两天，现场其实是一个风控页）。
- **它为什么必然漏**：滑块是**点过「登录」之后**才被风控拉起的（09:42 冷启动实测：
  刚打开的登录页上什么都没有），而那一版只在**提交前**查一次 ⇒ 时机上不可能看到它。
- **改法（两处，都在判据层、都离线可测）**：
  1. `FORM_STATE_EXPRESSION` 改为**顶层与同源 iframe 一起查**（`contentDocument`，跨源 try/catch）；
     读不到内容的 iframe 若地址/标题明确像风控页（`_____tmd_____` / `/punish` / `nocaptcha` / 「验证码」），
     留一条线索到新字段 `captchaFrame`。
  2. `captchaVisible()` 增加第四种载体 `captchaFrame`；`login-merchant.mjs` 第六步在
     `stillOnLogin` 分支里**再回读一次**表单状态，有验证码就报 `CAPTCHA_REQUIRED`
     （detail 说明「账号密码已经填在页面上了，请在窗口里把验证做完」），
     只有确实没有验证码才落 `LOGIN_NOT_CONFIRMED`。
- **方向选择（写明白）**：`captchaFrame` 是 **fail-closed** —— 把「读不到」判成「有验证码」，
  最坏是多叫一次人；判成「没有」就会继续提交、被静默拒掉、再被误归因，那正是要治的病。

### 验证到什么程度（说实话）
- **离线判据**：`login-merchant-core.test.mjs` **72/72 通过**（新增 7 条：把那个表达式放进
  `node:vm` 沙箱**真跑**，覆盖干净页 / 同源 iframe 内滑块 / 同源 iframe 内 0 尺寸滑块 /
  跨源风控 iframe / 跨源无关 iframe / 结构守卫）。
- **突变验证**（`tmp/mutation-check-captcha.mjs`）：把两处修复分别改坏一次，两次都**判红且点名到
  期望的那条用例**，跑完按 sha256 还原一致（`6fbffd97f9ee08d4`）。
- **回归面**：`skills/sycm-alimama-daily-report/scripts/*.test.mjs` **511/511**；
  `runtime/*.test.mjs` **1073/1074** —— 唯一那条红是另一条开发线新增的三个
  `*promotion-daily-report*` / `run-promotion-sales1.mjs` 未在 `SKILLS_TO_RUNTIME` 登记，
  与本批无关（那几个文件一个字没碰）。
- **未做真机验收**：本批是判据修复，**要等下一次平台真的拉起滑块**才会走到那段新代码。
  真机现场证据＝2026-10-08（已归档在当日实录与 `LOGIN-NOTES.md`）。
- ⚠️ 顺带纠正一条跑法：**这个 skill 的 `scripts/*.test.mjs` 要从仓库根跑**
  （`node --test "skills/sycm-alimama-daily-report/scripts/*.test.mjs"`）。
  从 skill 目录里跑会有 3 条**假红** —— 那几个用例用 `fs.readFile('./skills/…')` 相对路径读源码，
  CWD 一变就 ENOENT（实测：同一条命令从仓库根 11/11、从 skill 目录 8/11）。

## [1.7.16] - 2026-10-10

用户指令（原话）：「按你推荐的执行」。修的是 **2026-10-08 定时跑暴露的那个真缺口**：
掉登录被归成兜底 `STAGE_FAILED`（缺陷 ㉝），而且链里**没有任何一步会回头补登**。

### 归因：失败那一刻停在登录墙上 ⇒ `NEEDS_LOGIN`（不再是兜底 `STAGE_FAILED`）
- **现场**：2026-10-08 网林天猫停在第 2 步 `alimama-date`，页面被踢到
  `one.alimama.com/index.html#!/login/index`；链把它落成兜底 `STAGE_FAILED`，
  告警不点名「去哪台登哪个后台」，而自进化菜单按兜底派 `REAPPLY_DATES`/`RELOAD_PAGE`
  去动页面 —— 2026-10-09 那次 agent 实测：两个候选都试过、两次重试均 exit 1，全是白跑。
- **为什么原先判不出来**：阶段自己的 stdout/stderr 里**一个字都没有那个 URL**
  （它只报 `alimama: state did not settle to <日期>`）⇒ 只读 `failureOutput` 判不出。
  URL 只活在感知层产物里（`98-failure-state.txt` 的「URL：」那一行，来源＝`location.href`）。
- **改法**：新增纯函数 `loginWallOf({ targets, url, siteKeys })` ——「对所有登记站点一起判」，
  判据仍取 `login-merchant-core.mjs` 的 `SITES`（`pageMatch` + `loggedOut`，唯一来源），
  调用点不另写正则；`shopFailureCause` 在兜底那句之前读 `record.perception.state.url` 分流。
  `makeLoginWallFinder` 改成它的薄封装（行为逐字不变，用例盯住）。
- **优先级**：仍**不盖过** `SHOP_FUNC_NO_PERMISSION`、`PAGE_OBSTRUCTED`、`SOURCE_NO_ROW_FOR_DATE`、
  `INQUIRY_ROW_MISSING`、体检那一支与 push 的 `DUPLICATE_TARGET` —— 那几类的处置与它相反。

### 补登点：链中间撞到登录墙，就地补登一次再重试该步（`--relogin-on-wall`）
- **补的是什么缺口**：整轮唯一会去登的地方是分批开跑**之前**那一次 `login-preflight`
  （`scripts/run-batches.mjs` 写死 `login: true`），而它是**一次性的**。会话在它之后掉线时
  （2026-10-08：07:34 判 `ALL_IN`、07:36:57 就落登录墙），余下 11 步里没有任何一步回头看登录态
  ⇒ **一份存好的密码从头到尾没被调用过**。
- **行为**：某一步失败且页签确实停在登录墙上时，用链自己那条登录路径
  （`login-merchant.mjs --commit --proxy <店代理> --shop <店> --notify off`）补登一次；
  成功则**重试同一步**，通过就顺着 `for` 继续往下（不另起一轮、不重跑已成功的步骤）。
  补登没成 ⇒ **一个字段都不改**，照旧走原来的失败路径。
- **上限是硬的**：**每家店每轮最多一次**（`reloginUsed`）。每一次登录提交都是一次账号动作，
  平台风控看的正是「同一出口 IP 短时间内的登录次数」，所以不是「失败一次试一次」。
- **告警出口只有一个**：补登子进程固定 `--notify off`，不发第二条飞书（本仓纪律）。
- **开关与默认值**：链那一层 `--relogin-on-wall` **默认关**（它会真的提交登录表单，
  属「必须说出口的决定」）；宿主 `scripts/run-daily-job.mjs` **默认开**，
  配 `--no-relogin-on-wall` 一键退回（退回＝与从前逐字相同）。
  三跳全部接通：`run-daily-job` → `daily-job-plan`（`CHAIN_FLAGS` + `buildBatchChainArgs`）
  → `run-batches` → 链。

### 验证到什么程度
- **仅离线判据**：技能组 `run-multi-shop-day.test.mjs` **130/130 全绿**（含新增 6 条：
  `loginWallOf` 正反例用 2026-10-08 的**真实现场 URL 原值**、`makeLoginWallFinder` 重构防回归、
  `shopFailureCause` 分流与「不许盖过更高优先级」、`--relogin-on-wall` 默认关、
  以及一条**整条接线**的源码判据）；runtime `daily-job-plan.test.mjs` 新增 6 条三跳判据。
- **接线以 `--print` 真跑验证**（只打印、不执行）：分批形态 chain 参数为
  `--date 2026-10-08 --batch-size 5 --commit --notify --relogin-on-wall`；
  非分批形态为 `… --commit --notify --relogin-on-wall --login-preflight <路径> --will-resume`；
  加 `--no-relogin-on-wall` 后逐字不含它。
- **未做真机验收**：这条路径要等下一次真的掉登录时才会走到（那是好事）。
  `login-merchant.mjs` 在 havanaone 表单上「点击未被当成真实提交」（㉞，成因未定死）
  ⇒ 补登**可能仍然进不去**，此时它的价值是「多一次机会 + 归因正确」，
  不是「从此不用人登」。这一点写在这里，免得下次误以为它承诺了无人值守。
- **已知与本版无关的一处红**：`runtime/arch-boundary.test.mjs` 现在报三个
  `promotion-daily-report` 系文件未登记 —— 那是**另一条开发线**在工作区里的未提交改动
  （`git status` 可见，mtime 2026-10-09 13:03–23:15），不是本版引入的。

## [1.7.15] - 2026-10-07

用户指令（原话）：「修复这些问题，然后收尾吧」。修的是**当天真机上撞出来的两个缺陷**：
③ 的逐店那一半（`TARGET_PAGE_MISSING` 归因错）与 ㉘（`--only` 跳不过 `push`）。

### 修 ③（逐店那一半）：第 0 步被登录墙挡住时，不再报「页面不齐」
- **现场**：补科塔淘宝 10-06 时，店铺那台实例掉登录 ⇒ 生意参谋页被平台踢到
  `sycm.taobao.com/custom/login.htm?_target=…` ⇒ 链停在第 0 步，报
  `TARGET_PAGE_MISSING`「目标页面不在这个浏览器里…采集会从落位那一步就失败」。
  **真因是登录墙**，而这条文案把排查引向页面 —— 重开页面只会再落到登录页（白跑一趟）。
- **为什么会长成这样**：认页面用的是**结构判据**（`pagesMatching`，查询串与 hash 不参与匹配），
  它刻意不把 `_target=` 里的地址算作命中 —— 这个设计是对的（否则登录跳转页会被当成工作页，
  报「不唯一」，2026-09-17 与 09-22 各坑过一次）。副作用就是掉登录长成了「0 命中」。
- **改法**：`classifyExpectedPages` 在「0 命中」时先问一次注入进来的 `isLoginWall`。
  命中 ⇒ 发新编号 `TARGET_PAGE_LOGIN_WALL` / 理由 `LOGIN_REQUIRED` / 状态 `AUTH_REQUIRED`；
  没命中或判据自己抛错 ⇒ **逐字落回旧口径**（缺证据不下结论，与本模块文件头第 1 条同一条纪律）。
  「哪个 URL 是这个站点的登录页」是**平台知识**，由调用方注入（与 `expectedPages` 同一套注入模式），
  取值来自 `login-merchant-core.mjs` 的 `SITES[].loggedOut`（2026-09-23 实测值，唯一定义处），
  机制层不抄站点词表。
- **归因跟着改**：`record.stages[].blockingCodes` 开始记录拦截项的**编号**；
  `shopFailureCause` 见到登录墙 ⇒ 结论 `NEEDS_LOGIN`（下一步＝去登录；它在 `HUMAN_REQUIRED_CAUSES` 里，
  驻留与「要不要人」都跟着对）。`roundCauseOf` 也优先读体检 findings（原先只能等归位留下 `from`）。
- **验证到什么程度**：仅离线判据 —— `runtime/xws-platform-health-preflight.test.mjs` 新增 6 条、
  技能侧新增 7 条（含一条**接线**断言：工厂真的拿到 `isLoginWall`、编号真的落进收据、
  归因函数真的读它、`roundCauseOf` 真的拿到 findings）。8 条突变逐条改坏源码，
  确认**指名的那条**用例变红（`tmp/mutation-verify-2026-10-07.mjs`，`ALL_GOOD`）。
  真机依据是同日的现场（科塔淘宝 10-06 那两次跑），见 1.7.14 条目。

### 修 ㉘：`--only` 没点名 `push` 时，不再被 push 的源产物守卫拦下整家店
- **现场**：`--only health-check,sycm-date-again,backfill` 想只补回填，7 家**全部**死在
  「没有拿到 shopXlsxPath / promotionZipPath」，而且日志里连「7. push」都没打印（让人以为卡在别处）。
- **根因**：push 的前置守卫 `withSourcePaths` 写在**外层循环里**，排在 `run()`（`--only` 的跳过在里面）
  **之前** ⇒ 被跳过的阶段照跑前置校验。
- **改法**：抽 `stageSelected(only, name)` 作 `--only` 的**唯一点名判据**，守卫与跳过共用它；
  守卫加上 `&& stageSelected(args.only, 'push')`。跳过某一步就不该为它要产物。
- **验证**：仅离线判据 —— 新增 2 条（语义边界 + 一条源码级反断言：不许再出现
  「只看 `args.only`」的写法），突变验证覆盖。

## [1.7.14] - 2026-10-07

用户指令（原话）：「要补齐销售一部的数据二部先别动」。
本版把「补行骨架」的**默认范围**从「登记表全量 13 家」收成「参与采集的 8 家（销售1部）」，
即不再有「不给参数就把销售2部那 5 行顺手铺了」这条默认路径。

### 改：`ensure-inquiry-rows.mjs` 的默认范围收窄到 `collectingShopKeys()`（销售1部）
- **为什么改**：1.7.13 把建行接进定时链时，默认取的是 `shopBrowserKeys()`（13 家，理由写的是
  「行骨架回答的是这张表**声明**了哪些店铺」）。但行骨架实际回答的是「这张表的值**该由谁写**」——
  销售2部那 5 家整部门停采（`SHOPS_NOT_COLLECTING_YET`），按 13 家铺的结果是
  **每天往那 5 行写两列、然后它们永远空着**：这本身就是「在动二部」。
  用户口径「二部先别动」⇒ 默认收成参与采集的那 8 家，与链上其它步骤（`--batches` /
  `collectingShopKeys()`）同源。
- **二部没有被封禁**：`--shops` 的合法值集合仍是全部登记店，要临时给二部建行点名即可
  （`--shops 保拉淘宝,…`）。改的只是**默认**。
- **认下的代价**：二部将来恢复采集那天，得先点一次 `--shops` 把它们的行补上 ——
  比「默认每天都在动二部」是更小的意外。
- **改动面**：`resolveTargetShops` 改成**纯函数**（`registered` / `collecting` 两个名单由参数注入），
  这样范围口径可以离线断言而不起任何东西；`arch-boundary.test.mjs` 里那条白名单理由跟着改
  （它原先只提 `shopBrowserKeys()`）。
- **验证到什么程度**：新增 `ensure-inquiry-rows.test.mjs`（7 条）——默认＝参与采集名单、
  默认里一个停采店都不含、显式点名能点到停采店、产物顺序按登记表、未登记 fail-closed、
  真实登记表下默认严格小于登记表全量、以及一条源码级断言（默认不许回落到 `registered`）。
  这 7 条是**仅离线判据**；本版的真机证据是同日 10-06 的恢复实录（见下）。

### 记：同日三次真跑（不属本版改动，作为本版的现场依据）
- **10-06 的 13 行已建**（1.7.13 的 `--commit` 真跑）：`COMMITTED_AND_VERIFIED`、`created=13`；
  复跑同一条 ⇒ `ALREADY_PRESENT`（幂等实证）。
- **10-06 的 7 家询单回填补跑成功**（7/7）：值见
  `evidence/daily-report-2026-10-06-<店>/inquiry-backfill-receipt.json`；独立回读确认
  询单表 10-06 共 13 行、其中 7 行有值。
- **10-06 的最后一家（科塔淘宝）整链补跑成功**（本版收窄默认范围的那家正是它所在的部门）：
  它在前两轮里的现场是「**生意参谋 + 阿里妈妈双双掉登录**」——链停在 `health-check` 的
  `TARGET_PAGE_MISSING`（真因是登录墙，不是页面不齐，即待修缺陷 ③ 的又一次现身）。
  按 SOP §11 用 `login-merchant.mjs --commit --proxy http://127.0.0.1:19044 --shop 科塔淘宝`
  补救：凭据守卫 `verdict=ACCEPT`（填入的正是 `j873522735:小瓜`，没登错家），
  两个站点 `loggedInAfter=true`；随后 11 步全绿（`chain_rc=0`）、实例已释放
  （19034/19044 两遍独立回读全 0）。
  **独立回读（走 OpenAPI，不走链自己的收据）**：底单 10-06 = **8 行**（补前 7 行）、
  询单表 10-06 的科塔淘宝行 = `询单量 5 / 同层同行 9`。
  ⇒ 销售1部 8 家 10-06 全部齐；销售2部那 5 行仍是空骨架（`null`），符合本版「二部先别动」口径。
- **同日发现新缺陷 ㉘（未修）**：`--only` **跳不过 `push`** —— push 的阶段前置守卫
  `withSourcePaths`（`run-multi-shop-day.mjs:1842-1852`）排在 `run()`（含 `--only` 判定，`:1755`）
  **之前**，所以「只想补回填」时用 `--only` 会整店失败在 push 之前、且日志里连「7. push」都不打印。
  本次绕开链逐店直跑两段完成恢复；修法（把守卫挪进 `run()`）与复现命令记在
  `.workbuddy/memory/PROJECT-NOTES.md` ㉘。

## [1.7.13] - 2026-10-07

用户指令（原话）：「新建日期行这个可以加入自动化流程，你给出这个问题的解决方案」→ 看完方案后「全按建议」。
本版把「飞书询单表这一天的行骨架」从**人工预建**接成定时链的一步，并把它的缺失单列成一类失败。

### 修：飞书询单表缺「这一天的行」⇒ 8 家店回填全挂（㉗）
- **现象**（2026-10-06 真跑：`evidence/daily-job-2026-10-06/job.log`、`evidence/batches-2026-10-06/`）：
  两批 8 家店跑完前 9 步（第 7 步 `push` 写底单**全部成功**，收据都是 `COMMITTED_AND_VERIFIED`），
  第 10 步 `backfill` **8 家全部** `expected one Feishu row for <店> / <epoch>, got 0`；
  科塔淘宝另外停在第 2 步（`HTTP 400 alimama filter bar not ready; triggers=0`）。
- **根因**：`run-inquiry-backfill.mjs` 只**更新**已有行、**从不建行**；而「各店铺数据日报」的日期行
  一直是**运营侧预建**的（`docs/ops/PROJECT-BROWSER-AND-PORTS.md` 第 62 行记着只铺到 10-05），
  仓库里没有任何一步管它 ⇒ 一个外部依赖没落进流程，每天都可能全挂，而报错位置离真因隔着好几层
  （「页面读不到」「登录掉了」这两个方向都被排除过一遍，结论都不是）。
  本版新脚本的**只读排练**为证（不带 `--commit`）：`10-05` = 13 家全部已齐；`10-06` = 0 家已齐、13 家全缺。
- **修法**（四块，缺一块都只是「看着像修好了」）：
  1. 新增 `skills/sycm-alimama-daily-report/scripts/ensure-inquiry-rows.mjs`：**日级、幂等**，
     只写 `日期`＋`店铺` 两列（其余 31 列是 Lookup(`19`)/Formula(`20`) 派生列、不可写；
     行一在、底单数据一推上去它们自己解析出值）。默认**排练**，`--commit` 才写。
     写前 fail-closed 断言：表名＝`各店铺数据日报`、`日期` type 5、`店铺` type 3、
     目标店在「店铺」选项里**必须存在**（写一个不存在的店名，平台可能静默新建一个选项 ⇒
     表里多出一家谁也不认识的店，且看起来完全正常）。写后**独立回读**再断言。
     同日同店多行 ⇒ **整批一行都不建**（半路建一半会让状态更难说清）。
  2. 抽共用叶子：`listFieldOptions` / `resolveShopOptionId` 从 `run-inquiry-backfill.mjs`
     搬进 `inquiry-core.mjs`。建行与回填必须用**同一份**判据认「这一行在不在」；
     两份实现漂开的症状是「一边建、一边回填不上」，而两边都不报错。搬迁不改行为。
  3. 接进计划：`runtime/daily-job-plan.mjs` 加 `JOB_FILES.ensureInquiryRows` 与一步
     `ensure-inquiry-rows`，**全链与 `--batches` 两种形态都有**（它是日级动作，与批次粒度无关，
     也不该在每个批里各建一遍），排在链之前、其余前置步骤之后；`blocking: false` ——
     它失败时正确的处置是**照常采集**、事后把行建出来再只补跑回填，而不是让这一天的数据一条都不采。
     `--commit` 由计划显式给（脚本自己默认排练；漏这一句会静默地「一行都没建」）。
     `scripts/run-daily-job.mjs` 默认开、`--no-ensure-inquiry-rows` 一键退回。
  4. 单列失败成因 `INQUIRY_ROW_MISSING`：回填那句「候选行数＝0」现在带机器标记
     （由 `inquiry-core.describeFeishuRowGap` 产出，错误里**直接写出处置**）；
     链的 `shopFailureCause` 认识它，并登记进 `REASON_BY_CAUSE` / `ACTION_BY_CAUSE` /
     `REMEDIATION_TABLE`（`notifyLevel: 'human'` —— 与 `SOURCE_NO_ROW_FOR_DATE` **相反**：
     那一条谁都变不出来，这一条补一行就好，所以不许静默）。
     **刻意不进** `AGENT_PREFERRED_CAUSES`：修复 agent 手上只有页面动作，对它一个都不对症 ——
     这不是纸面推论，2026-10-06 那次 8 家各烧掉一轮 `--auto-repair`，
     8 份修复请求单给的全是 `REAPPLY_DATES` / `RELOAD_PAGE`。也不进 `HUMAN_REQUIRED_CAUSES`
     （没有哪一页需要人碰，驻留对它是纯浪费）。
- **验证到什么程度**：
  - **只读真机排练**（本版脚本，不带 `--commit`，一个字节都没写）：`--date 2026-10-06`
    → `targets: 13 / presentCount: 0 / missing: 13`；`--date 2026-10-05`
    → `presentCount: 13 / missing: [] / created: []`（幂等那一支也走通了）。
    表名、两个字段类型、13 个选项的真实存在都被断言过。
  - **离线**：`inquiry-core` 19、`remediation-table` 14、`run-multi-shop-day` 113、
    `daily-job-plan` 51、`escalation-plan` 22、`arch-boundary` 3 —— 全绿。
  - **尚未做（不在本版内）**：真建 10-06 那 13 行、以及补跑那 7 家的回填。那是本版交付之后单独执行的一步。

### 不变
- 没有改任何浏览器相关的逻辑：`--batches` 的起停与释放口径、共享窗口登录守卫、
  告警闸门（`--defer-agent-actionable-alert`）与驻留判据一个字都没动。

## [1.7.12] - 2026-10-06

用户指令（原话）：「那你推荐的改，然后网林这个你告诉我缺什么？」—— 指的是 2026-10-05 那一轮
（共用窗口掉登录 + `网林家居` 回填失败）复盘之后我列出的待修项。本版修其中两条，并撤回一条（见末节）。

### 修：协议没勾上却照样提交，还写下一份「同意过」的假凭据（㉔）
- **现象**（2026-10-05 真跑回执 `evidence/daily-job-2026-10-05/job.log`）：
  `agreementChecked:false`，却照样点了「登录」；同一份回执里写着
  `agreement.autoAccepted:true, agreedAt:…` ⇒ **一条假的同意凭据**。平台静默拒掉之后
  报出来的是 `LOGIN_NOT_CONFIRMED`「页面还停在登录页（可能是密码不对）」—— 方向正好反。
- **修法**：
  1. `login-merchant-core.mjs` 新增纯判据 `AGREEMENT_VERDICTS` / `judgeAgreement` / `agreementSatisfied`
     （五个出口各对应一个处置：页面没有那个框 / 本来就勾着 / 点了勾上了 / 点不着 / 点了没勾上）；
     `VERDICTS` 与 `VERDICTS_NEEDING_HUMAN` 各加 `AGREEMENT_REQUIRED`，
     `ACTION_BY_VERDICT` / `REASON_BY_VERDICT` 各加它的专属文案（不并进 `LOGIN_NOT_CONFIRMED`：
     那一条让人「改密码」，而这里的账号密码一个字都没错）。
  2. `login-merchant.mjs`：协议勾选走**两条通路** —— 先坐标点击（2026-09-23 实测有效），
     没勾上再 DOM `.click()`（2026-10-06 实测有效），每次点击后**回读**；
     `autoAccepted` / `agreedAt` 只在**回读确实为 `true`** 时才写；
     `CLICKED_BUT_STILL_UNCHECKED` / `NOT_CLICKABLE` ⇒ `AGREEMENT_REQUIRED`
     且**在取「登录」按钮坐标之前返回 exit 2**（不提交）。
  3. `AGREEMENT_TEXT` 不再写死 `#fm-agreement`（10-05 那份回执里 `text:null` 就是这个 id 已不在
     DOM 里）：改成从 `#fm-agreement-checkbox` 往上找容器取文本，`#fm-agreement` 只作旧页面兜底。
  4. `check-login-shops-core.mjs` 的 `LOGIN_FAIL_TEXT` 补 `AGREEMENT_REQUIRED`
     （漏了它，体检报告里会印出内部代号 —— 那条覆盖判据在同文件的用例里）。
- **为什么两条通路都留着**（不拿今天的实测删昨天的通路）：`evidence/login-agreement-probe-2026-10-06/`
  在一台一次性实例上实测 —— 坐标点勾选框中心（539,586）与点可见文字中心（727,596）**都**不改
  `checked`，DOM `.click()` 才改；而 2026-09-23 的证据恰好相反（坐标点击有效）。
  页面在这两个日期之间改过 ⇒ 删掉任一条都会在它改回去的那天静默失效。
- **验证程度**：离线用例（含两条接线判据：闸门必须在点「登录」之前、条件的**文本**必须真的读判据 ——
  只查「赋值在不在」会被 `if (false)` 骗过，这一点是突变验证当场抓到的）＋ 11 处突变验证
  （`evidence/fix-agreement-inquiry-2026-10-06/mutation-verify.txt`）。**未经真机复测**。

### 修：「这一天的源表里没有日期行」被归成兜底类失败（㉕）
- **现象**（2026-10-05 `网林家居`）：`backfill` 抛
  `inquiry source must contain exactly one daily date row`。三种完全不同的成因
  （该日无行 / 选到了区间 / 表里有两行）共用这一句 ⇒ ① 措辞不可行动；
  ② 自进化菜单按 `STAGE_FAILED` 派 `REAPPLY_DATES`（而它是**报告者不是执行者**）⇒ 白跑一轮；
  ③ 分诊落「要人处理」＋驻留判据落「脚本自修不动」⇒ 为一件不需要人做的事把窗口白挂几小时。
- **定案**（同店同实例同代码，只换日期）：`10-04` ⇒ 1 个日期行；`10-05` 与 `10-03` ⇒
  空态「暂无数据」、0 个日期行 ⇒ 日期生效、登录正常、身份对上、表没选错。
  **守卫本身是对的**，错的是归因。口径：**「暂无数据」≠「询单量 0」**（后者会渲染成一行 `0`，
  历史上有 122 行）。
- **修法**：
  1. `inquiry-core.mjs` 新增 `SOURCE_NO_ROW_FOR_DATE_TOKEN` 与纯函数 `describeDateRowGap`：
     0 个日期行 ⇒ 带标记 + **把现场值带出来**（日期列前 12 行原值、日期行数、期望日）；
     `>1` 行仍走旧那句（结构异常，要人/agent 去看）。
  2. `run-multi-shop-day.mjs`：`FAILURE_CAUSES` 加 `SOURCE_NO_ROW_FOR_DATE`；`shopFailureCause`
     认那个标记（import 常量，不写字面量）；补 `REASON_BY_CAUSE` / `ACTION_BY_CAUSE` 两条文案
     （下一步明写「不用重跑、也不用找技术同学」——兜底那句的最后一句恰恰是「转给技术同学」）。
  3. `remediation-table.mjs` 给它 `notifyLevel: 'silent'`（与 `DUPLICATE_TARGET` 同形：不叫人）；
     顺手把 `notifyLevel` 这条既有判据**明确**成「也是不驻留的判据」，
     由 `buildRepairRequest.noActionRequired` 落进修复请求单。
  4. `runtime/hold-and-resume-plan.mjs` 的 `unfixableShopsOf` 跳过
     `repairRequest.noActionRequired === true` 的店（原先「空菜单 ⇒ gaveUp 非空 ⇒ 算修不动」，
     对「谁都不用动」那两类同样成立 ⇒ 驻留 4 小时等一个不存在的人）。
  5. `autoRepairAndRetry` 的空菜单 `gaveUp` 措辞分两档（「本来就不需要任何人处理」≠「交给人」）。
- **验证程度**：离线用例（分类器、`describeDateRowGap`、`noActionRequired` 正反两面、
  驻留闸门正反两面、告警文案样例表覆盖）＋ 同一份突变验证脚本。**仅离线判据**。

### 撤回：原计划的「给共用商家窗口登记一个期望账号」（㉓）—— 实测否掉了它
原判据 `expectedMemberFor({shop:null})` 返回 `null` ⇒ `judgeFilled` 恒为 `UNKNOWN` ⇒
共用窗口无论填进哪家店的账号都照样提交。本打算给它登记一个期望账号，动手前核对登记表发现：
`里可林淘宝` 现在的 `alimamaMemberName` 是 **`里可林家居:小嘉`**（2026-09-30 用户账号表），
而 2026-10-05 那份**跑成了的回执**里，共用窗口填进去的是 **`里可林家居:阿彦`**。
⇒ 按登记表登记期望值，会把一条**正在工作的通路**当场判成 `WRONG_ACCOUNT` 并拒绝提交（假红）。
且用户 2026-10-05 口径是「账号要换就换」⇒ 这个期望值本身不稳定。
**故不修**，维持「共用窗口没有期望值、回执里如实写 `guardBasis:no_expected_member`」。

### 未动：商品数据链的失败告警仍输出技术串（㉒）
`scripts/run-product-data-job.mjs` 的 `notifyFailure` 仍把 `机器`、`D:\Retire\…` 盘符路径、
`job.log` / `collection.json` 文件名与 `FAILED/UNCLASSIFIED` 内部代号渲染给业务收信人。
**本版不动它**：那是另一个开发线程正在写的文件（工作区里已有它未提交的改动），
按本仓纪律「别的会话在改的文件一个字都不要碰」，改法已备好（4 个字段），等腾出手再说。

## [1.7.11] - 2026-09-30

用户指令（原话）：「先修分批的问题，然后你监督着去跑没成功那几家，分析到底是什么问题」。

这一批修的是**与「分批」同名、却根本没分批的那个缺陷**：`--batches` 只把**链**切成批，
而第 ① 步照旧一次起齐全部登记实例（13 家店 ＋ 竞品链）⇒ 峰值与「一次全起」逐字相同，
分批唯一的存在理由（省内存）一分没兑现。

### 改了什么

**① 分批形态下，第 ① 步只起共享实例（`runtime/daily-job-plan.mjs`）**

- `ensure-instances` 在分批形态下收窄成 `start-all.mjs --only dailyReport`，名单取自
  `runtime/batch-plan.mjs` 的 `SHARED_INSTANCE_KEYS`（同一个事实只写一处，不在这里再抄一遍键名）。
  店铺实例一律由**每一批自己的** `start` 起、同一批的 `stop` 停。
- 为什么不干脆删掉这一步：本轮的**共享商家浏览器登录守卫**排在 `batch-chain` 之前，
  它要开那台实例（19022/19023）的页面去补会话；而分批驱动里的 `ensure-shared` 排得比守卫**晚**
  （它在 `batch-chain` 内部）⇒ 实例必须先起。所以是**收窄**，不是删除。
- 实测的缺陷形态：16:26 那一轮第 0 步是不带 `--only` 的 `start-all.mjs`
  （`evidence/daily-job-2026-09-29/job.log` 08:26:30Z），它把 13 家店与竞品链一起起了一遍
  （进程取证 `tmp/procs-node.txt`：13 家店的浏览器/代理启动器全在）；修完同一位置变成
  `start-all.mjs --only dailyReport`，退出码 0。
- 不分批那一档**逐字未变**（`args: []`，仍是一次起齐），由一条与固定期望文本逐字比较的用例守着。

**② 分批形态下，整轮的逐店预检（`login-preflight`）不进计划**

- 两条理由：① 带 `--login` 时它**必然白跑** —— 店铺实例要等各批自己的 `start`，
  此刻 12 家店的调试端口一个都没开，逐店只会读到「连不上浏览器调试端口」⇒ 全 `UNREADABLE`
  ⇒ 退 3，而「自动登录一次机会都没有」这件事在日志里看不出来（与 2026-09-23 刚给这一步
  加 `--login` 时踩过的坑**逐字同一形态**，实测凭据见 `batch-plan.mjs` 的 `buildLoginPreflightStep`）；
  ② 就算它读得到，也会在开跑前把 **12 家店**的登录提交一次性排进队列 —— 而这类提交的间隔是被
  刻意拉开的（同一出口 IP 短时间多次登录＝账号风控）。
- 这不是新开的口子：该文件自己原来就写着「⚠️ 已知的重复（刻意留下，不是漏改）……
  要收紧的话应当删掉**这一遍**、不是删分批那条」。本轮照那句话收紧。
- 逐批那一条（`start` 之后、`chain` 之前，结论落 `login-preflight-b<N>.json`）不受影响 ——
  它才是权威的那一条（「本批的浏览器起没起、掉没掉登录」是**批次相关**的事实，不是整轮的常量）。
- 顺带的后果：分批形态下 `ensure-merchant-login` 不再「排在逐店预检之后」（整轮没有逐店预检了）。
  代价很小且是有意的：守卫只在**真掉登录**时才提交一次（正常那轮读到 `ALREADY_LOGGED_IN`、零提交），
  而保留一条「必然白跑、还会把 12 家店的提交排进队列」的步骤代价更大。这一条写在计划那一步的注释上。

### 验证到什么程度

- **离线判据 ＋ 真跑入口的 `--print`**（这一版不单独跑一轮真采集）：
  · `node --test runtime/daily-job-plan.test.mjs` **44/44**（新增两条：分批形态第 ① 步只起共享实例／
    整轮逐店预检不进计划）；
  · `node --test "runtime/*.test.mjs"` **984/984**；
  · `node scripts/run-daily-job.mjs --print --date 2026-09-22 --batches 5` 打出
    `start-all.mjs --only dailyReport` → `login-merchant.mjs … --commit --target sycm --notify off`
    → `run-batches.mjs …`；同一入口**不分批**时逐字与从前相同（四步 ＋ 驻留那一步都在）。
- **突变验证**（`tmp/mutate-batching-fix.mjs`，一次性脚本、不提交）：
  把 ① 改回 `args: []` ⇒ 红 1 条；把 ② 改回「总是加入」⇒ 红 5 条，且都点名到期望的那几条判据；
  还原后 sha256 逐字节一致，重跑 44/44 回绿。

## [1.7.10] - 2026-09-30

用户指令（原话）：「日报链这个改成 `https://kcne618basvj.feishu.cn/base/RjKcb3isDaVn1GsoVJfc7Ykknyg?table=blkA0FiI6um8CwmK`／
日报链的数据，店铺可以全部放在同一张表，不用改原本的流程，只是扩展了店铺数量／然后商品链改成表格中的 base，
还有对应好相应的店铺」＋「肯定开 13 家啊，收尾吧」。

这一批把**第 13 家店从「已登记」推到「参与采集」**（两条链都跑 13 家），并按用户给的两份新 base 重新落位。

### 改了什么

**① 日报链换 base：`PTfHbPt9Ea…` → `RjKcb3isDaVn1GsoVJfc7Ykknyg`（「各店铺日报 副本」）**

- 判据不是名字，是**底单行数**：换之前对七个候选 base 做逐表只读实读 —— 新 base 的
  「总数据来源底单」**2184 行**（04-01…09-29 每天 12 家齐），旧 base 1934 行（09-18…09-28 只剩每天 5 家）；
  「店铺底单」新 13 行 vs 旧 12 行；「各店铺数据日报」新 09-29 起每天 13 家 vs 旧 12 家。
  ⇒ 名字里带「副本」的那张才是全的，换过去是**纠正**而不是退步。
- 用户给的 `?table=blkA0FiI6um8CwmK` 在**四个相关 base 上逐个试过、一律回 `1254004 WrongTableId`**，
  且新 base 无 dashboard ⇒ 它不是任何数据表。写入落点**仍按表名**（`sourceTable` = `tblIuAX4nPc1zDOO`，
  并与页面读回的 base 名双方去空格后比对）。
- `sourceView`（`vewwg0rhjo`）与旧 base 那个逐字相同，故这一格不动；用例把它钉住防止再漂。

**② 商品链换 10 月两张 base**（月份口径＝**数据统计日期** `--date`，不是运行日）

- 销售1部 → `FhCUbn7vVaEc26sRjMAccQJAn5e`；销售2部 → `ZYwWbYP9fa5d3rsXX8IcKrkYnod`。
  旧 token（`LQgZbi78…` / `LLWcbIuV…`）留在注释里作**回滚值**。
- 换之前先钉住**安全前提**：三张被写的表（商品数据底单 / 询单数据底单 / 推广数据底单）在
  「9月 / 10月1部 / 10月2部」之间**逐字段（含顺序）完全一致**（73 / 14 / 82 字段，实测非推测）
  ⇒ 只换 id、不动任何写入逻辑。
- 顺带查明商品链**不写「店铺」列**：三张底单一个「店铺」字段都没有，看板上的「店铺」是
  type 19（引用/lookup，不可写），店铺只出现在收据的 `manifest` 里 ⇒ 「13 家商品数据」不需要补选项。

**③ 第 13 家改名：`网林定制淘宝` → `网林家居`**（三处独立证据，不是推测）

- 证据：① 账号表 15:43 与 16:01（测试版）两版都写「网林家居」，而 11:05 版写的是「网林定制淘宝」
  ⇒ 改名时点落在 11:05 与 15:43 之间；② 新日报 base 的「店铺」13 项选项含「网林家居」；
  ③ 新 base「店铺底单」13 行里那一行是 `平台店铺全称=网林定制家居 / 店铺=网林家居`。
- 这个键**就是写进飞书「店铺」列的值** ⇒ 全仓跟随改名：`SHOP_DEPARTMENTS`、`SHOP_BROWSERS`、
  `SHOPS_NOT_COLLECTING_YET`、`shop-identities.mjs` 及其用例、`docs/ops/PROJECT-BROWSER-AND-PORTS.md`。
- `platformOf` 改成**两来源**：带平台后缀的（淘宝/天猫/龙头店…）按后缀推；不带后缀的
  （「网林家居」——「家居」是**品牌词**不是平台标记）必须在新增的 `PLATFORM_BY_KEY` 里显式声明；
  两来源同时成立抛错，都没有也抛错。**刻意不把「家居」加进后缀表**：那等于宣称
  「叫家居的都是淘宝店」，而天猫店同样可以叫家居 ⇒ 静默误判。

**④ 开满 13 家：`SHOPS_NOT_COLLECTING_YET` 清空**

- 清空前，那家店的三件事（身份实测到 `expression` 级、飞书落点、实例侧）都已到位
  ⇒ 用户拍板「肯定开 13 家啊」，表清空，`collectingShopKeys()` 与 `shopBrowserKeys()`
  **逐字相同**（13 家）。当前分批：日报 **3 批 5/5/3**（第 2 批跨部门，与登记表注释的预测一致）、
  商品链 13 家、默认每批 5。
- 随之改口径的判据：`browser-ports.test.mjs` 改成「**空清单下也**断言两个集合逐字相同」
  （原来那句 `assert.ok(pending.length > 0, '空了就该把表删掉')` 与它自己的结论相冲突）。
- 「一定有『还没开始收集』的店」这类断言（`batch-plan.test.mjs`、`product-data-job-core.test.mjs`）
  改成**注入两个集合构造现场**：`resolveShopNames` / `assertBatchCoversRegistry` /
  `buildProductJobPlan` / `platformOf` 都开了可注入参数，默认值＝真实登记表。
  理由同一条 —— **靠「仓库里恰好有一家空店」覆盖它，等于把一年只响几次的守卫交给运气**，
  空店一开就永远没人守；不可注入的守卫只能靠人构造事故来验证，等于没有。
- 顺手把注释里过期的家数（12 家 / 五家店）对齐成中性写法或 13 家；「一店一名是常态」那句补上
  本次的实例（阿里妈妈＝会员名、生意参谋＝店名、飞书＝运营叫法）。

### 验证到什么程度（**说实话**）

- **仅离线判据**：`node --test runtime/*.test.mjs` **982/982**；`npm run test:runtime` **1025/1025**；
  日报技能 `node --test scripts/*.test.mjs` **406/406**；改动文件 `node --check` 全过。
- **没有跑过真机**：新日报 base 的**写入权限与真机写入未验**（没跑过 `--commit`）。
  这条链的顺序让风险有界 —— 前六步（health-check / alimama-date / promotion-submit /
  sycm-date / shop-report / promotion-fetch）**一个字都不写飞书**，写权限不够会停在 `push`。
- **没读到的证据**（不许当成「没问题」）：本机沙箱 stdout 不回显，所以**浏览器实例与端口现状这一轮没有读**；
  `--batches` 的「跑完释放」也没有真机复核。
- 2026-09-30 16:26 那一轮定时**用的是改动前的配置**（`check-login-shops` 只列了 12 家、缺「网林家居」，
  且版本行写的是 1.7.9）⇒ 本批次的改动**没有被那一轮执行过**，它的失败与本批无关。
  该轮自身的故障见 `evidence/daily-job-2026-09-29/job.log`：`ensure-instances` 退 1
  （里可林淘宝 `browser-missing`）、5 家店在归位时报 `targets.map is not a function`
  （`runtime/page-normalize.mjs:63` 拿到的是非数组 ⇒ 代理 `/targets` 回了错误体），另 3 家「归位后仍不齐」。
  **这一条不在本批次范围内，另行处理。**

## [1.7.9] - 2026-09-29

用户指令：「该需要修复的就修复，查清楚问题所在，9-24 的数据不用管了」。
修的是三处**接线断点**（都是「东西建好了、没接上」这同一个病根），另加一份全表逐日核查的结论。

### 修了什么

**① 询单量回填的 `店铺` 匹配：认「SingleSelect 选项 id」形态（⑧ 已修）**

- 真因（09-29 OpenAPI 实读证实）：`店铺` 是 `SingleSelect`，OpenAPI **会回两种形态** ——
  店名（全表 2185 行，如 `盖文淘宝`）与**选项 id**（`optFFaXJeh`，09-28 那 12 行）。
  原判据 `cell(fields['店铺']) === shop` 只认店名 ⇒ 撞上 id 那一天恒不匹配、报 `got 0`，
  而人在页面上明明看得见那一行 —— 本项目老病根「把读不到当成不存在」的又一例。
- `inquiry-core.mjs` 新增 `findDailyStoreRow()`：按「日期 + 店铺」找**唯一**候选，认两种形态；
  返回 `{record, matchedBy, candidateCount}`（**不抛错**，让调用方区分 0 个与 >1 个）。
  认 id 的正当性是它**在字段自己的选项表里唯一**，不是「为了兼容」；**绝不猜近似名**。
- `run-inquiry-backfill.mjs`：optionId 由 API 的 `property.options` 反查（`listFieldItems()` 新增），
  不存第二份；写前/回读用**同一个匹配器**（口径两边必须同一份，否则会出「写成功了、回读报 0」这种最难查的假红）。
- `matchedBy` 与 `shopOptionId` 落进收据（`plan.target` / `receipt.verified`）——
  09-29 之前没人记这个，所以「表里那行店铺存的是 optXXX」只能靠人肉重读全表才发现。
- **真机排练（只读，OpenAPI）**：09-28 五家 修复前候选=0 → 修复后候选=1 且 `matchedBy=field-option-id`；
  09-27（店名形态）五家 修复前=1 / 修复后=1 且 `matchedBy=shop-name`（**无回归**）；未登记店名 ⇒ 0。
  排练**未发任何写请求**。
- 突变验证：3/3 全红且点名到期望用例，源文件还原后 sha256 逐字节一致（`609214a8…`）。

**② `--auto-repair` 执行路径整条是死的（⑨ 已修）**

- 真因：`planRepair()` 给的候选是**对象** `{action, mutating, why}`，而 `executeRepairCandidate`
  原代码 `const action = list[0]` 把对象当**动作名**传下去 ⇒ 四路 `===` 全落空
  ⇒ 五家店都「试了 1 轮、applied=false」，等于**零修复动作真正执行过**。
- 用例当时全绿，是因为测试传的是**字符串数组**、生产传的是**对象数组**
  —— 本项目第三次吃「函数级全绿 ≠ 接线接上了」。
- 修法：新增导出的 `actionNameOf()` 归一成动作名（**同时接受两种形状**，并让「形状不合法」
  当场抛而不是留给 `===` 静默落空）；`splice` 改为**按名字** `findIndex` 摘除
  （原先拿字符串在对象数组里 `indexOf` 恒 -1 ⇒ `splice(-1,1)` 摘错，同一个动作被反复试）；
  `gaveUp` 文案不再印 `[object Object]`；`result.error` 如实转出「动作自己炸了」与「没落地」。
- 突变验证：3/3 全红且点名（M1 红 4 条、M2 红 2 条、M3 红 1 条），源文件逐字节还原。

**③ 链级告警不等 agent（⑨b 已修，默认关）**

- 真因：三层降级的第②层（唤醒修复 agent）在真跑里被跳过 —— 链级告警由 `run-multi-shop-day.mjs`
  **直接**发飞书，从不问「这一家该不该先交给 agent」，于是第③层（叫人）被提前执行。
- 边界说清：脚本自己是 shell/Node 子进程，**没有 `Agent` 工具，唤不醒 agent**。
  能做也真正断掉的那一截是：**别在这一刻叫人**，把派单落盘、如实说出「这一轮交给 agent 了」。
- 落地：`escalation-plan.mjs` 抽出 `classifyShopEscalation()`（**告警闸门与派单同一份判据**，
  不许各写一份）；`run-multi-shop-day.mjs` 新增默认关的 `--defer-agent-actionable-alert`：
  **只有整批失败都「agent 能救」时**才不发飞书、改落 `escalation-handoff.json`；
  **只要有一家「只能人上」（登录掉了/权限不足），照旧叫人且点名到店**（fail-closed）。
  半批进 agent 队列、人只看到另一半，是事后无从回答的形态，故「整批进 / 整批出」。
- 开关两跳都钉住（`run-daily-job` → `daily-job-plan` → `run-batches` → 链），
  用的是 `--auto-repair` 那次实测换来的判据（那一次就是断在第二跳）。
- 突变验证：3/3 全红且点名；其中第 3 个突变第一次**没被抓**（「整轮被体检拦住、`failed` 为空」
  这个形态漏了用例），补上 `roundBlocked` 那条后 3/3 抓住 —— 所以留下那句
  「用例没咬住代码就等于没写」。

### 全表逐日核查结论（只读）

询单表 2197 行 + 66 份收据交叉核对：09-17~09-23 5/5、**09-24 4/5（缺网林天猫）**、
09-25/26 5/5、09-27 4/5、09-28 2/5。失配 **100% 在 `店铺` 维度**，日期维度已排除（两边都是北京零点）。
附带查出 **09-24 网林天猫收据假绿**（写 6/10、实读 null，66 份里唯一一份）——
用户已明确「9-24 的数据不用管了」，故**不补**，只留档。
产物：`evidence/inquiry-writeback-audit-2026-09-29/`（README + 2197 行快照 + 4 个只读脚本）。
另：09-28 那 12 行与周围同属 `reczz28HKFE` 批次，是**普通批次行的 `店铺` 值被写成了选项 id 形态**，
不是「另一套流程写的骨架行」（初版判断已更正）。

### 验证到什么程度

- 离线：`runtime/*.test.mjs` 966/966、`skills/sycm-alimama-daily-report/scripts/*.test.mjs` 403/403、
  `skills/xws-to-feishu-base/tests/*.test.mjs` 101/101，全绿（本版之后）。
- 真机：① 有只读排练证据（未发写请求）。②③ 有突变验证，但**未在活页面上真跑过**
  （09-29 当晚 12 个端口全 free，无存活浏览器；未经许可不起停任何进程）。
  ⇒ ② 的验证程度是「修复层不再是死的」，**不是**「已证明能救回 09-28 那 4 家」；
  它**也救不了**那 4 家 —— 修复动作碰不到字段映射（⑧ 才是那 4 家的病根，已修）。
  ③ 的验证程度是「开关两跳都通、默认逐字不变」，**不是**「会话侧已按派单派 agent」。

## [1.7.8] - 2026-09-29

承接 1.7.7 的修复回环：那一层补上了「修完再重试」的**手**，但**眼睛和耳朵**还有两处缺口，
而它们正好挡住了用户点名要的那条路 ——「读不到就转 Agent，不行再转人工」。

2026-09-29 15:30 那轮定时跑（目标日 09-28）把两个缺口同时暴露了：
① 网林天猫在批次级预检里被判成「读不到」（`CDP 命令超时: Runtime.evaluate`），
   而预检**没有重试**，于是这家店**连自动登录都没被触发** —— 一个本该自愈的窗口故障，
   被升级成了「要人去窗口里动手」；
② 09-25 就定位过的「确认登录/快速进入」中间屏至今没被处理：登录成功后页面**地址不变**，
   而当时的唯一判据是 `isTaobaoLoginUrl(hrefAfter)` ⇒ 恒为真 ⇒ 那一步**从来没被点过**。

用户给了三条指令：「修吧」「读不到就转 Agent，不行再转人工」「自动同意登录」。本版按此落地。

### 改了什么

**一、登录补上「确认登录/快速进入」中间屏（`login-merchant-core.mjs` / `login-merchant.mjs`）**

- 新增 `CONFIRM_SCREEN_SELECTORS`（两个容器类）＋ `CONFIRM_ACTION_TEXTS`（快速进入/确认登录/确认进入）
  ＋ `CONFIRM_SCREEN_EXPRESSION`（取容器与可点叶子的**中心坐标**）。
- `detectConfirmScreen()`：**必须同时**命中容器类**和**带动作文案的可点叶子才算中间屏 ——
  只看容器会在别的页面上误判，只看文案会在菜单里误判。
- `judgeSubmitOutcome()`：三个出口 `CONFIRM_REQUIRED` / `AMBIGUOUS` / `NONE`。
- **接线顺序是本版的关键**：提交之后**先判中间屏、再判 URL**。原来的顺序让 URL 判据永远先命中，
  中间屏就永远轮不到。判出 `CONFIRM_REQUIRED` 就点它，`AMBIGUOUS` 则 `STOP_AND_ALERT`（不猜）。

**二、自动同意协议，并留下同意事实（同上两文件）**

- 提交前勾选协议（`#fm-agreement` 最近的那层 label），回读确认勾上了。
- 收据里落 `receipt.login.agreement = { autoAccepted, agreedAt, checkedAfter, text }` ——
  **同意了哪一份、什么时候**要留痕，否则事后无法分辨「用户早就同意的」与「系统替他点的」。

**三、「读不到」不再等价「掉登录」，且触发自动登录尝试（`check-login-shops-*.mjs`）**

- 新增 `PROBE_RETRY_LIMIT = 1` 与 `shouldRetryProbe()`：只对「没回执」与「每个站点都读不到」重试**一次**；
  任何一个站点读到实锤（在登录态/掉登录）就**不重试** —— 那是确定的事实。
  上限固定一次而不是「重试到成功」：代理真挂掉时无限重试会把一轮预检拖成永不返回，比读不到更糟。
- **只包在只读档外面**：`--login` 档重试一次就等于**第二次提交登录**，与「不重复提交」的纪律冲突，
  所以那一档刻意不重试，拿不到回执时如实报 `UNREADABLE`。
- 判据只有一个出口：`every(s => s === null)`，它已蕴含「任何非 null 就不重试」。
  曾经多加过一行显式的实锤分支，突变验证证明那是**死代码**（删掉后用例仍全绿）⇒ 已删。

**四、「转 Agent」那一步的菜单顺序按现场重排（`repair-actions.mjs`）**

- 新增 `describeUnreadable()`（唯一判据出口）＋ `reorderForUnreadable()`。
- 现场读不到（停在登录页 / 0 元素）时，把 `RELOAD_PAGE` 提到候选**第一位**：
  页面都读不到时「重新落日期」连目标元素都定位不了，必然白跑一轮（真跑里就是几十秒 + 一次真实页面操作）。
- 三条纪律：**只重排、不增删**（丢项会让「候选耗尽」这个停手条件提前成立，那是静默的）；
  现场认不出来一律原序返回（默认行为与加它之前逐字相同）；`note` 与重排**共用同一个判据**。

### 验证到什么程度

- 离线：该技能全量 **389/389**（16 个文件）；`login-merchant-core` **61/61**；
  `check-login-shops-core` **35/35**；`repair-actions` **16/16**。
- **突变验证 8/8 如期变红**，每条都点名到期望的那一条用例，且逐字节还原：
  预检判据（恒 true / 恒 false / 上限失效）、接线（改回硬编码 / 挪进 `--login` 档）、
  修复重排（取消重排 / 重排时丢项 / 0 元素不再算读不到）。
- **仅离线判据**：三处改动的真机现场（确认屏能否真点到、自动同意能否真勾上、重试能否真救回网林）
  本版**没有真机跑**，要等下一次定时跑或窗口空出后的真机演练。

**五、补登记一条跨目录依赖（`runtime/arch-boundary.test.mjs`）**

- 收口时守卫报「新增：`skills/xws-export-market-analysis/scripts/supervise-adaptive-export.mjs`」。
  查证：这不是本次改出来的，而是 **09-27 留下的一笔未提交改动**（该文件 mtime 09-27 14:53，
  最后一次提交 09-11），它给监管器接了两件事 —— 「登录态要人」时先自己试一次小旺神登录
  （`runtime/xws-login.mjs`），以及复用 `export-market-analysis.mjs` 的 `cleanupSearchTargets`。
- 这两条都是**干净的 skills → runtime**（`xws-login.mjs` 只依赖 `node:child_process` 与
  `browser-ports.mjs` 两个叶子），且登录能力只此一份、在 skills 侧重写一遍就是第二个事实
  ⇒ 按守卫要求**登记并写明理由**，而不是加白名单绕过。
- 突变验证：把这行登记删掉，守卫立刻报回「新增」（1/1 抓住，逐字节还原）。

## [1.7.7] - 2026-09-29

起因是 1.7.6 落地后暴露的一个缺口：感知层把失败落成了**事实**、分诊表把失败归成了**方向**，
但「方向」里那个「重试」还不完整 —— 出问题的那一步往往需要**先对页面做一件事**才有资格重试。
用户把这件事说得很直白：「重试这个必须要让 agent 根据失败原因去修复再重试」。
换句话说，**原样再来一遍不算重试**：对「弹窗盖住整页」这类成因，页不变则重跑必败。

本版补上那一层，**默认全关**，不改 11 步链的任何既有失败语义。

### 改了什么

**一、修复动作闭集与候选菜单（新增 `repair-actions.mjs`）**

- 只给四个**幂等、无端到端副作用**的页面动作：关遮挡层 / 归位页签 / 真重载 / 重新落日期。
  刻意不给「写飞书」「登录」「点业务按钮」这三类 —— 前两类是链自己的阶段，第三类可能有平台侧副作用。
- `REPAIR_TABLE`：成因 → 有序候选。`PAGE_OBSTRUCTED` 先关弹窗、不成再重载；
  `SHOP_BLOCKED` 先归位；`STAGE_FAILED` 先重新落日期。
- `planRepair()`：**认不出的成因给空候选**（不猜动作）；现场已是登录页时只加一句 note，不替人否决。
- `validateRepairActions()`：加载期互锁，钉住动作名与成因名都在各自闭集里、每个候选都有 why、无死动作。
- 本文件**零 import** ⇒ 不产生新的跨目录依赖边。

**二、修复动作执行器（新增 `repair-shop-stage.mjs`）**

- 一次只做一个具名动作（名字写错当场拒，不许静默变成「什么都没做」）。
- 执行前**先定位目标页**：按 host 判归属，认不出就报 `TARGET_PAGE_MISSING`，**绝不随便挑一页**。
- 执行后**回读**确认，落 `97-repair.txt` / `97-repair.json`。
- 退出码 0＝已落地 / 1＝没落地 / 3＝拿不到结论；**永不抛**。

**三、修复回环（`run-multi-shop-day.mjs` 的 `autoRepairAndRetry`，默认关）**

- 失败 → 读修复请求单 → 挑第一个候选 → 执行 → **重试失败的那一步**。
- 三条纪律：① 候选菜单为空就一步不动（闸门只有一个来源，不在调用侧另留排除名单）；
  ② 同一个动作不重复试，`applied !== true` 时**不重试阶段**（那正是要消灭的「原样再来一遍」）；
  ③ 永不抛、不改退出码。
- 救回来时把 `record.status` 翻回 ok 并清 `failedStage` —— 否则会出现「其实修好了、但照样叫人」的假红。
- 接线位置在 `buildRepairRequest` 之后、`recoverFailedShop` **之前**（回位会把页面导航走）。
- 入口侧：`--auto-repair [--auto-repair-max-rounds N]`，`scripts/run-daily-job.mjs` 透传到链，两处**默认关**。

### 为什么默认关（与 `autoLogin`/`hold` 刻意不同）

那两条打开的理由是「不打开就天天坏」（掉登录是每次重启必发生的常态）；而这一条是
**让系统自己在别人的页面上动手**，不打开只是维持原样 —— 而原样正是过去一直以来的行为。
要它就得显式说出口。

### 验证到什么程度

- 离线：该技能全量 **374/374**（16 个文件）；`runtime/daily-job-plan.test.mjs` **34/34**。
- **突变验证 4/4 如期变红**（拿掉默认关闭 / 重试改成跑第一步 / 没落地也重试 / 阶段表建两次），
  每条都点名到期望的那一条用例，且逐字节还原。脚本与结论：`evidence/repair-loop-2026-09-29/`。
- **真机演练未做**：这条路径会真的动页面，演练要在「未登记端口＋临时 profile」的一次性实例上做，
  当时有别的会话在跑采集。留待窗口空出后补，届时留下真跑证据。

## [1.7.6] - 2026-09-28

起因是用户复盘出这条链的**真实长期成本**：日报每天要跑，而「每天要跑通都得我多轮对话」——
维护本身在持续消耗注意力。第一性原理拆解后把成本定位在一处：**失败只留符号、不留事实**。
崩溃报的是 `action-row-hidden`（一个符号），人要弄清「当时页面到底长什么样」只能靠对话一轮轮问回去。
自进化需要三条硬前提 —— 可感知 / 可判定 / 可收敛；本仓当时只有「可判定」（第 11 步独立回读），另两条全缺。
本版补上前两条，**不改 11 步链的任何失败语义**（退出码、`failedStage`、既有告警触发条件一律不动）。

### 改了什么

**一、失败现场感知层（补「可感知」）**

- 新增 `skills/sycm-alimama-daily-report/scripts/failure-perception.mjs`：**零 import、依赖全部注入**，
  因此不产生 skills→runtime 依赖边、无需登记。导出 `FAILURE_STATE_EXPRESSION`（在页面里取现场的 IIFE，
  每一项都套 `safe()` 包装，取不到的那项退化为 `null` 而不中断整体）、`captureFailureState`（**永不抛**）、
  `renderFailureStateText`（人读版）。
- 取的事实：页面 title/url、**viewport**（冷启动小窗的直接判据）、可见文本、
  **遮挡层**（`wrapper_dlg_*` 一族，带 z-index 与 rect）、**可见按钮/链接及其矩形**（「入口在哪」的答案）、
  DOM 摘要（标签计数＋主容器）、表格尺寸。
- 产物三个：`98-failure-state.json`（给机器/下次执行用）、`98-failure-state.txt`（给人 30 秒看懂）、
  `98-failure-page.png`（截图；截图本身失败只降级，不影响前两个）。
- 接线 `run-multi-shop-day.mjs` 的失败 catch 块，**放在 `recoverFailedShop` 之前** ——
  顺序是关键，回位会导航走页面、现场就没了。失败语义一个字没改：不写 `failedStage`、不改退出码、
  不进告警，只追加 `record.perception` 与两个产物文件。

**二、错误分诊表（补「可收敛」）**

- 新增 `skills/sycm-alimama-daily-report/scripts/remediation-table.mjs`（同样零 import、纯数据＋纯函数）：
  - 动作闭集 `REMEDIATION_ACTIONS = ['RETRY_STAGE','RETRY_WITH_SETTLE','HUMAN']`；
  - `REMEDIATION_TABLE`：键＝`FAILURE_CAUSES`（7 个成因），每项含 `action`/`notifyLevel`(`silent`|`human`)/`why`/`verify`。
    **`DUPLICATE_TARGET` 是唯一 `notifyLevel='silent'`**（同日重复行＝被去重闸门正确拦下，不是故障）；
    其余全是 `human`；`STAGE_FAILED` 作兜底安全基座；
  - `lookupRemediation(cause)` **永不抛**，未登记的成因 **fail-closed 落 `HUMAN`**（⇒ 新问题一定到人）；
  - `triageFailures(failed)` → `{silent, needsHuman, total, silentCount, needsHumanCount}`；
  - `validateRemediationTable(table)` 校验动作名/`notifyLevel`/缺 `why`·`verify`。
- **互锁**：表键被 `remediation-table.test.mjs` 第 1 条钉在从 `run-multi-shop-day.mjs` 导入的 `FAILURE_CAUSES` 上
  （断言逐字相等），防枚举漂移。
- 接线 `run-multi-shop-day.mjs` 告警决策路径：失败时先 `triageFailures(...)`，新增闸门
  `if (triage && triage.needsHumanCount === 0)` ⇒ **整轮失败全落在 `silent` 里时不发告警**（只打印一行分诊）。

**三、修掉一个「证据不全被当成失败」的判据**

- 新增 `SCREENSHOT_INCOMPLETE_EXIT_CODE = 4`（`readback-daily-report.mjs`）：CDP 截图缺失不再退 1
  （＝真故障），而与「数据已验证、仅证据不完整」区分；`run-multi-shop-day.mjs` 收到 4 时记
  `evidenceIncomplete` 并**继续按成功收尾**。起因是 09-27 那轮盖文淘宝在 `readback` 退 1，
  而独立复跑同命令 exit 0、数据面完全无误 —— 失败纯粹来自证据收集的稳定性。

**四、店铺浏览器窗口尺寸（缓解冷启动布局不稳）**

- `runtime/browser-ports.mjs` 新增 `SHOP_BROWSER_WINDOW_SIZE='--window-size=1528,732'` 并塞进
  `SHOP_BROWSER_EXTRA_ARGS`：**只影响 5 个店铺 profile**，两条链浏览器的 argv 逐字节不变。
  起因是 09-27 首次七实例全冷启动那轮，五店实测视口极不稳定（1178x460 / 950x442 / 1528x732 混杂，
  而 `buildBrowserLaunchArgs` 从不传 `--window-size`）。**注意：这不是那一轮的完整解释**
  （盖文天猫视口正常却仍失败）——站得住的判据是「冷启动后页面布局在点击那一刻仍在动」。

**五、取件入口要求二次一致采样**

- `collect-promotion-report.mjs` 的取件入口从「单次采样」改成 `locateEntry/locateEntryRetry`，
  要求**两次一致采样**（`ENTRY_RESTABILIZE_MS=400`、`ENTRY_LOCATE_ATTEMPTS=4`），全败才抛且带两次采样文本。
  起因是 `promotion-fetch` 报操作行 `display:none` —— 该路径原本只采样一次、没有二次稳定判据。

### 验证

- `failure-perception.test.mjs` **9/9**（三分支：全成功／部分失败／全失败 ＋ 永不抛 ＋ 不静默空 ＋
  `about:blank` 跳过 ＋ 写盘失败）；`remediation-table.test.mjs` **12/12**；
  `run-multi-shop-day.test.mjs` **62/62**（新增 1 条接线守卫 ＋ 2 条行为用例）；
  该技能全套 **321/321**；`node --check` 全通过。
- **两处突变验证都真咬**：删掉表里的 `DUPLICATE_TARGET` ⇒ 报「表里缺：DUPLICATE_TARGET」；
  把闸门条件 `triage.needsHumanCount === 0` 改成 `false` ⇒ 用例 60 红，还原后 62/62。
- **假 DOM 实测**：表达式在模拟页面里正确取出 viewport 1178x460、遮挡层 z=99999、按钮 rect 796,0,45x26。
- **真机判据（09-28 16:04 那次重跑，仍属 1.7.5 代码）**：三处修复（窗口尺寸 ＋ 二次采样 ＋ 截图退 4）
  已在真跑里被考到并生效 —— 09-27 失败的三个形态（里可林＋盖文天猫 `action-row-hidden`、
  科塔视口外按钮）本轮全部通过，五店 0/5 → 3/5。
- **本版新增的两层（感知层＋分诊表）只跑到离线判据**：未真机跑（五店浏览器当时已全部释放，
  未经许可不起停任何进程）。⇒ 它们下一次定时跑的失败现场产物，是第一次真机被考。



起因是 **商品数据统一入口（`scripts/run-product-data-job.mjs`）首次真机执行连跑四轮、飞书零写入**。
第一轮是入口自己的接线错（`--downloads` 指到证据目录，而五店浏览器真实下载目录是
`%USERPROFILE%\Downloads`，导出的文件名又不含店铺标识 ⇒ 五家全部报「下载超时」）；
第 2~4 轮**采集全绿、导入全灭**，报 `XLS parser failed` / `ZIP parse failed` ——
那句话里没有任何 traceback，因为它根本不是解析器报出来的。

三条**实测**事实决定了这一版怎么做（都不是推断）：

1. 本机宿主沙箱对「给了子进程 stdin 管道的同步 spawn」直接回 `EBUSY`（`errno=-4082`），此时
   `status=null`、`stdout=null`、`stderr=''`（`evidence/import-ebusy-fix-2026-09-27/probe-spawn-stdio.mjs`）。
   同一个病根在这条链上有**三种完全不同的症状**，所以修的时候必须顺着调用链 grep 到底 ——
   只修看得见的那一处，会把「假绿」变成「假红」。
2. 询单导出的真实列名是 `最终付款人数/最终付款金额/最终付款件数`（**无「延」**），而契约写的是「延最终付款人数」。
   **不是平台改版**：仓库里 `evidence/product-inquiry-2026-09-23/gaiwen-*.xls`（契约就是照它写的）
   同样无「延」；「延」来自当初走 xlrd 读到乱码、命中「第 6 个使用行 + 12 列形状」兜底留下的痕迹。
3. 释放步骤的所谓「端口二次回读」原本是一句**恒真断言**：`stdout` 为 null 时 `Number('')||0` 恒等于 0。

### 改了什么

**一、同步 spawn 的 `stdio`（三处症状、一个病根）**

- `skills/sycm-{product,inquiry,promotion}-data/scripts/import-*.mjs`：**四轮零写入的直接原因**。
  补 `stdio: ['ignore','pipe','pipe']`，并把真因（非空 `stderr` 或 `error.message`）写进报错 ——
  上一版的 `stderr || 'XLS parser failed'` 在 EBUSY 下只剩后半句，看起来像解析器坏了。
- `scripts/release-product-data-browsers.mjs`：补 `stdio`；读不出来时返回 `null`（＝**没有证据**），
  只有真的读到 0 才算 `released`。取证：改前 `{status:null, errno:'EBUSY'}`，改后同一条命令返回 `2`。
- `scripts/stop-all.mjs`：监听表与 `taskkill` 两处补齐；读不到监听表时**不再断言「没有在跑」**，
  报告中多一个 `listenTableError`，`--yes` 下以非 0 收场（这条假绿在 `docs/ops/LOGIN-HOLD-AND-AUTO-RESUME-PLAN.md` 记过）。
- `runtime/browser-inventory.mjs`：`readProcessTable` 与监听表两处补齐。**不留这处，前三处会把假绿变假红**：
  读不到进程表 ⇒ 拿不到代理的命令行 ⇒ 代理一律被判「认不出启动脚本」而拒停。

**二、询单表头契约（`inquiry-core.mjs`）**

- 引入 `HEADER_ALIASES`：三个无「延」写法视为**同一列**，写回的目标字段与列序不变（仍由 `INQUIRY_HEADERS`/`TARGET` 决定）。
- 失败时把**实际表头**写进报错，不再只报「缺少 12 列标准表头」—— 上一轮就是卡在这句话上，
  只能靠人重新解一遍文件才知道「是列名变了还是采错了表」。
- 补 3 条回归用例（真实文件形状 / 乱码兜底 / 报错带实际表头）。旧用例把 `INQUIRY_HEADERS` 自己当夹具，
  等于把「契约与真实文件是否一致」整个跳过了。

**三、守卫**

- 新增 `runtime/product-data-path-sync-spawn-guard.test.mjs`：钉住这条链 13 个文件的
  「同步 spawn 必须显式写 `stdio`，且 stdin 不许是管道」。范围**故意不是全仓** ——
  全仓版会因为别的会话正在改的文件立刻变红，那不是发现缺陷，只是噪音。

### 验证到什么程度

- **真机**：`node scripts/run-product-data-job.mjs --date yesterday --commit --notify` → **退出码 0**，
  runId `2026-09-26-20260927145927861-03ec0bd9`（11m53s）。底单 24/14/52/43/32、询单 0/4/7/9/3、
  推广 92 源行→92 计划行；商品表 4581→4746、询单表 1005→1028、推广表 2472→2564。
- **幂等**：用刚写完的同一批产物重算（dry-run，不写飞书）⇒ 五家三段 `plannedRows` 全 0。
- **释放**：脚本外独立两次 `Get-NetTCPConnection -LocalPort <端口> -State Listen` 回读，
  19031~19035 与 19041~19045 全 free；`release.json` 逐条带证据真停（代理命令行匹配店名、
  浏览器 CDP 自证 profile 一致），停后盘点 `missing`。
- **守卫突变验证**：4 种改法（去掉 `stdio` ×3、`stdio:'pipe'` ×1）全红且**点名到期望的那一处**，
  还原 sha256 一致、还原后回绿 → `evidence/import-ebusy-fix-2026-09-27/mutation-verify-guard.mjs`。
- 证据目录：`evidence/import-ebusy-fix-2026-09-27/`（含 `VERDICT.md`）与
  `evidence/product-data-job-2026-09-26/2026-09-26-20260927145927861-03ec0bd9/`。

### 本版没有做

- **全仓版的「禁止裸同步 spawn」守卫（L3）仍未做**：1.7.1 就记着这条待办，本版只钉了商品数据这条链；
  仓库其它链上仍有未写 `stdio` 的调用点（若干 test 与工具脚本），未逐处判读。
- **里可林淘宝 2026-09-26 询单为 0 行**：平台导出文件里只有表头 ＋ 平均值/汇总值，没有商品行
  （09-25 同店为 5 行）。按事实记录，不当失败处理。
- 入口其余接线修复（下载目录改回真实目录、`capture:true`、阶段状态、告警投递）与那一轮的采集侧轮询修复
  同属本批次，一并落地；单独看它们都只是「少传一个参数」，合起来才是「这条链能跑通」。

## [1.7.4] - 2026-09-26

起因是 **2026-09-25 那一轮五家店里有一家写了 0 行，而人赶到时窗口已经没了**
（`evidence/hold-and-resume-2026-09-26/foreground-*.txt`，原件在 `evidence/multi-shop-2026-09-25/`）：
科塔淘宝停在第 3 步 `promotion-submit`，`关后回读：全屏层剩 2 个（["DIV#mask_dlg_624 z=99998",
"DIV#wrapper_dlg_624 z=99999"]）｜目标可点=false ⇒ 没关掉`。同一步上**网林**的层却是
`剩 0 个｜目标可点=true ⇒ 已关掉` —— 两层身份相同（`DIV#wrapper_dlg_*` ＋ `data-owner-id=app` ＋
`z=99999`）⇒ **不是「这一层关不掉」，而是这一份渲染里我们选中的那个控件不管用**：
科塔那次选中的是一个**没有文字标签的 `IMG`**，位置 x=1003（视口宽 1442 ⇒ 并不在真正的右上角），
旧代码的「右上角图标」兜底档把它当成了关闭键。而系统当时对这种情况只有一种处置：
**按失败收尾、把整棵进程树连同窗口一起回收** —— 人要看的那一页，被我们自己收走了。

三条**实测**事实决定了这一版怎么做（都不是推断）：

1. 宿主在驱动命令结束时回收**整棵进程树** ⇒ `start-all.mjs` 起的窗口在命令结束 **0.26 秒**后
   连启动器一起消失（`evidence/batches-2026-09-22/batches.log`；判据是启动器日志里没有
   `msedge exited` 行，而代理还活着 ⇒ 现场看起来像「停了一半」）。⇒ **「不释放」不等于「窗口还在」**。
   要让窗口活到人来，唯一可靠的形态是**这一轮不结束**：驻留不是一个开关，而是「进程活着」这件事本身。
2. 人处理完（关掉弹窗／重新登录）之后**不会回复我们**（2026-09-25 23:40 用户原话：
   「等业务人员登录了，系统会自动续跑」）⇒ 必须由系统自己反复问一个**只读**判据。
3. 续跑必须**只补那几家**：同一天＋同店铺有查重键，已 push 过的店再跑会撞「早跑的低值无法同日重推」，
   把一次成功续跑变成一个新的告警。

### 改了什么

**一、关遮挡层：从「一次候选」升级成完整一档（`collect-core.mjs`）**

- **先发一个真实 Escape**（CDP `rawKeyDown → keyUp`，走代理既有的 `/key` 白名单路由）。不用
  `dispatchEvent(new KeyboardEvent(…))`：这一族页面**只认真实输入事件**（09-17 那条
  「`el.click()` 无效、真实鼠标点才落盘」的对照同样适用于按键）。选它是因为它
  **不用点页面上的任何东西**，没有「点错」的风险。不注入 `pressEscape` 时**跳过并在日志里说清**，
  不假装试过。
- **关不掉才走有序候选表** `pickOverlayCloseCandidates`：明确关闭语义 → 消失类确认词
  （新增 `OVERLAY_ACK_PATTERN`：我知道了／不再提示／稍后／跳过／以后再说…）→ 层右上角图标。
  每个候选都要过**危险词黑名单**，且**封顶 `OVERLAY_MAX_PICKS = 3`** —— 点三次已足够证明「点不动」，
  再多就是乱点。旧实现只有「名义关闭 → 右上角图标」两档、**只点一次**，科塔那次就是一次点错即终局。
- **判据从「层归零」放宽成「层归零 *或* 目标可点」**（`judgeOverlayAfter`）：旧实现是
  `dismissed = after.remainingLayers.length === 0`，把「层还在、但已经不挡目标」这个**正确结果**
  也判成了失败。
- 未关掉这一支的正文**必须带机器标记** `OVERLAY_NOT_DISMISSED`：链靠这个标记认这一族失败，
  **不靠中文措辞**（措辞一改，判据就静默失效）。

**二、关不掉就「换一个现场再来一次」（`collect-promotion-report.mjs`）**

第 1 遍复核不中 ⇒ 关（ESC → 有序候选）；**连关都关不掉** ⇒ **真重载一次页面**
（`createPageReloader`，`window.location.reload()` —— **不能用 navigate**：同 URL 是同文档导航，
浏览器什么都不做，这一条 09-21 在落位那一步已经付过一次学费），拿到一份新渲染把同一条路再走一遍。
**为什么敢在这一页重载**：走到这一步这个阶段**本来就已经要失败了**，而产物是这一步成功之后才落盘的
⇒ 重载不会弄丢任何已取到的东西，成本只有几秒。
`collect-shop-report.mjs` 只接了 ESC ＋ 有序候选，**不接重载** —— 那一侧没有现场证据，
**没有证据就不加带副作用的动作**。

**三、失败分类多一类，「需要人」第一次有了可枚举的判据（`run-multi-shop-day.mjs`）**

- 新增 `PAGE_OBSTRUCTED`，判据是上面那个**机器标记**，不是措辞猜测。
- 新增 `HUMAN_REQUIRED_CAUSES = ['NEEDS_LOGIN', 'PAGE_OBSTRUCTED']`，必须**真包含于**
  `FAILURE_CAUSES`，由**加载期互锁**钉住（有一个值不在闭集里就抛错）—— 不让「一个分类值活在四处、
  漏一处就静默落进 `BUG`/`STOP_AND_ALERT`」那类事故重演。
- 新增 `--will-resume`，**且只有真的会驻留时才写进告警**。开着它时正文从「登录好之后告诉技术同学
  重跑一次」改成「**关掉之后不用回复、也不用重跑**：这一轮的窗口留在原地，系统会自己接着把这家店
  剩下的步骤跑完」。留窗口是承诺，**承诺错了比不说更贵**，所以这个开关跟着「会不会驻留」走。
- **修掉一个真缺陷**：`dispatchRoundAlert` **缺 `action === 'off'` 分支** —— 传 `off` 的调用会一路
  落到「去重 ＋ 投递」，也就是**真发一条飞书**。它至今没炸，只因两个调用点各自拦了一道；
  而本版新增的第三个调用点（驻留那一步）差一点就是那条漏网的路径。现在出口自己判 `off`。

**四、「驻留 → 只读判据转正 → 只补失败店自动续跑」（`runtime/hold-and-resume-plan.mjs` ＋
`scripts/hold-and-resume.mjs`，均为新增）**

分工沿用本仓已有的形状（`daily-job-plan.mjs`/`run-daily-job.mjs`、`batch-plan.mjs`/`run-batches.mjs`）：
**计划是纯的，执行是薄的** —— 判据、命令行、文案全在纯函数层（可被离线用例与突变验证覆盖），
执行层只负责起进程与循环。纯函数层**只依赖 node 内建**，业务词表由调用方传进来。

- **判据不另写一份**：关遮挡那条探针用的就是采集脚本**同一个** `overlayScanExpression`；
  登录那条用 `login-merchant-core.mjs` 新加的 `isLoginWallUrl`（＝既有 `isTaobaoLoginUrl` ＋
  新增的 `isSycmLoginWallUrl`，按 `host` ＋ `pathname` **结构**判，不按子串 ——
  登录跳转页把目标地址放在 `_target=` 里，整串 `includes` 会误命中）。同一个问题两处各写一份判据，
  迟早漏掉新出现的那种登录页，而**漏掉的症状是「一直等到超时」**。
- **轮询间隔按判据的成本分**，不按「统一一个好记的数」：广告那条是只读 DOM 查询 ⇒ **30 秒**；
  登录那条要连淘宝后台读页面、且频繁探测本身可能触发风控 ⇒ **120 秒**。默认截止 **当天 12:00**。
  驻留期间**每 15 分钟往日志写一行状态**（不许静默）。
- **「读不到」不当作「好了」**（`judgeProbes`）：探针返回 `unknown` 与「还在等」同等对待，
  一个探针都没有（`total === 0`）也**不算 ready**。「读不到被读成好了」是本仓最贵的一类错误 ——
  它会拿着一个还堵着的现场去写飞书。
- **续跑起点＝「失败那一步」与「人碰过页面」两者取更早的**：`PAGE_OBSTRUCTED` 与 `NEEDS_LOGIN`
  都意味着页面状态已不可信（人关过弹窗／脚本自己重载过那一页／人重新登过），页面上的
  **日期筛选**已经不在原处，所以起点一律下探到 `alimama-date`（`resumeFloorFor`），且
  **只许往前、不许往后**（`Math.min`）。漏了它，续跑会拿着一个没有日期的报表页往下做，
  出来的数**看着像数据、实际是别的时段**。
- **`health-check` 永远带上**：人刚动过浏览器，页签与端口必须重新体检过才敢往下写。
  一个阶段名都认不出来时返回 `null`（＝不点名，整链跑）—— 猜「从哪一步开始」的代价是**漏跑一段**，
  而漏跑一段的续跑**看起来与成功一模一样**。
- **只补失败那几家**（`--shops`），不整轮重跑。`--login-preflight` 与 `--will-resume` **刻意不传**：
  前者那份结论是这一轮开跑前写的、人刚动过页面之后已经过期，拿它当解释会把「这次为什么失败」
  说成上一次的原因；后者会让收信人以为还会继续自动重试，而续跑**只做一次**。
- **退出码口径只有一处来源**（`HOLD_EXIT`，入口也读同一份）：0＝不需要驻留｜1＝续跑没成功｜
  2＝判不了｜3＝等到截止时间｜4＝续跑成功。这一步 `blocking: false`，**不覆盖**链的退出码 ——
  覆盖会造出两种假结论：「不需驻留（0）」把链的失败洗成绿、「等到 12:00（3）」把一个本来写成功的
  轮次染红。**只有 4 允许把整轮翻回 0**，因为它对应一件真发生过的事（那几家真的补上了）；
  另外三种情况各有一行日志说清「窗口放了 / 还要人看」。
- **到点没等到人必须发通知**（`closeOutNotice`）：驻留结束时窗口会按约定放掉，那之后人再也接不上手，
  静默释放等于「人以为还有现场，其实没了」。
- **修掉一个写用例时才发现的真缺陷**：`resumeResultNotice` 的成功与失败原本**共用同一个 `alertId`**，
  而告警出口按 `alertId` 查那 6 小时去重窗口 ⇒ 同一天里先成功过一次，之后的**失败**会被自己那条
  成功记录挡掉 —— **一条真正需要人看的消息一个字都发不出去**，日志里只留一句「这一条没往外发」。
  现在成功/失败各一个编号，失败那条叫「自动续跑没成功」，并明说**不会再自动重试第二次**。

**五、接线（`runtime/daily-job-plan.mjs` / `scripts/run-daily-job.mjs`）：定时链由四步变五步**

驻留那一步排在**链之后**、带 `onlyWhenChainFailed`（判据抽成纯函数 `shouldRunStep`：
它的两条分支在入口里是**走不到**的 —— 要真起进程；判据必须活在能被离线断言的地方）。
⇒ **链成功的那一天，它对行为的影响是零**（这一步根本不执行）。`--no-hold` 是一键退回的开关。
`--will-resume` **只在真的会驻留时**才加给链（没解析出 `resolvedDate` 就不加）。
**分批形态刻意不驻留**，并在返回值里留 `batchWithoutHold` 由 `--print` 说出来：
`--batches` 的存在理由就是「跑完一批就放掉」，与「把窗口按住几小时」在同一条命令里直接冲突，
这一档**未设计** —— 宁可把缺口写进日志，也不要静默少一步。

### 验证到什么程度

- **受影响用例 168/168 通过、0 失败、退出码 0**（7 个文件：`hold-and-resume-plan`、
  `daily-job-plan`、`test-suite-discovery`、`version-consistency`、`arch-boundary`、
  `run-multi-shop-day`、`collect-core`）。原始输出
  `evidence/hold-and-resume-2026-09-26/affected-tests.txt`。
- **突变验证 9/9 抓住，全部逐字节还原（sha256 自证）**。脚本与输出都在
  `evidence/hold-and-resume-2026-09-26/`（`mutation-verify.mjs` ＋ `mutation-output.txt`）。
  每条突变都**点名到了期望的那条用例**，而不是只报「有失败」—— 一条把整份文件带崩的语法错误
  也会让用例全红，那不算抓住。被它抓住的九件事：判据「空集不算好了」被拿掉、起点下探方向写反、
  续跑成功/失败共用告警编号、驻留那一步不再「只在链失败时」执行、`--will-resume` 不跟着驻留走、
  整步被拿掉、`shouldRunStep` 写反、告警出口缺 `off` 分支、`PAGE_OBSTRUCTED` 分类分支被删。
- **接线真的接上了**（不是「函数全绿、没人调」）：`--print` 真跑一遍入口，断言那一步与
  `--will-resume` 出现在**将要执行的命令行**里；四条接线判据各有用例钉住。
- **两个套件的读数（修完下面那两处旧账之后重跑的）**：`runtime` 整包 **957/957**、
  受影响技能整包 **297/297**，退出码都是 0。原始输出
  `evidence/hold-and-resume-2026-09-26/suite-runtime.txt` 与 `suite-skill-daily-report.txt`；
  修之前分别是 957/955/2 与 297/296/1（那 3 条红都不是本版引入的，见下一节）。
- **本版最大的缺口，说清楚**：整条「驻留 → 人处理 → 自动续跑」**没有在真机上跑过一轮**。
  离线判据能证明「判据本身不坏」与「它真的被接线接上了」，**证明不了**「40 分钟后人来把弹窗关掉，
  它真的会认出来并只补那几家」。第一次真跑的入口是 **08:14 那次定时**，条件是那天恰有一家店停在
  这两类失败上 ⇒ 它**可能连续几天不被考到**。真跑的证据会落进 `evidence/daily-job-<目标日>/job.log`，
  判据是里面出现 `[驻留]` 开头的行。

### 同一版内补的两处旧账（09:4x 补做，都在本版的提交里）

这两处**都不是 1.7.4 引入的**，是本次跑提交前门禁时顺出来、当天一并还掉的旧账。
版本号不另开 —— 按本文件的版本口径，「小到一次改注释的提交不单独开版本号」。

- **EBUSY 的第四处漏修**：`runtime/generate-competitor-field-reference-docx.test.mjs` 的
  `spawnSync(process.execPath, …)` **没写 `stdio`** ⇒ 宿主沙箱下 `status=null`，两条用例报
  `renderer exited null: undefined` / `null !== 0` —— 看起来像**渲染器坏了**，实际是**这道门自己
  没跑起来**。与 1.7.1/1.7.2 修掉的那三处同一病根，当时都没扫到这个文件。补上
  `stdio: ['ignore','pipe','pipe']` 之后两条**真的通过** ⇒ 渲染器本身没坏。
  **这一条要记**：那个限制**穿透到孙进程**，只要还按「修一处算一处」的修法，就还会漏掉第五处。
- **审计表守卫的扫描范围**：`daily-report-audit.test.mjs` 的「全仓库只有写入方与迁移提到这张表」
  被取证文件 `evidence/daily-report-2026-09-24-independent-verify/probe-audit-table.mjs`
  （09-25 就在那里，按它的设计要直接读这张表）打红。**改的是范围，不是白名单**：
  `evidence/` 整个目录不再参与扫描，依据是 `AGENTS.md` 对它的定性
  ——「do not treat it as live input」。档案里的探针没有任何链会 import 或执行，
  构不成「第二个能对『这天推过没有』下断言的地方」；而加进白名单反而更糟：白名单有**双向校验**
  （每一项都必须真的还在说这张表），删掉一个旧探针就会让守卫因为与这条不变量无关的理由变红。
  **代价写进了代码注释**：真有人把生产读者藏到 `evidence/` 下，这条守卫**看不见** ——
  接受它的前提是 `AGENTS.md` 那条定性成立，若 `evidence/` 下的东西哪天被接进执行路径，这条排除要一起撤掉。
  **并且验证了它不是被改成装饰**：突变 2/2 —— 把表名塞进 `scripts/run-daily-job.mjs` 与
  `runtime/browser-ports.mjs`（都在非白名单、非 `evidence/`），守卫**都红、且点名到那个文件**，
  还原 sha256 逐字节一致。

### 本版没有做

- **分批形态（`--batches`）不驻留**（理由见上，刻意留名）。
- **没有改 `runtime/batch-plan.mjs` 的 `releaseAfterBatch`**：设计工单
  `docs/ops/LOGIN-HOLD-AND-AUTO-RESUME-PLAN.md` 里原本那一条没做，改成挂在入口的第五步上更小、
  也避开了「分批释放判决要重新设计」。该文档开头已补「落地状态」并写明与原文的三处差异。
- **不自己登、不自己关**：脚本能做的「关」已经在采集脚本里试完了（ESC ＋ 有序候选 ＋ 一次重载），
  再关不掉就是**人的动作**；协议/确认那一步也由人点。
- **不承诺「无人值守」**：驻留要求窗口在一个**有交互桌面**的会话里。宿主若跑在无桌面的会话，
  窗口对人不可见 ⇒ 这条需求在那个部署形态下**做不到**，不靠「应该能看见」糊过去。
  这一条仍待验证（与 1.7.3 押后的商家浏览器自动登录同一档）。

## [1.7.3] - 2026-09-25

> **落地方式**：本条目与 1.7.4 在**同一次提交**里落地。原因是这一版改的
> `runtime/daily-job-plan.mjs`、`scripts/run-daily-job.mjs`、`run-multi-shop-day.mjs`
> 与它们的用例文件，随后又被 1.7.4 在同一份工作区里继续改（两个批次在 hunk 级交织），
> 拆成两次提交需要人工重构中间状态，风险大于收益。用户对此的授权原话是
> 「与昨天那份登录驻留合并成一次落地」。**本版已按 1.7.3 的版本号真机跑过一轮**：
> 2026-09-26 08:14 定时轮（目标日 09-25），日志第一行 `版本：sycm-automation 1.7.3`，
> 四家写成、一家停在 `promotion-submit`（正是 1.7.4 要解决的那个现场）。


起因是**「五家店一家都跑不起来」的真因查清了**：日报链的**整轮级体检**跑在共享商家浏览器
（`dailyReport`，19022/19023）上，而驱动的处置是「商家浏览器体检未通过 ⇒ **整轮不跑**」。
这台实例**此前没有任何一步会给它补登录** —— `check-login-shops.mjs` 刻意只覆盖「一店一实例」
那五个（它文件头写着「刻意不查商家浏览器」），逐店的 `--login` 打不到共用实例上。
⇒ 它一掉登录，整轮零产出，而告警还把成因说成「页面不齐，去把这两页各开一个」，
收信人照着做无效（真因是会话没了）。

实测凭据（本轮修复的依据，不是推断）：`evidence/daily-job-2026-09-24/job.log` 08:16 那一轮 ——
`[一轮] 归位后仍不齐（生意参谋工作页=0  飞书底单页=1）` → `[归位] 生意参谋工作页：reclaim`
（导航回期望 URL 了，页面又被弹回登录页 ⇒ 仍 0） → `[一轮] 体检未通过：阻断 1 项`
→ `[驱动] 商家浏览器体检未通过 ⇒ 整轮不跑`。同一天另外四轮则是第二种放大型形态：
单店停在第 1/6 步就把 `break` 掉整个循环，其余四家一步都没跑。

### 改了什么

- **`runtime/daily-job-plan.mjs` + `scripts/run-daily-job.mjs`：定时链由三步变四步，
  新增 `ensure-merchant-login`（共享商家浏览器登录守卫）。**
  纯函数 `buildMerchantLoginGuardArgs({ login, notify })` 决定参数，三个取舍都写在那里：
  · `--target sycm`：那台实例的期望页面是「生意参谋工作页 + 飞书底单页」，
    **阿里妈妈页不该在这里**（多店铺下它落在各店自己的实例上）——带 `both` 的实测后果是
    「登录明明成功了，复检却因为『阿里妈妈页 0 个』判成 `PARTIAL`」，一条看起来像故障、
    其实是判据与现场不匹配的结论（缺陷④）；只盯 sycm 之后这条路不存在。
  · `--commit` / `--check-only` 由调用方显式选：默认 `off`（一个页面都不碰），
    `autoLogin` 打开时才升级成会提交表单的 `--commit`。整轮**最多一次**登录提交。
  · `--notify` **跟着整轮走**：`login-merchant.mjs` 自己的默认值是 `auto`（会投递），
    不显式压成 `off` 的话，「不给 `--notify`」这个默认档会悄悄发一条飞书 ——
    直接违反本文件头第 ③ 条不变量，而且链那侧的用例看不出来。
  排在「逐店预检」之后、「链」之前：排在链之前是硬要求（链的整轮级体检第一名就是它），
  排在逐店预检之后是为了拉开登录提交的间隔（这台实例与「盖文天猫」同账号同出口 IP）。
  它 `blocking: false`：没登成时链自己那一次体检会如实报「整轮不跑」并告警。
- **`skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`：默认值翻成
  「一家失败不带走其余」，新增显式反向开关 `--stop-on-first-failure`。**
  旧默认（首家失败即停整轮）的实测代价：当天四轮全都只写进 0~1 家，而其余四家本来都是能成的。
  各家店的采集/推送是独立的（各自的实例、账号、自己那几行飞书 + 写后回读核对），
  一家失败不会让别家的数据变得不干净；而继续跑也**不会让失败变安静**——
  轮末照旧 `anyFailed` ⇒ 退出码 1 ＋ 一条点名到店的告警。`--keep-going` 仍然接受
  （它是新默认值的显式声明），保留是为了不改既有调用方的命令行。
- **`runtime/daily-job-plan.test.mjs` / `run-multi-shop-day.test.mjs`：判据跟着改。**
  新增两组：共享实例守卫的「只盯 sycm / 默认只读 / 告警默认不投递 / 整轮只出现一次」，
  以及 `--print` 真跑一遍入口、钉住 `login-merchant.mjs --commit --target sycm --notify off`
  真的出现在将要执行的命令行里（防「函数全绿、没人调」）；默认方向的判据
  （`stopOnFirstFailure` 默认 false）与「旧的 `if (!args.keepGoing)` 写法不许回来」的反向断言。

### 验证到什么程度

- **仅离线判据**：`node --test runtime/daily-job-plan.test.mjs`、
  `node --test skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs`
  与 `node scripts/run-daily-job.mjs --print`（后者不起任何进程、不碰浏览器、不写飞书）。
- **真机未验**：`ensure-merchant-login` 在「商家浏览器真的掉登录」现场的那一次真跑
  这一版还没跑过（上一版 1.7.2 之后这台实例一直在线）。第一次真跑的证据会落进
  `evidence/daily-job-<日>/job.log`，届时补记。

## [1.7.2] - 2026-09-25

起因是**提交前门禁在一个后台会话里跑了 8 小时 2 分，没人知道它还在跑**。
2026-09-25 10:28 为了给 1.7.1 做提交前检查跑了 `npm run test:staged`；它按「受影响的测试」选面，
把 `skills/xws-export-market-analysis/` 的**整套**测试拉了起来 —— 实测 **664 条用例、合计 7.64 小时**，
其中 `prepare-flow.test.mjs` 的 7 条 `full flow …` 用例**每条各等满 CLI 自己的 60 分钟下载 deadline**
（`61.9 / 61.4 / 60.6 / 60.6 / 60.6 / 60.4 / 60.4` 分，错误全是 `Timed out waiting for .csv download`），
这 7 条吃掉总时长的 **92%**。门禁本身没有给出整体结论，而它也不该以「拖着跑半天」的形式存在。

### 改了什么

- **`scripts/run-affected-tests.mjs`：给每条命令加墙上时钟预算。**
  默认 **1800 秒/条**，`--budget-seconds=N` 可改，`0`＝不限。超预算时**连根终止整棵进程树**
  并退出 **3 = INCOMPLETE** —— 口径沿用本仓已立过的那一条：**没有结论既不是通过、也不是失败**，
  所以不伪装成 0（假绿）也不伪装成 1（假红）。为此把 `spawnSync` 换成异步 `spawn`
  （`spawnSync` 只能杀直接子进程，留下过孤儿；Windows 用 `taskkill /F /T` 连根拔）。
  超预算时会打出被砍的那条命令、它的含义、以及「单独跑完它 / 放宽预算」两条出路。
- **`scripts/delivery-status.mjs`：补上 `stdio: ['ignore','pipe','pipe']`。**
  与 1.7.1 同一病根（宿主沙箱对「同步 spawn ＋ 管道 stdin」回 `EBUSY`），1.7.1 修了链上与另外几个
  门禁脚本，**漏了这一处** ⇒ `npm run check:delivery`（`AGENTS.md` 强制要报的那一步）在这类会话里
  直接抛 `spawnSync git EBUSY`，看起来像 git 坏了。同文件 `:19` 那处本来就写了 `stdio`。
- **`AGENTS.md` 新增两条跑法纪律**：①「跑完释放」不是默认行为 —— `run-daily-job.mjs` 不带 `--batches`
  时计划里根本没有 stop 步骤，只有 `--batches N` 才经 `run-batches.mjs` 释放；②不许只信
  `stop-all.mjs` 的退出码判释放（它有已知假绿），必须回读端口，且第一次读可能是旧值。
- **顺带更正一条 09-25 自己下过的错结论**：那天 18:04 被这个门禁派生出来的 CLI 子进程，
  **没有**碰真小旺神。判据：`prepare-flow.test.mjs` 里 29 处 `spawn(process.execPath)` 与
  29 处 `"--proxy"` 一一对应（配 `startFakeProxy` 本地假 CDP 代理），且 `flow.mjs:81/130`
  里 `--proxy` 覆盖默认值 ⇒ 不会回落到真 `3457`、不碰买家浏览器 `9222`、不消耗配额。
  坏的只是「选面太宽 ＋ 单条 60 分钟」，不是「门禁去动了生产」。

### 验证到什么程度（说实话）

- `npm run check:fast` = **PASS**（2 个 JS 文件）。
- `npm run test:offline` 三段全绿：`sycm-export-search-rank` / `xws-export-market-analysis`
  （含 `deadline` 一项）/ `huitun-topic-heat` 均 `ok: true`。
- `npm run check:delivery` **从「直接崩」变成能出结论**：实测 `mainline_contains_commit=true`、
  `remote_contains_commit=true`、`worktree_clean=false`、`verdict=WORKTREE_DIRTY`。
- 超预算分支**真机实测**（不是只读代码）：`--budget-seconds=3` 下踢 `test:runtime`，
  退出码 **3**、提示完整；**终止后另起命令查进程表，孤儿 = 0 个**。
- 参数校验实测：`--budget-seconds=abc` → 报用法错、退出码 **2**。
- **本版没做的**：没有完整重跑一次 `test:staged`（一次就是几小时，正是本版要消除的东西）。
  `prepare-flow.test.mjs` 那 7 条各 60 分钟的真实失败（`Timed out waiting for .csv download`
  ⇒ `1 !== 0`）**仍然红、本版没修** —— 本版只把它从「会拖死门禁」降级成「会被预算砍掉并如实报
  INCOMPLETE」。它与 1.7.1 已记录的那 10 条 EBUSY 假红、以及 `unit:skills` 段短路导致的
  「`test:staged` 永远给不出整体结论」，一起留在待修清单里。

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
