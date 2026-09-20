# 视口/弹窗脆性与飞书共享页污染链（2026-09-20）

这篇回答两个具体问题，并给出可落地的方案。**所有结论都标注了「核过」还是「未核」** ——
这个仓库已经吃过「把未验证的推断写成事实」的亏（见 `collect-promotion-report.mjs` 里那段注释的订正）。

---

## 一、盖文天猫那台为什么是 1032×500

### 答案：因为没有任何东西在设窗口尺寸

核对链：

1. `runtime/browser-ports.mjs` 的 `buildBrowserLaunchArgs()`（`:198-207`）拼出来的 argv 只有四项：
   `--user-data-dir` / `--remote-debugging-port` / `--no-first-run` / `--no-default-browser-check`，
   再加 `extraArgsForProfile()`（店铺 profile 只有 `--disable-sync`）和 startUrl。
   **没有 `--window-size`，也没有 `--start-maximized`。**
2. 五家店各有自己的 profile（`SHOP_BROWSERS`，`:123-160`）：
   `likelin-home` / `wanglin-flagship` / `suixin-custom` / `gaiwen-flagship` / `shop-j873522735`。
3. 于是 Edge 用**该 profile 自己记住的窗口尺寸**。profiles 里的实数（读
   `<profile>/Default/Preferences` 的 `browser.window_placement`）：

| profile | 运营叫法 | 记录的窗口 | 说明 |
| --- | --- | --- | --- |
| likelin-home | 里可林淘宝 | left 13 / top 11 / right 1072 / bottom 776 → **1059×765** | 唯一一个高的 |
| wanglin-flagship | 网林天猫 | 13/0/1072/592 → 1059×592 | maximized:true |
| suixin-custom | 盖文淘宝 | 15/0/1072/592 → 1057×592 | maximized:true |
| shop-j873522735 | 科塔淘宝 | 303/0/1360/592 → 1057×592 | |
| gaiwen-flagship | 盖文天猫 | 13/0/1068/592 → **1055×592** | maximized:true |

四个 profile 的 `work_area_*` 都写着工作区 **1536×816**（这台机器的桌面工作区）。

4. 与实测对齐：盖文天猫实测视口 **1032×500**，窗口 1055×592 ⇒ 差 **23×92**，
   正好是窗口边框 + Edge 自己的标签栏/地址栏。**自洽**。

所以「1032×500」不是被谁设的，是「没人设」的结果：窗口 1055×592 减去浏览器自身占用的 92px。
里可林那台 765 高 ⇒ 视口约 673，比盖文天猫多 170px 的余量。

### 真正的判据在哪里

`collect-promotion-report.mjs:176-177`（弹窗按钮表达式）：

```js
visible: r.width > 0 && r.height > 0 && r.y >= 0 && r.y < window.innerHeight,
hitOk: !!point && (point === el || el.contains(point) || point.contains(el)),
```

`point` 是 `document.elementFromPoint(中心点)`（`:174`）。中心点一旦落到视口外，
`elementFromPoint` 返回 `null` ⇒ `hitOk=false` ⇒ `pickConfirmButton` 永远挑不出「确定」
（`:193-195`）⇒ `waitForConfirmButton` 轮询 30 次后抛错（`:205-215`）。

而**没有任何一步负责把按钮送进视口**。

### 弹窗自身的几何（实测）

固定层 `position:fixed; z-index:100001; top:0; height:494; overflow:auto`；弹窗从 `top:107` 往下长：

| | header | dialog-body | footer | 「确定」rect | 中心点 y | 视口 500 下的结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 盖文淘宝 | 107..172 | 172..442（h=270） | 442..507 | [259,469,24,12] | 475 | 过（余量 25px） |
| 盖文天猫 | 107..172 | 172..478（h=306） | 478..543 | [257,505,24,12] | 511 | **不过（超 11px）** |

两个页面的弹窗**底栏位置正好差 36px＝body 高度差**。也就是说弹窗是从固定顶端往下长的，
内容多高、底栏就落多低，**没有任何 clamp**。

（未核的部分要说清：这 36px 里有多少来自弹窗内容高度、多少来自两台视口高度之差，我没有分开量。
线索：同一页面元素「下载报表」在盖文淘宝是 x=933、盖文天猫是 x=925，差 8px ⇒ 两台视口宽度
并不逐字相同，所以「仅视口不同」和「仅弹窗内容不同」两种解释我都不能排除。
下次开浏览器时同时量五家的 `innerWidth/innerHeight` + 弹窗三个 rect 就能定论。）

