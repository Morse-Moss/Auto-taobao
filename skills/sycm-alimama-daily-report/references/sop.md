# 运营日报采集 SOP

## 1. 启动独立浏览器

```powershell
node runtime/start-daily-report-browser.mjs
node runtime/start-daily-report-proxy.mjs
```

确认 `19022` 和 `19023` 正在监听，且代理 `/health` 返回 `browser.id=edge-daily-report`。每次动作前从 `/targets` 重新发现页面，不保存 target id。

端口与 profile 的权威值在 `runtime/browser-ports.mjs`（唯一来源），两个启动器从这里取；不要在命令行或代码里另写一份（写死的默认值会静默指向错目标）。某台机器要换端口就设 `PROJECT_BROWSER_PORT` / `CDP_PROXY_PORT` / `CDP_BROWSER_PORT`。

### 1.1 为什么必须与竞品链各用一个浏览器（客户交付必须交代）

- 生意参谋、阿里妈妈、飞书登录的是**商家账号**。
- 小旺神插件**只有买家账号能用**（它是买家视角看市场/竞品数据的）。
- 同一个浏览器 profile 不可能同时是商家与买家 ⇒ 这两条链必须各用一个独立实例、独立调试端口、独立 CDP 代理端口，不能为了「省一个浏览器」而合并。
- 合并后的失败形态是静默的：点击和导航都成功，但操作的是另一个账号的浏览器 —— 不报错，只会把数据写到错的地方。

交付客户前要确认两个登录态分别在位：商家号登在 `D:/Retire/edge-daily-report-profile`（这条链），买家号登在 `D:/Retire/edge-debug-profile`（竞品链、里面装着小旺神）。不要把商家号登进别的配置，也不要把买家号登进日报配置。

这条链属于**商家浏览器**（乙）。三条业务路线各归哪个浏览器，权威表在 `runtime/browser-ports.mjs` 的 `ROUTES`，可读版在 `docs/ops/PROJECT-BROWSER-AND-PORTS.md` §1.3：买家浏览器走竞品链（小旺神），商家浏览器走「关键词·搜索排行 ＋ 本日报 ＋ 周表粘贴飞书 ＋ 千牛/卖家工作台（预留）」。

这两个进程不常驻：跑完一轮后它们会随宿主一起退出，下一轮重新启动即可；启动本身不改变任何远端状态。启动器在起之前会先看端口上是谁：若端口已被**另一个 profile** 的浏览器占用，它会拒绝启动并打印对方的 profile（继续起只会把调试端点接到别人身上）。

### 1.2 起不来先看「同 profile 是否已有实例在跑」

**启动器现在会自己说这件事**（2026-09-17 起）：同一个 profile 已经有实例跑在**别的端口**上时，它拒绝启动，并直接打印那个端口与两种处置。所以先读它那几行，不要一上来就人工枚举进程。

它给出的失败形态（改之前只会打印这些，两行单看都像「端口没起来」）：

```text
[browser] msedge exited code=0
[browser] 调试端口 19022 在 30000ms 内没有就绪（最后错误：ECONNREFUSED）
```

原因不是端口被外人占，而是**同一个 profile 已经有一个实例在跑**（比如上一次遗留的、跑在旧端口上的那个）：Edge 按 user-data-dir 单例，新进程把请求交给已有实例后立即退出，于是新端口上永远不会有调试端点。

处置顺序：

1. 看启动器那行结论；它的判据是在**登记表已知的端口**上探一遍、用 profile 自证，所以点名是可信的。
2. 那个端口上如果确实是本 profile，**直接复用它**：代理按登记表起在 `19023`，只把内部那一跳用 `CDP_BROWSER_PORT=<实际端口>` 指过去。脚本侧无感，因为它们只认 `19023`。
3. 只有当启动器说「没能在登记表已知的端口上找到它」时才人工枚举：`Get-CimInstance Win32_Process` 按 `--user-data-dir` 过滤 `msedge`，看它的 `--remote-debugging-port`（注意 PowerShell 工具在本机不回显 stdout，要写文件再读）。
4. 不要为了「统一端口」去杀那个浏览器。它可能是别人正在用的窗口；本项目的纪律是**未经许可不动任何进程**。
5. **不要**改用 profile 目录里的 `DevToolsActivePort` 来判断：2026-09-17 实测它两个方向都不可靠（9222 端口空闲、文件还在；9223 活着、文件不存在），Windows 上也没有 `SingletonLock` 可看（Chromium 在 Windows 用命名互斥体，不落文件）。

## 2. 日期落位（先做这一步，再做任何采集）

两个站点的落位方式不同，这是实测结论，不是设计偏好。用同一个脚本：

```powershell
node skills/sycm-alimama-daily-report/scripts/date-picker.mjs --site alimama --date 2026-09-15
node skills/sycm-alimama-daily-report/scripts/date-picker.mjs --site sycm --date 2026-09-15
```

| 站点 | 正常日更（昨日） | 回填历史日 |
| --- | --- | --- |
| 阿里妈妈 | 构造 URL hash 后 navigate | 同一条路：构造 URL。**不需要点日历** |
| 生意参谋 | 切「询单到付款」页签 → 点 `1天` | 切页签 → 点 `自定义` → 日历里左右两块各点一次目标日 → 确定 |

