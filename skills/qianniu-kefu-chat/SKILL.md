---
name: qianniu-kefu-chat
description: Export per-shop 千牛 customer-service chat history for a natural week (with lookback) through the shop's isolated browser and the 聊天记录查询 mtop APIs, then package it into txt/csv/json plus a 总览 page for operations.
---

# 千牛客服聊天记录（周采集）

平台**不支持批量导出聊天记录**（淘宝官方帮助中心原话：只能看近 3 个月，无导出）。唯一可行的路线是
在店铺自己的浏览器里打开千牛「聊天记录查询」应用，用页面内的 `window.lib.mtop.request` 直调接口，
绕开 UI 点击与 sign。本技能把这套路线固化成可周更的脚本。

## 前提

- 目标店铺浏览器与代理**已在运行**（端口来自 `runtime/browser-ports.mjs`，一店一 profile）。
  本版不负责起停；批次壳（`run-batches`）负责起停是接入第二步。
- 店铺浏览器里的账号必须登录着（聊天记录域是 `market.m.taobao.com`，与日报链维护的
  `myseller/sycm/alimama` 域**不是同一套登录态**，会单独过期）。掉登录时脚本会尝试自动恢复，
  但那条登录流程只覆盖生意参谋/阿里妈妈，**恢复不了就如实报 `NEEDS_LOGIN`**（见下节）。
- 店铺全称取 `skills/sycm-alimama-daily-report/scripts/shop-identities.mjs` 的 `fullName`。

## 接口与语义（2026-10-19 实测，别凭猜测改）

页面：`https://market.m.taobao.com/app/qn/im-history-search/index.html#/`

| 动作 | 接口 | 关键入参 |
|---|---|---|
| 会话列表 | `mtop.taobao.wireless.amp2.paas.conversation.list` | `selfWwNick:null,targetWwNick:null,beginDate,endDate`（YYYYMMDD，闭区间） |
| 消息明细 | `mtop.taobao.wireless.amp2.im.paas.message.list` | `userNick,cid,userId,cursor,forward,count` |

实测结论（改代码前先读）：

1. **会话列表按「会话创建时间」过滤**，不是最后消息时间。单周查询是完整的
   （按天拆开求并集＝单周结果，逐 cid 相等）。
2. **宽区间会被截断**：一次查 8-01~9-30 只回 8 月那批（上限约 200~240 行）。
   ⇒ 必须切块，单块 ≤ 7 天（`MAX_CHUNK_DAYS=14` 是硬上限，默认 7）。
3. **创建于本周之前、本周有消息的会话不会被单周查询返回**。实测 9-21~9-27 那周
   159 场活跃会话里 36 场属于这类（22.6%），全部落在 30 天内，30 天以上 0 场。
   ⇒ 每次查询必须带 `--lookback-days 30` 回溯，再按窗口过滤消息。
4. **消息明细没有结束边界**：`cursor` 是起始时间戳，`forward:true` 向后翻页，
   会一直翻到「现在」。取回后必须按 `[周一 00:00, 下周一 00:00)` 过滤；
   某页首条已越过窗口末尾即可停（`hasMore` 仍可能是 true）。
5. **`userId` 必须取会话行的 `userID.appUid`**。拿 cid 里的数字段顶替会被判
   `not same shop::请输入完整的同店账号`。
6. **`userNick` 只需 `cntaobao<店铺全称>`**（实测不带子账号、带任意子账号都认，
   只有不带 `cntaobao` 前缀会报 not same shop）。
7. 方向判定（**别再把会话行 userID 当买家**，2026-10-19 踩过）：
   · 客服 = 会话行的 `userID.appUid`（实测那一侧是「里可林家居:小俊」）∪ 昵称带 `店名:` 的发送方 uid；
   · 买家 = 本场「非店侧 uid 里的众数」（或昵称等于 `displayName` 的发送方）；
   · 其余 = 系统。实测四家店买家约 43-45%、客服约 55%、系统 < 1%。
8. 机器人会话：cid 含 `#11005`（店小蜜）。

## 用法

```bash
# 采上一完整自然周（周一 00:00 ~ 周日 24:00），默认四家店
node skills/qianniu-kefu-chat/scripts/export-kefu-chat.mjs --week last-week --notify

# 只想看「将要发到飞书的原文」而不真发（第一次上调度前先过目）
node skills/qianniu-kefu-chat/scripts/export-kefu-chat.mjs --week last-week --notify-dry-run

# 指定某一天所在周 / 指定店铺 / 指定回溯
node skills/qianniu-kefu-chat/scripts/export-kefu-chat.mjs \
  --date 2026-09-21 --shops 盖文天猫,里可林淘宝 --lookback-days 30

# 打包成运营交付物（txt/csv/json/总览）
node skills/qianniu-kefu-chat/scripts/package-kefu-chat.mjs \
  --src evidence/kefu-chat-2026-W42/<runId> --out output/kefu-chat/2026-W42

# 交付物验收（只读复核：条数自洽、窗口、方向、重复、BOM、块数）
node skills/qianniu-kefu-chat/scripts/verify-pack.mjs --out output/kefu-chat/2026-W42
```

退出码：`0` 全成；`3` 有店需要人（`NEEDS_LOGIN` / `PAGES_ABSENT`）；`1` 其它失败。

