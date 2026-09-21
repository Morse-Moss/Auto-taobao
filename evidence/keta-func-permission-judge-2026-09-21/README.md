# 「这一项订购不在账号上」→ 具名失败 + 会叫对人（2026-09-21）

## 一句话

科塔这一项订购不在账号上，是**平台侧**的事；我们能做、也已经做的是：
让它变成一条**有名字、能复现、且不会误杀健康店**的失败，并且让告警说人话 ——
而不是像 09-21 那样只留一句「读数仍是 null」，然后被报成「这家店的窗口里页面不齐，去打开窗口补上」。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `skills/sycm-alimama-daily-report/scripts/date-picker.mjs` | 新增 `probeShopFuncPermission()` / `isFuncPermissionDenied()` / `namedFailure()` / 导出常量 `SHOP_FUNC_NO_PERMISSION`；`SITES.sycm` 新增 `permissionHost` / `permissionProbeUrl`；**两条「页面起不来」的失败路径都先问平台再决定报哪种错** |
| `skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs` | `FAILURE_CAUSES` 新增 `SHOP_FUNC_NO_PERMISSION`；`shopFailureCause()` 新增一条（**优先于「停在哪一步」**）；`REASON_BY_CAUSE` / `ACTION_BY_CAUSE` 各补一条（三张表互锁，少一条模块起不来） |
| `date-picker.test.mjs` | 新增 2 条：判据真值表（「问不到」不许当结论）+ 接线判据（两条路径都真接了、且问的是真模块不是壳） |
| `run-multi-shop-day.test.mjs` | `shopFailureCause` 新增两个用例；告警渲染表的 `cases` 补一条（那张表要求「每一条结论都必须被渲染一次」） |

## 判据长什么样

问平台一句，而不是接着猜。同一个地址（**不带 `/new`** 的那条真模块），平台答得是确定性的：

```
里可林淘宝  asked=true code=0      → isFuncPermissionDenied=false
网林天猫    asked=true code=0      → false
盖文淘宝    asked=true code=0      → false
科塔淘宝    asked=true code=5903   → true    （message: No Buy Func Permission.）
盖文天猫    asked=true code=0      → false
```

三条设计上的选择，都是被现场逼出来的：

1. **问的必须是不带 `/new` 的真模块。** 带 `/new` 的壳对谁都回 `code:0`（它是给菜单用的），
   拿它当判据会永远判「没问题」——这一条有专门的用例守着。
2. **「问不到」一律不算。** 页面漂走了、网络抖了、eval 的上下文被重载拆了 —— 这些都返回 `asked:false`，
   判据只认「问到了、平台明确说不在」。**无法解释不能当结论用**（否则会把一次读失败写成「这家店没订购」）。
3. **两条失败路径都要接，且顺序不能反**（先问、再抛）。现场里科塔两种形态都出现过：
   14:54 是「页面还在位、重载后读不出来」，15:58 是「页面已漂到首页、连页面都认不出」。
   接线判据扫源码钉住这两处 —— 只改一条会被逮住。

## 逐条证据（都在本目录）

| 产物 | 证明的事 |
| --- | --- |
| `01-keta-live.txt` | **现场实跑**：先 `recover-entry` 导航回入口 → 认不出页面 → `shop-func-permission-probe` 拿到 `code=5903` → 抛 `SHOP_FUNC_NO_PERMISSION`（exit 1） |
| `02-gaiwen-tb-control.txt` | 健康店同一步照旧 `status=APPLIED`、`presetWasNoop=true`、trace 里没有探针 ⇒ **没有误杀，健康路径行为与从前逐字相同** |
| `03-probe-5shops.txt` | 五家并排跑同一个探针：4 家 `code=0`、科塔 `code=5903` ⇒ 判据的分界线在真实数据上成立 |
| `04-round-rehearsal.log` | 整轮（排练档，不写飞书）：**第 1 家就停住**（`DUPLICATE_TARGET` —— 这天飞书里已有数据，脚本按「不许写第二遍」停整轮），所以科塔这一轮**没被跑到** |
| `05-keta-round-only.txt` | 于是单独跑科塔一家（`--shops 科塔淘宝`）拿**端到端**证据：落到第 4 步 `sycm-date` 失败，驱动的 `summary.json` 里带上新结论，告警正文已是人话 |
| `suite-skills.txt` | 全量 `skills` 套件分母与 `not ok` 行（结论见下一节） |
| `mutation.txt` | 突变验证：把判据改坏三处，看它是不是红在期望的那一条上 |

## 全量 skills 套件：783 例 / 777 绿 / 6 红 —— 6 红全部来自「两次套件抢同一把机器级锁」

`suite-skills.txt`（exit 1）：

```
# tests 783   # pass 777   # fail 6   # cancelled 0   # skipped 0   # todo 0
# duration_ms 1223173.7213
```

6 条红**全部**落在同一个文件的相邻区间 `skills/xws-export-market-analysis/tests/prepare-flow.test.mjs:718~855`，
而且 6 条的 stderr 是同一句：

```
{"status":"BUSY","error":"another Xiaowangshen market-analysis run is already active","details":{}}
```

即**互斥锁没拿到、CLI 直接拒启动**；后面那些断言（退出码 2 变 1、关页签 `[]` 而非 `["home"]`、health 调用 0 次）
全是这个拒绝的连坐。归因有四条互相独立的证据：

1. 那把锁是**机器级**的：`os.tmpdir()/xws-runs/.market-analysis.lock`，只有 `XWS_MARKET_ANALYSIS_LOCK` 能改路径，
   而这些用例没设 ⇒ **同一台机器上并行跑两次 `skills` 套件必然互撞**。
2. 进程树实证：`run-test-suite.mjs skills` → `node --test …` → `prepare-flow.test.mjs` → 真 CLI 子进程
   （`export-market-analysis.mjs --keyword 浴缸 … --proxy http://127.0.0.1:<假代理>`）；持锁 PID 当时是**活的**。
3. **另一个会话的独立记录**：`evidence/huitun-usage-limit-fix-2026-09-21/README.md` 记了同一现象
   （它那次 781 例里 1 条红 `#608`，同样是 BUSY），并反过来引用本目录产物的 `#582~#587` 作旁证。
4. 「不是卡死的陈旧锁」：套件跑完后复查，锁文件**已被释放**。

两个必须记住的口径：

- 基线是 **761/761 全绿**（`evidence/full-automation-fixes-2026-09-21/unit-2026-09-21-c.txt`），所以这 6 条红相对基线是「新增的红」；
  但**不是任何一方改动引入的回归**。分母从 761 涨到 783，是因为这一天里多个会话都在加用例
  （含另一会话 09:31 新建的 `spawn-lock-isolation.test.mjs`）⇒ 两个分母**不能逐例对齐**。
- **TAP 编号是全局连续的**（全文只出现一次 `ok 1 - `）⇒ `not ok 582` **不是**该文件第 582 条用例，
  定位要用 `location:` 里的 `文件:行号`。

**这个锁隔离缺陷另一个会话已经在修**（09:31 落盘：`prepare-flow` 新增 `cliEnv()` 把锁指到用例自己的 runtime 目录，
并新建守卫 `tests/spawn-lock-isolation.test.mjs` 扫源码防漏改），本次**不重复动它**，也不提交它的文件。

## 没做的事

- 没有点科塔平台的任何「订购/领取」按钮（那是改真实账号状态，要用户点头）。
- 没有写飞书（整轮走的是排练档）。
- 没有起停任何进程。
- 没有改 `skills/xws-export-market-analysis/` 里的任何文件（那是另一个会话正在修的范围）。