阿里妈妈的所有筛选状态都编码在 URL hash 里，实测直接导航即可同时落位，无需任何点击：

```text
https://one.alimama.com/index.html#!/report/account?rptType=account
  &startTime=2026-09-15&endTime=2026-09-15
  &effectEqual=30&bizCodeIn=["onebpSearch","onebpDisplay"]&granularity=day
```

- `startTime=endTime` 才是单日；漏掉就会静默变成区间累计。
- `effectEqual=30` = 30天累计数据；`bizCodeIn` 两个场景 = 关键词推广 + 人群推广。
- 页面等于昨日时会回显 `昨日` 而不是日期，所以断言必须把 `昨日` 按站点时区换算回具体日期。

模式由脚本自动判定：目标日等于站点时区的昨日走预设，否则走显式；`--mode preset|explicit` 可强制。脚本每次都执行「动作前读一次 → 动作 → 回读断言」，并且回读的断言比动作更强：

- 阿里妈妈：日期必须等于目标日，且筛选栏必须同时出现 `关键词推广` + `人群推广` + `末次点击归因` + `30天累计数据` + `分日`。断言按语义识别，不按下标（筛选栏顺序是页面实现细节）。
- 生意参谋：日期必须等于目标日，且活动页签必须是 `询单到付款`。

任一条不成立就报错，并把 `trace` 一起打出来，不需要重新手工复现才知道卡在哪一步。

### 页面漂移自检

每次动手前必查这几条；不成立时停下来看页面，不要改选择器去凑：

- 生意参谋的活动页签是三层结构，`汇总分析` 和 `询单到付款` 各有自己的一套日期控件。页签是 `汇总分析` 时 `1天` 按钮的文案读出来是空串，硬点会点到别的东西。
- 关闭状态的日历菜单仍然留在 DOM 里（`display:none`，格子 `rect` 全 0）。判断「面板是否打开」必须看它是否真的渲染出来，否则会得到「面板已打开、格子都在 (0,0)」的假状态。
- 按钮可能在视口外。实测视口宽 1031，`自定义` 按钮在 x=1035 —— 真实鼠标点击会静默落空且不报错。所以取点前先 `scrollIntoView`，再用 `elementFromPoint` 复核命中。
- 这些按钮的 `innerText` 可能是空串（`1天`/`按7天为周期`/`按30天为周期` 三个都返回 `""`），但 `textContent` 正常。文案匹配一律用 `textContent`。
- **阿里妈妈侧栏的文案尾部带 iconfont 私有区字符**（2026-09-17 实测：`下载管理` 后面跟着 `U+E617`）。`textContent === '下载管理'` 会得到 0 个命中，读起来像「元素不存在」；要么先剥掉 `U+E000–U+F8FF`，要么用 `includes`。排查手法：把命中文本逐字符打 `codePointAt(0)`，一眼就能看出多出来的那个码位。
- 一个按钮外面套 div、里面套 span，三者 `textContent` 都等于目标文案 —— 按文本找元素会「命中 4 个」。先只在 `BUTTON/A` 这类可点击语义标签里找，仍不唯一时取面积最小的那个。

## 3. 店铺数据

在已登录的生意参谋中按以下路径操作：

```text
自助分析 -> 分析空间 -> 公共空间 -> 取数报表 -> 日报 -> 预览 -> 下载报表
```

已验证报表 id：`4300764`。下载后的工作簿应只有 `data` sheet，表头 119 列。选择请求日期对应的唯一一行；不要默认第一行永远是昨日。

这份工作簿与日期无关（一次导出含多天），09-14 与 09-15 两次运行用的是同一个文件、同一个 SHA256。

### 3.1 2026-09-17 实测的可靠路径

外层是企业门户壳，真正的应用在 iframe 里，每一步都会换 URL，逐级点击容易走偏。实测可用的两条捷径：

- 顶层菜单 `自助分析` → `https://sycm.taobao.com/adm/v3/micro/auto_analysis/my_space`；
- iframe 自身地址可直接开：`https://sycm.taobao.com/lyone/auto_analysis/my_space?insertType=sycm&layoutHide=1&useDebug=false`（同源，去掉外壳后探针不必穿透 iframe）。左栏切 `公共空间`（URL 追加 `&activeKey=common`）。

**但别从门户首页直接跳这条 iframe 地址**（2026-09-17 实测）：页面停在 `sycm.taobao.com/portal/home.htm` 时导航过去，
12 秒后它自己跳回门户（跟随器日志：`11:18:27 跟随 → …/lyone/auto_analysis/my_space` → `11:18:39 跟随 → …/portal/home.htm`）。
地址没错，是当时页面不在应用内、没有外壳上下文。采集路径必须先落到任一个应用内页
（本 SOP 用 `qos/service/frame/shop/performance/new#/shop`），再跳公共空间。两条入口各自都能稳定停住
（18 秒复读 URL 不变），差别只是外壳页把内容装在 iframe 里（探针要读 `contentDocument`），直连页的元素就在主文档里。

