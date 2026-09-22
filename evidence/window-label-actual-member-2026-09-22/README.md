# 窗口标志页显示「实际登录的会员名」（2026-09-22）

一句话：五台日报采集窗口的标签页上，**除了「登记表说应该是谁」，现在还写出「这台机器实际登的是谁」**；
两者不一致时那一行在页面上**标红**。不一致＝串号的现场证据 —— 2026-09-13 出过一次
「登录态完全正常、但登的是别人」，而串号的下游代价是**静默**的（文件照落、数字照进飞书，
阿里妈妈那份产物里连一个店铺身份字段都没有，事后从产物里查不出来）。

由来（用户 2026-09-22 采纳的推荐）：窗口标志页原先只写**登记表里的**会员名（＝「应该是谁」），
回答不了「现在实际是谁」。这一项是那三条建议里的第三条，另外两条是「推送」（已做）
与「`NO_SAVED_CREDENTIAL` 告警文案」（**刻意未做**，见文末）。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `runtime/shop-window-label.mjs` | 新增纯函数 `memberVerdictFor({expected, actual})`（四态：`null`/`unregistered`/`match`/`mismatch`）；`labelPageUrlFor` 新增可选参数 `actual`（量到才带）；新增 IO `readLoggedInMemberOn`（经各店自己的代理 `POST /eval` 读阿里妈妈页头的会员名）；`ensureLabelTabOn` 透传 `actual`；`main` 在「挂标签页」与「只读报告」两条路上各读一次并如实记账 |
| `runtime/shop-window-label.html` | 新增 `#actual` 一行（`.x` / `.x.ok` / `.x.bad`）：读 `?actual=`，与 `?member=` **逐字**比，不符挂 `bad`（红）、相符挂 `ok`（绿）；量不到整行不显示 |
| `runtime/shop-window-label.test.mjs` | 新增 6 条用例（URL 口径 / 判定四态 / 两层包装与表达式复用 / 读不到不抛错 / 透传 / 页面元素与标红）；`fakeProxy` 补 `/eval` 分支（**照真代理的两层包装**）并记录 body；两条「键集合封闭」判据改用共享常量 `LABEL_URL_KEYS` |

`runtime/arch-boundary.test.mjs` 的 `RUNTIME_TO_SKILLS` 白名单**不需要改**：它是按**源文件**登记的，
`runtime/shop-window-label.mjs` 已在名单里；本轮新加的依赖只是同一个技能目录里的另一个模块
（`collect-core.mjs`，取它那两个表达式与 `normalizeShopName`）。

## 判据（都在这一版上真跑过）

| 层 | 结果 | 文件 |
| --- | --- | --- |
| 离线用例 | **47/47/0**（新增 6 条） | `01-offline-tests-47of47.txt` |
| 突变验证 | **10/10 CAUGHT**，还原后 47/47/0、三文件与基准**逐字节一致**（sha256 自证） | `02-mutation-verification-10of10.txt` |
| 真机只读报告 | 五家店（含未登录时读不到的情形）**实际会员名全部读出来且与登记表一致** | `03-live-readonly-report.json` |
| 真机挂标签页 | 5 台全部 `reused:true` / `pinned:true` / `failed:0`（**没有新建任何页签**） | `04-live-commit-report.json` |
| 真机回读 | 5 台 URL 全部带上 `actual=`，值与登记表逐字一致 | `05-…json` + `06-readback-summary.txt` |
| 渲染级 | 一次性 headless 实例把页面真画一遍，回读 DOM：一致→`x ok`、不一致→`x bad`、登记表无期望值→只报实际值、量不到→空 div | `07-headless-render-4cases.txt` |
| `runtime` 全量 | **866/866/0**（上一版 860，多出的 6 条就是本轮新增） | `08-runtime-suite-866of866.txt` |
| `sop-runtime` | **398/398/0** | `09-sop-runtime-398of398.txt` |

`run-test-suite.mjs runtime` **不递归 `runtime/sop-runtime/`** —— 报「runtime 全量绿」时必须另外说明
那 398 条，否则会以为它们也在里面（上一轮为此吃过一次真实红灯）。

## 复核命令（本目录内可直接跑，已实测）

```bash
node evidence/window-label-actual-member-2026-09-22/mutate-label-actual.mjs        # 突变 10 条，自带还原与 sha256 自证
node evidence/window-label-actual-member-2026-09-22/label-render-check.mjs         # headless 渲染四态（一次性 profile，不碰运行中的实例）
node evidence/window-label-actual-member-2026-09-22/readback-summary.mjs           # 把回读快照摘成一张表
```

`label-render-check.mjs` 是靠 `import { labelPageUrlFor } from '../../runtime/shop-window-label.mjs'`
定位源码的 —— 复制进本目录时**改过那一行**（深了一层）。它用的 Edge 是
`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`、profile 落在
`tmp/edge-headless-profile`（一次性、ASCII 路径、跑完不清理，`tmp/` 已被 gitignore）。

## 现场实际发生了什么（如实记，不美化）

1. **五台窗口的标签页被重新导航了一次**（幂等复用分支，没有新建页签，没有置前，工作页/千牛/登录页一个没碰）。
   这一轮之前它们指向的是最后一版旧页面，所以不重新挂的话，新功能在机器上是看不见的。
2. **里可林淘宝、盖文天猫那两台上的 `state=需要登录` 消失了。** 这不是丢信息：状态是**每轮从页签清单现量**的
   （`loginStateHint`），只有「**确实看到一个停在登录页的后台页面**」才会给值；这一轮五台都扫不到登录页，
   按既有口径「量到才显示、不写占位」⇒ 整条不带。顺带说明：这一轮五台的 `actual` 都能读到，
   本身就证明五台**此刻都是登录着的**（登录前那一页会被重定向到登录页，读到的 `memberName` 就是 null）。
3. 只读报告（不带 `--commit`）现在**每台多一次 `POST /eval`**（读会员名）。表达式只读文本、不点任何控件；
   读不到一律记 `null` 并带上原因，**不抛错、不拦人**。`--prune`（清页签）不读 —— 与「登的是谁」无关。

## 未关闭项

- **生意参谋页头店名（第二个独立见证）刻意没做。** 那一页显示的是**店铺名**（`盖文全卫定制`），
  而会员名是另一套（`随心品质定制:阿彦`）—— 两者**本来就可以不同名**。并进同一行会让「不一致」
  这句话变得有歧义（是串号了？还是只是两套名字？）。要做就得先想清措辞，所以留给下一步，不是漏了。
- **`main` 那两条接线（只读报告读一次 / 挂标签页时读一次）没有离线判据。** 突变 M1 覆盖的是
  `ensureLabelTabOn → labelPageUrlFor` 那一段；`main → ensureLabelTabOn` 那一段这一轮**只有真机跑过**
  （`03`/`04` 两份报告是它的证据）。要补成离线用例得把 `main` 的循环抽出来 —— 那是一次独立的重构。
- `memberVerdictFor` 用的归一化是采集链的 `normalizeShopName`（复用，不另写一份）。它会把
  连续空白折成一个空格 —— 会员名里没有空格，所以这一轮没有影响；但**如果哪天有店名带空格，
  比对口径就跟着它走**，改它要连这里一起想。
- 建议里的第 2 条小项 **`NO_SAVED_CREDENTIAL` 的告警文案**没动：它要改的是「脚本不接触凭据」这条既有边界，
  按用户口径等他有空单独谈。
