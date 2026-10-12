# 修复 agent 报告 — 网林家居（2026-10-04 批次 b2）

- 修复 agent：repair-agent-1004
- 生成时间：2026-10-05（本轮后台修复会话）
- 仓库版本：`git log -1` = `7c668a0 fix(daily-report): ★行标题判据被包成 RegExp ⇒ 恒不命中 —— 8 家店全停 shop-report 的真因`
- 目标日：2026-10-04
- 失败阶段：`health-check`
- 成因：`SHOP_BLOCKED`
- 复现命令（原失败来源）：`node scripts/run-daily-job.mjs --date yesterday --batches 5 --notify --auto-repair`（2026-10-05 15:30）

---

## 一、最终结论（先说）

**agent 修不动 —— 同样不是脚本缺陷、也不是登录墙，而是本轮编排形态的已知缺口：跑完即释放（`--batches`）导致该店专属浏览器实例（代理端口 19062）已经退出，任何页面动作都无从执行。本店当天的病因（页面漂移 `ambiguous-drift`）确凿，但需要「留现场的 `--no-release` + `scripts/start-all-hold.mjs`」形态重跑后，agent 才能对着活着的 19062 执行 `RESET_PAGES` 归位。**

**是否要人：需要，但人要做的是「换留现场形态重跑，让 agent 能修」——不是一个纯运营动作。**

---

## 二、时间线（每步：实际命令 + 回读到了什么）

### 步骤 0：读现场（只读）
命令：`ls evidence/batches-2026-10-04/b2/网林家居/`
回读到：`01-health-check.txt 02-alimama-date.txt 03-promotion-submit.txt 04-sycm-date.txt 05-shop-report.txt 06-promotion-fetch.txt 07-push.txt`、`97-repair-request.json`、`98-failure-page.png`、`98-failure-state.json`、`98-failure-state.txt`、`99-recovery.txt`、`promotion-report-manifest.json`、`shop-report-manifest.json`。

### 步骤 1：以请求单为准（只读）
命令：读 `97-repair-request.json`
回读到：
- `stage = health-check`，`cause = SHOP_BLOCKED`，`error = 阶段 health-check 失败（exit 2）`
- `candidates = [ RESET_PAGES(mutating=false), RELOAD_PAGE(mutating=true) ]`
- `execHint = node .../repair-shop-stage.mjs --shop 网林家居 --proxy http://127.0.0.1:19062 --stage health-check --cause SHOP_BLOCKED --action <候选动作> --log-dir evidence\batches-2026-10-04\b2\网林家居`

### 步骤 2：核对 `--shop`/`--proxy` 一致性（只读）
命令：`Grep "网林家居|proxyPort" runtime/browser-ports.mjs`
回读到：`网林家居: { profile:'.../wanglin-custom', browserPort:19052, proxyPort:19062, ... }` —— 与请求单 `--proxy http://127.0.0.1:19062` **一致**。

### 步骤 3：真失败正文取证（只读）
命令：`cat evidence/batches-2026-10-04/b2/网林家居/01-health-check.txt`
回读到（关键内容）：
```
归位：有一项不敢动或没做成（生意参谋工作页:ambiguous-drift），交给体检去报
  [归位] 生意参谋工作页：ambiguous-drift
体检未通过：阻断 1 项，告警 1 项
  [阻断] TARGET_PAGE_MISSING：目标页面「生意参谋工作页」不在这个浏览器里
         （按片段 sycm.taobao.com/qos/service/frame/shop/performance 找到 0 个）；采集会从落位那一步就失败。
  [告警] EGRESS_PROXY_NOT_DECLARED：没有声明出网代理……
```
同文件内 JSON 证据（归位账）：
```
"before": [ {"page":"生意参谋工作页","count":0}, {"page":"阿里妈妈报表页","count":1} ],
"after":  [ {"page":"生意参谋工作页","count":0}, {"page":"阿里妈妈报表页","count":1} ],
"changed": false,
"actions": [
  { "page":"生意参谋工作页", "action":"ambiguous-drift", "found":0,
    "url":"https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop",
    "drifted":2,
    "from":[ "https://sycm.taobao.com/adm/v3/micro/auto_analysis/my_space#/monitor",
             "https://sycm.taobao.com/lyone/auto_analysis/my_space?insertType=sycm&layoutHide=1&useDebug=false&activeKey=common" ] },
  { "page":"阿里妈妈报表页", "action":"already-one", "found":1 } ],
"verdict": { "ok":false, "changed":false, "notDone":["生意参谋工作页:ambiguous-drift"] }
```
要点（与主流程一致）：
- **不是登录墙**：URL 里没有 `custom/login.htm?_target=`；页签都在 `sycm.taobao.com` 主机上，只是漂到了 `auto_analysis/my_space` 系列，而期望的「生意参谋工作页」片段是 `qos/service/frame/shop/performance` —— 同主机漂移 2 个页，归位器判 `ambiguous-drift`（不敢猜要归到哪一页）⇒ 体检阻断 `TARGET_PAGE_MISSING`。
- 备选成因候选 `RESET_PAGES` 正是为这种「页签被带走/漂到别处 → 按期望清单归位」准备的。
- 该体检发生在 2026-10-05 07:45，**当时 19062 还活着**（否则连这个账都拿不到）；现在已释放。