**这类页面不要用固定 sleep 等元素**：出现时间随会话状态变。可靠做法是轮询等目标元素出现（每 2.5s、上限 ~25s），
点击前再用 `elementFromPoint` 按矩形中心复核命中（元素可能在视口外或被别的层盖住）。

公共空间的报表列表里 `日报` 那一行右侧是 `预览`；点进预览页后 URL 形如
`/lyone/auto_analysis/datafetch/report_generation?...&reportId=4300764&type=preview`，页面底部按钮依次是 `下载报表` / `加入我的报表` / `加入在线表格`。

预览页顶部的三行元信息是现成的断言材料，开跑前值得读一次：

```text
数据来源：电商后台-天猫淘宝-生意参谋
数据维度：店铺-整体
统计日期：<起始>～<结束>      ← 09-17 实测为 2026-08-18～2026-09-16（自动更新-最近30天）
```

`统计日期` 的上界必须已经包含请求日；不含就说明源报表还没更新到那一天，此时下载会静默少一行（导入端才会以「找不到目标日行」报错）。

下载文件名形如 `日报_<YYYYMMDD>_<报表定义哈希>.xlsx` —— 哈希随报表定义走、不随内容变（09-16 与 09-17 两次下载哈希相同），所以**不能拿文件名判断是否是新数据**，必须读内部 `统计日期` 列。

## 4. 推广数据

日期与三个筛选条件由 §2 的 URL 落位保证；剩下的下载动作：

1. 滚动到报表底部，点击 `下载报表 -> 确定`。
2. 打开 `下载任务管理`，等待任务显示 `生成成功`。
3. 下载 CSV 营销场景报表。最后一次下载按钮需要 CDP 真实鼠标事件；脚本触发的 DOM `.click()` 不会启动下载。

成功文件应是含一个 GB18030 CSV 的 ZIP。CSV 必须是 71 列、两条数据：场景 `371 / 关键词推广` 和 `372 / 人群推广`，且内部日期等于目标日。

### 4.1 下载任务管理怎么进（2026-09-17 实测，别跟侧栏较劲）

侧栏的 `下载管理` 是一个**折叠分组**，里面的 `下载任务管理` 才是目标页。实测两个坑：

- 侧栏是固定高度的独立滚动容器：窗口 `window.scrollTo` 带不动它，目标项会永久停在视口下方（视口高 691 时它在 y≈712）。真实鼠标点击落空且不报错。要滚的是它自己的滚动祖先（`overflow-y: auto|scroll` 且 `scrollHeight > clientHeight` 的那一层）。
- 更省事的是直接导航到子项 `href`：`https://one.alimama.com/index.html#!/report/download-list`（另一个子项是 `#!/report/strategy-download`）。侧栏折叠状态、滚动位置都不用管。

ZIP 解析时注意：**压缩长度要从中央目录读（偏移 20），不要读本地文件头（偏移 18）**。流式生成的 ZIP 本地头里这两个字段常写成 0、真值放在 data descriptor 里，按本地头切会得到 `unexpected end of file`。

## 5. 询单量补充

在同一独立生意参谋浏览器中操作：

```text
服务 -> 店铺绩效 -> 业绩分析 -> 询单到付款 -> 日 -> 选择目标日期
```

页面表格中，以列名和行名交叉定位：

- `询单量` = `当日询单人数` 列的目标日期行。
- `同层同行询单量` = `当日询单人数` 列的 `同行同层均值` 行。

不要使用操作截图中的示例数字，也不要误取 `询单人数`、`同行同层优秀`、`汇总值` 或 `全店平均值`。

同行同层对比行只在预设模式下存在（实测 2026-09-16）：

| 模式 | 表格行数 | `同行同层均值` |
| --- | --- | --- |
| `1天` 预设（昨日） | 7 行 | 有 |
| `自定义` 选历史日 | 3 行（日期行 + 汇总值 + 平均值） | 无 |

所以回填历史日时 `同层同行询单量` 在数据源层面不可得。默认行为是 fail-closed 报错；确认要只写 `询单量` 时显式加 `--allow-missing-peer`，脚本会在单据里写下 `degraded.code = PEER_UNAVAILABLE` 并保持那一格空白（不写 0、不写占位值）。

```powershell
# 正常日更
node skills/sycm-alimama-daily-report/scripts/run-inquiry-backfill.mjs `
  --date 2026-09-15 --source-shop 盖文旗舰店 --shop 盖文天猫

# 历史日回填（显式降级）
node skills/sycm-alimama-daily-report/scripts/run-inquiry-backfill.mjs `
  --date 2026-09-14 --source-shop 盖文旗舰店 --shop 盖文天猫 --allow-missing-peer
```

先跑干跑计划；脚本会先校验页头店铺身份。确认目标记录唯一、且两个字段（或降级时的那一个字段）为空后，追加 `--commit`。脚本只更新这两个字段，写后回读并验证其他字段未变化；相同来源值再次运行时应返回 `ALREADY_VERIFIED`。

一次只填**一个店**：`--source-shop` 是生意参谋侧的店铺名（`页头` 里那个 `XX 主店`），`--shop` 是飞书询单表里那一行的店铺选项名。SOP 只覆盖盖文天猫那一家，其余 11 家的行保持空白 —— 这是现状而不是故障，别把「11 行为空」当成回填失败。

