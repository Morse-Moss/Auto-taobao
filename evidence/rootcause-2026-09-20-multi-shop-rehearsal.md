# 日报排练失败根因（那轮 = `evidence/multi-shop-2026-09-19`）

一轮实测：`mode=rehearse`，`06:00:34.078Z → 06:07:24.157Z`，共 **410 秒**，五家店全部被尝试过。

| 店铺 | 结果 | 停在哪 |
| --- | --- | --- |
| 里可林淘宝 | ok | 11/11 全绿 |
| 网林天猫 | failed | `readback` |
| 盖文淘宝 | failed | `shop-report` |
| 盖文天猫 | failed | `promotion-submit` |
| 科塔淘宝 | failed | `push` |

五家的 `02-alimama-date` 全部 `exit=0` / `status=APPLIED`。

## 先订正我上一轮说错的两条

### 订正 1：「残留弹窗 ⇒ date-picker 读到两个「昨日」⇒ 停在第 2 步」不成立

四条依据：

1. 那个 `triggers=2` 在 **网林天猫** 的 `02-alimama-date.txt` 里，不在盖文淘宝；
2. `triggers=` 数的是 `.mx-trigger` 且断言要求 **≥6**（`date-picker.mjs:169-175`），
   所以 `triggers=2` 的含义是「筛选栏还没渲染出来」，跟弹窗没有任何关系；
3. 它是 `read-before-skipped / tolerated:true`（`:417-428` 的 catch 是全捕）⇒ **它没有停**；
4. `evidence/` 全目录里 `alimama date trigger ambiguous` 与 `state did not settle` **零命中**，
   本轮五家 date 阶段全部 exit=0。

但要说清分寸：**「弹窗里有一个「昨日」」这一点是核过的**。`probe-live/pages-now.txt` 里
盖文淘宝/科塔淘宝两个页面上各有**两个**「昨日」，第二个 `rect=[347,206,246,30]` 落在弹窗 body 内、
命中自己=true。所以代码注释里那条推断不是凭空写的，只是「它导致 ambiguous 停」这一步**从未被观测到**。

已把 `collect-promotion-report.mjs:217-225` 的注释改成「已核 / 未核」分开写（无行为改动）。

### 订正 2：「证据日志是追加式的、要按末块解析」不对

`run-multi-shop-day.mjs:586` 是 `writeFileSync` —— 每个阶段文件**每轮覆盖**，只保留最新一轮。
我先前「读首块会读到上一轮旧记录」的解释是错的（虽然「看最新一轮」这个结论恰好一样）。

## 根因 A（核过）：一次「读不到表」的超时，变成下一家的「页面状态不符」

飞书底单页是**五家共用的一页**（19022/19023）。把页面送回源表这件事，写在
`readback-daily-report.mjs:360-368` 的**收尾**里；而 `run-daily-report.mjs:78-86` 的 `inspectTarget`
在 `main` 一开头就要求当前 URL 的 table/view 恰好是 `tblkY3W8tnPWPcnh` / `vewwg0rhjo`。

链条：

1. 网林 readback 在 `waitForModel` 等**询单表** `tblUnwn05vl8Wik9` 超时 30 秒（`last=false`）⇒ 抛错；
2. ⇒ **收尾那段没执行**，页面留在询单表；
3. 3 分钟后科塔 push 一进来就被拦：
   `Feishu page is not on authorized table/view: …?table=tblUnwn05vl8Wik9&view=vewHgmRhGR`
   —— 该阶段**从启动到失败只有 0.3 秒**（inspectTarget 是第一件事）。

即：上游的「清理/复位」动作挂在**成功路径末尾**，它的失败会在下游第一步以**看起来无关**的报错出现。
判「谁污染了谁」的方法是看 push 报错 URL 里的 `table=`，不是看报错措辞。

同类历史：`evidence/multi-shop-2026-09-18-commit/00-README.md` 记过一次同串报错（当时原因是裸 base 页）。

**未定论**：网林 readback 为什么 30 秒没等到询单表（`last=false` = base 在了但 `base.tables` 里没有那张表）。
在同一目录里，里可林 readback 刚刚成功读过同一批表，所以不是「这三张表读不了」。

## 根因 B（核过）：弹窗底栏落在视口折叠线以下，而等待期间从不滚动

