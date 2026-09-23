# 明日前置体检（2026-09-23 记，面向 2026-09-24 那一轮）

目的：回答「明天（09-24）的定时日报会不会顺利」。结论先写在这里，原始输出在 `raw/`。

## 结论先行

1. **五家店这一侧已经就绪**：六台 profile 的淘宝凭据在 09-23 晚已收敛成「每台同 origin 恰好 1 条、且都是本店账号」，
   链的第②步 `login-preflight`（默认带 `--login`）会在跑前对五家店自己登一次；登不进去才发飞书告警。
2. **唯一的缺口是商家浏览器（19022/19023）**：它掉登录 ⇒ 链第 0 步找不到它的「生意参谋工作页」⇒ **整轮一步都不跑**。
   而**没有任何一步会自动登它**（`check-login-shops.mjs` 刻意只查五家店；批次计划的共享实例那一步只有「起」没有「登」）。
3. **它此刻是活着且已登录的**（见下「现场快照」），但这份保证**只对「本会话还开着、机器没重启」成立** —— 关会话或重启即失效。
4. **另一条要拍板的事**：定时任务 `sycm 日报定时（每日 11:40）` 的排期实际是 **08:14**，与它名字里的「11:40」对不上
   （见下「排期不一致」）。**未擅自改动。**

## 明天会原样执行的三条命令

来自 `node scripts/run-daily-job.mjs --print`（只打印、没有起任何进程），原始输出在 `raw/daily-job-print.txt`：

```
1. ensure-instances  node scripts/start-all.mjs
                     （幂等：已就位的不碰；把声明实例起齐）
2. login-preflight   node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --login --json
                     （会碰页面：掉登录的当场自己登一次；登不进去当场各发一条飞书告警）
3. chain             node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs
                       --date yesterday --commit --notify-print
                       --login-preflight <本轮证据目录>/login-preflight.json
```

版本＝`sycm-automation 1.6.0`；目标日字面量＝`yesterday`（由驱动按 Asia/Shanghai 解析，跨零点不漂）。

**注意第 1 步是「起齐全部 7 个实例」**：里面包含商家浏览器。如果那时它不在，这一步会**冷启动**它 ——
而它会话级 cookie 在进程结束时已丢，起来就是未登录；第 2 步**不覆盖它**，于是第 3 步在第 0 步体检就停。

## 现场快照（2026-09-23 17:1x）

`node runtime/browser-inventory.mjs`（只读对账），原始输出在 `raw/inventory.txt`：

| 实例 | 浏览器 | 代理 |
|---|---|---|
| 竞品链 | 9222 free | 3457 连不上 |
| **商家浏览器（日报/周表/灰豚）** | **19022 occupied（profile 一致）** | **19023 在** |
| 里可林淘宝 / 网林天猫 / 盖文淘宝 / 盖文天猫 / 科塔淘宝 | 19031~19035 全 free | 19041~19045 全连不上 |

⇒ 与「跑完释放」的口径一致：**只留商家浏览器在跑**，五家店等明天第 1 步自己起。

## 排期不一致（待拍板）

| 项 | 值 |
|---|---|
| 任务名 | `sycm 日报定时（每日 11:40）` |
| 实际 rrule | `FREQ=DAILY;BYHOUR=8;BYMINUTE=14` ⇒ **每天 08:14** |
| 创建时（09-21） | `BYHOUR=11;BYMINUTE=40` ⇒ 11:40 |
| 触发记录 | 09-21 11:41、09-22 11:41、**09-23 08:15** |

**没有任何记录说明这是谁改的、什么时候改的。** 风险不在「跑不跑得成」（09-23 那次全绿），
而在**数据面**：业务口径里「**11:40 是唯一安全边界**」——阿里妈妈推广块上午有未回补窗口（8 指标 0→非 0），
而查重键是「同一天＋同店铺」⇒ **早跑写进去的低值无法同日重推修正，只能先把那天删掉**。
⇒ 两个选项：**把排期改回 11:40**（推荐，与任务名和既有边界一致）／**改任务名承认 08:14**。

## 明天开跑前必须成立的条件

- [ ] 机器没重启过、或重启后有人确认过商家浏览器是**已登录**的（只读复核命令见下）。
- [ ] 商家浏览器的「生意参谋工作页」**恰好 1 个**（链第 0 步的前置，漏了整轮不跑）。
- [ ] 五家店只要能被第 2 步自己登起来就行（凭据已收敛，无需人工）。

## 只读复核命令（都不写生产数据）

```
node runtime/browser-inventory.mjs                 # 谁还活着
node runtime/shop-pages.mjs                        # 六个后台的期望页面各几个（只读，exit 2＝有缺口）
node scripts/run-daily-job.mjs --print             # 明天会原样跑的三条命令
node runtime/start-all-hold.mjs --only dailyReport # 需要把商家浏览器托住时（后台跑）
```

## 缺口（未修，需拍板）

**给商家浏览器一条「自动登它」的路**（现为 1.7.0 候选）：它既不在 `check-login-shops.mjs` 的覆盖里，
批次计划 `SHARED_INSTANCE_KEYS = ['dailyReport']` 的 `buildSharedStep()` 也只有「起」没有「登」。
要接上还得先解决 `--shop` 与 `--proxy` 必须配对（`judgeShopTarget`）这件事 ——
**共享实例没有店名，于是它的身份守卫目前是空转的**（真机复核判 `UNKNOWN`、`guardBasis: no_expected_member`）。
