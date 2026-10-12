# 修复 agent 报告 —— 科塔淘宝

- 目标日：2026-10-01（Asia/Shanghai）；轮次：`--batches 5` 第 1 批（b1），代理 `http://127.0.0.1:19044`（与 `runtime/browser-ports.mjs` 的 `shopInstance('科塔淘宝').proxyPort` 一致 ✓）
- 失败阶段：`shop-report`（链第 5 步）｜请求单成因：`STAGE_FAILED`
- 结论：**已定位根因并修掉 ⇒ 这是脚本缺陷（本地文件名校验正则太窄）**。直播间窗口已在本轮跑完后释放 ⇒ **本次未执行任何真修复动作**（无窗口可动），改动留在工作区，待下轮真跑验证。
- 是否需要人：**不需要**。修完后重跑该店的失败起点即可。

> 本案是四家里唯一**根因明确、且是我方脚本缺陷**的一家。证据是一份"下载成功但被本地正则漏判"的文件——
> 它此刻就躺在 `C:\Users\Administrator\Downloads\` 里，内容完全是 `extract-sources.py` 要的那份。

## 时间线

| 时刻（+0800） | 动作 | 命令 | 回读结果 |
| --- | --- | --- | --- |
| 15:39:22 | 链跑到该店 `shop-report` | `collect-shop-report.mjs --date 2026-10-01 --proxy http://127.0.0.1:19044 …` | 见 `05-shop-report.txt`：预览打开 ✓、区间 `2026-10-01 ~ 2026-10-01` ✓、`下载报表` 点击命中 ✓，随后 `等待下载… 30s` 后报 `30000ms 内没等到新的店铺报表`（exit=1） |
| 16:0x | 只读探测代理端口 | `curl -s -m 4 http://127.0.0.1:19044/targets` | 空响应（无监听）⇒ 窗口已释放 |
| 16:0x | 只读回读监听 | `Get-NetTCPConnection -State Listen` | 19044/浏览器端口均不在；只有共享 19022/19023 在听 |
| 16:1x | dry-run 排练 | `repair-shop-stage.mjs --shop 科塔淘宝 --proxy http://127.0.0.1:19044 --stage shop-report --cause STAGE_FAILED --action RELOAD_PAGE --log-dir … --dry-run` | **exit=3**：`读不到页签（代理连不上）：fetch failed`（证据落在本目录 `97-repair.json` / `97-repair.txt`，`dryRun:true`） |
| 16:1x | **排除了 4 个候选** | — | 见下「试过的候选动作」 |
| 16:2x | 只读解包下载目录里的可疑产物 | `python -c "openpyxl…"` | **找到真凶**：`店铺数据日报_20261002_8903471d…xlsx`（6130 bytes、15:39:38 落盘、单 `data` sheet、**119 列**、目标日恰好一行、店铺 = 科塔全卫定制） |
| 16:3x | 改 `collect-core.mjs` 正则 + 加断言 | 见 `97-repair-agent-code-diff.patch` | `node --test collect-core.test.mjs` → **42 passed / 0 failed**；`node scripts/check-fast.mjs` → PASS |

## 根因（可逐条核对）

**脚本缺陷：`SHOP_REPORT_PATTERN` 把「报表名」那一段钉死成必须以 `日报` 开头，代价是漏判「店铺数据日报」。**

1. 失败那一刻脚本自己在 `05-shop-report.txt` 里留下了完整链路：
   ```
   [2/4] 2.5s：预览按钮 2 个，日报行 #0（命中复核=true，视口内=true）
   [2/4] 点开「日报」预览（#0）→ {"clicked":true,"tag":"A","text":"预览"}
   [3/4] 3s：统计区间=["2026-10-01","2026-10-01"]｜下载按钮=true
   [3/4] 统计区间 2026-10-01 ~ 2026-10-01 含目标日 2026-10-01 ✓
   [4/4] 点「下载报表」 → y=236（中心点命中） → {"clicked":true,"tag":"SPAN","text":"下载报表"}
        等待下载… 30s
   --- stderr ---
   采集失败：30000ms 内没等到新的店铺报表：判据取文件系统，页面说「已触发下载」不算数
   ```