### 「页面有一点变动是不是都会失败」

分层回答，别一竿子打翻：

- **就是这一条路径：是。** 判据是「中心点在视口内」，余量是 25px / -11px 这个量级，
  而弹窗内容高度实测在 270~306 之间浮动。一行文案换行、多一个提示行、多一个表单项，
  都足以把 475 推过 500。这不是偶发，是判据本身没有余量。
- **整条链不是都这样。** 同一个仓库里另外三处都留了余量：`date-picker` 的 `settle` 有 8 次重试
  （`:430-444`）、`readback` 的 `waitForModel` 轮询 30 秒、`collect-shop-report` 的预览按钮
  轮询 8 次。真正脆的是**三个条件同时成立**的地方：必须真实鼠标点击 + 判据要求中心点在视口内
  + 没有一步负责把它送进视口。
- **最刺眼的一点：这个模式在本仓库里已经解决过一次。** `collect-shop-report.mjs:99-107` 就是为
  同一类问题写的（注释原文：「按钮可能在视口外（实测过 x=1035 而视口宽 1031），
  那样『点了』会静默落空且不报错 —— 所以点击前一律复核」），并且配了
  `scrollIntoViewExpression`（`collect-core.mjs:105-115`）。**只有阿里妈妈弹窗的「确定」这条路径漏了这一步。**

---

## 二、飞书页污染链是什么、根因是什么

### 是什么：同一张飞书页被五家店串行共用，而它的「当前 table/view」是一个会串味的全局状态

- 一轮里，只有两个阶段碰飞书页（`run-multi-shop-day.mjs` 的 `buildShopStages`）：
  `push`（第 7 步，`dailyProxy`＝19023）与 `readback`（第 11 步，同）；中间的
  `sycm-reset` / `sycm-date-again` / `backfill` 走的是**这家店自己的**浏览器（`shopProxy`）。
- **`push` 自己不导航**。`run-daily-report.mjs` 里没有任何 `/navigate` 调用；它在 `main` 第一件事就是
  `inspectTarget`（`:78-86`、调用点 `:276`），要求当前页 URL 的 `table`/`view` **恰好**等于
  `sourceTable=tblkY3W8tnPWPcnh` / `sourceView=vewwg0rhjo`，不对就抛错。
- **`readback` 才负责导航**，而「离开时把页面送回源表」写在它的**成功路径末尾**（`:360-368`），
  代码注释自己写着「底单是这条链的默认工作面，runner 也要求飞书页停在 table=<底单>&view=<视图>」。

于是链条是：`readback` 中途抛错 ⇒ 收尾不执行 ⇒ 页面停在它最后导航到的那张表上 ⇒
**下一个碰这个页面的人（下一家的 `push`）撞上一个与它的期望不符的状态**。

本轮的实际发生：

```
06:04:01  网林天猫 readback  → waitForModel 等询单表 tblUnwn05vl8Wik9 超时 30s（last=false）→ 抛错
06:04:01  收尾(把页面送回源表) 未执行 → 页面留在询单表
（中间 3 家店共 10 个阶段都跑在别的浏览器上，与飞书页无关）
06:07:23  科塔淘宝 push  → inspectTarget 拦下：not on authorized table/view …?table=tblUnwn05vl8Wik9&view=vewHgmRhGR
06:07:23  该阶段从启动到失败 0.3 秒
```

**两条报错在日志里看起来毫无关系**：一条是「表 30 秒没加载」，一条是「页面不在授权的 table/view」。
排查时很容易把后者当成「科塔的飞书配置不对」。

### 根因（三层，从浅到深）

1. **复位动作的位置错了。** 「离开时恢复默认工作面」是一件**无论成功失败都该发生**的事，
   却被写在成功路径的末尾。失败这条分支根本没有复位语义。
2. **「设置」与「断言」分家了。** `push` 断言一个**不是自己设置**的状态。这是典型的
   「依赖外部可变状态」：只要上游有任何一个不还原的出口，它就坏，而且坏在别人身上。
   09-18 那次同类报错的修法是**人工**导航到正确 table/view（见
   `evidence/multi-shop-2026-09-18-commit/00-README.md`「中途两次失败」第 1 条）——
   那是一次外部准备动作，没进代码，所以下次照样踩。
