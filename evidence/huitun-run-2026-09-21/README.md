# 灰豚采集段：登录之后仍跑不通的两件事（2026-09-21）

背景：灰豚段此前卡在人工登录墙，摩斯扫码后让我重跑。登录确实过来了（页头出现
`ID：1001392394`），但重跑连挂，于是有了下面两件事。

## 结论

1. **入口点击是偶发静默失败**：4 次里 3 次挂在「打开话题搜索」，页面状态是「锚点可见、
   URL 30 秒不变」。旧代码既不验证点击有没有生效、也不重试，只能干等到超时。
   → 已修（先复核命中点再点、点完验证跳转），复核 6/6 通。
2. **配额耗尽被读成「浏览量 0」，并且会进回填计划**（`willWrite: true`）。这是本轮更严重的一条：
   等于把「渠道不给查」记成「数据就是 0」，公式随即把关键词从 A候选 降成 B-持续观察。
   → 已加闸，改为显式失败（fail-closed，不产生写入计划）。
3. **采集本身打通过一次**：`泡澡浴缸` → 话题 `#泡澡浴缸#`、浏览量 `32.7w` = `327,000`
   （`runtime/huitun-runs/20260921T074136Z-.../results.json`）。
4. **当天配额已用尽**：页面原文「该版本每天最多可以访问10次，请升级到高版本使用」。
   今天这台账号在 4 次成功查询之后开始返回该文案（更早的额度是否被别的用途占用未查），
   所以今天不可能再采到新值。

## 一、入口点击为什么挂

`openTopicSearch` 原实现是「给锚点打一个 `data-huitun-topic-search` 属性 → 再 `clickAt` 那个属性」。
`clickAt` 自己算 rect 中心，中间隔着一次网络往返；话题入口在「热门内容」子菜单里，展开带动画，
目标在往返期间动过就点空，而点空既不报错、页面也不动。

失败现场（`live/watch.txt`，1.4 秒采样）：

```
t+ 15s  [20260921T073954Z-...] DBA8D2A0  https://xhs.huitun.com/#/home
t+ 20s  ... anchorRect:[0,0,0,0]          ← 菜单已展开
t+ 21s  ... anchorRect:[68,369,56,17]     ← 锚点可见、可命中
t+ 47s  ... anchorRect:[68,369,56,17]     ← 27 秒没动，URL 一直是 #/home
```

同页签截图（`live/t021-DBA8D2A0.png`）显示「热门内容」正常展开、无弹窗遮挡 ⇒ 不是弹窗挡住，
也不是账号没权限（切红薯版是稳的，页签稳定停在 `xhs.huitun.com`）。

手点复现：在新页签上逐字复刻脚本步骤（`probe-replicate.txt`）全部成功；成功轮 200ms 快采
（`live/watch-fast.txt`）显示 `#/home → #/anchor/anchor_topic` 只隔约 2 秒。⇒ 路径没问题，是时序。

修法（`run-huitun-topic-heat.mjs`）：滚进视口 → `elementFromPoint` 复核「这一点真落在锚点上」
→ 按该坐标走 `/clickPoint` → 点完验证 URL 变了没 → 没变就重算重点。每次点击打
`TOPIC_ENTRY_CLICKED`，超时错误带上 `clicks` 与 `lastMiss`，不再是「等了 30 秒」这一句。
复核：修后连跑 6 次，`TOPIC_ENTRY_CLICKED` 全是 `attempt=1`，6/6 到 `TOPIC_SEARCH_READY`。

## 二、配额墙被当成空结果（更严重）

配额用尽时结果表位置放的是升级引导文案。`classifyTopicSnapshot` 在「没有完全同名话题」时
直接拿这段文案当 `emptyText` 证据，返回 `NO_EXACT_TOPIC` / `views: 0`；`buildUpdatePlan`
看到字段为空就把它排进 `updates`。实测产物：

