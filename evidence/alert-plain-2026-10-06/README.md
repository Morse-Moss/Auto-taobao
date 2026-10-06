# C 项：共用窗口要有名字 · 告警只给业务人员看（2026-10-06）

用户原话两条（这是本次改动的验收口径）：

> 「既然掉登录了，又自动修复不了，就应该挂住等人过来登录啊，还有你发给飞书的报警是什么东西，
> 一堆专业术语，你让业务人员怎么处理？？？？」
>
> 「第三点那个我就特意设计了标识页，让用户知道是哪个窗口」

第二句是**改法约束**：不要新造一套命名，用**已有的标识页机制**。本目录是 C 项的取证。

> B 项（分批形态挂住等人）的取证在 `evidence/batch-hold-2026-10-06/`，已提交 `3ed5af7`。

## 一、改之前的那条告警长什么样

逐字留档在 `evidence/daily-job-2026-10-05/ALERT-COPY-REBUILD.md` §4。要点：

- 两条技术行：`机器：DESKTOP-KJP4RA5`、`浏览器配置：D:\Retire\edge-daily-report-profile`；
- 没给店名时的指路：「登录页已经开在**那台电脑的**浏览器窗口了」——「那台电脑」在告警里没有落点，
  四台浏览器长得一样，人到了机器前还得猜；
- 标题只说「需要你登录一次」，不说哪扇窗。

这三处的共同病根：**收信人是业务人员，而消息是写给技术同学的。**

## 二、改了什么

### 1. 共用商家浏览器也有了标识页（复用既有机制，没有新造的命名）

`runtime/shop-window-label.mjs` 加了一张共用目标表 `SHARED_LABEL_SUBJECTS`（目前只有 `merchant` 一条），
于是：

- 窗口标题 = `商家浏览器（日报共用） · 日报采集窗口`（与店铺窗口同一条口径：`名字 · 日报采集窗口`）；
- 标识页那一屏会明说「这个浏览器窗口是几项共用工作合用的，**不属于任何一家店**」，
  并且不写「两个名字是同一家店」那一行（它确实不属于任何一家店）；
- 命令行：`node runtime/shop-window-label.mjs --commit --front --subject merchant`。

为什么是「共用窗口」而不是某家店的名字：把那台窗口标成某家店，就是**把标签贴错窗口**——
窗口上看起来完全正常，只是错了。所以 `sharedSubjectOf()` 对未登记的键**抛错、不回落**，
并且有一条判据钉着「共用窗口的标题与每一家店的标题都不相同」。

为什么挂在页签上、不动首屏：那台实例的首屏是生意参谋工作页，它是链的整轮级体检点名要看的一页
（`expectedPagesForDailyBrowser()`）。换首屏 = 体检当场判「这一页不在」→ 整轮一家都不跑。
（这解释了 `runtime/launch-plan.mjs` 当初为什么**故意不给**共用实例设 `PROJECT_BROWSER_URL`。）

接线在 `runtime/daily-job-plan.mjs` 的 `label-merchant-window` 那一步（默认开，`--no-merchant-label` 可关），
排在 `ensure-instances` 之后——实例没起来时它只会读到「连不上代理」。**分批与非分批都要有**：
那台实例是共用的，两种形态都靠它跑整轮级体检。

### 2. 告警里去掉机器名与盘符路径

- `buildLoginAlert` 的 `source` 不再带 `machine` / `browserProfile`；
- 加了一条**形状判据** `assertBusinessReadable()`：告警对象里一旦出现技术字段（含 `machineName`
  这类变体，用「包含」匹配），**在构造时就抛错**——不靠写的人记得；
- 技术串没有丢：它落进回执的 `receipt.tech`（`login-merchant.mjs` 的 `deliverAlert`），
  仍然在 `job.log` 里可查；
- 「下一步」与标题改由**窗口标题**指路：`resolveAction(verdict, shopName)` 说
  「标题写着「X」的那个浏览器窗口（任务栏里就能看到）」，没给店名时 `X = SHARED_WINDOW_NAME`
  （＝标识页真的写到标题上的那个名字，唯一来源，不在这里另拼一份）。

> 附带效果：`profileForShop` 的两条 fail-closed 闸门原来挂在 `alertForRun` 上。
> 告警不带 `browserProfile` 之后那个调用点会**消失**，于是「以后有人顺手删掉它」就成了新的静默失败通道。
> 处理：把调用点搬到 IO 脚本（`receipt.tech = { machine, browserProfile: profileForShop(...) }`），
> 并加一条**源码级判据**盯着它（`login-merchant-core.test.mjs` 的「接线（源码级）：IO 脚本真的调了 profileForShop」）。