3. **设计层：共享一页 + 多主体串行，把「页面状态」变成了隐式的进程间通信通道**，
   而它没有所有权、没有生命周期、没有契约。任何一家的异常都会以别人的错误形式出现。

---

## 三、方案

### 针对弹窗/视口

**A1（推荐，判据侧，有现成范式）点「确定」之前先把它滚进视口，再重新量、再点。**

- 位置：`collect-promotion-report.mjs` 的 `waitForConfirmButton`（`:205-215`）。
- 做法：候选找到后用 `scrollIntoViewExpression('[data-collect-dialog="0"]')`
  （表达式已经给每个候选打了这个属性，`:172`）滚动 → `delay` → **重新量** rect/hitOk →
  仍然 `hitOk=false` 才判失败。判据本身（必须 `hitOk`）一个字不改。
- 为什么这个方向对：固定层是 `overflow:auto`，滚动是页面设计内的合法路径；
  而且 `scrollIntoView({block:'center'})` 会滚**所有可滚动祖先**，正好包含那个固定层。
- 为什么它比「把窗口调大」更根本：它让判据不再依赖「视口恰好够高」这个环境事实。
- 必须有界：滚一次再等一轮；滚完还不行就报错，不要死等。
- 突变验证（本仓库纪律）：把新加的滚动那一步删掉，用例必须变红，且点名到这一条。

**A2（推荐，配置侧，与 A1 互补）给店铺浏览器一个确定的窗口尺寸。**

- 位置：`runtime/browser-ports.mjs` 的 `buildBrowserLaunchArgs`（`:198-207`）。
- 实测依据：工作区 1536×816；09-17 那台视口 732 时可点。
- 未核、必须先实测的一点：`--window-size` 与 profile 记忆的窗口尺寸谁说了算。
  所以候选是 `--window-size=1536,816` 与 `--start-maximized`（后者更接近「恢复满工作区」）。
  **这条不许凭直觉写进代码**——写之前起一次浏览器量 `innerWidth/innerHeight` 验一下。
- 定位：它是**减少贴边界**的补丁，不是根治。A1 才是根治。

**A3（便宜且高价值）把现场证据塞进失败信息。**

- `DIALOG_BUTTONS_EXPRESSION`（`:168-180`）现在只报 `visible`/`hitOk`，**不报 rect、不报视口**。
  这次我为了还原「y=505、视口 500」不得不另写外部探针。
- 加上 `rect` 与 `[innerWidth, innerHeight]`，以后这一条超时自带证据。
- 同一条纪律也适用于 `readback` 的 `waitForModel`：现在失败只报 `last=false`，
  应该带「页面当前 URL + `base.tables` 里的 key 列表 + 已等多少轮」——
  网林那条超时我到现在还判不了根因，就是因为这个。

**A4（值得先探一次，可能是最优）查阿里妈妈能不能绕开这个弹窗。**

报表页的下载如果有可直接触发的 URL 或接口，交互点就整体消失，这一类脆性一起消失。
**这是一次只读探路，没做出来之前不许当结论。**

### 针对飞书共享页

**B1（推荐，治本）`push` 进场时自己导航到源表，`inspectTarget` 退化成「回读校验」。**

- 位置：`run-daily-report.mjs` 的 `main()`，在 `const target = await inspectTarget(args)`（`:276`）**之前**
  加一步：用 `dailyProxy` 的 `/navigate` 到
  `${origin}/base/${appToken}?table=${tableId}&view=${viewId}`，然后保留 `inspectTarget` 原样。
- 语义变化：从「要求别人已经放好」变成「我自己放好，并且核对确实放好了」。
  上游任何失败都不再能影响它。
- 代价：每次 push 多一次导航（秒级）。
- 可测性：抽成 `ensureTargetPage(args)`，用假 fetch 记录调用序列，断言 `navigate` 发生在
  `inspectTarget` 的 eval 之前（`date-picker.test.mjs` 已有同类「记录 calls」的手法可抄）。
  突变：删掉这步导航 → 用例必须红。

**B2（推荐，兜底）`readback` 的归位挪进 `finally`。**

- 位置：`readback-daily-report.mjs:360-368`。
- 注意：它自己也可能失败 ⇒ 必须 catch 住，**不许掩盖原始错误**（原始的 30 秒超时才是要看的）。
- 它不能替代 B1（绕过驱动直接跑 push 仍然会踩），但它让「离开时恢复工作面」这条语义真的成立。