```
"status": "NO_EXACT_TOPIC",
"viewsRaw": "该版本每天最多可以访问10次，请升级到高版本使用\n\n升级版本",
"views": 0,
"expectedPriority": "B-持续观察",
"willWrite": true          ← 会真写 0
```

即：带 `--apply` 跑，`灰豚话题浏览量` 会被写成 `0`，公式把该词从 `A候选` 降成 `B-持续观察`。
这与契约 §空结果（`.ant-table-placeholder` 文本 `没有找到话题~~点击这里`）不是一回事 ——
一个是「查了，没有同名话题」，一个是「渠道拒绝服务」。

修法（`flow.mjs`）：`classifyTopicSnapshot` 在把 `emptyText` 当证据之前先过 `LIMIT_WALL_PATTERN`，
命中就抛错。与 `parseDisplayedViews` 拒绝无法解析的浏览量文案同一层、同一风格。
真机复核（`tmp/collect-huitun-quota-guard.out.txt`）：

```
{"status":"FAILED","error":"Huitun refused to serve this query instead of returning an empty result: 该版本每天最多可以访问10次，请升级到高版本使用\n\n升级版本"}
```

不产生 `DRY_RUN_READY`、不产生写入计划。

**遗留（已实测取证，见 §五）**：这条现在落成不含确定性 code 的通用 FAILED。按本仓「确定性 code
必须映射成收据上的 failureClass」的规矩，它更该是 `HUMAN_REQUIRED`（人要等配额重置或升级，
不是代码 bug）。改状态词表会牵动适配器映射与既有用例，本轮没动，留待决定。

## 三、当天可采到的那一个值

```
keyword 泡澡浴缸 | 话题 #泡澡浴缸# | viewsRaw 32.7w | views 327000
expectedPriority B-持续观察   （327000 < 10,000,000，未过 A 门槛）
```

需求口径见 `docs/requirements/KEYWORD-PRIORITY-REQUIREMENT-ORIGINAL.md`：门槛 `1000w` = `10,000,000`
（公式源码字面量 `10000000`），与脚本自报的 `expectedPriority` 一致。
**注意**：这个值**没有写飞书**，是 dry-run。写入需要另取一次明确授权。

## 四、写入与回读（15:59–16:01，摩斯明确授权「写」）

写的是 09-19 那张表的 `泡澡浴缸`（`record recvvIWvenK0TL`）：

```
灰豚话题浏览量  ""  ->  "327000"        期望 327000  => OK
优先级          "A候选" -> "B-持续观察"   （公式自己结算，不是我们改的）
内容热度         "高" -> "高"            （未被改动）
apply exit=0，写前先落 BACKUP_WRITTEN
```

写后队列：`A候选 0`（C 287 / B 13）⇒ 灰豚段下一次跑会遇到空队列，确定性跳过。

**顺手发现的一件事：库里同时有 `关键词分析 V1（修正版）` 和 `关键词分析 V1（2026-09-19）`。**
两者不是同一张表：

| 表 | 字段数 | 行数 | 优先级分布 | 泡澡浴缸 |
| --- | --- | --- | --- | --- |
| `修正版` (`tblmU1n3SO8Mz7Ub`) | 26 | 301 | C 242 / B 58 / 空 1 | `B-持续观察`，灰豚空，**内容热度空** |
| `2026-09-19` (`tblZsUns9353w3nl`) | 29 | 300 | C 287 / B 12 / **A候选 1** | `A候选`，灰豚空，内容热度 高 |

采集的队列是从 `2026-09-19` 读的、结果文档也绑在它上面，所以写它。
`修正版` 的 `A候选` 是 0 行 —— 这条链在它上面根本不会有活干。
**「当期表是哪一张」不该由名字排序决定**：第一版驱动就是按名字倒序取，抓到了无日期的 `修正版`
（字面排序反而压过带日期的），被守卫拦住。现在改成从采集结果文档反推目标表、再与飞书实况核对名字。

## 五、那条配额墙失败到底被归成什么（实测，未修）

