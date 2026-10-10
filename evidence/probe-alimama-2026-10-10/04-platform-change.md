# 追加证据：这是**平台改版**，不是脚本回归（2026-10-10）

## 关键对照
2026-09-20 的同名实验 `evidence/alimama-cold-mount-2026-09-20/03-hash-change-inplace.txt` 记录：
- 把页签 hash 换到 `startTime=2026-09-16` ⇒ 触发器**立刻显示 `2026-09-16`**（11 个，稳定 30 秒）
  ⇒ **当时 URL hash 确实能设日期**（这正是 `route:'url-hash'` 这条设计的依据）

2026-10-10 实测（同一台机器、同一家店 里可林淘宝 / 19041）：
- 页签先于 `about:blank` 再整页 navigate 到 `…index.html#!/report/account?startTime=2026-10-10&endTime=2026-10-10&…`
  ⇒ `href` **带上了** hash（`isRequestedQztDefaultSet=1`）、标题＝`营销场景报表_万相台无界版`、触发器 11 个
  ⇒ **但日期触发器显示 `过去 7 天`、页面明写「数据范围为：2026-10-03至2026-10-09」**
- 再用 `location.replace(同 URL)` 硬重载，等 14 秒 ⇒ 仍然 `过去 7 天` / `10-03至10-09`
- ⇒ **`startTime/endTime` 这两个参数今天页面已经完全不理会**，永远回落到默认「过去 7 天」

## 结论
- 09-16 设计时「筛选状态完整编码在 URL hash 里、navigate 即落位」是**真的**；
- 现在平台改成**必须点面板选日期**，URL 参数只影响别的（场景/归因/粒度仍生效：`关键词推广人群推广`
  `末次点击归因` `30天累计数据` `分日` 都在）。
- ⇒ ㊵ 的最终定性：**平台改版导致 `route:'url-hash'` 这条日期策略失效**，与 10-09/10-10 的代码改动无关。

## 日期控件是另一套组件（不是 sycm 那套 OUI）
- 点日期触发器（`.mx-trigger` 第 4 个）后，页面出现**两个**新的 `.mx-trigger`：
  `2026-10-03`、`昨日` ⇒ `.mx-trigger` 从 11 变 13。
- 面板 DOM 家族是 `mx-output / mx-output-list / mx-output-item / mx-output-footer`，
  **没有** sycm 用的 `.oui-date-picker-menu` / `.oui-dt-calendar-*`。
- ⇒ 现有 sycm 的日历机器**不能直接复用**；alimama 侧需要按 `mx-output-*` 结构另写。

## 二次点击未生效
点 `.mx-trigger-label`（「昨日」，(763,276)）后 5 秒：触发器仍 `过去 7 天`、数据范围仍 `10-03至10-09`。
⇒ 只点面板项不够，需要确认按钮或另一次交互（面板结构需再读一次才敢定论，本轮未定）。

## 决定性验证：点面板能设对日期（本轮已完成，2026-10-10 22:1x）
日期面板结构（点 `.mx-trigger` 第 4 个后出现）：
  `.mx-output-bottom.mx-output-open`  rect=[564,227,253,229]
    选择日期： 2026-10-03 - 昨日
    快捷日期： 昨日 / 过去 7 天 / 上周 / 过去 15 天 / 本月 / 过去 30 天 / 上月
    确定 / 取消
坐标实测：快捷「昨日」=(584,332)（`asiYysgNak`）｜「确定」=(597,435)（`asiYysgNaZ`），两者 elementFromPoint 命中自己。

点「昨日」→点「确定」之后：
  href  → `…#!…&startTime=2026-10-09&endTime=2026-10-09&…`   ← **URL 参数这时才跟着变**
  trig  → 第 4 个变成 **`昨日`**（正好命中链路的 `/\d{4}-\d{2}-\d{2}|昨日|今日/`）
  页面  → **数据范围为：2026-10-09至2026-10-09**   ← 真正对了

⇒ 因果方向是 **「面板 → URL」**，不是脚本原来假设的 **「URL → 面板」**。
⇒ ㊵ 的可执行修法：alimama 侧加一条「点日期触发器 → 面板里选到目标日（昨日用快捷、其它日用选择日期）→ 点确定」
  的新原语，替代 `route:'url-hash'` 那条 navigate 即落位的老路。

## ⚠️ 更正（同日更晚，必须写下来）—— 我前面的「URL 参数被平台废弃」这个结论**是错的**

继续实测发现（同一台机、同一页签）：
- 页签**已经在报表路由**时：`/navigate` 到 `startTime=2026-10-05` ⇒ 日期变 `2026-10-05`、范围 `10-05至10-05` ✅
  `/navigate` 到 `2026-10-06`、`location.replace` 到 `2026-10-01` ⇒ 全部**正确生效** ✅
- 页签**在首页**（`one.alimama.com/index.html`，无 `#!`）时：`/navigate` 到 `…index.html#!/report/account?startTime=2026-10-10…`
  ⇒ hash 被吃掉、停在首页、`过去 7 天` ❌

⇒ 真正的成因比我先前说的**窄得多**：不是「参数废弃」，而是
**「从首页整页导航进报表路由」这一步会被 SPA 吞掉**；只要页签已经在报表路由内，日期参数一直好使。

⇒ 正解＝`enterAlimamaReportRoute()`：navigate 之后**回读 `document.title`**，还在首页就改成**页内 `location.hash=…`** 再回读。
   真机验证（2026-10-10 22:2x，从首页 `triggers=4` 的现场起跑）：
   `date-picker.mjs --site alimama --date 2026-10-09 --proxy …:19041`
   ⇒ `status: APPLIED`、`observedAfter: 昨日`、页面独立回读 `数据范围为：2026-10-09至2026-10-09`。
   trace 里 `enter-report-route.landed.t = 营销场景报表_万相台无界版` 是新函数把页面送进报表路由的证据。

⇒ 面板路径（`applyAlimamaDateViaPanel`）保留为**后备**：仅在 navigate+hash 之后仍落不上（settle 抛）时才走。
   它本身也已实测可用（点快捷「昨日」+「确定」⇒ `10-09至10-09`），但本轮主路径用不到它。
