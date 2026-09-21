# 科塔「生意参谋工作页留不住」的根因取证（2026-09-21）

## 一句话结论

**科塔全卫定制 的生意参谋账号没有「单店版-服务洞察专业版」（`service-analyze-C`）这项功能权限。**
平台对工作页 `/qos/service/frame/shop/performance` 直接 302 到
`/custom/no_permission?code=5903&message=No Buy Func Permission.`；
另外四家店都是 200。所以工作页**只要我们一重新加载/导航就必然被弹走**，这不是我们这一侧能修的。

## 为什么「去现场看一切正常」

工作页的地址是 `/qos/service/frame/shop/performance/new#/shop` —— 带 `/new` 的那条。
实测（本目录 `sycm-entry-http-compare.txt`）：

| 路径 | 科塔 | 盖文淘宝（健康） |
| --- | --- | --- |
| `/qos/service/frame/shop/performance/new` | 200（**服务端不拦**）→ 页面自己的 JS 再跳走 | 200 |
| `/qos/service/frame/shop/performance` | **302 → `/custom/no_permission?code=5903`** | 200，不跳 |

带 `/new` 的入口**不报错**，只是静静地落到一个生意参谋首页
（`/mc/free/sycm` 或 `/portal/home.htm`，两者都出现过）。人打开浏览器看到的是
「生意参谋已经登录、店铺名对、首页有数、菜单里『服务 → 考核 → 店铺绩效』也在」——
没有任何一处显示「你没权限」。所以人会判断「一切正常」。

菜单不做筛选（`sycm-menu-node.txt`：两家店的 `店铺绩效` 节点逐字相同，
`menuCode=sycm_v2_qos_shop_performance_new_v2`），**点进去才会撞墙**。

## 五家店并排（`sycm-plainpath-5shops.txt` / `sycm-service-analyze-5shops.txt`）

| 店铺 | `/qos/.../performance` 是否被重定向 | 有 `service-analyze-C` | 订购窗口 |
| --- | --- | --- | --- |
| 里可林淘宝 | 否 | 有 | 2026-06-17 → 2027-06-16（余 270 天） |
| 网林天猫 | 否 | 有 | 2026-06-17 → 2027-06-16（余 270 天） |
| 盖文淘宝 | 否 | 有 | 2024-02-20 → 2027-05-22（余 245 天） |
| **科塔淘宝** | **是 ★** | **没有这一条 ★** | — |
| 盖文天猫 | 否 | 有 | 2026-08-03 → 2027-08-02（余 317 天） |

两个独立来源同时指向一项权限：**服务端 302（code=5903）** 与
**`permission.json` 里缺 `service-analyze-C`**。五家店 5/5 相关，没有例外。

`service-analyze-C` = 单店版-服务洞察专业版（moduleId 88，project `customer-service-performance`）。

## 何时坏的（时间线，全部有产物）

| 时间（本地） | 事件 | 证据 |
| --- | --- | --- |
| 09-20 16:33–16:39 | 科塔全链跑通（`08-sycm-reset` 把工作页从报表预览页**导航回**入口地址，随后第 9 步落位、第 10 步读到「询单量=6」） | `evidence/multi-shop-2026-09-19-rerun4/科塔淘宝/08-sycm-reset.txt`、`09-…`、`10-…` |
| 一旦页面被**真正重载** | 弹走 | 见下 |
| 09-21 14:54 | `sycm-date` 报 `重新加载页面后读数仍是 null`（读 16 次全 0），`observedBeforeReload=统计时间 2026-09-19` | `evidence/multi-shop-2026-09-20-rehearsal2/科塔淘宝/04-sycm-date.txt` |
| 09-21 15:00 | 页签已在 `/mc/free/sycm`；领回导航 200 但 3/7/15/30 秒四点全被弹回 | `tmp/reclaim-19044.txt` |
| 09-21 15:37 / 15:52 | 仍是 `/mc/free/sycm` | `keta-targets.json`、`tmp/targets-now.txt` |
| 09-21 15:57 | 整轮停在 `sycm-date`；体检的 reclaim 在 ~1.2 秒的落窗里「看着成功」，5 秒后弹回 | `evidence/daily-backfill-2026-09-20/keta-run.log` |
| 09-21 16:47 | 新建干净页签同样被弹回（5/15/25/35/45 秒五点） | `evidence/daily-backfill-2026-09-20/keta-fresh-tab-probe.json` |
| 09-21 16:51 | 页签在 `/portal/home.htm`（`navName=…/ipoll/index.htm`，即被人点过「数据概览」）。**这就是「现场看正常」的那一刻** | `sycm-tab-state-compare.txt` |

所以：**09-20 那次导航回位还是通的**（权限当时在），
**09-21 14:54 起就再也回不去了**。触发暴露它的是今天新加的「真重载」
（`window.location.reload()`，见状态契约 §10）——重载一个已被收回权限的页面，必然被弹走。

## 页签现场（`cross-shop-sycm-probe.txt`）

```
商家浏览器 19023  页签=3  工作页=1
里可林淘宝 19041  页签=2  工作页=1
网林天猫 19042  页签=2  工作页=1
盖文淘宝 19043  页签=2  工作页=1
科塔淘宝 19044  页签=2  工作页=0   ← 停在 https://sycm.taobao.com/portal/home.htm
盖文天猫 19045  页签=3  工作页=1
```

科塔那一个 sycm 页签（`0F3988566AF5D318E806DF8B456BE2E0`）**就是**原来的工作页——
它没有丢，是被同一个页签里的重定向换成了首页。`localStorage` 也能佐证：
四家健康店里都缓存着 `permission.json?...&p_url=…performance/new` 与
`getPageInfo.json?pageCode=SYCM_fG2ZQMSB`，科塔没有。

## 对我们这一侧意味着什么

1. 这一项**不是**「服务重启 / profile 冲突 / 代理指错 / 导航方式」的问题。进程与端口这一层是干净的
   （科塔只有一个顶层浏览器 PID 22236（19034）与一个代理 PID 41136（19044））。
2. 「先领回」这套自愈对**权限被收回**无效：领回用的是同一个 `/new` 入口，一样被弹。
3. 但**带 `/new` 的入口不报错**这件事很坏：它让我们拿到的是「体检假绿」，
   阶段 4 才炸，而且告警文案写成「这一轮不需要你在浏览器里做什么」——
   真实下一步恰恰是「得有人去这家店的生意参谋开通权限」。这是**该修的那一环**。

## 没做的事（留给人拍板）

- 没有去点科塔首页上的「一键领取」（惠商免费包）或任何「订购」按钮 ——
  那会改真实账号的订购状态，属于对外可见、不可撤销的动作。
- 没有关闭/新建任何页签去「修」科塔现场（除了 16:47 那次探针页签，已按 targetId 关掉并回读自证）。
- 没有起停任何进程。
