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
| `04-round-rehearsal.log` | 整轮（排练档，不写飞书）：前四家照常、科塔以新结论收尾 |
| `suite-skills.txt` | 全量 `skills` 套件分母与 `not ok` 行 |
| `mutation.txt` | 突变验证：把判据改坏三处，看它是不是红在期望的那一条上 |

## 没做的事

- 没有点科塔平台的任何「订购/领取」按钮（那是改真实账号状态，要用户点头）。
- 没有写飞书（整轮走的是排练档）。
- 没有起停任何进程。
