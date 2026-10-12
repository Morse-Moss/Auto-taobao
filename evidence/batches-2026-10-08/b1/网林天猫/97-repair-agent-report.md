# 修复 agent 报告 — 网林天猫（stage=alimama-date，cause=STAGE_FAILED）

- 目标日：2026-10-08
- 店：网林天猫（proxy=19042 / browser=19032 / profile=wanglin-flagship）
- 证据目录：`evidence/batches-2026-10-08/b1/网林天猫/`
- 作业依据：`docs/ops/REPAIR-AGENT-HANDOFF.md`
- 结论：**转人**（本店商家号在**两个后台**都掉登录，需人工登录一次；页面类修复动作对本因无效）

---

## 0. 第 0 步：把实例拉起来（--batches 形态失败店也在释放名单里）

| 步 | 命令 | 回读结果 |
|---|---|---|
| 0.1 | `curl -s -m 5 http://127.0.0.1:19042/targets` | **空**（实例不在） |
| 0.2 | `node scripts/start-all-hold.mjs --only 网林天猫`（后台托住） | 起就位，进程托住 |
| 0.3 | `Get-NetTCPConnection -LocalPort 19042 -State Listen` 读两遍 | 两遍都 `127.0.0.1:19042 Listen pid=122252`（一致） |
| 0.4 | `curl …/19042/targets` | 只有 1 个「网林天猫 · 日报采集窗口」标签页 |

> 冷启动后工作页（生意参谋/阿里妈妈）不存在（只剩标签页），故第 1 步需要先把链的工作页建起来才可能有「要修的那一页」。用链自己的 `health-check` 归位完成（见下）。

## 1. 读现场

- `97-repair-request.json`：cause=STAGE_FAILED，stage=alimama-date，candidates=`[REAPPLY_DATES, RELOAD_PAGE]`，execHint 指向本目录。
- `98-failure-state.txt`：页面标题「万相台无界版」，URL=`one.alimama.com/index.html#!/login/index?mxredirectUrl=…/report/account…`，可见「立即登录 / 立即开始体验」⇒ 阿里妈妈**登录墙**。
- `login-preflight-b1.json`：本店 alimama 探针结论 **LOGGED_IN**（href=`one.alimama.com/index.html`），与失败现场**矛盾**（见 §5）。

## 2. 重试复现（先建页，再复现）

命令：`node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date 2026-10-08 --shops 网林天猫 --only health-check,alimama-date`
日志：`97-retry1.log`

回读：
- health-check 归位 `create` 了 生意参谋工作页 + 阿里妈妈报表页（各 1）。
- **生意参谋工作页落在 `https://sycm.taobao.com/custom/login.htm?_target=…`（登录墙）**；阿里妈妈报表页落在 `#!/login/index`（登录墙）。
- 阶段 alimama-date：`navigate` 到 `one.alimama.com/index.html#!/report/account?…startTime=2026-10-08…` 后 **exit 1**（未能落到报表）。停手时 3 个页签，其中 `custom/login.htm` 被列为「不属于期望清单」。
- 汇总：`网林天猫：failed（停在 alimama-date）`；**EXIT=1**。

## 3. 逐个候选动作（闭集内，先排练再真跑）

命令模板：`node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 网林天猫 --proxy http://127.0.0.1:19042 --stage alimama-date --cause STAGE_FAILED --action <动作> --log-dir evidence/batches-2026-10-08/b1/网林天猫`

| 候选 | --dry-run | 真跑 | 回读 |
|---|---|---|---|
| `REAPPLY_DATES` | exit 0（排练：会执行，不发写请求） | **applied=false**，exit 1 | detail=「日期需要重新落位（alimama）—— 请重试该站点的落位阶段来完成，本动作不重复实现落位」（该动作是**报告者**不是执行者）。留证 `97-repair-REAPPLY_DATES.json` |
| `RELOAD_PAGE` | exit 0 | **applied=true**，exit 0 | detail=「页面已重载并就绪」；重载后回读 URL **仍是 `#!/login/index`**。留证 `97-repair-RELOAD_PAGE.json` |

## 4. 重试（RELOAD_PAGE applied=true 之后）

命令：`node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs --date 2026-10-08 --shops 网林天猫 --only alimama-date`
日志：`97-retry2-after-reload.log`

回读：**EXIT=1**，仍停在 alimama-date，页面仍被弹回 `#!/login/index`；生意参谋页仍在 `custom/login.htm`。⇒ 页面类动作（重载/落位）都试过，**不能修**。

## 5. 决定性取证：这是「真掉登录」，不是页面不跟手

只读登录探针（`login-merchant.mjs --check-only --notify off`，本机就是 preflight 用的同一份判据；**本 agent 未发任何飞书**）：
- `--target both`：`verdict=NEEDS_LOGIN`，`sycm loggedIn=false href=…/custom/login.htm…`，`alimama loggedIn=false href=…/#!/login/index`；EXIT=2。留证 `97-probe-both-checkonly.log`。
- 探针在 `siteLoggedIn` 里是「navigate 到 probeUrl → **等 5s** → 读 href」⇒ 不是「读太快」造成的假读数。

**preflight 矛盾的解释**：`login-preflight-b1.json` 判 LOGGED_IN，是**批开始那一刻**的读数（探针同样等 5s）。⇒ 该店商家号的会话是在 **preflight 之后、alimama-date 阶段之前** 掉掉的（两个后台都在此后变成登录墙）。这是**环境/会话失效**事实，不是页面渲染问题；页面类修复动作（本 agent 的闭集）对它**一个都不对症**。

## 6. 结论

- **转人**：需人工在「网林天猫」窗口（profile=wanglin-flagship，标题「网林天猫 · 日报采集窗口」）**用该店商家号登录一次**；两个后台（生意参谋 + 阿里妈妈）都掉，都要登。登录时点浏览器提示里的「保存密码」。
- 试过什么：候选 `REAPPLY_DATES`（applied=false）、`RELOAD_PAGE`（applied=true，URL 未变）；两次重试均 exit 1；只读探针实证两站 `loggedIn=false`。
- 是否改仓库代码：**否**。
- 可选后续（供人/团队判断，本 agent 未实施）：本店在本轮的 preflight 与实跑之间掉了登录；若这类「preflight 绿、实跑红」反复出现，可考虑让链在 alimama-date 失败时按 `NEEDS_LOGIN` 归因（而不是兜底 `STAGE_FAILED`），以便告警直接点名「去登哪台」。

## 附：本目录留证清单

- `97-live-targets-before.json`（修复前页签快照）
- `97-retry1.log` / `97-retry2-after-reload.log`
- `97-repair-REAPPLY_DATES.json` / `97-repair-RELOAD_PAGE.json`（另：`97-repair.json`、`97-repair.txt` 为最后一次动作的产物）
- `97-probe-alimama-checkonly.log` / `97-probe-both-checkonly.log`
