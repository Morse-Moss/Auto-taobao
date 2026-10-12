# 修复 agent 报告 —— 里可林淘宝

- 目标日：2026-09-30（Asia/Shanghai）
- 失败阶段：`health-check`｜成因：`SHOP_BLOCKED`
- 代理：`http://127.0.0.1:19041`（与 `runtime/browser-ports.mjs` 的 `shopInstance('里可林淘宝').proxyPort` 一致 ✓）
- 结论：**agent 修不动（现场已不在）—— 转人**。**未执行任何修复动作**，未写飞书。

## 时间线

| 时刻（+0800） | 动作 | 结果 |
| --- | --- | --- |
| 15:57 | 读 `docs/ops/REPAIR-AGENT-HANDOFF.md` | 得到作业口径 |
| 15:58 | 读本店 `97-repair-request.json` / `01-health-check.txt` / `98-failure-state.*` / `99-recovery.txt` | 现场事实已取（见下） |
| 15:58 | `curl http://127.0.0.1:19041/targets` | **exit=7（连接被拒）** |
| 15:58 | 同一命令对 19043 / 19044 / 19063 | 全部 **exit=7** |
| 15:59 | `Get-NetTCPConnection` 扫 19000–19100 全部监听端口 | 只有 **19022 / 19023**（共享商家浏览器与其代理） |
| 15:59 | 统计各 profile 的 msedge 进程 | 只有 `edge-daily-report-profile`；**`edge-profiles/*` 一个进程都没有** |
| 16:00 | 查 `Retire` 相关 node 进程 | 只有 `start-daily-report-browser.mjs(57436)` / `start-daily-report-proxy.mjs(45740)`，都起于 15:31:07 |
| 16:00 | 判定：**停工条件「需要起/停任何实例而窗口已不在」已满足** | **停手，不做修复动作** |

## 失败那一刻的现场（读自落盘证据，不是猜的）

`01-health-check.txt`（07:36:05Z）：

```
归位：归位后仍不齐（生意参谋工作页=0  阿里妈妈报表页=1）
体检未通过：阻断 1 项，告警 1 项
  [阻断] TARGET_PAGE_MISSING：目标页面「生意参谋工作页」不在这个浏览器里
         （按片段 sycm.taobao.com/qos/service/frame/shop/performance 找到 0 个）
[归位] 生意参谋工作页：reclaim｜found=0
       url = https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop
       from = https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop
       targetId = 04C047FE3360738550F4AE1A62F2E681｜status = 200
```

`99-recovery.txt`（停手时页签，共 4 个）：

```
· https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new
· file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=%E9%87%8C%E5%8F%AF%E6%9E%97%E6%B7%98%E5%AE%9D...
· https://login.taobao.com/havanaone/login/login.htm?bizName=taobao
回位：不需要 —— 已经恰好一个性能页
回位后 生意参谋工作页 是 0 个（回位前 0 个）
```

**读法**：`login.taobao.com/havanaone/login/login.htm` 这个页签**存在**，但**不是**归位动作产生的那一个
（归位动作 `reclaim` 的 `from` 是 sycm 自己的 `/custom/login.htm?_target=...`）。
`_target=` 是服务端帮未登录访客回跳用的参数 —— 它是**会话失效被弹回登录页**的形态，
而不是「页签停在登录页原样加载」。与感知层的已知缺陷（`98-failure-state.txt` 全 `?`、截图拍到别的页）
无关：**这里判据来自 `01-health-check.txt` 的归位 JSON，不是那张截图**。

## 试过的候选动作

**一个都没试。** 原因不是「动作不对」，是**现场已经不在了**：

```
$ curl -s --max-time 8 http://127.0.0.1:19041/targets ; echo exit=$?
exit=7
$ Get-NetTCPConnection -State Listen | 过滤 19000-19100
19022   (edge-daily-report-profile)
19023   (start-daily-report-proxy.mjs)
$ 过滤 msedge 进程的 --user-data-dir
D:/Retire/edge-daily-report-profile   ← 只有这一个 profile
D:\Retire\edge-daily-report-profile
```

`D:/Retire/edge-profiles/likelin-home` 这个 profile **一个进程都没有**，它的调试端口 19031
与代理端口 19041 都**没有监听**。`repair-shop-stage.mjs` 的每一个动作都要经过
`--proxy` 选实例（`RELOAD_PAGE`/`REAPPLY_DATES` 还要先 `locateStagePage` 读页签），
现在跑它只会得到「读不到页签（代理连不上）」。**这不是修复，这是一次注定失败的调用**，
所以没有执行。

## 为什么「起实例再修」不是 agent 该做的事

- 作业指导书的**停工条件**逐字写着：「或**需要起/停任何实例而窗口已不在** —— 停手报告，
  **不要自行 start-all**」。
- 本批判据：上游进程 `run-daily-job.mjs`（起于 15:31:07）在 **15:55:17** 以 `exitCode: 1` 结束
  （见 `evidence/daily-job-2026-09-30/run-receipt.json` 的 `finishedAt`）。分批形态**跑完即释放**
  （`runtime/daily-job-plan.mjs` 里那段注释：命令结束宿主会回收整棵进程树），
  所以 5 家店铺实例连同它们的代理**随上游进程一起消失**，共享商家浏览器
  （19022/19023，不属于任何批次，只被停止的定时任务自己拉起，故存活）是唯一活着的实例。
- 因此这四家店的修复**必须与一次真实运行同场**才有对象可修。

## 需要人做什么

1. **重新跑一轮**（会重新拉起 5 家店铺实例）：
   ```
   node scripts/run-daily-job.mjs --date 2026-09-30 --batches 5 --notify
   ```
2. 若仍卡在 `TARGET_PAGE_MISSING`，那说明是**会话问题而不是页签漂移**：
   判据是登录页 URL 的 `_target=` 参数（被服务端弹回）而不是 `login.taobao.com`
   这个主机名单独出现（`99-recovery.txt` 里它一直都在，却仍判 `AUTH_UNKNOWN`）。
   这种形态**只能人登**：在那台机器上打开这家店的浏览器窗口，人工登录淘宝商家账号一次。
3. 人登完之后再跑一次同一轮，本店的 `health-check` 才能过。

## 权限与边界遵守情况

- 只读现场：读证据文件 + `curl` 只读探测 + `Get-NetTCPConnection` / `Get-CimInstance` 进程盘点。
- **未**改 `.workbuddy/`；**未**启动/停止/重启任何进程、容器或浏览器；**未**触碰任何端口。
- **未**改仓库代码 ⇒ 无 `97-repair-agent-code-diff.patch`。
- **未**发飞书（飞书叫人由主会话那一层决定）。
- 动代码前的基线：`git log -1` = `148fefc8dac2bc238f9ba5fe2a520203ec14727d`（Thu Oct 1 15:54:30 2026 +0800）。