`flow.mjs:190` 抛的是**普通 `Error`，不带 `.code`**；`translateFlowError`
（`adapter.huitun-keyword-heat.mjs:193-210`）的 `FLOW_ERROR_RULES` 里没有匹配它的模式，
按该函数自己的注释「未命中规则的异常原样抛出」，它被**原样抛出**。于是它落到
`worker-adapter.mjs:20-29` 的 `failureClassOf` 兜底分支。实测（`quota-wall-failure-class.txt`）：

```
failureClassOf (worker-adapter)   => BUG  => action=STOP_AND_ALERT  "bug suspected, stop automation"
classifyExternalFailure (policy)  => BUG  => action=STOP_AND_ALERT  "bug suspected, stop automation"
```

同时发现**两个轴是分开读的**，改一个不动另一个（这两条是对照，不是推测）：

| 只改这一处 | 运行时那条轴（failureClassOf） | CLI 那条轴（退出码 / preserveBrowser） |
| --- | --- | --- |
| `.code = 'HUMAN_REQUIRED'` | 仍 `BUG` ← 它读 `.failureClass`，不读 `.code` | 退出码 2、保留页签 |
| `.failureClass = 'HUMAN_REQUIRED'` | `HUMAN_REQUIRED` → `WAIT_HUMAN` | 仍退出码 1、关页签 ← 803/883 行读 `.code` |

即「给它挂个 HUMAN_REQUIRED」一句话不够，**两个字段都得表态**。
另外即使都改对，`round-notify-policy.mjs` 里 `HUMAN_REQUIRED` 的措辞是**为登录失效写的**
（标题「平台登录已失效」、`needs: ONSITE`、`retryAutomatically: true`），配额墙套上去
会得到「请去那台机器上登录」的通知、并按 15 分钟节点白重试到当日上限（配额当天不会自愈）。
语义最贴的现成类别其实更接近 `POLICY_DENIED`（`needs: CONFIG`、`retryAutomatically: false`）。

事实边界：该能力**尚未挂任何排期**（`config/` 内 grep `huitun` 零命中，
`skill-registry.index.json` 只有能力登记），所以今天没有无人值守流程会被这条错分类弄停。

## 文件

| 文件 | 内容 |
| --- | --- |
| `live/watch.txt` | 1.4 秒采样的失败现场（含锚点 rect 演化） |
| `live/watch-fast.txt` | 200ms 快采，成功轮的进入时点 |
| `live/t0xx-DBA8D2A0.png` | 失败轮运行页签截图（t+21s 锚点已可见） |
| `probe-header.txt` | 页头平台下拉三项：`logo_dy.svg` / `logo_chuangyi.svg` / `logo_xhs__2.svg` |
| `probe-switch.txt` | 切红薯版逐秒记录：稳定停在 `xhs.huitun.com`，无弹回 |
| `probe-open-topic.txt` | 单步走通打开话题搜索（`sub8-popup` 确为「热门内容」） |
| `probe-replicate.txt` | 新页签上逐字复刻脚本步骤，全通 |
| `probe-account.txt` | 红薯版页头账号标记 `ID：1001392394`、输入框/搜索按钮就位、风控文案为空 |
| `diagnose-topic-menu.txt` | 抖音版工作台上锚点不存在（说明必须先切红薯版） |
| `apply-and-readback.txt` | 写入全过程：反推目标表 → 定位 A候选 行 → dry-run → apply → 独立回读 |
| `probe-keyword-tables.txt` | 两张「关键词分析」表的字段数/行数/优先级分布对照 |
| `quota-wall-failure-class.txt` | 配额墙失败经三个分类器实测：`BUG` → `STOP_AND_ALERT`；两个轴分开读的对照 |
| `probe-quota-wall-class.mjs` | 上一条的复现脚本（`node evidence/huitun-run-2026-09-21/probe-quota-wall-class.mjs`） |
| `topic-menu-*.png` / `switch-5s-*.png` / `after-topic-click.png` / `replicate-final.png` | 各阶段截图 |