`--commit` 会往 `daily_report_push_audit` 写 `action='inquiry-backfill'` 的行（见 §6.2）；`plan.json` / `inquiry-backfill-plan.json` 里也带 `environment` 与 `evidence` 两块，和主链一个形状。

## 6. 合并与回填

先运行 Skill 入口脚本生成 dry-run `plan.json` 和 `paste.tsv`，核对请求日期、店铺名、目标 base/table、字段数和场景。API 有写权限时用同一命令追加 `--commit`。若 API 返回 `403 / 91403`，停止 API 重试，在飞书网格中新建一行、选中首列，通过代理 `POST /paste` 发送真实 `Ctrl+V`。随后用 `--verify-existing --expected-before-count N` 回读验收，其中 `N` 是粘贴前已确认的行数。

目标行顺序为：119 个店铺字段、69 个关键词推广字段、69 个人群推广字段。目标表前两列和末六列不在写入 payload 中。

`店铺` 是飞书侧异步算出来的派生字段，紧随创建的第一次回读可能读到空数组。这不代表写入失败，脚本会对这一格做有界重试；预算耗尽仍会如实报错并说明记录已存在。

收据里有两块专门用来**事后自证**的内容（2026-09-17 起），出问题时先看它们：

- `environment`：这次是在什么环境里跑的 —— `computedAt`（真实时钟）、`node`、`proxyUrl`，以及浏览器/代理的端口、id、label；每一项都带 `source`（`env` / `registry-default` / `env-invalid`）与 `registryDefault`。
  一眼就能回答「有没有偏离登记表」：例如 `browserPort: {"port":9223,"source":"env","registryDefault":19022}` 就是「登记表写 19022、实际用的是 9223」。
  它只观测、不裁决：环境变量不合法会记成 `env-invalid`，而不是让一次数据导入失败（这些端口是浏览器链在用，runner 自己并不读它们）。
- `sourceSelfChecks`：这次用的两份源数据**是不是目标日那一天**。逐项列出店铺侧的 `targetRowCount` / `matchedRowDate` / `firstRowDate`..`lastRowDate`，与推广侧 CSV 的 `observedDates` / `csvName`，最后给 `allMatchDate`。
  不通过时脚本在**字段映射之前**就停（`assertSourceDates`）并点名两个文件名 —— 比原来那句 `unexpected 关键词推广 identity/date: …` 多了「哪个文件、观察到哪几天」。

顺带一条别踩的：文件名里的哈希（`日报_20260917_adc987ef….xlsx`）**随报表定义走、不随内容变**，两次下载可能同名同哈希。判「是不是新数据」只能读内部的日期列，也就是上面这个 `sourceSelfChecks`。

### 6.1 飞书里的「行序」是怎么来的（2026-09-17 用户提问后补）

底单是**只追加**的：API 路径 `batchCreateRecords` 加到末尾，UI 路径是新建一行再粘贴。飞书 OpenAPI 没有「插到第 N 行」这种能力，表里也没有可写的「序号」字段。

所以看到的行序 = **记录创建顺序**。底单视图 `vewwg0rhjo`（名「表格」）的当前配置是：按「店铺」分组、**没有任何排序**（`sortInfo: []`）⇒ 组内就按创建顺序排。

后果：先跑「昨日」、再回填更早的日期，回填那行就落在后面。实测两代数据都一样 —— 09-15 先落位第 5 行、09-14 后落位第 6 行，屏幕上于是显示「…15、14…」。这不是数据错位，收据里的 `recordCountBefore/After` 就是落位下标，可逐条复核。

要按日期看，直觉做法是在视图上加一条排序「统计日期 升序」—— 那是视图属性，不改记录，也不影响下游月份数据表/仪表盘的字段引用。

**但 2026-09-17 实测这张视图的排序落不了库**，别以为「加上就好了」：

- 用 CDP 在排序面板里设了「统计日期 升序」，面板当时回读 `sortInfo:[{fieldId:"fldkIuNvnY",desc:false}]`、渲染顺序也真的变成升序 —— **但整页刷新后 `sortInfo` 回到 `[]`**；
- 面板里那个「自动排序」开关（默认开）关掉也一样；
- 抓包显示「加排序」这个动作**零网络请求**；
- 服务端独立判据：同一视图带 / 不带 `view_id` 各拉一次记录，返回顺序完全相同（= 创建顺序）⇒ 服务端确实没存；
- 权限上查不出「不许存」的理由（`records: []`、`isLock:false`、`view.sort={visible:true,editable:true,localEditable:false}`）；
- 同 base 的 `tblm9Hx7R9A1YoLC` 视图**是存得住 `sortInfo` 的**，所以不是整个 base 的问题。

⇒ 结论：**不要把「视图排序」写进 SOP 当作可靠手段**。要按日期读，请用收据里的 `recordCountBefore/After` 还原落位，或改用「另存为新视图」再在新视图上排序。完整证据见 `docs/ops/DAILY-REPORT-RUN-2026-09-17-FINDINGS.md` §8.5。