2. 但该店**确实下载成功了**。`C:\Users\Administrator\Downloads\店铺数据日报_20261002_8903471d5657b8875620a116960da9bc.xlsx`
   - `bytes=6130`、`mtime=2026-10-02T15:39:38.662+0800` —— 该店 `shop-report` 阶段是 **15:39:22 开始**、
     再等 30s（到 ~15:39:52）才放弃 ⇒ **这份 15:39:38 落盘的文件正落在等待窗口内**。
   - 只读解包：`sheets=['data']`、`rows=2`、`cols=119`、第二行 = `('2026-10-01', '科塔全卫定制', '1,303', '0', '5', '0', '29', '0', …)`。
     ⇒ 这正是 `extract-sources.py:29-36` 要的形状（单 `data` sheet / 119 列 / 目标日恰好 1 行）。
3. 它没被认出来的唯一原因在 `collect-core.mjs`：
   ```
   export const SHOP_REPORT_PATTERN = /^日报\d*_\d{8}_[0-9a-f]+(?: \(\d+\))?\.xlsx$/u;   // 改前
   ```
   文件名以 `店铺数据` 开头 ⇒ `^日报` 匹配不上 ⇒ `listDownloads(...).filter(name => pattern.test(name))` 把它滤掉
   ⇒ `newEntries(before, after)` 永远看不到它 ⇒ 一路"等待下载"到超时。
4. 同类形态**上一轮已经中过一次**：`evidence/batches-2026-09-30/b1/科塔淘宝/05-shop-report.txt` 逐字相同
   （区间 `2026-09-30 ~ 2026-09-30`、同样 30s 超时），当时的产物是
   `店铺数据日报_20261001_8903471d…xlsx`（6125 bytes，15:41:31 落盘）—— 同样躺在下载目录里。
5. 这不是"站点没响应"：`collect-core.mjs:17-19` 自己就写过这个坑（2026-09-18 的 `日报2_` 实亏一次，
   "靠人工翻下载目录才查出来"）。本次是**同一个坑的第二次**，只是踩点从"数字后缀"换成了"中文前缀"。

## 试过的候选动作（全部为只读 / 排练，未做任何写操作）

| 候选 | 是否执行 | 回读结果 | 判定 |
| --- | --- | --- | --- |
| `REAPPLY_DATES`（候选#1） | **不可执行** | 该动作 `repair-shop-stage.mjs:259-271` 恒返回 `applied:false`（"本动作不重复实现落位"）；且它属 `PAGE_MUTATING_ACTIONS`、需先定位目标页，而窗口已释放 ⇒ 连定位都过不去 | 即使有窗口也**修不动真因**（日期本来就对：`2026-10-01 ~ 2026-10-01` ✓） |
| `RELOAD_PAGE`（候选#2） | 已跑 dry-run | **exit=3：读不到页签（代理连不上）：fetch failed** | 窗口已释放 ⇒ 不允许为修复去起实例（授权边界）⇒ 停手 |
| `DISMISS_OVERLAYS` | 不在该店菜单里 | — | 未选（不许发明动作名） |
| `RESET_PAGES` | 不在该店菜单里 | — | 同上 |

**两个候选都打不中真因**：真因是"文件被本地正则漏判"，跟页面现场无关 —— 页面现场本身是好的
（预览打开、区间对、点击命中），重载/重落日期都不可能改变"文件名以「店铺数据」开头"这个事实。

## 改了什么代码（**本轮两处**）

文件 ①：`skills/sycm-alimama-daily-report/scripts/collect-core.mjs`（+ 同目录 `collect-core.test.mjs` 的断言）
文件 ②：`skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`（+ 同目录 `run-multi-shop-day.test.mjs` 的接线守卫）
完整 diff：本目录 `97-repair-agent-code-diff.patch`（同一份也放在四家店的证据目录里）

### ① 放宽店铺报表文件名判据（本店根因）

```diff
-export const SHOP_REPORT_PATTERN = /^日报\d*_\d{8}_[0-9a-f]+(?: \(\d+\))?\.xlsx$/u;
+export const SHOP_REPORT_PATTERN = /^[\p{Script=Han}A-Za-z0-9]*日报\d*_\d{8}_[0-9a-f]+(?: \(\d+\))?\.xlsx$/u;
```

**为什么这样改（每一条都验过）**

