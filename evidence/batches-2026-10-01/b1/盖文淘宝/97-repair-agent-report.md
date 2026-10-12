# 修复 agent 报告 —— 盖文淘宝

- 目标日：2026-10-01（Asia/Shanghai）；轮次：b1，代理 `http://127.0.0.1:19043`（与 `shopInstance('盖文淘宝').proxyPort` 一致 ✓）
- 失败阶段：`health-check`（链第 0 步体检）｜请求单成因：`SHOP_BLOCKED`
- 结论：**根因 = 该店这条浏览器实例的登录态已失效（页面被弹到登录墙）⇒ 只能人上（重登），不是脚本缺陷。**
  直播间窗口已在本轮跑完后释放 ⇒ 未执行任何真修复动作。
- 是否需要人：**需要**——在**该店自己的窗口**里重新登录一次。

## 时间线

| 时刻（+0800） | 动作 | 命令 / 文件 | 回读结果 |
| --- | --- | --- | --- |
| 15:36:38 | 链跑到该店 `health-check` | `01-health-check.txt` | `归位：归位后仍不齐（生意参谋工作页=0  阿里妈妈报表页=1）`；阻断项 `TARGET_PAGE_MISSING`（exit=2） |
| 16:0x | 只读探测代理端口 | `curl -s -m 4 http://127.0.0.1:19043/targets` | 空响应（无监听）⇒ 窗口已释放 |
| 16:0x | 只读回读监听 | `Get-NetTCPConnection -State Listen` | 19043/19033 均不在听 |
| 16:1x | dry-run 排练 | `repair-shop-stage.mjs --shop 盖文淘宝 --proxy http://127.0.0.1:19043 --stage health-check --cause SHOP_BLOCKED --action RESET_PAGES --log-dir … --dry-run` | **exit=0**：`排练（--dry-run）：会执行 RESET_PAGES …一个写请求都不发`（`RESET_PAGES` 不需要先定位目标页，故排练期不连代理 —— 该条**不能**用来证明窗口在不在；窗口是否在由上面的端口探测判定） |

## 根因（可逐条核对）

**该店登录态已失效。** 判据来自失败那一刻链自己写下的两个文件：

1. `01-health-check.txt:32-42`（`normalize.actions[]`，归位动作的现场）：
   ```
   "page": "生意参谋工作页",
   "action": "reclaim",
   "found": 0,
   "url":  "https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop",
   "from": "https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop",
   "status": 200
   ```
   `from` 命中的是 **`sycm.taobao.com/custom/login.htm?_target=…`** —— 这是生意参谋对**未认证请求**的回落地址
   （带 `_target=` 记着原目标），**不是 404/缺页**。归位动作重新 navigate 到工作页后，`after` 仍是
   `生意参谋工作页=0`（同一文件 `:12-31`）⇒ 不是"渲染没起来"，是被**反复弹回登录墙**。
2. `99-recovery.txt:1-5`（停手时的页签清单）：
   ```
   停手时页面停在：生意参谋工作页=0  阿里妈妈报表页=1（共 4 个页签）
     · 不属于期望清单：https://login.taobao.com/havanaone/login/login.htm?bizName=taobao
     · 不属于期望清单：https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new
     · 不属于期望清单：file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=盖文淘宝&por…
   回位：不需要 —— 已经恰好一个性能页（https://sycm.taobao.com/custom/login.htm?_target=…）
   回位后 生意参谋工作页 是 0 个（回位前 0 个）
   ```
   页签里**同时**出现 `login.taobao.com/havanaone/login/login.htm`（淘宝登录页本体）与 sycm 的 `custom/login.htm` ⇒ 会话确实没了。

（旁注：本目录 `98-failure-state.json` 拍的是 `one.alimama.com/index.html#!/login/index`
"阿里妈妈万相台无界版 立即登录"页 —— 这是**感知层拍错页**的已知缺陷，但结论方向与上面一致：都在登录墙。
以请求单的 `cause/stage` 为准，`98-failure-state.txt` 字段全 `?` 也是已知渲染 bug。）

