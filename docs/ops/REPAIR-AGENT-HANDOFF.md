# 修复 agent 作业指导书（按需唤醒）

这份文件是**给「修复对话」的 prompt 源**。当日报链失败、脚本自己的修复回环也没救回来时，
由**定时任务那个 WorkBuddy 会话**（不是 shell 脚本）按本文件派一个后台修复 agent
去接管现场，修不动再转人。

## 为什么是「会话派 agent」而不是「脚本叫 agent」

`node scripts/run-daily-job.mjs` 是 shell 子进程，它**没有** `Agent` / `SendMessage` 这类
模型侧工具 —— 所以脚本自己**不可能**唤醒 WorkBuddy 对话。能把 agent 叫起来的只有一个
**WorkBuddy 会话**（定时任务本身就是）。因此分工是：

- **脚本侧**：失败时把现场落成事实（`98-failure-state.json`）、写修复请求单（`97-repair-request.json`）、
  **驻留不退出**（窗口留着，现场就在）；
- **会话侧**（定时任务）：跑完命令后读「有没有需要救的现场」，有就派一个后台修复 agent；
- **修复 agent**：读现场 → 选动作 → 执行 → 重试那一步 → 记录全过程；
- **人**：agent 也修不动时才发飞书叫人。

## 规格（三层降级，用户 2026-09-29 定）

1. 脚本自己修（`--auto-repair`：挑候选动作 → 执行 → 重试失败那一步）。
2. 修不动 ⇒ **驻留 + 唤醒修复 agent**。**不先用飞书叫人** —— 飞书是最后一层。
3. agent 也修不动 ⇒ 才发飞书告警。
4. 「没登记修复的成因」不该出现 —— 遇到就驻留等 agent/人，而不是直接放弃。
5. 权限：只读现场 + **允许改仓库代码**修根因；**全过程必须可回溯**。

### 第 2 层是怎么接上的（2026-09-29，⑨b）

第 2 层原先**在真跑里从没被执行过**：链级告警由 `run-multi-shop-day.mjs` 直接发飞书，
从不问「这一家该不该先交给 agent」，于是第 3 层（叫人）被提前执行。

硬事实：脚本是 shell/Node 子进程，**没有 `Agent` 工具，唤不醒 agent** ——
能把 agent 叫起来的只有 WorkBuddy 会话（定时任务本身就是）。所以这一层拆成两截：

- **脚本侧（已接上）**：链在发飞书之前过一道闸门。给 `--defer-agent-actionable-alert` 时，
  把失败店按 `classifyShopEscalation`（`runtime/escalation-plan.mjs`，**与派单同一份判据**）
  分成「agent 能救」与「只能人上」两堆：
  - **只有整批失败都「agent 能救」** ⇒ 不发飞书，改把派单写进
    `evidence/batches-<日>/b<n>/escalation-handoff.json`（不分批则写在 `multi-shop-<日>/` 下）；
  - **只要有一家「只能人上」**（登录掉了、权限不足）⇒ 照旧发飞书且点名到店（fail-closed）。
  - 半批进 agent 队列、人只看到另一半，是事后无从回答的形态 ⇒ **整批进 / 整批出**。
  - 默认关：它改变的是「要不要打扰人」，属于口径决定（脚本侧口令见下面的触发条件）。
- **会话侧（你的活）**：会话跑完命令后读**两处**——先看那份 `escalation-handoff.json`，
  没有再跑 `node runtime/escalation-plan.mjs --date <目标日> --json`，
  `needsAgent=true` 就照 `handoff` 那句派一个后台修复 agent。

## 触发条件（脚本侧判据，会话侧照读）

跑 `node scripts/run-daily-job.mjs --date yesterday --batches 5 --notify` 之后，
出现**任一条**即需要唤醒修复 agent：

- `evidence/multi-shop-<目标日>/summary.json` 里有店 `status !== 'ok'`；且
- 该店的 `autoRepair.gaveUp` 非空（脚本自己修过但没救回来），**或** `repairRequest.candidates` 为空
  （成因没登记修法）。