**B3（便宜且高价值）`inspectTarget` 的报错自带诊断。**

现在这条文案（`:85`）只会让人怀疑配置——09-18 那次就被误判成「我开的是裸 base 页」。
应该报出：当前 table/view、期望 table/view、以及「页面停在别的表上，很可能是上一家的阶段留下的」。

**B4（不建议优先，可选）驱动层在某家失败后、进入下一家之前补一次「飞书页归位」。**

它只救驱动这一条路，还会让人以为问题已解决。真要做，必须在注释里写明它不是根治。

**B5（不建议现在做）每家店独立飞书标签页。** 内存代价大（现在一台机器 7 个 Edge），B1 已经够。

---

## 四、还缺的两块证据（都不许猜）

1. **网林 readback 为什么 30 秒没等到询单表**（`last=false`）。
   同一目录里里可林 readback 刚刚成功读过同一批表，所以不是「这些表读不了」。
   要定论得复现一次并留住：当时 URL、`base.tables` 的 key 列表、等待轮数。
2. **同一弹窗在两家店铺页上差 36px 的来源**（内容高度 vs 视口高度）。
   下次开浏览器时同时量五家的视口与弹窗 rect 即可。

## 五、取证清单

- `runtime/browser-ports.mjs:123-160`（五家 profile）、`:198-207`（启动 argv，无 window-size）
- `<各 profile>/Default/Preferences` 的 `browser.window_placement`（`probe-live/95-profile-window.txt`）
- `probe-live/gwtm-dialog.txt`（盖文天猫：视口 1032×500、确定 rect、祖先链、固定层）
- `probe-live/probe-dialog-19043.txt`（盖文淘宝：弹窗三段 rect、确定 [259,469,24,12]）
- `collect-promotion-report.mjs:168-180 / 193-215`（判据与等待）
- `collect-shop-report.mjs:99-107` + `collect-core.mjs:105-115`（本仓库已有的滚动范式）
- `run-daily-report.mjs:78-86 / 276`（`inspectTarget`，只断言不导航）
- `readback-daily-report.mjs:325-368`（先导航读表、收尾才归位）
- `run-multi-shop-day.mjs:366-462`（阶段表：只有 push / readback 用飞书页）

---

## 六、已落地（2026-09-20 当日，及验收方式）

批准范围＝ A1、A3、B1、B2、B3。B4/B5 按「不建议」未做；A2/A4 需要在起浏览器的条件下实测，未动。

### A1＋A3：点不着就滚进视口，并把现场证据塞进失败信息

- 位置：`collect-promotion-report.mjs` 的 `waitForConfirmButton`（已导出，只为可测）
  与 `DIALOG_BUTTONS_EXPRESSION` / `describeDialogCandidates`。
- 判据一个字没改（仍是「文案是确定 **且** 中心点命中自己」）；改的是「判不通过时做什么」：
  先把候选滚进视口，下一轮按**原判据**重判；滚了几次进日志与报错。
- 现场证据：`DIALOG_BUTTONS_EXPRESSION` 现在报 `rect` / `centerY` / `viewport`，
  `describeDialogCandidates` 给出一行「视口 [1032,500]｜确定@[257,505,24,12]点不着」。
- 验收：`collect-core.test.mjs` 新增 3 条。其中「等确定」那条用假代理做状态机 ——
  **滚动之前永远只给不可点的那份**，所以「最终拿到可点的确定」这件事本身就证明了滚动发生在重判之前。
  另外追加了两条有界性断言：滚一次就够（`scrolls=1`、`attempts=2`）、滚完不行就有界收手（`scrolls=attempts`）。

### B1＋B3：push 进场自己落位；停错表的诊断自带原因

- 新增 `feishu-shared-page.mjs`：`inspectPageUrl` / `buildTargetTableUrl` /
  `describeTargetMismatch` / `assertOnTargetPage` / `describePageSearchFailure`。
  判据与措辞只此一份，push 与 readback 两侧对「这一页现在在哪张表」给同一个答案。
- `run-daily-report.mjs`：`main()` 里 `ensureTargetPage(args)` 排在 `inspectTarget(args)` **之前**；
  `inspectTarget` 的断言保留，语义从「唯一的守卫」降为「回读校验」。