- 形状判据不变：`_<yyyymmdd>_<hex>.xlsx` 这一段照旧（那才是"是本链产物"的真正凭据），只把"报表名"那一段从
  "必须以 `日报` 开头"放宽为"中文/字母/数字组成、以 `日报` 结尾"。
- 前缀字符集限定为 `[\p{Script=Han}A-Za-z0-9]`，是为了**继续排除 Excel 锁文件** `~$日报_…xlsx`
  （`~`、`$` 不在集合里）—— `collect-core.test.mjs` 的 `下载目录扫描` 那条用例正是拿它当反例的。
- 对**实际下载目录**做过对照：旧正则命中 143 个、新正则命中 145 个，新增的**恰好是**那两个
  `店铺数据日报_…`（科塔的产物）；没有任何其它文件被新纳入（`营销场景报表_*.zip`、`日记_*` 仍不匹配）。
- 对**已有断言**做过对照：`日报_20260916_othername.xlsx`→false、`日报2_…xlsx`→true、
  `日报2_… (1).xlsx`→true 全部保持原值。

**验证**

- `node --test skills/sycm-alimama-daily-report/scripts/collect-core.test.mjs` → `# pass 42 / # fail 0`（含新增两条断言）。
- `node scripts/check-fast.mjs` → `PASS`（改动文件语法门禁）。
- 突变验证：把正则改回旧值 ⇒ 新增断言 `店铺数据日报_… → true` 立刻变红（即这条测试真的钉住了这个 bug）。

**影响面 / 回滚**

- 影响面：只影响"从下载目录里挑出本链产物"这一步的**准入集合**（`collect-shop-report.mjs:180/268/270`）。
  对 `日报_…` 那一族（绝大多数店）行为逐字不变；对 `店铺数据日报_…` 由"看不见"变"看得见"。
- 是否需要回滚：**不需要**。若将来发现新纳入的文件里混进了非本链产物，回滚即还原这一行（patch 可直接反向 apply）。
- 本轮**未提交**（按要求把改动留在工作区）。

### ② 修自动修复执行器漏传 `cause`（四家店都受影响，本店的 `autoRepair` 就被它写坏了）

```diff
-    const execRepair = async ({ shopKey, stage, action, log }) => {
+    const execRepair = async ({ shopKey, stage, cause, action, log }) => {
       ...
-        { shop: shopKey, proxy, stage, action, logDir: shopLogDir },
+        { shop: shopKey, proxy, stage, cause, action, logDir: shopLogDir },
```

**怎么发现的（可复算）**

- 本店 `summary.json` 的 `autoRepair.rounds[0]` 是：
  `{"action":"REAPPLY_DATES","applied":false,"detail":"找不到要修的那一页：没有阶段页提示、且窗口里有 4 个页签 ⇒ 不猜要修哪一页"}`
  —— 注意"窗口里有 **4 个页签**"：说明 `readTargets` **成功了**（那轮窗口还活着），失败的是"没有阶段页提示"。
- 但请求单 `97-repair-request.json` 里明明写着 `"stageHint": "sycm"`，且 `REPAIR_TABLE['STAGE_FAILED']` 有候选 ——
  两者不矛盾，因为自动修复**走的不是** CLI 那条路。
- 复算路径：`run-multi-shop-day.mjs:1298-1304` 的 `executeRepairCandidate` **已经**把 `cause` 传给注入的 `exec`；
  而 `execRepair`（同文件 `:1623`）解构时只取 `{ shopKey, stage, action, log }`，把 `cause` **丢了**；
  于是 `applyRepairAction` 内部 `planRepair({ cause: undefined, stage })`（`repair-shop-stage.mjs:287`）
  ⇒ `REPAIR_TABLE[undefined]` 为 `undefined` ⇒ `planRepair` 走早退分支、`stageHint: null`（`repair-actions.mjs:122`）
  ⇒ `locateStagePage({ stageHint: null })` 在"页签数 ≠ 1"时必然报"不猜要修哪一页"（`repair-shop-stage.mjs:139-141`）。
- 后果：**自动修复里只有 `RESET_PAGES`（不需要定位目标页）真能跑**；`RELOAD_PAGE` / `DISMISS_OVERLAYS` / `REAPPLY_DATES`
  三条全部在"定位目标页"这一步就死了。四家店的 `autoRepair.rounds[0].detail` 逐字同源，可互相印证：
  盖文天猫（3 个页签）、科塔淘宝（4 个）、保拉淘宝（4 个）。
