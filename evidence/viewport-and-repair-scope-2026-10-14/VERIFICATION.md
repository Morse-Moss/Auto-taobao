# 1.9.0 验证记录（视口闸门 / 窗口归位 / 修复层作用域 / 告警指纹）

目标日 2026-10-13 那一轮日报暴露了四个互相独立的问题，本批次逐个修掉。
这份文件是**本批次的可核产物清单**，路径都在 `evidence/` 下（`git check-ignore -v` 已核：未被忽略）。

## 一、修了什么（与 CHANGELOG 1.9.0 一一对应）

| # | 问题（现场） | 修法 | 判据落在哪 |
|---|---|---|---|
| 1 | 共用商家浏览器窗口被挤到 692×307，登录表单下半截落在窗口外，脚本按坐标点「登录」点在空白处 —— 报出来的却是「可能是密码不对」 | 日报链新增第 0 步 `shop-viewport-gate`（量视口，不达标就停）；`runtime/shop-viewport-gate.mjs` 收口阈值与判据 | `runtime/daily-job-plan.test.mjs`、`runtime/shop-viewport-gate` 相关用例 |
| 2 | 同一个窗口为什么会变小：**没有任何一步负责把它摆正** | `runtime/browser-window-bounds.mjs`（新）+ `start-project-browser.mjs` 启动后用 CDP 归位；只对共用商家浏览器生效 | `runtime/browser-window-bounds.test.mjs` |
| 3 | 登录这条路**在点下去之前**不问「点得到吗」 | `login-merchant-core.mjs` 的 `judgeViewportForClick` + 两个判决词（`VIEWPORT_TOO_NARROW/SHORT`）+ 闸门排在**所有**坐标点击之前 | `login-merchant-core.test.mjs`、`check-login-shops-core.test.mjs` |
| 4 | `readback` 失败时，修复动作落在**店铺标识页**上（`applied:true`，目标页纹丝没动） | `stage-browsers.mjs`（新，唯一口径）+ `STAGE_PAGE_HINT.push/readback='feishu'` + 页签归属走 `target-url-match.mjs` + 驱动侧互锁 | `stage-browsers.test.mjs`、`repair-shop-stage.test.mjs`、`run-multi-shop-day.test.mjs` |
| 5 | 告警去重看的是**停的位置**，不是**要做的事**：轮级两种不同成因被抹成同一个指纹（第二条被静默挡掉） | 指纹改成 `ROUND_BLOCKED:<轮级成因>` / `SHOP_LEVEL` ＋ 去重排序的**成因集合** | `run-multi-shop-day.test.mjs`（5 条指纹用例） |

## 二、验证到什么程度（**照实说**）

### 已验（离线判据，可重跑）

```bash
# ① 定向组：642 pass / 0 fail
node --test "skills/sycm-alimama-daily-report/scripts/*.test.mjs" "runtime/arch-boundary.test.mjs" \
  "runtime/alert-throttle.test.mjs" "runtime/test-suite-discovery.test.mjs" \
  "runtime/affected-test-selection.test.mjs" "runtime/version-consistency.test.mjs" "runtime/browser-ports.test.mjs"
# 原样输出见 targeted-tests.txt（末尾 EXIT=0）

# ② 突变验证（三个，都从本目录跑）
node evidence/viewport-and-repair-scope-2026-10-14/mutate-login-window-gate.mjs      # 7 处 → 全红
node evidence/viewport-and-repair-scope-2026-10-14/mutate-repair-scope.mjs           # 9 处 → 全红
node evidence/viewport-and-repair-scope-2026-10-14/mutate-alert-fingerprint.mjs      # 4 处 → 全红
# 原样输出见 mutations-*.txt（三份末尾都是 EXIT=0）
```

三个脚本都是**位置无关**的（仓库根靠向上找 `VERSION` 哨兵定位，不写死绝对路径、不数 `..` 层数），
所以放在本目录里可以直接跑，原件与副本不需要各自维护。每个变异都**逐字节还原**源文件（sha256 自证）。

**这次绿灯对应哪一版内容（顺序要说清）**：`targeted-tests.txt` 是**版本号已改成 1.9.0 之后**重跑的
（所以它同时覆盖了 VERSION / package.json / CHANGELOG 的一致性）。三份 `mutations-*.txt` 跑在这之前，
但它们只改**代码文件**、且每次都逐字节还原；版本号那一改**没有碰任何代码文件**，
所以它们对应的代码与最终提交逐字节相同。为免留下「哪一次对应哪一版」的空档，
改写版本文件之后又单独补跑过 `runtime/version-consistency.test.mjs`：**6 pass / 0 fail**。

值得单独记下来的两条：

- `mutate-repair-scope.mjs` 的 **M2**（把共用端口 19023 抄成字面量）**只让一条源码层断言变红**，
  所有行为级断言照旧全绿 —— 因为抄的那个值今天恰好等于登记表。这就是「值级断言抓不住抄常量」
  的实证，也是那条源码层断言存在的唯一理由。
- `mutate-repair-scope.mjs` 的 **M8**（把 `readback` 的实例改回店铺实例）一口气红了 26 条，
  其中既有新加的阶段表用例，也有既有的
  「采集/回填/回位打这家店自己的代理，推送/回读打商家浏览器代理」——
  说明驱动侧互锁真的在拦，不是纸面约定。

### 未验（**必须由真机补**）

- **第 0 步视口闸门与窗口归位没有任何真机运行**：本批次没有跑过日报链（按用户要求，
  在驻留窗口期不手工重跑；也没有授权起停进程）。所以「窗口被挤小时闸门会拦住」这件事
  目前只有离线判据。**下一个 11:00 定时轮是第一次真机接触**，要盯
  `evidence/daily-job-<日>/viewport.json` 与 `job.log` 里那一行。
- 登录侧闸门同理：`--dry-run` 不点击，所以它只在真跑时才会真的拦住。
- 告警指纹改判只验了离线行为（`dispatchRoundAlert` + 临时节流文件），没有真发过飞书。

## 三、本批次**没有**修的东西（留给下一批，别当成已修）

- `readback` 仍然**没有** `push` 那套「自己找回目标页」的兜底（`ensureTargetPage`），
  仍然只会抛一句 `expected one Feishu page for target base, got 0`。本批次只把它
  **指对了页**（阶段提示 + 按阶段选实例），没有给它自愈能力。
- 指导书写着「候选菜单为空 ⇒ 转人」，所以 `planRepair` 在**成因未登记**时给出的 `stageHint`
  （本批次新修）目前只用于诊断与请求单里的定位信息，不会让 agent 多执行一个动作。
  要不要放宽这一条是口径决定，不在本批次内。
- 历史遗留（与本批无关，未动）：`test:staged` 超预算、不带 `--batches` 没有 `stop` 步、
  `login-merchant` 不去重、网林日报下载停顿。

## 四、目标日 2026-10-13 那一轮的现场证据（同批提交）

`evidence/batches-2026-10-13/`（142 个文件，含 `b2/网林淘宝/97-repair-agent-report.md` ——
修复 agent 复现的三处框架缺口）、`evidence/daily-job-2026-10-13/`、
`evidence/daily-report-2026-10-13-<店>/`（8 家）、`evidence/product-data-job-2026-10-13/`、
`evidence/promotion-batches-2026-10-13/`。

判断「那天收完没」的权威是**飞书底单行**，不是那一轮的 `summary.json`：
8 家店 2026-10-13 的行都在（独立 OpenAPI 回读，表内共 2279 行），询单 8 家全有值（合计 53）。
