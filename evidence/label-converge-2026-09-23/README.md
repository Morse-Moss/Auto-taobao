# 标识页收敛（1.4.0）—— 一次性实例真机演练与突变取证

本轮回答用户 2026-09-23 的两句话：

1. 「**有两个肯定不行只保留一个标识**」→ 改代码（见下「改了什么」）。
2. 「**为什么要人工登录？没有保存密码吗？**」→ **没有改代码**，结论写在「第 2 问的答复」一段。

本目录只放**这一轮**的取证。同一话题上一轮（1.3.0：释放、首屏＝标识页、登录守卫位置）的取证在
`evidence/batches-release-and-label-2026-09-23/`。

## 文件怎么读

| 文件 | 是什么 | 能不能复核 |
| --- | --- | --- |
| `rehearse-converge-throwaway-2026-09-23.mjs` | 一次性实例真机演练脚本（未登记端口 19931/19941 + 临时 profile） | 能，直接跑，见下「复核命令」 |
| `throwaway-rehearsal.txt` / `.json` | **run 3＝全绿那次**的原始输出（结论 `全部成立`、`exit=0`） | 能（重跑会覆盖它，先复制） |
| `throwaway-rehearsal-run1-断言写错的那次.*` | 第一次跑：**断言写错**（按「留的必是首屏那个」断言）⇒ 红了，因此记下 `/targets` 顺序这条事实 | 留档，不代表代码有问题 |
| `throwaway-rehearsal-run2-中断的那次.*` | 第二次跑：脚本里一处编辑被静默丢掉（`labelOrder is not defined`）中途崩了；同时也暴露「崩了退出码却是 0」 | 留档 |
| `mutate-1.4.0.mjs` | 突变验证脚本（12 条：本版 3 条 ＋ 1.3.0 的 9 条） | 能，直接跑 |
| `mutation-report-1.4.0.txt` / `.json` | 12/12 如期望变红、还原 12/12 逐字节一致 | 能（重跑会覆盖它） |

## 改了什么（只有一处行为变更）

`runtime/shop-window-label.mjs` 的 `ensureLabelTabOn`：`labels.length > 1` 时从**停手报错**
改成**收敛成一个**（留第一个 → 导航到本次 URL → 钉住 → 关掉其余 → 回读确认恰好剩一个）。
配套：抽出 `closeTabsAndConfirm`（与 `pruneTabsOn` 共用同一份「关+回读」口径）、四条来源路径都带
`converged`、CLI 成败两种情形都报收敛细节、`PRUNE_POLICY.label` 的 `why` 注明「正路在挂标签页那一步、
这条是兜底」。判据：`runtime/shop-window-label.test.mjs`（53/53）。

## 三条真机实测到的事实（都不是代码错，是「想当然」被抓掉）

1. **`/targets` 的顺序既不是页签条顺序、也不是创建顺序** —— 而且两次运行还不一样
   （run1/run3：新建的重复页排在首屏那个**前面**；run2：排在**后面**）。
   所以「留第一个」只有在「与 `prunePlan` 同一个顺序」时才有意义；「窗口上写的是什么」
   由「留下的那个重新导航」保证。两件事都与顺序无关。
2. **回读确实需要「等一拍」**：`reads=1,1,2`（run1/run3/run2）。270ms 那一拍在收敛这条路上同样存在
   —— 这就是把它并进共享助手、而不是各写一份的理由。
3. **中途崩溃时的退出码原来是 0**（run2 暴露）。已改成「每一项检查都过 **且** 没有致命中断」才为 0。

## 复核命令

```bash
# 真机演练（会起一个一次性 Edge + 一次性代理，跑完自己 taskkill/删 profile/回读端口）
node evidence/label-converge-2026-09-23/rehearse-converge-throwaway-2026-09-23.mjs

# 突变（会把源码改坏再还原，跑完自证 sha256 逐字节一致）
node evidence/label-converge-2026-09-23/mutate-1.4.0.mjs

# 判据本身
node --test runtime/shop-window-label.test.mjs
```

演练脚本**自己会拒绝**在端口已被占用时启动（那意味着那里有别人的实例），不会接上去。

## 第 2 问的答复（为什么还要人工登录）

- **密码确实存着**：五家 profile 的密码库都非空（只读审计见
  `../batches-release-and-label-2026-09-23/login-data-audit-0923.txt`，该脚本只读 origin 与长度，不读明文）。
- **缺的是那条 origin**：浏览器填充密码**按 origin 匹配**。盖文天猫只存了
  `havanalogin.taobao.com/mini_login.htm`，而自动登录固定打开 `login.taobao.com/havanaone/login/login.htm`
  ⇒ 一次也填不上 ⇒ 报「没存凭据」（`NO_SAVED_CREDENTIAL`，`login-merchant.mjs:292`）。
- **不是** 2026-09-19 那种「主站会话有效被重定向到千牛」的假阴性（那次有 `detectLoginDetour` 兜；
  这次的 `href.sycm` / `href.alimama` 都是**真的登录页 URL**）。
- 处置：**在盖文天猫自己的窗口里人工登一次并勾「保存密码」**（一次性）。让脚本改用密码库里那条 origin
  属于**改动采集链行为**，需授权后再动；「让脚本自己带账号密码」不做 —— 凭据不进任何仓库内的东西。

## 未做的（别当成已做）

- 盖文天猫人工登一次 → 才能重跑 2026-09-22 整轮（真写重跑要先删已写数据，未做）。
- 熔断（同一账号连续 2 次失败当天不再试）仍未实现。
- 冷启动恢复回来的 `about:blank` 仍是「空页」来源之一；竞品链 9222 首屏仍是 `about:blank`（刻意）。
- 带 `--login` 的成功支路、`--no-auto-login` 未在真机验过。