## 试过的候选动作

| 候选 | 是否执行 | 回读结果 | 判定 |
| --- | --- | --- | --- |
| `RESET_PAGES`（候选#1） | 已跑 dry-run | exit=0，`会执行 RESET_PAGES`（排练不连代理，无语义） | **脚本自己的 auto-repair 真跑过它**：`summary.json` 的 `autoRepair.rounds[0]` = `{"action":"RESET_PAGES","applied":false,"detail":"归位后仍不齐（生意参谋工作页=0  阿里妈妈报表页=1）"}` ⇒ 归位再试仍落在登录墙 |
| `RELOAD_PAGE`（候选#2） | **不可执行** | 窗口已释放（`curl` 空响应 / 端口不在听）；且 `health-check` 不在 `STAGE_PAGE_HINT` 里 ⇒ 即使有窗口，`locateStagePage` 也会因"没有阶段页提示"停手 | 即便能跑，**重载一个登录墙只会得到另一个登录墙** —— 页面类修复对登录失效无效（`repair-actions.mjs:215` 的 `note` 就是这个口径） |

**候选都打不中真因**：真因是会话失效，而修复动作闭集里**刻意没有登录动作**
（`repair-actions.mjs:44-47`：登录要么走 `login-merchant.mjs`、要么交给人）。⇒ 按作业指导书第 6 步转人。

## 需要人做什么

1. 打开**盖文淘宝自己的那个窗口**（调试端口 19033，窗口里会显示"这个浏览器窗口是给这家店用的"），
   用「盖文淘宝」的账号登录；登完点浏览器提示里的「保存」把密码存下来（存过之后系统下次能自动登）。
   —— 判据：该窗口的生意参谋工作页不再是 `custom/login.htm?_target=…`。
2. 然后重跑该店：`node scripts/run-daily-job.mjs --date 2026-10-01 --shops 盖文淘宝`，
   读 `01-health-check.txt` 应变成 `归位：本来就在位（生意参谋工作页=1 阿里妈妈报表页=1）`。
3. 回读底单：`node skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs --date 2026-10-01`。
4. 注意：本店整条链从第 0 步就没过 ⇒ **底单 2026-10-01 的盖文淘宝那一行没有写**。

## 改了什么代码

**本案没有代码修法**：这不属于脚本缺陷（页面类修复/文件判据都碰不到"会话失效"），
也不该为此在修复动作闭集里加登录动作（那是把"交给人"的活塞进自动修复菜单，方向相反）。

但本轮确实改了仓库代码，两处都**与本店无因果关系**（完整 diff 见本目录 `97-repair-agent-code-diff.patch`）：

- ① `collect-core.mjs`：放宽店铺报表文件名判据（科塔淘宝的根因）。
- ② `run-multi-shop-day.mjs`：自动修复执行器 `execRepair` 补传 `cause`（影响所有跑 auto-repair 的店）。

**顺带指出本店 auto-repair 记录的一处"看起来更糟"的原因**：本店 `autoRepair.rounds[0]` 是
`{"action":"RESET_PAGES","applied":false,"detail":"归位后仍不齐（生意参谋工作页=0 阿里妈妈报表页=1）"}` ——
`RESET_PAGES` 是唯一**不需要**定位目标页的动作，所以它是四家里唯一"真的跑到动作本身"的一家；
剩下那家候选 `RELOAD_PAGE` 因为上面 ② 的缺陷连"该修哪一页"都定位不到。
详见 `../b1/科塔淘宝/97-repair-agent-report.md` 的「②」一节。

## 边界遵守情况

- 只读现场 + dry-run 排练；**未**改 `.workbuddy/`；**未**启动/停止/重启任何进程或浏览器；**未**发飞书。
- 写动作仅限本证据目录下的本报告与脚本自动写的 `97-repair.json`/`97-repair.txt`（`dryRun:true`）。
- 基线 `git log -1` = `66321974406c9b7f073cf097cb80bc72bdd6e95e`。