数据本身不会串行：同一行的 `统计日期`、`关键词推广日期`、`人群推广日期` 必须相等，这由 `buildCombinedFields` 的等值断言与 `assertSourceDates` 两道闸门分别保证。

### 6.2 本地审计日志 `daily_report_push_audit`（2026-09-17 建）—— 是审计，不是台账

**它的作用**：回答「本地能不能查『某天推过没有、用的哪个源文件、推了几次、跑在哪个端口上』」。
在此之前这些信息只散在 `evidence/daily-report-*/receipt.json` 里，得一个个目录翻；飞书那边查不了 SQL（外部租户）。

**它明确不是**台账、不是权威，边界由三件事守死：

1. **没有读接口** —— 写入方 `runtime/daily-report-audit.mjs` 只导出写函数。单测里有一条守卫盯着「不许导出任何读语义的名字」。
2. **没有业务唯一键** —— 同一天同一店推十次就写十行；「重复」本身就是要被记录的事实。
3. **查重、判重、幂等一律仍然只问飞书**（`run-daily-report.mjs` 的 `duplicates` 逻辑）。

因此**它允许与飞书不一致** —— 不一致正是它要暴露的现象，不是要消除的噪声。日报链的事实只有一个来源：飞书底单里有没有那一行。

写入时机：`run-daily-report.mjs` 只在**真的动了外部系统**的两条路径写行（`--commit` → `action='push'`，`--verify-existing` → `action='ui-verify'`）；`run-inquiry-backfill.mjs` 在 `--commit` 路径写 `action='inquiry-backfill'`（写入成功与「回读后确认已一致」各记一行，`detail.status` 区分）；失败也会写一行（`outcome='failed'`）；dry-run 什么都不写。**写审计失败不会让日报失败** —— 只打印一行 `[audit] 未写入（不影响本次结论）：…`。

`inquiry-backfill` 这个词原先只存在于 007 的 CHECK 与本文档里，`appendAudit` 却只被 `run-daily-report.mjs` 调用 ⇒ **询单回填从来没留下过审计行**（2026-09-17 复盘发现的缺口，已接线）。这是本项目反复出现的「词表/文档比代码乐观」形态 —— 词表里有、但没人写，等于把缺口伪装成已完成；再遇到「某个值只在词表和文档里出现」时，先去代码里确认有没有写入方。

怎么查（只在本地库 `xws_automation`，无需浏览器）：

```sql
-- 某天发生过什么
select at, action, outcome, shop_name, record_count_before, record_count_after,
       browser_port, source_promotion_file, receipt_path
from daily_report_push_audit where report_date = '2026-09-16' order by at;

-- 最近发生过什么
select at, action, outcome, report_date, shop_name, detail->>'error' as err
from daily_report_push_audit order by at desc limit 20;
```

落库与回滚：`db/migrations/007-daily-report-push-audit.sql`（2026-09-17 已 apply 到业务库，回读 22 列 / 3 索引 / 2 CHECK）；
回滚 `007-rollback.sql` 刻意 **fail-closed**（表里还有行就拒绝删）。隔离预演见 `runtime/verify-migrations-isolated.mjs`。

### 6.3 证据目录的代次：同一天重跑不许覆盖上一轮（2026-09-17 起）

默认证据目录原先只按 `reportDate` 取名（`evidence/daily-report-2026-09-16`），于是**同一天跑第二遍会静默覆盖第一遍的 `plan/paste/receipt`**。2026-09-17 真的发生过，而且后果是隐性的：那个目录里的 `plan.json` 属于后一次跑，`before/after-import-readback.json` 却属于清理前的那一次 —— 一个目录里装着两代产物、描述的不是同一批记录，事后从文件名上完全看不出来。

现在的规则（确定性，不问人）：

| 情形 | 落点 |
| --- | --- |
| 调用方显式给了 `--output-dir` | 原样用（那是他的选择，脚本不替他改名） |
| 默认，`evidence/daily-report-<date>` 里**已有内容** | 顺延 `-rerun2`、`-rerun3`… |
| 默认，目录空/不存在 | `evidence/daily-report-<date>`（第 1 代） |
| `run-inquiry-backfill.mjs` / `readback-daily-report.mjs` | **并入当前最新一代**（`policy: 'latest'`） |

两条要记住的：

- 判据是「目录里**有没有东西**」，不是「几个已知文件名在不在」—— 只按文件名判的话，截图与探针这类额外产物会绕过它，而那恰恰是最该保住的证据。
- 回填与回读必须用 `latest`：它们是**同一次运行的后两个阶段**，产物要和 plan/receipt 落在同一个目录里；若也按「另开一代」走，第一天的第二次跑就会把一次运行的产物拆到三个目录，那「这是哪一代」就没有答案了。两个写入方共用 `daily-report-runtime.mjs` 的 `resolveEvidenceDir`（不许各自拼目录，有测试盯着）。

`plan.json` / `receipt.json` 里新增 `evidence` 块（`outputDir` / `generation` / `reason`），stdout 也会打 `outputDir` 与 `evidenceGeneration` —— 收到收据就知道它属于第几代、和哪一批源文件是一对。

