# 修复 agent 报告 —— 盖文淘宝

- 目标日：2026-09-30（Asia/Shanghai）
- 失败阶段：`health-check`｜成因：`SHOP_BLOCKED`
- 代理：`http://127.0.0.1:19043`（与 `runtime/browser-ports.mjs` 的 `shopInstance('盖文淘宝').proxyPort` 一致 ✓）
- 结论：**agent 修不动（现场已不在）—— 转人**。**未执行任何修复动作**，未写飞书。

## 时间线

| 时刻（+0800） | 动作 | 结果 |
| --- | --- | --- |
| 15:57 | 读作业指导书 | 口径就位 |
| 15:58 | 读本店 `97-repair-request.json` / `01-health-check.txt` / `98-failure-state.*` / `99-recovery.txt` | 现场事实已取（见下） |
| 15:58 | `curl http://127.0.0.1:19043/targets` | **exit=7（连接被拒）** |
| 15:59 | `Get-NetTCPConnection` 扫 19000–19100 | 只有 **19022 / 19023** |
| 15:59 | 统计各 profile 的 msedge 进程 | **`edge-profiles/suixin-custom` 一个进程都没有** |
| 16:00 | 判定：**停工条件「需要起/停任何实例而窗口已不在」已满足** | **停手** |

## 失败那一刻的现场（读自落盘证据）

`01-health-check.txt`（07:39:41Z）—— **与里可林淘宝逐字同形**：

```
归位：归位后仍不齐（生意参谋工作页=0  阿里妈妈报表页=1）
体检未通过：阻断 1 项，告警 1 项
  [阻断] TARGET_PAGE_MISSING：目标页面「生意参谋工作页」不在这个浏览器里
         （按片段 sycm.taobao.com/qos/service/frame/shop/performance 找到 0 个）
[归位] 生意参谋工作页：reclaim｜found=0
       url = https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop
       from = https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop
       targetId = 13223B02ADCEF82A74A3A1BB4A82AEC4｜status = 200
```

`batches.log` 里本店停手时的页签（共 4 个）：

```
· https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new
· https://login.taobao.com/havanaone/login/login.htm?bizName=taobao
· file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=%E7%9B%96%E6%96%87%E6%B7%98%E5%AE%9D&por
回位后 生意参谋工作页 是 0 个（回位前 0 个） —— 下一轮仍然会从这个起点开始，先看现场
```

**读法**与里可林淘宝完全一致：归位动作自己发出的那条 `reclaim` 的 `from` 是
sycm 自己的 `/custom/login.htm?_target=...`（带 `_target=` 参数＝**服务端弹回**），
而 `login.taobao.com/havanaone/login/login.htm` 那个页签是**本来就存在**的、不是归位产生的
⇒ 会话已被弹回登录页。判据来自 `01-health-check.txt` 的归位 JSON，**不是**那张可能拍错页的截图。

## 试过的候选动作

**一个都没试**，原因与里可林淘宝同源 —— 现场已不在：

```
$ curl -s --max-time 8 http://127.0.0.1:19043/targets ; echo exit=$?
exit=7
$ 监听端口 19000-19100：只有 19022 / 19023
$ msedge 的 --user-data-dir 分布：只有 edge-daily-report-profile
```

`D:/Retire/edge-profiles/suixin-custom`（本店 profile）无进程，19033 / 19043 无监听。
`repair-shop-stage.mjs` 的一切动作都以 `--proxy` 为唯一实例选择器，
跑它只会得到「读不到页签（代理连不上）」，因此未执行。候选 `RESET_PAGES` / `RELOAD_PAGE`
**都没有被证伪，也都没有被执行** —— 待现场恢复后可再试。

## 需要人做什么

同里可林淘宝（两家同形，建议一并处理）：

1. 重跑一轮以重新拉起实例：`node scripts/run-daily-job.mjs --date 2026-09-30 --batches 5 --notify`
2. 若仍报 `TARGET_PAGE_MISSING`，即会话问题 ⇒ **只能人登**：人工打开该店浏览器窗口登录一次。
3. 上游进程 `run-daily-job.mjs` 于 15:55:17 以 `exitCode: 1` 结束，分批形态跑完即释放
   ⇒ 5 家店铺实例与其代理已随之消失（共享商家浏览器 19022/19023 因不属任何批次而存活）。

## 权限与边界遵守情况

- 只读现场；**未**改 `.workbuddy/`；**未**启动/停止任何进程、容器或浏览器；**未**碰任何端口。
- **未**改仓库代码 ⇒ 无 patch 文件。**未**发飞书。
- 基线 `git log -1` = `148fefc8dac2bc238f9ba5fe2a520203ec14727d`。
