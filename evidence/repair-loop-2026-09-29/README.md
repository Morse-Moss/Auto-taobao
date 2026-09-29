# agent 修复回环（失败 → 修 → 重试）— 2026-09-29

## 这一批要解决的问题

用户原话是规格：

> 重试这个必须要让 agent 根据失败原因去修复再重试

也就是说，**重试不能是「原样再来一遍」**。对 `PAGE_OBSTRUCTED`（弹窗盖住整页）这类成因，
原样重跑的成功率是零 —— 页面还是那个页面。要做到「修完再试」，
链路里缺的是一层**可执行的修复能力**：光有「哪一步失败了」「页面当时什么样」还不够，
还得有「可以对这个页面做哪几件机械的事，以及先试哪件」。

## 三层结构（各管一段，互不越界）

| 层 | 文件 | 管什么 |
|---|---|---|
| 感知 | `failure-perception.mjs`（09-28 已建） | 失败 → **事实**（DOM 摘要、截图、页签） |
| 分诊 | `remediation-table.mjs`（09-28 已建） | 事实 → **方向**（重试 / 重试并等待 / 交给人） |
| 修复 | `repair-actions.mjs` ＋ `repair-shop-stage.mjs`（09-29 新建） | 方向 → **候选动作** ＋ **执行** |
| 编排 | `run-multi-shop-day.mjs` 的 `autoRepairAndRetry`（09-29 新建） | 失败 → 修 → **重试失败那一步** |

分工的一句话版本：**agent 挑动作，脚本做动作，驱动串起来。**

## 新增能力

### 1. `repair-actions.mjs` — 修复动作闭集 ＋ 候选菜单（零 import）

- `REPAIR_ACTIONS`（闭集）：`DISMISS_OVERLAYS` / `RESET_PAGES` / `RELOAD_PAGE` / `REAPPLY_DATES`
- `REPAIR_TABLE`（成因 → 有序候选）：
  - `PAGE_OBSTRUCTED` → 先关弹窗，关不掉就重载换个现场
  - `SHOP_BLOCKED` → 先归位页签，不成再重载
  - `STAGE_FAILED` → 重新落日期，不成再重载
- `planRepair()`：认不出的成因 ⇒ **空候选**（不猜动作）；现场是登录页 ⇒ 只加一句 note，不否决
- `validateRepairActions()`：加载期互锁，钉住「动作名在闭集里、成因名在 `FAILURE_CAUSES` 里、
  每个候选都有 why、阶段名在 `STAGE_NAMES` 里、没有死动作」

### 2. `repair-shop-stage.mjs` — 执行器（一次只做一个具名动作）

- `applyRepairAction()`：永不抛，一切异常翻成 `{applied:false, detail}`
- 执行前**先定位目标页**（按 host 判归属，认不出就 `TARGET_PAGE_MISSING`，**绝不随便挑一页**）
- 执行后**回读**确认，落 `97-repair.txt` / `97-repair.json`
- 退出码：0＝已落地 / 1＝没落地 / 3＝拿不到结论

### 3. `autoRepairAndRetry()` — 编排（默认关）

失败 → 读请求单 → 挑第一个候选 → 执行 → **重试失败的那一步**。三条纪律：

1. **闸门只有一个来源**：候选菜单为空就一步不动。不在调用侧另留「不许修」的名单
   —— 本链已经吃过「同一件事活在四处」的亏。
   （`NEEDS_LOGIN` 这类天然没有候选 ⇒ 自动不碰，不靠第二份名单去挡。）
2. **同一个动作不重复试**：修完重试还失败就换下一个候选，候选耗尽就停。
   `applied !== true`（没修成）时**不重试阶段** —— 那正是「原样再来一遍」。
3. **永不抛、不改退出码**：回环自己炸了也只是维持原失败态，交回上层照旧分诊／告警。

救回来时它改 `record`（`status` 翻 ok、清 `failedStage`、记 `rescuedFrom`/`rescuedBy`），
因为「修好了」必须对后面的分诊与告警都成立 —— 否则会出现「其实修好了、但照样叫人」的假红。

## 接线（两处，都默认关）

```
run-multi-shop-day.mjs  --auto-repair [--auto-repair-max-rounds N]
scripts/run-daily-job.mjs  --auto-repair [--auto-repair-max-rounds N]  （透传到链）
```

默认关的理由（与 `autoLogin`/`hold` 刻意不同）：那两条打开是因为
「不打开就天天坏」；而 `--auto-repair` 是**让系统自己在别人的页面上动手**，
不打开只是维持原样，而原样正是过去一直以来的行为。

位置：`buildRepairRequest` 之后、`recoverFailedShop` **之前**。
回位会把页面导航走，之后修的就不是那个坏页面了。

## 验证

| 证据 | 结果 |
|---|---|
| `tests-result.txt` | 255/255（驱动＋修复两模块＋分诊表＋感知层＋采集核心等） |
| 该技能全量离线 | **374/374**（16 个文件，11 秒；e2e 文件在本上下文不展开） |
| `mutation-result.txt` | **4/4 突变如期变红**，且点名到期望的那一条 |
| `runtime/daily-job-plan.test.mjs` | 34/34（含 4 条新透传用例） |

`mutate-repair-loop.mjs` 改坏这四处、确认对应用例真的红，再逐字节还原：
1. 默认关闭被拿掉（`if (true)`）→ 接线守卫红
2. 重试改成「跑第一步」而不是「重跑失败那一步」→ 按名字重跑守卫红
3. 动作没落地也照样重试阶段 → 「不重试阶段」用例红
4. 阶段表被建两次 → 「只该出现一次」守卫红

复跑：`node evidence/repair-loop-2026-09-29/mutate-repair-loop.mjs`（退出码 0＝四条都咬人）

## 已知未做

- **真机演练未做**：这条回环会真的动页面，演练要在「未登记端口＋临时 profile」的一次性实例上做，
  而当前有别的会话在跑采集。等窗口空出来再补，届时会留下 `repair-shop-stage.mjs` 的真跑证据。
- **外部 agent 直接调 `repair-shop-stage.mjs` 这条路未验**：驱动内的 `--auto-repair` 已接线，
  但「agent 读请求单 → 自己敲命令」那条路没有走通一次的记录。