历史目录已按同一条规则对齐过（2026-09-17）：`daily-report-2026-09-16` = 第 1 代（08:03-08:14，清理前那次），`-rerun2` = 第 2 代（10:17，重推），`-rerun3` = 第 3 代（11:27，给客户演示那次）。**移动产物会让审计表里历史行的 `receipt_path` 变成旧路径** —— 这是可接受的：审计表是「只追加的动作日志」，它允许与当前事实不一致，那正是它要暴露的现象。

### 6.4 独立回读与截图（脚本化，2026-09-17 起）

```bash
node skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs --date 2026-09-16
```

它走**另一条完全不同的通路**读同一个事实：CDP → 飞书页面的 bitable 内存模型（`window.bitableStore.modelOperator.base`），既不过 runner 的断言，也不过飞书 OpenAPI。写入方自证没法排除「写入方和读者一起错了」，所以这一步是收据那两个数字的旁证。产出 `independent-readback.json` 与两张截图（`feishu-source-table-after-*.png` / `feishu-inquiry-table-after-*.png`，后缀 `--shot-suffix` 可改）。

两条实测注意：

- **页面模型存的是 SingleSelect 的选项 id，OpenAPI 存的是选项名字**。不映射就会把 `optIYzOzu2` 当成店名印进证据里（读证据的人得自己猜这是哪家店），而且它看起来完全像一个正常的值。映射实现放在 `daily-report-runtime.mjs` 的 `resolveOptionToken`，表达式里用 `.toString()` 注入，保证「测过的那份」和「真的在跑的那份」是同一份；映射不出来或同一个 id 在不同字段指向不同名字时，如实标 `resolvedBy` 并保留原始 id。
- 导航到目标表本身就是一次重新加载，顺手解决页面的陈旧问题（老标签页里的 `table.recordsNum` 是打开那一刻的值，实测与别的页读到的差过 12）。所以脚本先导航再等模型就绪，且**轮询**等（每 2s、上限 30s），不用固定 sleep。JSON 里那个字段特意叫 `recordsNumFromPageModel`，就是提醒它可能落后于服务端 —— 它是旁证，不是权威。

### 6.5 同一目标日、不同时刻导出，阿里妈妈侧会不一样（2026-09-17 实测，影响「什么时候跑」）

拿两代运行对同一个目标日（2026-09-16）逐字段比了一次：

| 侧 | 结果 |
| --- | --- |
| 店铺块（生意参谋，119 字段） | **逐字段完全相同** |
| 推广块（阿里妈妈，两次导出相隔约 3 小时 18 分：08:04 → 11:22） | **8 个指标由 `0` 变为非 0**，另有 **4 个字段由「空（未写入）」变为有值** |
| 日期 / 场景 id / epoch | 两次完全一致（不是选错日期或场景） |

变化的例子：`引导访问人数` 0 → 125、`引导访问潜客数` 0 → 111、`优惠券领取量` 0 → 6、`关键词推广旺旺咨询量` 0 → 7；新出现的是 `引导访问潜客占比` / `平均访问页面数`（两个场景各一份）。

⇒ **阿里妈妈侧当日上午有数据未回补完的窗口：导出得越晚越准，早上的导出会给你一份偏低的推广数据。**

后果比「数字不准」更麻烦：底单的查重键是「同一天＋同店铺」，所以早跑写进去的那份偏低数据**没法靠同日重推修正** —— 重推会被 `duplicate daily report row exists` 拦下，只能先按 §9.3 把那天删掉再重跑。

⇒ 纪律：**日更不要赶早**，等阿里妈妈侧回补完再跑（实务上过午再跑）。这条不是脚本能兜住的，脚本没法判断「平台今天补完没有」；要加自动判定，得先找到平台侧那个「数据已完整」的信号。
证据：`evidence/daily-report-2026-09-16-rerun3/payload-diff-vs-rerun2.json`。

## 7. 本轮实测基线

2026-09-16 重跑（先删掉 09-14/09-15 既有数据，再分别验证两种模式）：

| 项 | 09-15（预设） | 09-14（自定义） |
| --- | --- | --- |
| 阿里妈妈落位 | URL 构造，回显 `昨日` | URL 构造，回显 `2026-09-14` |
| 生意参谋落位 | 页签切换 → `1天` | 页签切换 → `自定义` → 日历两击 |
| 推广 ZIP | `营销场景报表_20260916_121308.zip` | `营销场景报表_20260916_150325.zip` |
| 导入结果 | `COMMITTED_AND_VERIFIED`，247 字段 | `COMMITTED_AND_VERIFIED`，243 字段 |
| 记录数 | 4 → 5 | 5 → 6 |
| 询单表行数 | 7 行 | 3 行 |
| 询单量 | 14 | 10 |
| 同层同行询单量 | 36 | 不可得（`PEER_UNAVAILABLE`） |

- 店铺文件：31 行（含表头）、119 列，两日共用同一个 SHA256。
- 阿里妈妈归因周期：`30天累计数据`；场景 371/372；粒度 `分日`。
- 两次导入的 `payloadFields` 都等于该日期上一次运行的值（247 / 243），源文件 SHA 与 `dateEpoch` 也一致 —— 可复现。
- 这两份推广 ZIP 是同一批次下载并已校验内部日期的文件，本轮没有重跑下载动作；URL 落位本身已用页面回读断言验证，但「URL 构造 → 点击下载 → 文件内容」这一段没有被本轮覆盖。
- 询单表 `09-14 / 盖文天猫` 的 `同层同行询单量` 在本次之后仍然是空白，这是预期状态，不是遗漏。

