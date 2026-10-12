# 修复 agent 报告 —— 科塔淘宝

- 目标日：2026-09-30（Asia/Shanghai）
- 失败阶段：`shop-report`｜成因：`STAGE_FAILED`
- 代理：`http://127.0.0.1:19044`（与 `runtime/browser-ports.mjs` 的 `shopInstance('科塔淘宝').proxyPort` 一致 ✓）
- 结论：**agent 修不动（现场已不在）—— 转人**。**未执行任何修复动作**，未写飞书。

## 时间线

| 时刻（+0800） | 动作 | 结果 |
| --- | --- | --- |
| 15:57 | 读作业指导书 | 口径就位 |
| 15:58 | 读 `97-repair-request.json` / `05-shop-report.txt` / `98-failure-state.*` / `99-recovery.txt` / `04-sycm-date.txt` | 现场事实已取 |
| 15:58 | `curl http://127.0.0.1:19044/targets` | **exit=7（连接被拒）** |
| 15:59 | 监听端口扫描 19000–19100 | 只有 **19022 / 19023** |
| 16:00 | 判定停工条件满足 | **停手** |

## 失败那一刻的现场（读自落盘证据）

`05-shop-report.txt`（07:41:14Z，`collect-shop-report.mjs` exit=1）：

```
[0/4] 先回位到应用内页
[身份] 生意参谋店铺名 = "科塔全卫定制"（主店）｜期望 "科塔全卫定制" ✓
[1/4] 再进 自助分析 · 公共空间
[2/4] 2.5s：预览按钮 2 个，日报行 #0（命中复核=true，视口内=true）
[2/4] 点开「日报」预览（#0）→ {"clicked":true,"tag":"A","text":"预览"}
[3/4] 3s：统计区间=["2026-09-30","2026-09-30"]｜下载按钮=true
[3/4] 统计区间 2026-09-30 ~ 2026-09-30 含目标日 2026-09-30 ✓
[4/4] 点「下载报表」
      → y=236（中心点命中） → {"clicked":true,"tag":"SPAN","text":"下载报表"}
      等待下载… 3s …（每 3s 一次，一直到）… 30s

采集失败：30000ms 内没等到新的店铺报表：判据取文件系统，页面说「已触发下载」不算数
```

`04-sycm-date.txt`：`--site sycm --date 2026-09-30` → `status=APPLIED`（落位成功）。

`98-failure-state.json`（07:42:00Z）拍到的是**另一个页面**（本项目已知的感知层缺陷）：

```
url   : https://sycm.taobao.com/lyone/auto_analysis/datafetch/report_generation?...&reportId=6311903&type=preview
title : 瓴羊One·分析
tables: [ {rows:0,  cols:120}, {rows:2, cols:119} ]   ← 日报预览页，119/120 列都在
可见文本: 统计日期： 2026-09-30～2026-09-30 … 2026-09-30 科塔全卫定制 1,934 0 3 …
interactive: [ 下载报表 @ (590,231,80,28) , 加入我的报表 , 加入在线表格 ]
```

**读法**：这张截图**与失败同形**——正是「点了下载、页面在预览页、30s 内没有文件落盘」那一刻
（`waiting` 期间被拍下，所以预览页仍然活着）。它证明了业务侧的判据：
**下载动作被命中、统计区间正确、页面正常**，而**文件系统里没有新 xlsx**
⇒ 失败发生在「浏览器点击已发出 → 文件落盘」之间，不在页面上。

`99-recovery.txt`（停手时页签，共 4 个）：

```
· https://sycm.taobao.com/lyone/auto_analysis/datafetch/report_generation?insertType=sycm&layoutHide=1&useDebug=
· file:///D:/Retire/sycm-automation/runtime/shop-window-label.html?shop=%E7%A7%91%E5%A1%94%E6%B7%98%E5%AE%9D&por
· edge://downloads-hub/                      ← 与「文件没落盘」同一条事实链
回位：把 .../report_generation?insertType=sycm&la 送回 .../qos/service/frame/shop/performance/new#/shop
回位后 生意参谋工作页 恰好一个
```

`edge://downloads-hub/` 这个页签值得注意：它是 Edge 的下载中心，与「30s 内 Downloads
目录没有新 xlsx」是同一件事的两种呈现。本店目录下**没有** `shop-report-manifest.json`
（对比保拉淘宝有），说明采集脚本确实**没能产生产物清单**。

## 试过的候选动作

**一个都没试**，因为现场已不在（19044 无监听、`edge-profiles/shop-j873522735` 无进程）：

```
$ curl -s --max-time 8 http://127.0.0.1:19044/targets ; echo exit=$?
exit=7
```

顺带记录一处**预期内的**行为，供下次现场恢复后参考：候选 `REAPPLY_DATES` 在
`repair-shop-stage.mjs:259` 的实现是「如实报告『日期需要重落』，由 agent 重试落位阶段」，
**它本身永远 `applied=false`**（源码注释写明「本动作不重复实现落位」）。本店请求单
`stageHint="sycm"`，所以它若被执行会返回
`日期需要重新落位（sycm）… evidence.needsRetryStage = 'sycn-date'`（实为 `sycm-date`），
然后按流程应换下一个候选 `RELOAD_PAGE`。**此处仅作记录，本次未执行** ——
因为任何调用都会先死在「读不到页签（代理连不上）」。

## 需要人做什么

1. 重跑一轮以拉起实例与代理：
   `node scripts/run-daily-job.mjs --date 2026-09-30 --batches 5 --notify`
2. **重点观察这一家**：它是唯一一家「页面全对、下载点击命中、文件没落盘」的店。
   现场恢复后建议先试 `RELOAD_PAGE`（换一份新渲染再点一次），再不行则人工点一次
   「下载报表」，看 Edge 是否弹下载拦截/多文件下载询问 —— `edge://downloads-hub/`
   页签是否出现是关键旁证。
3. 注意：本家没走到 push，所以**底单第 2026-09-30 行的科塔全卫定制那一行没有写**。

## 权限与边界遵守情况

- 只读现场；**未**改 `.workbuddy/`；**未**启动/停止任何进程、容器或浏览器；**未**碰任何端口。
- **未**改仓库代码 ⇒ 无 patch 文件。**未**发飞书。
- 基线 `git log -1` = `148fefc8dac2bc238f9ba5fe2a520203ec14727d`。