### 步骤 4：端口探活（只读）
命令：
```
curl -s -m 4 http://127.0.0.1:19062/json/version ; echo "exit=$?"
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
⇒ **19062 已无人监听**。与主流程「19 个店铺端口两遍独立回读全部 FREE」一致。

### 步骤 5：dry-run 排练（只读，一个写请求都不发）
命令：
```
node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs \
  --shop 网林家居 --proxy http://127.0.0.1:19062 \
  --stage health-check --cause SHOP_BLOCKED \
  --action RELOAD_PAGE \
  --log-dir evidence/batches-2026-10-04/b2/网林家居 \
  --dry-run --timeout-ms 8000
```
回读到：
```
[修复] RELOAD_PAGE｜网林家居@http://127.0.0.1:19062｜阶段 health-check
[修复] 证据 = evidence\batches-2026-10-04\b2\网林家居\97-repair.txt
[修复] ❌ 未应用：读不到页签（代理连不上）：fetch failed
exit=3      ← REPAIR_EXIT_CODES.INCONCLUSIVE
```
证据落盘：`97-repair.txt` + `97-repair.json`（脚本自写）。
> 选 `RELOAD_PAGE` 而非 `RESET_PAGES` 做排练，是因为 `RELOAD_PAGE`（needsPage=true）会先 `readTargets` 连代理，能拿到「连不上」的确证；`RESET_PAGES`（needsPage=false）在 dry-run 下会跳过连代理、直接打印「会执行 RESET_PAGES」，拿不到连接证据。两者真跑都需要 19062 活着。
⇒ 脚本在定位/读页签的第一步就报「代理连不上」。按硬边界与作业指导书，**不再试写动作**。

### 步骤 6：未执行的动作
- **未**试 `RESET_PAGES` 真跑、**未**试 `RELOAD_PAGE` 真跑、**未**重试 `health-check` 阶段、**未**回读飞书底单。
- 原因：实例已释放（步骤 4/5 已证），页面动作前置条件不成立。

---

## 三、候选动作逐个结果

| 候选动作 | 是否真跑 | applied | detail | 回读底单行数 |
| --- | --- | --- | --- | --- |
| RESET_PAGES (mutating=false，首选) | 否（前置条件不成立，未跑） | —（此动作未做 dry-run，避免误报「可执行」） | — | 未回读 |
| RELOAD_PAGE (mutating=true) | 否（仅做 --dry-run 排练） | 未应用 | `读不到页签（代理连不上）：fetch failed`（exit=3 INCONCLUSIVE） | 未回读 |

> 说明：这是**唯一**能确认的事实——实例不在，两个候选都无法执行。因病因（`ambiguous-drift`）指向 `RESET_PAGES` 更对症，实例若是活的应当**先试 `RESET_PAGES`**（非 mutating，风险最低），applied=false 再换 `RELOAD_PAGE`。但当前场景下换哪个都命中同一个「代理连不上」，故不重放。

---

## 四、要人做什么

**核心：换「留现场」形态重跑，让 agent 能对着活着的 19062 执行 `RESET_PAGES`。**

1. **重跑本店并留现场**（agent 未执行任何启动/停止动作）：
   ```
   node scripts/run-daily-job.mjs --date 2026-10-04 --shops 网林家居 --no-release
   # 另起终端：node scripts/start-all-hold.mjs      （让 19052/19062 实例保持存活、不释放）
   # 确认存活：curl http://127.0.0.1:19062/json/version  应有 JSON 返回
   ```
2. **对活着的实例派修复 agent**（按病因选动作）：
   ```
   node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs \
     --shop 网林家居 --proxy http://127.0.0.1:19062 \
     --stage health-check --cause SHOP_BLOCKED \
     --action RESET_PAGES \
     --log-dir evidence/batches-2026-10-04/b2/网林家居
   ```
   - `applied === true` ⇒ 重试 `node scripts/run-daily-job.mjs --date 2026-10-04 --shops 网林家居`，再 `node skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs --date 2026-10-04` 核对底单「店铺名称」列（「店铺」列是 Lookup，回读必为空，别误判）。
   - `applied !== true` ⇒ 换 `RELOAD_PAGE` 再试。
3. **旁证（可选）**：`EGRESS_PROXY_NOT_DECLARED` 是本店一直挂着的告警级项（非阻断）。本次失败的主因是页漂移，不是出网代理；但如果留现场重跑后仍反复出页漂移，建议按告警口径固定 `--no-proxy-server` 或显式声明出网代理（属另一条链，不属本次修复）。

**本店当天数据若已由另一轮补入底单，则视为已闭环。**

---

## 五、代码改动

**无。** 本店不是脚本缺陷：归位器 `ambiguous-drift` 是**正确的 fail-closed 行为**（同主机有 2 个候选页时不敢猜，符合「不猜要修哪一页、绝不回落第一个页签」的纪律），体检 `TARGET_PAGE_MISSING` 阻断也是对症的。真正的障碍是**编排形态**（实例释放）而非代码。
未产生 `97-repair-agent-code-diff.patch`（无 diff）。

## 六、复现本报告用到的全部命令（可回放）
```bash
git log -1 --oneline
curl -s -m 4 http://127.0.0.1:19062/json/version ; echo "exit=$?"
cat evidence/batches-2026-10-04/b2/网林家居/01-health-check.txt
node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 网林家居 --proxy http://127.0.0.1:19062 --stage health-check --cause SHOP_BLOCKED --action RELOAD_PAGE --log-dir evidence/batches-2026-10-04/b2/网林家居 --dry-run --timeout-ms 8000
```