这些值只证明 2026-09-16 的实测流程。未来运行必须重新验证页面状态、日期、文件结构和登录态。

## 8. 2026-09-17 全链实录（目标日 2026-09-16，正常日更＝预设）

| 项 | 值 |
| --- | --- |
| 目标日 | 2026-09-16（`new Date()` 判定的「昨日」） |
| 阿里妈妈落位 | URL hash 构造，回显 `昨日`，解析为 2026-09-16；`APPLIED` |
| 生意参谋落位 | 切 `询单到付款` 页签 → 点 `1天`；`统计时间 2026-09-16` |
| 推广 ZIP | `营销场景报表_20260917_080428.zip`（71 列、371/372、内部日期 09-16） |
| 店铺 XLSX | `日报_20260917_…xlsx`（单 `data` sheet、119 列、30 行，含 09-16 唯一一行） |
| 导入 | `COMMITTED_AND_VERIFIED`，`recvvqPBEP0cMe`，6 → 7 行，239 字段 |
| 派生字段重读 | `derivedReadbackAttempts: 3`（第 1 次读到空数组，有界重试第 3 次就位） |
| 询单回填 | `COMMITTED_AND_VERIFIED`，`询单量 13` / `同层同行询单量 39`（预设模式，同行基准在） |
| 幂等复跑 | 同参数再跑询单回填 → `ALREADY_VERIFIED` |
| 独立回读 | 底单 7 行（…09-14/09-15/09-16）；询单表 `2026-09-16 / 盖文天猫 → 13 / 39` |

本轮新增的三条可复用结论（已写进 §2 / §3.1 / §4.1）：侧栏文案带 iconfont 私有区字符、侧栏是固定高度的独立滚动容器、ZIP 压缩长度要读中央目录。

环境偏离（必须交代）：本轮日报浏览器是**上一次留下的实例**，跑在迁移前的旧端口 `9223`（profile 正确、账号正确；Edge 同 profile 单例，新起 19022 只会并入旧实例并退出）。为不中断任何进程，CDP 代理按登记表起在 `19023`，仅内部那一跳用 `CDP_BROWSER_PORT=9223` 指到活着的浏览器。下次干净重启后 `19022/19023` 才是一致的默认组合。

## 9. 重推：用户清掉某天数据后重跑同一天（2026-09-17 实测一遍）

触发场景：运营发现某天数据不对，直接在飞书里删掉那一行（或清掉几个字段），让你重跑。
**重推不是重新采集**：源文件通常还在 Downloads，比对 sha256 与上次收据一致即可复用。

### 9.1 七个步骤（顺序照做）

1. **只读确认现状**：先读飞书，确认目标日那行真的没了、现在还剩几行。判据不是「用户说删了」，
   而是回读结果（本次：7 → 6 行，首轮那行 `recvvqPBEP0cMe` 确实不在）。
2. **比对源文件 sha256**：与上一轮收据里的 `source.shopSha256` / `promotionSha256` 逐字节比对。
   一致 ⇒ 同输入重跑，结论可与首轮对照；不一致 ⇒ 先查清为什么，别急着写。
3. **确认飞书页在浏览器里开着**：runner 的 `inspectTarget` 要求**恰好一个**页面，且 URL 必须带
   `table=` 与 `view=` 且等于授权目标。报 `expected one Feishu page for target base, got 0` 就是没开 ——
   用代理开一个：`GET /new?url=<encodeURIComponent(底单 URL，含 table 与 view)>`，再 `POST /bringToFront?target=…`。
   ⚠️ 同时开两个该 base 的页会让 `matches.length === 2` 失败，读完记得 `GET /close?target=…`。
4. **把生意参谋页导航到店铺绩效**：`date-picker` 是按 **URL 片段**找页面的
   （`sycm.taobao.com/qos/service/frame/shop/performance`），停在 `portal/home.htm` 会报 `got 0`。
   先导航到 `https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop`，再跑
   `date-picker.mjs --site sycm --date <目标日>`。目标日＝昨日时会自动走 `1天` 预设——
   这是生意参谋侧拿到同行基准的唯一模式。
5. **导入**：先干跑看 `recordCount` 与 239 字段，再 `--commit`。
   **重推会生成新的 `recordId`**（旧记录不会回来）；行数是「前 → 前＋1」，因为那一行确实已被删掉。
6. **询单回填**：干跑会告诉你两个字段现在是不是空的（用户可能把它们也清了）。
   `WRITE_REQUIRED` ⇒ 会写；`ALREADY_VERIFIED` ⇒ 无需写。写完 `unchangedOtherFields: true` 才算过。
7. **独立回读 + 截图**：别只用 runner 自己的断言 —— 换成一条完全不同的通路再读一次同一个事实：
   `node skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs --date <目标日>`（见 §6.4）。
   脚本自己会 `POST /bringToFront` 再截图（否则 `Page.captureScreenshot` 会报 `CDP 命令超时`，后台 tab 被节流），
   并把「页面模型里的记录数」与「目标日命中几条」写进 `independent-readback.json`。

