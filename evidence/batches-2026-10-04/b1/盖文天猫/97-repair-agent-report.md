# 修复 agent 报告 — 盖文天猫（2026-10-04 批次 b1）

- 修复 agent：repair-agent-1004
- 生成时间：2026-10-05（本轮后台修复会话）
- 仓库版本：`git log -1` = `7c668a0 fix(daily-report): ★行标题判据被包成 RegExp ⇒ 恒不命中 —— 8 家店全停 shop-report 的真因`
- 目标日：2026-10-04
- 失败阶段：`shop-report`
- 成因：`STAGE_FAILED`
- 复现命令（原失败来源）：`node scripts/run-daily-job.mjs --date yesterday --batches 5 --notify --auto-repair`（2026-10-05 15:30）

---

## 一、最终结论（先说）

**agent 修不动 —— 但不是脚本缺陷、也不是页面本身的问题，而是本轮编排形态的已知缺口：跑完即释放（`--batches`）导致该店专属浏览器实例（代理端口 19045）已经退出，任何页面动作都无从执行。本店当天应由「留现场的 `--no-release` + `scripts/start-all-hold.mjs`」形态重跑后再派 agent。**

**是否要人：需要，但不是「立刻人工救数据」—— 见第四节「要人做什么」。**

---

## 二、时间线（每步：实际命令 + 回读到了什么）

### 步骤 0：读现场（只读）
命令：
```
ls evidence/batches-2026-10-04/b1/盖文天猫/
```
回读到：`01-health-check.txt 02-alimama-date.txt 03-promotion-submit.txt 04-sycm-date.txt 05-shop-report.txt`、`97-repair-request.json`、`98-failure-page.png`、`98-failure-state.json`、`98-failure-state.txt`、`99-recovery.txt`。

### 步骤 1：以请求单为准（只读）
命令：读 `97-repair-request.json`
回读到：
- `stage = shop-report`，`cause = STAGE_FAILED`，`error = 阶段 shop-report 失败（exit 1）`
- `candidates = [ REAPPLY_DATES(mutating=true), RELOAD_PAGE(mutating=true) ]`
- `execHint = node .../repair-shop-stage.mjs --shop 盖文天猫 --proxy http://127.0.0.1:19045 --stage shop-report --cause STAGE_FAILED --action <候选动作> --log-dir evidence\batches-2026-10-04\b1\盖文天猫`

### 步骤 2：核对 `--shop`/`--proxy` 一致性（只读）
命令：`Grep "盖文天猫|proxyPort" runtime/browser-ports.mjs`
回读到：`盖文天猫: { profile:'.../gaiwen-flagship', browserPort:19035, proxyPort:19045, ... }` —— 与请求单 `--proxy http://127.0.0.1:19045` **一致**。

### 步骤 3：真失败正文取证（只读）
命令：`cat evidence/batches-2026-10-04/b1/盖文天猫/05-shop-report.txt`
回读到（关键行）：
```
[身份] 生意参谋店铺名 = "盖文旗舰店"（主店）｜期望 "盖文旗舰店" ✓   （身份核对通过）
[1/4] 再进 自助分析 · 公共空间
[2/4] 2.5s：预览按钮 1 个
...（每 2.5s 一次，直到）
[2/4] 25s：预览按钮 1 个
采集失败：等不到「日报」这一行的预览按钮
```
⇒ 失败是**这一页里没有「日报」那一行**（预览按钮恒为 1 个，不是目标行），非登录失效、非脚本崩溃。这与主流程判断一致：属运营侧报表配置（自助分析·公共空间的日报看板缺失/改名），不是脚本可自愈的页面态。
> 注：`98-failure-page.png`/`98-failure-state.json` 的 `stateSummary.url = null`，而同目录 `98-failure-state.json` 里实际抓到的页是 `one.alimama.com/.../report/download-list`（万相台下载管理页），**不是**真正的失败页（sycm 自助分析）——即感知层「拍错页」已知缺陷。按作业指导书，以请求单 cause/stage 为准，截图仅辅助。

### 步骤 4：端口探活（只读）
命令：
```
curl -s -m 4 http://127.0.0.1:19045/json/version ; echo "exit=$?"
```
回读到：
```
（无输出）
exit=7      ← curl 7 = Failed to connect：连接被拒（实例已退出）
```
对照（同一条命令打共享商家端口）：
```
curl -s -m 4 http://127.0.0.1:19022/json/version
{"Browser":"Edg/150.0.4078.65", ... }  exit=0   ← 19022 在听
```
⇒ **19045 已无人监听**；只有共享商家浏览器 19022/19023 存活。与主流程「19 个店铺端口两遍独立回读全部 FREE」一致。