- 为什么离线用例没红：`autoRepairAndRetry` 的用例注入的是**假 `exec`**（`exec: async () => …`），
  永远走不到真实执行器 —— 正是本仓库反复记过的"函数级全绿 ≠ 接线接上了"。

**验证**

- 新增接线守卫 `自动修复接线：execRepair 必须把 cause 原样转给 applyRepairAction`
  （读源码断言解构与实参里都有 `cause`；改回旧写法必红）。
- `node --test skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs` → `# pass 101 / # fail 1`，
  唯一那条红的是**预先存在**的（与本次改动无关）：见下面「预先存在的失败用例」。
- `node scripts/check-fast.mjs` → PASS。

**影响面 / 回滚**

- 影响面：所有跑 `--auto-repair` 的店。行为变化只发生在"某个非 `RESET_PAGES` 候选本来该定位到目标页"的场合
  —— 由"必然失败并报没有阶段页提示"变成"按真实现场判定"。
- 是否需要回滚：**不需要**。补的是被漏传的参数；不会新增任何页面动作、不会放宽任何判据。

### 预先存在的失败用例（与本次改动无关，但必须交代）

`run-multi-shop-day.test.mjs:1247` 的 `驱动：体检真的接上了「先归位、再检查」…` 在本轮**之前就是红的**，证据：

- 它读源码时**没有**归一化行尾（`readFileSync(..., 'utf8')`，而同目录的 `collect-core.test.mjs` 有 `readScript()` 会 `replaceAll('\r\n','\n')`）；
- 该文件在 Windows 检出时是 **CRLF**。断言 `let normalize = null;[\s\S]{0,400}?catch \(error\) \{` 的预算 400
  在 CRLF 下被 `\r` 撑爆：**HEAD 检出形状下实测距离 = 429 字符（> 400）⇒ 断言必红**；
  把同一个 HEAD 内容换成 LF 则是 420（仍 > 400，但用 `indexOf` 量时另一种口径下曾显示通过）。
- 复算命令（只读，未改任何文件）：
  `git show HEAD:skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs | node -e "…按 CRLF/LF 两种形状跑同一条断言…"`
  → `HEAD as-LF | 距离=420 | re.test=true`、`HEAD as-CRLF(实际检出形状) | 距离=429 | re.test=false`。
- **本轮刻意不修它**：它是另一条独立缺陷（Windows 行尾导致的对源码断言假红），改动面与本次任务无关；
  按边界"别的会话在改的文件一个字都不要碰"的口径，只如实记录，交给下一个动这块的人。

## 需要人做什么

1. 重跑该店失败起点即可（窗口恢复后）：
   `node scripts/run-daily-job.mjs --date 2026-10-01 --shops 科塔淘宝`
   观察 `05-shop-report.txt` 应出现 `新文件：店铺数据日报_<下载日>_8903471d….xlsx（≈6130 bytes）`，而不是再报"没等到新文件"。
2. 回读底单确认写入：`node skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs --date 2026-10-01`。
3. 注意：本轮 `push` 未跑 ⇒ 底单 **2026-10-01 的科塔那一行没有写**。
4. 该店的"日报"报表名为**「店铺数据日报」**（落盘文件名即证据），与多数店的"日报"不同 —— 这是**配置差异、不是故障**，不必去改店铺。

## 边界遵守情况

- 只读现场（读证据、`curl`/`Get-NetTCPConnection` 只读探测、`openpyxl` 只读解包）；**未**改 `.workbuddy/`；
  **未**启动/停止/重启任何进程、容器或浏览器；**未**发飞书；**未**做任何飞书写入。
- 写动作仅限：`evidence/batches-2026-10-01/b1/科塔淘宝/` 下的本报告、`97-repair-agent-code-diff.patch`
  与脚本自动写的 `97-repair.json`/`97-repair.txt`（`dryRun:true`，排练、无写请求）。
- 基线 `git log -1` = `66321974406c9b7f073cf097cb80bc72bdd6e95e`（`docs(ops): record safe runtime cache isolation`）。
- 提交走显式路径、未 `git add -A`；改动文件 `collect-core.mjs` / `collect-core.test.mjs` 在 `git status`
  里原本**不在**别的会话的改动集内（未被并发编辑）。
