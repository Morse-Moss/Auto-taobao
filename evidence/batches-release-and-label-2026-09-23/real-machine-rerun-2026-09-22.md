# 真机报告：按用户三条修复重跑 2026-09-22 日报（1.3.0 的本版真机）

跑的命令（排练档，**不写飞书** —— 09-22 的底单当天已经写过，`--commit` 会撞硬重复停止）：

```
node scripts/run-batches.mjs --date yesterday --batch-size 5 \
  --logs evidence/batches-2026-09-22-rerun
```

- 起跑 `2026-09-23T05:41:19.918Z`（本地 13:41）／结束 `05:45:01.820Z`（本地 13:45），耗时 3 分 36 秒。
- 产物全在 `evidence/batches-2026-09-22-rerun/`：`batches.log`（440 行）、`batches.json`、
  `login-preflight-b1.json`、`b1/00-health-check-daily.txt`、`b1/summary.json`。
- 日志首行写的是 `版本：sycm-automation 1.2.0` —— 那是**启动时读到的旧值**（版本号是这一轮之后才改的）。
  功能代码全部冻结在起跑之前的取证在 `../batches-release-and-label-2026-09-23/code-frozen-at-start.txt`。

---

## 一、用户三条要求在真机上的结论

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| 每一轮跑完要释放浏览器资源 | ✅ **做到** | `batches.log` 里 `--- stop` 段：5 家代理 + 5 家浏览器逐个 `taskkill`，每家都有 `停后盘点到:missing`；`stop 退出码=0`；末尾 `分批跑结束：0/1 批成功；释放 1 批` |
| 不要空页 | ✅ **五家全 0** | 只读探针（跑中）`../batches-release-and-label-2026-09-23/tabs-probe-readonly.txt`：五家窗口空白页各 0 个 |
| 每个店铺的浏览器要有标识页 | ✅ **五家都有**（一家有 2 个，见第五节） | 同一份探针：里可林淘宝／网林天猫／盖文淘宝／科塔淘宝各 1 个，盖文天猫 2 个 |

释放的**旁证**（释放之后窗口真的没了）：`tabs-probe-after-release.txt` —— 同一个只读探针在 05:44:55
释放之后再跑一遍，五家店的代理端口全部 `fetch failed`（代理与浏览器一起被停，这是 `stop-all.mjs` 的既有行为）。

## 二、这一轮为什么没跑成：卡在盖文天猫「掉登录 + 没有可填的凭据」

链（`run-multi-shop-day.mjs`）在**第 1 步体检**就被自己拦住了，一个采集步骤都没跑：

```
[一轮]   归位：归位后仍不齐（生意参谋工作页=0  飞书底单页=1）
[一轮]     [阻断] TARGET_PAGE_MISSING：目标页面「生意参谋工作页」不在这个浏览器里
          （按片段 sycm.taobao.com/qos/service/frame/shop/performance 找到 0 个）
[驱动] 商家浏览器体检未通过 ⇒ 整轮不跑（推送段与回读段都要用它）。
```

工具自己给出的因果在告警文案里（`batches.log` 第 389 行）：

```
（跑前先查过登录态：盖文天猫（生意参谋、阿里妈妈）掉登录了 —— 上面那条「页面不齐」就是这么来的：
 掉登录时采集页面会被平台送回登录页，开几个都一样。）
```

跑前登录守卫（`login-preflight-b1.json`，本版新位置：**排在每一批的 `start` 之后**）这次**真的查到了本批实例**
（不再是 1.2.0 那种五家全 `HTTP 500 连不上浏览器调试端口`），并且**带 `--login` 真的试着自动登了**：

| 店铺 | verdict | 站点判据 | 子脚本结论 | 人话 |
| --- | --- | --- | --- | --- |
| 里可林淘宝 | UNKNOWN | sycm/alimama 都是 `UNREADABLE` | PARTIAL | 没进去的是「生意参谋、阿里妈妈」 |
| 网林天猫 | UNKNOWN | 都是 `UNREADABLE` | LOGIN_NOT_CONFIRMED | 页面还停在登录页 |
| 盖文淘宝 | UNKNOWN | 都是 `UNREADABLE` | LOGIN_NOT_CONFIRMED | 页面还停在登录页 |
| **盖文天猫** | **NEEDS_LOGIN** | sycm、alimama **都是 `LOGGED_OUT`** | **NO_SAVED_CREDENTIAL** | 登录时请点浏览器提示里的「保存密码」 |
| 科塔淘宝 | UNKNOWN | sycm `LOGGED_IN`、alimama `UNREADABLE` | PARTIAL | 没进去的是「阿里妈妈」 |