## 三、改之后实际渲染出来的文本

见 `ALERT-COPY-AFTER.md`（由 `rebuild-alert-copy.mjs` 用**真构造器 + 真渲染器**生成，不是手抄）：

```
【需要处理】商家浏览器（日报共用） 需要你登录一次
对象：生意参谋
原因：账号密码填了、登录按钮也点了，页面却还停在登录页。 页面还停在登录页 —— ...
下一步：登录页已经开在标题写着「商家浏览器（日报共用）」的那个浏览器窗口（任务栏里就能看到）了。...
时间：2026-10-06 15:31
告警编号：sycm-login-sycm-20261006
```

两条 `机器：` / `浏览器配置：` 行都没有了；指路落到了 Taskbar 上真能找到的那一行字。

## 四、突变验证（`mutation-output.txt`）

`node evidence/alert-plain-2026-10-06/mutation-verify.mjs` —— **8 条全部被抓住，还原 sha256 全部一致，
最终测试复绿**。每条针对一个「会被静默改回去」的点：

| 突变 | 期望被命中的判据 |
| --- | --- |
| M1 共用窗口标题写成某家店的名字 | `共用窗口的标题里出现了店名` |
| M2 共用窗口 URL 不再带 `shared=1` | `页面里读了 ?shared= 但脚本从不写它` |
| M3 `--only` 与 `--subject` 不再互斥 | 用例名：`--subject 与 --only 互斥` |
| M4 标识页不认 `shared` | `页面没有读 shared` |
| M5 形状判据被短路 | 用例名：`形状判据：技术串一旦被加回告警` |
| M6 告警 source 又带上机器名 | `给技术同学看的字段` |
| M7 `resolveAction` 回落到「那台电脑」 | `没承诺「登录页已经开好」` |
| M8 计划那一步丢掉 `--subject merchant` | 用例名：`共用窗口标识页` |

两点口径（复用 B 项那份跑通了的骨架，理由写在脚本头部）：

- 「点名期望串」按断言形状取：`assert.match`/`assert.equal` 取**断言消息原话**；
  `assert.throws` 的红是「没抛出」，Node 默认消息里不含断言消息，所以取**用例名**（M3/M5）。
- stdio 必须写成 `['ignore','pipe','pipe']`：写成 `'pipe'` 会在本机沙箱下 `EBUSY`，
  后果是测试根本没启动、`catch` 把「没跑起来」当成「测试红了」——突变验证会变成空转假绿。

## 五、测试

| 记录 | 口径 |
| --- | --- |
| `suite-runtime.txt` | `npm run test:runtime` — 114 文件，**1090/1090 通过**，exit 0 |
| `suite-skill-daily-report.txt` | `node scripts/run-test-suite.mjs skills --skill=sycm-alimama-daily-report` — 18 文件，**443/443 通过**，exit 0 |
| `suite-runtime-first-run-two-registration-reds.txt` | 第一次跑 runtime 时的原始输出：**2 条红**，逐字保留 |

那 2 条红是**登记类守卫**，不是缺陷，也不该被当成缺陷修掉——它们是这次改动**必须显式登记**的地方：

1. `arch-boundary.test.mjs`「skills → runtime 的依赖清单与登记逐字一致」
   —— `login-merchant-core.mjs` 新 import 了 `runtime/shop-window-label.mjs` 的 `sharedSubjectOf`，
   要在 `SKILLS_TO_RUNTIME` 里登记并写理由（**告警里那句指路必须与写到窗口上的标题同源**）。
2. `hold-and-resume-plan.test.mjs`「接线：定时计划里真的有「驻留」这一步」
   —— 计划多了一步 `label-merchant-window`，那个字面量数组要跟着改。

处置都是「把新事实写进登记表」，没有改任何判据的严格度。

## 六、复现

```bash
# 1. 突变验证（会改写源码；不要与别的测试/采集同时跑）
node evidence/alert-plain-2026-10-06/mutation-verify.mjs

# 2. 重建告警文本（只读，不改源码）
node evidence/alert-plain-2026-10-06/rebuild-alert-copy.mjs

# 3. 两组测试
npm run test:runtime
node scripts/run-test-suite.mjs skills --skill=sycm-alimama-daily-report
```

## 七、没有做的事

- **没有**给共用实例换首屏（理由见 §2.1，那会让整轮一家都不跑）。
- **没有**把技术串删掉，只是搬到了收信人看不到的地方（回执 + `job.log`）。
- **没有**在任何存活进程上做写操作：本目录的证据全部来自离线用例、渲染与突变验证；
  `--subject merchant` 这条命令**没有**在活的 19022 上跑过（真机验收由定时链自己在 15:30 完成）。