跑批口径、交付物长什么样、怎么验收（独立复核命令）见 `docs/ops/KEFU-CHAT-WEEKLY.md`。

## 自动登录（2026-10-19 加）

探测到聊天记录接口不再认这个会话时，脚本会**自己调一次仓库既有的登录流程**
（`skills/sycm-alimama-daily-report/scripts/login-merchant.mjs`），然后**重新问一次聊天记录接口**。

```bash
# 默认就开；关掉：
node skills/qianniu-kefu-chat/scripts/export-kefu-chat.mjs --week last-week --no-auto-login
# 强制走一遍登录流程（账号本来就登着时它只会判 ALREADY_LOGGED_IN，不改状态）——
# 用来证明这条接线是通的，因为日常里它永远不会被执行：
node skills/qianniu-kefu-chat/scripts/export-kefu-chat.mjs --week last-week --shops 里可林家居 --rehearse-login
```

**必须知道的一条**：那条登录流程只验「生意参谋」和「阿里妈妈」两个后台
（它的 `SITES` 里就这两个键），而聊天记录页在 `market.m.taobao.com` —— **不在其中**。
所以它报 `LOGGED_IN` / `ALREADY_LOGGED_IN` **不等于**聊天记录能用。本脚本据此设了三道：

1. 它说成了 ⇒ **重新加载聊天记录页**（登录换掉的是 cookie，已跑起来的单页应用会把旧会话留在内存里）
   并**再探一次**接口；
2. 再探仍不认 ⇒ 报 `NEEDS_LOGIN`，原因写明「自动登录报了成功但接口仍拒绝」，**不继续采**
   （否则会采出 0 场，看着像「这一周没人聊天」）；
3. 它说要人（滑块、没存凭据、填成别家、提交没生效…）⇒ 原样把结论带进 `error`，只试这一次，不重试。

子进程固定带 `--commit`（不带就只是只读排练，看着跑过实际一个键都没按）和 `--notify off`
（不让它绕过本链的告警策略自己往飞书发）。登录回执落在证据目录 `login-<店铺键>.json`。

## 失败模式与处置

| 状态 | 含义 | 处置 |
|---|---|---|
| `BROWSER_DOWN` | 端口连不上 | 先起该店浏览器（`start-all.mjs --only <店>`）；本脚本不代起 |
| `PAGES_ABSENT` | 页面打开了但 `window.lib.mtop` 15 秒内不可用 | 人在该窗口看一眼；别连试 |
| `NEEDS_LOGIN` | 接口返回会话过期，**自动登录也没能解决** | 看 `error` 里的登录结论；`CAPTCHA_REQUIRED` 等只能人工。**别连试**（连着试会锁号） |
| `LIST_FAILED` | 列表接口报错（非会话过期） | 看错误码；网络类可重跑，风控类停下 |
| `COLLECT_FAILED` | 有会话没采完 | 重跑幂等（按 cid 去重），不会产生重复行 |

已知成本（2026-10-19 实测，不是估算）：回溯 30 天时每店候选会话 180~541 场，
**四家全量 11 分 37 秒**；单店 `里可林家居`（42 场）约 15~20 秒，`盖文天猫`（176 场、候选 541 场）约 8 分钟。
预算参数：页内 `SESSION_BUDGET_MS=18s`、单请求 6 秒、连挂 3 次才判失败（另有整遍重试回合）。

注意「抓了 541 场只用到 176 场」不是浪费：会话列表按创建时间过滤，30 天回溯是必须的
（创建于本周之前、本周有消息的占活跃会话 22.6%）；而 `modifyTime` 可能比真实末条早最多 17 天，
拿它预筛会漏数据。所以约 2/3 的空会话是这套口径的固有代价。

## 与既有链路的关系
- 复用：`runtime/browser-ports.mjs`（端口唯一来源）、`shop-identities.mjs`（店铺全称）、
  `runtime/notify-feishu.mjs`（告警投递）。
- **不复用**：日报链的登录维护（域不同）、自修复候选集（对千牛 SPA 未验证，
  本链明确声明「无自修复能力」）。
- 第二步（未做）：在 `runtime/workflow-catalog.mjs` 登记 `kefu-chat` 并走
  `scripts/run-batches.mjs`，白拿批次起停、释放与 `unfixableShopsOf` 托住逻辑；
  调度建议周日 21:00（避开日报 08:00 / 商品 10:00 / 推广 11:00）。

## 复核手法（探针是一次性的，不入库）

上面每条实测结论都是 2026-10-19 用一次性探针验的，脚本在 `tmp/kf-probe-*.mjs`（`tmp/` 已被 gitignore，
新克隆不会有）。要复核时按同样手法重写，别凭印象改判据：

- **接口语义**：在店铺页里直接 `window.lib.mtop.request({...})` 拿原始返回，打印行数/字段，
  而不是经本 skill 的归一化结果判断（归一化会把问题吃掉）。
- **窗口完整性**：同一周分别按「单周」和「按天拆开求并集」查一遍，逐 cid 对比是否相等。
- **回读对条数**：从交付 json 挑会话，用**另一条代码路径**重取一次，比条数与首末时间；
  一次 eval 只翻一页，别在一屏里翻完（代理 30 秒上限）。可用
  `verify-pack.mjs` 做结构复核，但它不替代真回读。