整轮结论：`NEEDS_LOGIN`（掉登录 1 家／没结论 4 家），守卫退出码 2。

### 自动登录为什么没成：**密码库里有凭据，但 origin 对不上**

用户 2026-09-23 的原话是「我这些店铺全部都手动登录过……我都去浏览器看了，都还有账号密码信息」。
这句话是**对的** —— 只读审计（`login-data-audit-0923.txt`，只读 origin 与长度，不读任何明文）显示五家都有：

| profile | 凭据条数 | 存的 origin |
| --- | --- | --- |
| gaiwen-flagship（盖文天猫） | 1 | `https://havanalogin.taobao.com/mini_login.htm`（用过 1 次） |
| likelin-home（里可林淘宝） | 2 | `…/havanaone/login/login.htm`、`havanalogin…/mini_login.htm` |
| wanglin-flagship（网林天猫） | 1 | `…/havanaone/login/login.htm` |
| suixin-custom（盖文淘宝） | 4 | `login.taobao.com/member/login.jhtml` ×2、`havanalogin…/mini_login.htm` ×2 |
| shop-j873522735（科塔淘宝） | 2 | `…/havanaone/login/login.htm`、`havanalogin…/mini_login.htm` |

而自动登录打开的登录页是**固定那一条**（`login-merchant-core.mjs` 的
`TAOBAO_LOGIN_URL = https://login.taobao.com/havanaone/login/login.htm?bizName=taobao`），
Chromium 的密码填充**按 origin 匹配** ⇒ 只有 origin 是 `login.taobao.com` 的那几家有得填；
**盖文天猫的密码库里压根没有 `login.taobao.com` 这条**（它只有 `havanalogin.taobao.com`），
所以它在第一步就 `NO_SAVED_CREDENTIAL` 停住 —— **不是脚本坏了，是这家店缺一条能匹配上的凭据**。

这与本仓库早先的结论一致（`evidence/close-then-restart-risk-2026-09-23/README.md`：
「盖文天猫的密码库没有这份凭据（`autofill=false/false`），自动填不了 ⇒ 必须人工登一次并勾「保存密码」」），
本轮把「为什么」补成了可复算的判据：**差的是 origin，不是凭据本身**。

一次人工处理即可（按 SOP 的说法就是告警文案里那句）：在**盖文天猫自己的窗口**里，
用它自己的账号登一次，登录时点浏览器提示里的「保存密码」。之后这条路才会自动。

## 三、这一轮里本版两处改动都走通了

- **首屏＝该店标识页**：五家 `start` 都是 `起前:browser-missing` → 冷启动 → 起来之后窗口里就有标识页
  （`label:<店>` 的只读报告里 `reused: true`，即复用现成那一页、原地导航，**没有新建页签**），
  同时空白页为 0 ⇒ 「不要空页」与「要有标识页」是一次动作解决的两件事。
- **释放口径反转**：这一批**链失败**，走的正是旧口径「留着」的那一档，而新口径照样执行了 `stop`，
  五家 `停后盘点到:missing`。也就是说「一律释放」在**失败档**上被真机走到过，不是只在成功档试过。

## 四、欠账 / 未验证（别当成已做）

- **盖文天猫必须人工登一次**（见第二节）。在那之前，「22 号补跑」不可能整轮跑通 —— 卡点在数据入口，
  不在采集逻辑。
- **盖文天猫窗口里有两个标识页**（未解决，见第五节）。
- 带 `--login` 的**成功**支路（掉登录 ⇒ 自己登回来）本机仍未跑通一次；`--no-auto-login` 真机未跑。
- 「同一账号连续 2 次失败当天不再试」的熔断仍未实现。
- 日志里 `释放=` 这个词原先是 stop 的**退出码**，与末尾「释放 N 批」并列时会被读成「一批都没释放」——
  本版把这一行改成 `stop（释放窗口）=退出码 N`，改动见 CHANGELOG。

## 五、未解决：盖文天猫窗口里有两个标识页

跑中只读探针（`tabs-probe-readonly.txt`）那一行：