### 9.2 本次重推的基线（同一批源文件，两个 sha256 与首轮一致）

| 项 | 首轮 08:08 | 重推 10:2x |
| --- | --- | --- |
| 底单记录 id | `recvvqPBEP0cMe` | `recvvrlGsi7Js6` |
| 行数 | 6 → 7 | 6 → 7 |
| 回读字段 | 239 | 239 |
| 派生「店铺」就位次数 | 3 | 2 |
| 询单回填 | 13 / 39 | 13 / 39 |
| 收据 `environment` | （该版收据还没有这一块） | 四项全 `registry-default`（19022 / 19023 / `edge-daily-report`） |

**落位再次印证 §6.1**：重推的 09-16 追加在**第 7 行**，屏幕顺序 …09/15、09/14、09/16…——
这是 append-only ＋ 视图无排序的必然结果，不是数据错位。

**审计表**（§6.2）本次留下第一条生产行：`id=2, push / ok, 2026-09-16, recvvrlGsi7Js6, 6 → 7, 239, api-commit, 19022 / 19023`
（`id=1` 是建表当天的冒烟行，写完即删；序列不回退，所以第一条生产行是 2）。

**已知缺口（2026-09-17 当日下午已补）**：`inquiry-backfill` 原先只在 007 的 CHECK 词表与本文档里，
`appendAudit` 却只被 `run-daily-report.mjs` 调用 ⇒ 第 6 步**不会**留下审计行。现已接线
（`run-inquiry-backfill.mjs` 的 `--commit` 路径写 `action='inquiry-backfill'`，写入与「回读后已一致」各一行）。
注意本文档 §9.2 这张基线表记的是**接线之前**那一轮，所以它没有对应的审计行。

完整实录与两个缺口：`docs/ops/DAILY-REPORT-RUN-2026-09-17-FINDINGS.md` §9。
证据：`evidence/daily-report-2026-09-16-rerun2/`（含 `independent-readback.json` 与只读探针副本）。
目录代次见 §6.3：`daily-report-2026-09-16` = 第 1 代（08:0x）、`-rerun2` = 第 2 代（10:2x）、`-rerun3` = 第 3 代（11:2x 演示）。

### 9.3 反过来：怎么安全地把某一天清掉（2026-09-17 实做了一遍）

运营有时会先让你清掉某天（而不是重推）。**清理比写入更需要先看清列的性质**：

1. **先判定每一列是不是派生列**（`listFields()` 的 `type`）：
   `19 Lookup` / `20 Formula` / `21 Link` / `100x 系统列` ＝ 派生。它们的值来自别处（底单），
   删掉源行本来就会让它们归零，**不构成「丢失手工数据」**。
2. **只有「非派生、非结构、非本次自己写的那两个字段」还有内容时，才停下来问人。**
   本次实测：`各店铺数据日报` 的 12 行 09-16 记录，**手写列非空 = 0** —— 那张表 33 个字段里
   28 个是派生列，只剩 `询单量` / `同层同行询单量` 两列是人写的（也就是本链要回填的那两列）。
   换句话说：**那张表整张都是底单的派生视图**，删行不会伤到人手录的数据。
3. **删除端点有坑（实测）**：`DELETE .../records/batch_delete` 在这张 base 上返回
   `code=1254043 RecordIdNotFound`，但 `DELETE .../records/{record_id}`（单条）**正常**
   （`code=0, deleted=true`）。批量失败时别以为是 id 错了 —— 换成逐条单删即可。
4. **删完必须两侧独立回读**：这次 底单 7 → 6、`各店铺数据日报` 2197 → 2185，目标日各剩 0 条。
5. **审计表刻意不回改**：`daily_report_push_audit` 里仍留着那次 push 的记录，
   它现在指向一个已被删掉的 record_id —— 这正是「审计允许与飞书不一致」要暴露的现象，
   **不要**为了让两边看起来一致去删审计行。
6. **别在事后拿清理脚本重跑做「幂等复核」**：它会把自己的回执文件覆盖掉
   （本次就发生过一次 —— 重跑后 `deleted` 变成空数组，第一次的 13 条删除记录被抹掉，
   只能按当时输出手工还原）。要复核幂等就写到另一个文件名里去。

可复现脚本副本：`evidence/daily-report-2026-09-16-clear/script-clear-inquiry-rows.mjs`；
删前枚举快照与删后回读：同目录的 `pre-delete-snapshot.json` / `post-delete-verification.json`。

7. **在证据脚本里别复写审计表名**：审计表守卫扫的是全仓库 `.mjs`，`evidence/` 也在扫描面内
   （它扫的是字符串内容，不是只看代码 —— 真要命的「第二读者」恰恰是把表名写进 SQL 字符串的那种）。
   本次第一版证据脚本在 `note` 里原样写了表名，提交前被守卫抓红一次；改成「本地审计表」即可，
   证据价值不减。**不要为了让证据脚本能过而去放宽守卫白名单**，守卫原样保留是最省的。