**更快的一条**（脚本已经替你判过）：若那一轮的日志里有
「派单已落盘：…/escalation-handoff.json」，直接读那份 JSON 的 `targets[]` ——
那是脚本按**同一份判据**筛出来的、且已经确认「整批都够格交给 agent」的名单。
注意：这两条判据同源但**触发条件不同** —— `escalation-handoff.json` 只在给了
`--defer-agent-actionable-alert` 且整批都够格时才出现；没给这个开关时仍按上面那两条自己判。

## 修复 agent 该做什么（按顺序）

1. 读 `evidence/multi-shop-<目标日>/<店>/97-repair-request.json`（修复请求单）。
   里面已给：`cause`、`stage`、`candidates`（含每个动作的 `why` 与 `mutating`）、
   `statePath`（完整现场事实）、`screenshotPath`、`retryStage`、`execHint`。
2. 读同目录 `98-failure-state.json` / `98-failure-state.txt` / `98-failure-page.png`
   —— 这是**失败那一刻**页面长什么样（视口、可见文本、遮挡层、可见按钮及坐标、DOM 摘要）。
   ⚠️ 已知缺陷：感知层有时拍错页（落在千牛/下载页而非真正失败那页），**以请求单里的
   `cause` 与 `stage` 为准**，把截图当辅助证据。
3. 从 `candidates` 里**挑一个**动作（只能挑菜单里的，不能发明动作名）。挑的依据是现场事实，
   不是猜。菜单为空 ⇒ 跳第 6 步（转人）。
4. 执行：照 `execHint` 的形状调
   `node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop <店> --proxy <该店代理> --stage <阶段> --cause <成因> --action <动作> --log-dir <该店证据目录>`
   - 先加 `--dry-run` 排练一次（一个写请求都不发），确认目标页认得出来，再去掉 `--dry-run` 真跑。
   - `--proxy` 必须与该店匹配（`runtime/browser-ports.mjs` 的 `shopInstance().proxyPort`）；
     两者对不上脚本会停手。
5. 动作 `applied === true` ⇒ 重试失败那一步（`run-daily-job.mjs --date <目标日> --shops <该店>`
   ＋ 只跑失败起点之后的阶段）。回读底单行数确认真的写进去了。
   - 动作没落地（`applied !== true`）⇒ 换下一个候选，不重试阶段（原样再来一遍不算修复）。
   - 候选试完仍失败 ⇒ 进第 6 步。
6. **转人**：把「已试过哪些动作、每次回读结果、当前现场」写进
   `evidence/multi-shop-<目标日>/<店>/97-repair-agent-report.md`，然后才发飞书告警。

## 必须记录（可回溯，用户硬要求）

修复 agent **每一步**都要落盘到 `evidence/multi-shop-<目标日>/<店>/`：

- `97-repair-agent-report.md`：人读版。时间线（做了哪几步、每步命令、每步结论）、
  试过的候选动作与回读结果、最终结论（救回 / 转人）、如果改了代码改了什么、为什么。
- 每个动作一份 `97-repair.json`（脚本自己写，含 `applied` / `detail` / `evidence` / 目标页 URL）。
- 若改了仓库代码：`git diff` 落到 `97-repair-agent-code-diff.patch`，并在报告里写清
  「改了什么、为什么、影响面、是否要回滚」。

**不许只写结论**：报告里必须有「试过什么、每步回读到了什么」——「我修好了」不是证据。

## 边界

- 不改 `.workbuddy/` 下任何东西（只在 `evidence/` 里写）。
- 不重启/停止任何存活进程、容器、浏览器实例（修复动作本身就是脚本接口，不需要重启）。
- 动仓库代码前先 `git log -1`；提交走**显式路径**、绝不 `-A`；
  别的会话在改的文件一个字都不要碰。
- 修复动作本身有闭集（`DISMISS_OVERLAYS` / `RESET_PAGES` / `RELOAD_PAGE` / `REAPPLY_DATES`），
  **不许发明新动作名**，也不许绕过 `repair-shop-stage.mjs` 直接操作浏览器。
