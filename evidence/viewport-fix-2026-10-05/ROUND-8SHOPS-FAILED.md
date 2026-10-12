# 2026-10-05 重跑 8 家（目标日 2026-10-04）：视口修法生效、8 家仍全挂

命令：`node scripts/run-daily-job.mjs --date 2026-10-04 --batches 5 --notify --auto-repair`
HEAD：`5d7ce9e`（含今天 5 笔日报相关提交）｜9m05s｜全链退出码 **1**｜**飞书零写入**

## 一、总账

| 批 | 店 | 结果 | 停在 |
|---|---|---|---|
| b1 | 里可林淘宝 / 网林天猫 / 盖文淘宝 / 科塔淘宝 | failed | `promotion-submit` |
| b1 | 盖文天猫 | failed | `alimama-date` |
| b2 | 网林淘宝 / 里可林天猫 / 网林家居 | failed | `promotion-submit` |

8/8 failed。`batches.json` 两批 `steps`：`start`/`label:*`/`stop` 全 0，`chain` 全 1。

## 二、视口修法**已生效**（这正是推翻旧结论的证据）

8 家 `98-failure-state.json` 实测视口全部为 **1506×642 / dpr 1.25** —— 与 09-28~10-04 历史成功轮**逐字一致**。

对照：本轮之前的 12:04 那一轮（同一目录，已被覆盖前读到）视口是 `1114×642`，按钮 `rect=[1013,312,48,12]`；
本轮视口 `1506×642`，按钮 `rect=[1400,314,48,12]`。**两种视口下都是「命中自己=0」。**

⇒ **窗口宽度不是根因。** 12:30 那份「根因＝窗口可用宽度 1506→1114」的结论必须更正：
它解释不了「同为 1506 时，10-04 那轮 4 家成功、10-05 本轮 8 家全挂」。

## 三、与历史成功轮的逐行对照（同一位置、同一按钮）

历史成功轮（`evidence/batches-2026-10-03/b1/网林天猫/03-promotion-submit.txt`，视口同为 1506）：

```
[submit] 候选 1 个，取文档序第一个（SPAN，其可点祖先是 BUTTON，点击靠冒泡触发）
[submit] 滚动后复核通过（y=314（中心点命中））→ 点击 → {"clicked":true,"tag":"SPAN","text":"下载报表"}
```

本轮（`evidence/batches-2026-10-04/b2/网林淘宝/03-promotion-submit.txt`）：

```
[submit] 候选 1 个，取文档序第一个（SPAN，其可点祖先是 BUTTON，点击靠冒泡触发）
[遮挡] 全屏层 DIV#wrapper_dlg_814(data-owner-id=app) z=99999 … → 回读：剩 0 个｜目标可点=false ⇒ 不再挡事
[submit] 重新定位「下载报表」：候选 1 个，tag=SPAN，rect=undefined（未说明原因）
采集失败：「下载报表」复核未通过（not-hit，y=314，视口内=true，视口内采样=25/25，命中自己=0，rect=[1400,314,48,12]，视口=[1506,642]）
```

同一个 y=314、同一个视口，历史「中心点命中」，本轮「命中自己 0/25」。

## 四、关键读法：「不是被谁盖住」

`collect-core.mjs` 的 `describeHitMiss` 只在 `hit.blocker` 有值时才输出「遮挡物=」。
本轮 7 家的失败信息里**全都没有**「遮挡物=」，且 `视口内采样=25/25`（点都在视口内）。

按 `hitCheckExpression` 的 blocker 计算式，这三条同时成立只有一种解释：
**`win.elementFromPoint()` 在那个执行上下文里返回 null（或不可用）** ⇒ 25 个采样点全部拿不到命中对象 ⇒ `命中自己=0`。

⇒ 这不是「右侧悬浮条盖住按钮」（若是，`blocker` 会打印出 tag/cls），而是**判据本身在那个上下文里失真**。
（本轮现场截图右侧确有一条客服/直播浮栏，但它**不是**本次失败的原因。）

## 五、今日提交时间线（本轮跑的是这一批之后的代码）

```
09:46 8b453aa 报表下载漏判、修复动作漏传成因、13 家身份实测回填
10:08 93af363 销售2部 5 家停采
10:37 2878220 清空等待名单、按新账号表更新三家身份、修一个真崩溃
11:12 b29f64c 报表清单在 iframe 里 + 盖文天猫报表名不含「日报」   ← iframe 改造
11:35 6e4269c ★我自己引入的 iframe 表达式形状错 —— 8 家店全停在 promotion-submit
11:59 1ff609e ★两套「命中」判据不一致 —— 现场自相矛盾的那两行
12:18 b674ff3 ★整页重载后必须重新定位
12:38 5d7ce9e fix(browser): 店铺实例强制 --force-device-scale-factor=1.25
12:46 本轮启动 → 12:49~12:54 8 家全挂
```

11:18 / 11:43 / 12:01 三轮真机各暴露一个缺陷、各修一笔；**本轮是「三修 + 视口修」后的第一次真跑，仍全挂 ⇒ 还有第四个未暴露的缺陷。**

⚠️ `1ff609e` 的提交信息自己记录了这个矛盾：
> 修前：overlayAfter.targetHit = true(25/25)  vs  hitCheck.ok = false(0/25) ⇒ 矛盾
> 修后：overlayAfter.targetHit = false(0/25)  vs  hitCheck.ok = false(0/25) ⇒ 一致

**它的修法是「把 overlayAfter 对齐到 hitCheck」—— 即统一到了「不命中」这一侧。** 真机证据（中心单点判命中、25 点判不命中）指向的是**另一侧**才是对的。这条修法方向存疑，是下一步首要复核对象。

## 六、顺带确认的两件事

1. `b674ff3` 的「重载后重新定位」**确实被调用了**（日志出现 `重新定位…（reloaded）`），但拿不到 rect（`rect=undefined`）—— 这条路径至今没成功过一次。
2. 感知层读现场少剥一层 `value`：`98-failure-state.txt` 字段全 `?`、`97-repair-request.json` 的 `stateSummary` 全 `null`，而 `98-failure-state.json` 数据齐全。09-29 记的这条缺陷**仍在**，本轮第三次复现。

## 七、结论

- 视口修复（`5d7ce9e`）**必要但不充分**，它把窗口恢复到历史成功轮的尺寸，**没有解决问题**。
- 8 家全挂的当前形态是「25 点采样全部拿不到命中对象」，指向**判据/执行上下文**，而不是遮挡、也不是窗口宽度。
- 需要一次真机取证才能定论：在一次性实例上，对同一个 `[data-collect-alimama-download]` 目标，
  分别量 `document.elementFromPoint` / `el.ownerDocument.defaultView.elementFromPoint` 的返回值与 `inScope`。