现场（`probe-live/gwtm-dialog.txt`，盖文天猫那台）：

- 视口 **1032×500**；
- 「确定」`rect=[257,505,24,12]` —— y 完全在视口外；
- 「取消」`rect=[317,495,64,32]` —— 中心点 y=511，也在视口外。

判据在 `collect-promotion-report.mjs:176-177`：

- `visible` 用 `r.y < window.innerHeight` ⇒ 确定 false / 取消 true，**与日志逐字吻合**；
- `hitOk` 用 `elementFromPoint(中心点)` ⇒ 两者都 false。

弹窗自身的固定层实测是 `position:fixed; top:0; height:494; overflow:auto`，而底栏 `dialog-footer`
在 y=478..543 —— 它**本来就在弹窗可视区之外**，要靠滚动弹窗才露出来。而 `waitForConfirmButton`
（`:205-215`）只有轮询、没有滚动 ⇒ 30 次 × 1 秒后整店失败。

**变量是窗口尺寸**：09-17 同一页面（盖文淘宝）日志里留的是 `视口=[1528,732]`，那时底栏远在视口内。
同轮另外三家的 `promotion-submit` 都是 `exit=0` ⇒ 那三台的窗口够高。
（店铺浏览器没有设 `--window-size`，视口＝窗口自身。）

## 根因 C（核过，但上轮的表述要收窄）：`--only` 在没同时给显式源路径时会被提前拦下

`run-multi-shop-day.mjs` 里，push 的 `withSourcePaths` 注入在 `:708-720`，而 `--only` 的跳过判断在
`run()` 内部 `:680` —— **注入早于跳过**。跳过采集段时 `record.source` 为空 ⇒ `:491-495` 抛
「没有拿到 shopXlsxPath / promotionZipPath」，而运行的可能是 `--only sycm-reset` 这种与 push 无关的阶段。

收窄：**同时给 `--shop-xlsx` + `--promotion-zip` 就能用**（09-18 的 README 正是这么补跑的）。
坏的是「不给源路径又想只跑非采集段」这条路，且报错文案会把读的人指向采集段。

## 未定论：盖文淘宝 shop-report，「日报」行的预览按钮 25 秒内 0 个

- 事实：2.5 / 5 / … / 25 秒共 10 次采样，全部「预览按钮 0 个」。
- 反证「不是慢」：同轮科塔**首采也是 0 个**，5 秒变 1 个；里可林 2.5 秒就有 2 个。
- 反证「不是登录/身份」：`[身份] 生意参谋店铺名 = "盖文全卫定制" ✓`。
- 全 `evidence/` 目录只出现 1 次。
- **缺的证据**：当时那屏的 DOM / 正文长度没有留档。对照：`promotion-submit` 那条报错里带了
  「正文 3008 字符」，而这条什么都没带 ⇒ 判不了是「列表没渲染」「这一店日报列表为空」还是「页面停在别处」。

## 时间账（整轮 410 秒）

- 网林 readback ≈ 40 秒（脚本内 30 秒超时 + 读表）；
- 盖文淘宝 shop-report ＝ 25 秒轮询；
- 盖文天猫 promotion-submit ＝ 30 秒轮询；
- 三家硬等合计 ≈ 95 秒；
- 另有每店固定 ≈ 35 秒的 sycm 复位段（`07-push` → `09-sycm-date-again`：里可林 35.0s、网林 36.1s）。

所以这一轮本身不到 7 分钟。感知上的「卡了很久」主要来自这轮之前的多轮手工重跑，以及
「每次都要重跑整轮才拿得到一个结论」这件事本身。

## 取证清单（都可复核）

- `evidence/multi-shop-2026-09-19/summary.json`（逐店 `failureOutput` 原文）
- `evidence/multi-shop-2026-09-19/{店铺}/02|03|05|07|11-*.txt`（末轮各阶段原文）
- `probe-live/gwtm-dialog.txt`（弹窗按钮矩形 + 祖先链 + 固定层）
- `probe-live/pages-now.txt`（五个页面 的 URL / 可疑按钮 / 两个「昨日」）
- `probe-live/round-timeline.txt`（410 秒逐阶段时间轴）
- `probe-live/feishu-fail-history.txt`、`preview-btn-fail-history.txt`（历史频度）
- `probe-live/viewport-in-logs.txt`（09-17 的 `视口=[1528,732]`）