- 落位目标 URL 的形状与 `readback-daily-report.mjs` 的 `tableUrl()` 逐字相同（那里已经在用）。
- 顺带发现并修掉一个同族缺口：**URL 对 ≠ 页面模型已加载**。所以「已经在授权 table/view 上」
  时仍然等一次模型（`waitForTargetModel`，判据与 readback 的 `waitForModel` 同源：等**目标表这个键**，
  不等 `base.tables` 变成真对象）。不这样做，同一个「还在加载」会换个面目报在 `inspectTarget` 里。
- 报错文案（保留前缀以便历史证据继续命中）：
  `Feishu page is not on authorized table/view｜当前 table=…（询单表）&view=…｜期望 …｜五家店共用这一页…上一家…`
  另外 `got 0/2` 那条也会列出 `/targets` 当前认到的页面 —— 只报数字时，
  「页面被切到别的 base」与「代理连错了浏览器」长得一模一样。

### B2：readback 的归位挪进 finally

- 位置：`readback-daily-report.mjs` 的 `main()`。读两张表整段包进 `try/finally`，归位在 `finally` 里。
- 归位自己的失败**必须吞掉并出声**（`[leaveOn] 归位失败：…`）——原始异常才是要报出来的那个。
  末行总结也跟着说实话：没归位时不许打印成「已留在 null」。

### 验收与证据

- 新增 `feishu-shared-page.test.mjs`（13 条）：纯判据 + 用**假代理**跑真行为 + 接线断言 + 夹具与配置同源。
- `collect-core.test.mjs` 新增 3 条；`node --test` 两个文件合起来 48 条全绿。
- 突变验证（见 `evidence/shared-feishu-page-2026-09-20/01-mutation.txt`）：5 条突变各自点名一条用例，
  还原后逐字节一致。M1 删落位、M2 落位不发导航、M3 归位搬出 finally、M4 诊断丢掉线索、M5 去掉滚动。
- 一个刻意的设计取舍：`ensureTargetPage` 第二个参数只给测试用（注入更短的等待），
  生产调用一律 `ensureTargetPage(args)`。

### 仍未做（等条件）

- **A2** 给店铺浏览器定窗口尺寸：`--window-size` 与 profile 记忆谁说了算还没实测，不许凭直觉写。
- **A4** 阿里妈妈能否绕开弹窗：只读探路，需要活的报表页；仓库里目前**没有任何**它的接口/URL 线索
  （grep `one.alimama.com` 只有 3 个页面级 URL，无 XHR 记录），所以这只能靠现场探。
- 网林 readback 的 `last=false` 与那 36px 的来源：仍缺现场证据（见第四节）。

---

## 七、同一天的第二处：落位等不到页面（「读不到」≠「落位失败」）

不在原方案清单里，是 rerun3 复盘时冒出来的第三处「设置与断言分家」。

现场：盖文淘宝 / 盖文天猫 停在 `alimama-date`，报出来的却是页面读取表达式**原样抛出**
（`filter bar not ready; triggers=0` / `date trigger ambiguous: []`），调用栈顶是 `settle` 里那次
`readSiteState` —— 也就是第一次读就穿透出整步，而 navigate 到那一刻只过了 1.2 秒。
实测冷挂载到筛选栏齐全要 6190ms，所以那个写在注释里的「8 次重试」在这种情况下**一次都没跑到**。

改法（`date-picker.mjs`，本轮唯一的功能改动）：

- 那次读取移进容错：读不到＝「还没渲染好」＝再等一轮，不是这一步输了；
- 预算 `settleAttempts = 16` × 1200ms ≈ 19s（实测 6.2s 的约 3 倍，依据写在注释里）；
- 等过不止一轮就记 `settle-retried { reads, readFailures }` 进 trace —— 「这一步为什么慢」以后查得到；
- 终态报错把「一次都没读成」与「读成了但对不上」分开。

值得单独记一笔的理由：「动作前页面还没渲染完」在正常一轮里是**常态**。rerun4 五家里三家在这一步的
读取都撞上半渲染（`triggers=2` 就是它的指纹，一直被 `read-before-skipped` 容忍着，所以没人注意），
而网林天猫的 settle 也是靠重试才过（`reads=2, readFailures=1`）—— 换回旧版，那一家会死在第一次读取上。

- 证据：`evidence/alimama-cold-mount-2026-09-20/`（冷标签实测、同条件端到端复现、突变、整轮 rerun4）。
- 未动：生意参谋侧的页签读取（`--expect-tab`）仍在容错外；本轮 3 家实跑都过，按「不许凭直觉改」留着。