### 步骤 5：dry-run 排练（只读，一个写请求都不发）
命令：
```
node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs \
  --shop 盖文天猫 --proxy http://127.0.0.1:19045 \
  --stage shop-report --cause STAGE_FAILED \
  --action RELOAD_PAGE \
  --log-dir evidence/batches-2026-10-04/b1/盖文天猫 \
  --dry-run --timeout-ms 8000
```
回读到：
```
[修复] RELOAD_PAGE｜盖文天猫@http://127.0.0.1:19045｜阶段 shop-report
[修复] 证据 = evidence\batches-2026-10-04\b1\盖文天猫\97-repair.txt
[修复] ❌ 未应用：读不到页签（代理连不上）：fetch failed
exit=3      ← REPAIR_EXIT_CODES.INCONCLUSIVE
```
证据落盘：`97-repair.txt` + `97-repair.json`（脚本自写）。
⇒ 脚本**在定位目标页的第一步（`readTargets`）就报「代理连不上」**，因此连「目标页认得出来吗」都无从判。按硬边界与作业指导书，**不再试写动作**（写动作必然同样连不上；试了也只是原样复现连不上，不算修复）。

### 步骤 6：未执行的动作
- **未**试 `RELOAD_PAGE` 真跑、**未**试 `REAPPLY_DATES` 真跑、**未**重试 `shop-report` 阶段、**未**回读飞书底单。
- 原因：实例已释放（步骤 4/5 已证），所有页面动作的前置条件不成立。按作业指导书「若确实连不上：不要起/停任何进程或浏览器……直接把『因实例已释放、无法执行页面动作』作为结论」执行。

---

## 三、候选动作逐个结果

| 候选动作 | 是否真跑 | applied | detail | 回读底单行数 |
| --- | --- | --- | --- | --- |
| REAPPLY_DATES | 否（前置条件不成立，未跑） | —（dry-run 未做此动作） | — | 未回读 |
| RELOAD_PAGE | 否（仅做 --dry-run 排练） | 未应用 | `读不到页签（代理连不上）：fetch failed`（exit=3 INCONCLUSIVE） | 未回读 |

> 说明：dry-run 下 `RELOAD_PAGE` 在 `readTargets` 阶段即失败，`applied` 不进入应用态。因实例已释放，换另一个候选（REAPPLY_DATES）也会命中同一个「代理连不上」，故不原样重放。

---

## 四、要人做什么

**不是「人工补这一天盖文天猫的日报」这么急**——先确认这家店到底是不是「日报看板已经不在自助分析·公共空间里了」：

1. **人工确认（建议运营/负责人做）**：用盖文旗舰店账号进「生意参谋 → 自助分析 · 公共空间」，看是否还有名为「日报」的看板行（预览按钮对应的那一行）。
   - 若**被改名/移动/删除**：这是运营侧配置变更，恢复该看板/改回名称后，次日链自然带上；或让脚本侧的报表匹配口径同步改名（需改代码，属另一件事）。
   - 若**仍在**：说明是当次渲染态偶然（预览按钮未从 1 变到目标行）——用「留现场重跑」验证（见下）。
2. **重跑本店（要真让 agent 能修，必须换编排形态）**：
   ```
   node scripts/run-daily-job.mjs --date 2026-10-04 --shops 盖文天猫 --no-release
   # 另起一个终端：node scripts/start-all-hold.mjs   （把 19045 实例留下、别释放）
   # 确认 curl http://127.0.0.1:19045/json/version 有返回后，再派修复 agent 走 repair-shop-stage.mjs
   ```
   （`--no-release` + `start-all-hold.mjs` 的确切用法以仓库现行为准；本报告只给方向，agent 未执行任何启动/停止动作。）

**本店当天数据若运营已手工补过（另轮已写入底单），则视为已闭环，无需再动。**

---

## 五、代码改动

**无。** 本店不是脚本缺陷（同批次 `7c668a0` 修的「★行标题判据 RegExp 恒不命中」是另一条线；本店 05-shop-report.txt 显示身份核对已通过、且已进到「自助分析·公共空间」等预览按钮，属页面内报表行缺失，非脚本 bug）。
未产生 `97-repair-agent-code-diff.patch`（无 diff）。

## 六、复现本报告用到的全部命令（可回放）
```bash
git log -1 --oneline
curl -s -m 4 http://127.0.0.1:19045/json/version ; echo "exit=$?"
cat evidence/batches-2026-10-04/b1/盖文天猫/05-shop-report.txt
node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 盖文天猫 --proxy http://127.0.0.1:19045 --stage shop-report --cause STAGE_FAILED --action RELOAD_PAGE --log-dir evidence/batches-2026-10-04/b1/盖文天猫 --dry-run --timeout-ms 8000
```