```
=== 盖文天猫（代理 19045） 页签 5 个：空白 0 个、标识页 2 个
    https://one.alimama.com/index.html#!/login/index                       ← 登录守卫刚开的（LOGGED_OUT 才开）
    https://sycm.taobao.com/custom/login.htm?_target=…                     ← 同上
    file:///…/shop-window-label.html?shop=盖文天猫&port=19035              ← 冷启动首屏（launch-plan 给的）
    file:///…/shop-window-label.html?shop=盖文天猫&port=19035&member=…&actual=…  ← 带会员名的那个
    https://login.taobao.com/havanaone/login/login.htm?bizName=taobao      ← 登录守卫开的登录页
```

于是 `label:盖文天猫` 这一步退出码 1，报的是它刻意的那句停手：

```
"labelTab": { "ok": false, "error": "这个窗口里堆了 2 个标签页，先去关到只剩一个" }
```

**影响面**：这一步是 `blocking: false`（只影响人看不看得懂，不影响数据），整轮没跑成的真因是第二节的掉登录。
但「窗口上到底写着哪家店」这件事本身是那个功能的全部理由，所以记下来。

**已确证的一条机制（有正反两面的实测）**：**Edge 冷启动会恢复上一轮的页签**。
证据是 13:29 那一轮（`evidence/batches-2026-09-22/batches.log` 第 277-428 行）：`start` 报
`起前:browser-missing`（五家全是**冷启动**）、而且当时用的还是**旧代码**（首屏是 `about:blank`，
所以页签清单里明明白白躺着一个 `空白页（残留） about:blank`）—— 可是其中三家的窗口里**已经有**一个
`…?shop=…&port=…&member=…&actual=…` 的标识页。那个 URL 只可能由**更早的某次 `shop-window-label.mjs --commit`**
写下 ⇒ 它只能是**从上一轮的会话里恢复回来的**。

**这一轮为什么只有盖文天猫出现两个**：两次冷启动之间用户手动开过／关过浏览器（原话「我刚才手动把之前的浏览器全关了」），
每个 profile 上一次留下来的页签集合因此各不相同，属于**不受控的中间状态**，本轮复现不出来。
要复现，得在 `start` 之后立刻跑一次只读的 `/targets` 盘点，把「恢复回来的 vs 新开的」逐页签分开记。

**处置建议（没动手，等拍板）**：
1. 让 `ensureLabelTabOn` 在 `labels.length > 1` 时**收敛**（更新第一个、关掉多余的并回读确认）——
   这本来就是 `prunePlan` 里 `label` 类的既定策略（「只留一个：堆了多个说明上一轮挂标签页时没按幂等走」），
   现在的「停手」是比它更早写下的决定。**会改掉一条写明的设计决定**，所以不擅自做。
2. 保留停手，但在批次里给 label 步骤补一次 `--prune --commit`（只清重复标识页）。
3. **从源头掐掉会话恢复**（收尾时把 profile 的 `exit_type` 落成 `Normal`），顺带解决
   「上一轮的残留页签每天回来」这个更大的问题 —— 它同时也是「不要空页」这条要求的隐患：
   恢复回来的 `about:blank` 一样是空页。这条动的是 `scripts/stop-all.mjs` 与各 profile，必须显式授权。

## 六、证据清单

| 文件 | 是什么 |
| --- | --- |
| `../batches-2026-09-22-rerun/batches.log` | 这一轮全量日志（440 行） |
| `../batches-2026-09-22-rerun/batches.json` | 逐批结构化小结（`release`、各步退出码） |
| `../batches-2026-09-22-rerun/login-preflight-b1.json` | **本批**的登录态结论（3124 字节） |
| `../batches-2026-09-22-rerun/b1/00-health-check-daily.txt` | 链的体检原始输出（阻断项在这里） |
| `tabs-probe-readonly.txt` | 跑中页签只读盘点（含判据：空白 0／标识页 1） |
| `probe-tabs-readonly-0923.mjs` | 上面那份的脚本（收进 evidence 时改过 import 的层级并实跑过） |
| `tabs-probe-after-release.txt` | 释放之后再跑同一探针：五家全部读不到 ⇒ 窗口确实没了 |
| `login-data-audit-0923.mjs` / `.txt` | 五家剖面密码库的 origin 只读审计（不读明文） |
| `code-frozen-at-start.txt` | 「功能代码全部冻结在起跑之前」的 mtime 取证 |
