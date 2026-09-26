# 证据：关不掉的遮挡层转人工 ＋ 驻留后自动续跑（1.7.4，2026-09-26）

这一轮改了两件相连的事：**① 广告遮挡层从「一次候选」升级成完整一档**；
**② 关不掉 / 掉登录时不再把窗口收走，而是驻留等人，人处理完自动只补那几家。**
版本口径见 `CHANGELOG.md` 的 1.7.4 段落，设计工单见
`docs/ops/LOGIN-HOLD-AND-AUTO-RESUME-PLAN.md`。

## 为什么会有这一批（现场，不是推断）

2026-09-26 08:14 那一轮（目标日 2026-09-25）五家店里四家写成、**科塔淘宝写了 0 行**，
停在第 3 步 `promotion-submit`。同一步上**网林**的同类层却关掉了 —— 两份原件逐字复制在本目录：

| 文件 | 店 | 选中的控件 | 关后回读 | 结果 |
| --- | --- | --- | --- | --- |
| `foreground-2026-09-25-keta-03-promotion-submit.txt` | 科塔淘宝 | `IMG「」` 于 (1003,27) | 剩 2 个（`mask_dlg_624` ＋ `wrapper_dlg_624`）｜目标可点=false | **没关掉** ⇒ 停在这步 |
| `foreground-2026-09-25-wanglin-03-promotion-submit.txt` | 网林天猫 | `SPAN#mx_697「」` 于 (1225,34) | 剩 0 个｜目标可点=true | 已关掉 ⇒ 这一步过 |

两层的身份相同（`DIV#wrapper_dlg_*` ＋ `data-owner-id=app` ＋ `z=99999`）⇒ 不是「这一层关不掉」，
而是**这一份渲染里，我们选中的那个控件不管用**。科塔那次选中的是一个**没有文字标签的 `IMG`**，
位置在 x=1003（视口宽 1442 ⇒ 并不在真正的右上角）—— 旧代码的「右上角图标」兜底档把它当成了关闭键。
这正是「一次候选 + 没有第二次尝试」的代价。

完整现场（含另三家店与整轮日志）在 `evidence/multi-shop-2026-09-25/` 与
`evidence/daily-job-2026-09-25/`（这两个目录未纳入版本管理，只在本机）。

## 本目录有什么

| 文件 | 是什么 | 怎么复现 |
| --- | --- | --- |
| `affected-tests.txt` | 受影响用例的原始输出：**168 条全过、0 失败** | 见下方命令 |
| `mutation-verify.mjs` | 突变验证脚本（9 条，把源码逐条改坏再还原） | `node evidence/hold-and-resume-2026-09-26/mutation-verify.mjs` |
| `mutation-output.txt` | 上面那次的输出：**9/9 抓住**，每条都点名到期望的用例，全部 sha256 逐字节还原 | 同上 |
| `suite-runtime.txt` | `runtime` 整包套件：**957 条全过、0 失败、退出码 0** | `node scripts/run-test-suite.mjs runtime --concurrency=1` |
| `suite-skill-daily-report.txt` | 受影响技能整包：**297 条全过、0 失败、退出码 0** | `node scripts/run-test-suite.mjs skills --skill=sycm-alimama-daily-report --concurrency=1` |
| `audit-guard-mutation-verify.mjs` ＋ `audit-guard-mutation-output.txt` | 审计表守卫的突变验证：**2/2 抓住**（收窄扫描范围后它仍然会咬，且点名到文件） | `node evidence/hold-and-resume-2026-09-26/audit-guard-mutation-verify.mjs` |
| `foreground-*.txt` | 上面那张表的原始证据 | — |

## 两个套件现在都是全绿（2026-09-26 09:4x 修掉那 3 条红之后）

结论先说：`runtime` 整包 **957/957**、受影响技能整包 **297/297**，两个套件退出码都是 0。
修之前它们分别是 957/955/2 与 297/296/1 —— 那 3 条红**都不是本批引入的**，是本仓早记过的两类旧账。
这两笔在本次一并还掉了：

1. + 2. `runtime/generate-competitor-field-reference-docx.test.mjs` 的两条
   （`renderer consumes every special-looking line instead of stalling` /
   `client reference markdown renders end to end`）：报 `renderer exited null: undefined` 与
   `null !== 0` —— 本仓记过两次的**宿主沙箱假红**（`spawnSync` 默认三根管道 ⇒ `EBUSY`、`status=null`）。
   该文件 `:15` 的 `spawnSync(process.execPath, …)` **没写 `stdio`**，与本批无关
   （`git diff 5e8fec5 d258c9c --name-only` 里没有它，且它只 import node 内建）。
   ⇒ 与 1.7.1/1.7.2 修掉的那三处**同一病根**，是**第四处漏修**。
   **改法**＝补 `stdio: ['ignore','pipe','pipe']`（只有 stdin 要改，stdout 还要用来判断）。
   修完这两条**真的通过** ⇒ 渲染器本身没坏，此前是**这道门自己没跑起来**。
3. `skills/sycm-alimama-daily-report/scripts/daily-report-audit.test.mjs`
   （`全仓库只有写入方与迁移提到这张表`）：红点是取证文件
   `evidence/daily-report-2026-09-24-independent-verify/probe-audit-table.mjs`
   （2026-09-25 22:34 就在那里，与本批无关）—— 它按设计要直接读这张表。
   **改的是守卫的扫描范围，不是白名单**：`evidence/` 整个目录不再参与扫描，
   依据是 `AGENTS.md` 对它的定性「do not treat it as live input」——
   档案里的探针没有任何链会 import 或执行，构不成「第二个能对『这天推过没有』下断言的地方」。
   进白名单反而更糟：白名单有**双向校验**（每一项都必须真的还在说这张表），
   删掉一个旧探针就会让守卫变红，而红的理由与这条不变量毫无关系。
   **代价写在代码注释里**：真有人把生产读者藏到 `evidence/` 下，这条守卫**看不见**。
   **并且验证了它没被改成装饰**：突变 2/2 —— 把表名塞进 `scripts/run-daily-job.mjs` 与
   `runtime/browser-ports.mjs`（都在非白名单、非 evidence），守卫**都红、且点名到那个文件**，
   还原 sha256 逐字节一致。脚本与输出＝`audit-guard-mutation-verify.mjs` / `audit-guard-mutation-output.txt`。

（`test:staged` 对这批改动共选 8 项，含 `npm run test:unit`；上面两笔覆盖了其中会红的部分。
`test:unit` 本身没跑 —— 它是全量套件，与本次改动面无直接关系，且正是 1.7.2 记的那个长跑门禁。）



## 复现命令（都在仓库根跑）

```bash
node --test runtime/hold-and-resume-plan.test.mjs runtime/daily-job-plan.test.mjs \
  runtime/test-suite-discovery.test.mjs runtime/version-consistency.test.mjs \
  runtime/arch-boundary.test.mjs \
  skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs \
  skills/sycm-alimama-daily-report/scripts/collect-core.test.mjs
```

`mutation-verify.mjs` **会改写源码**，所以：

- 不要与别的测试/采集同时跑（它会临时改坏 `runtime/` 与 `skills/` 下的源文件）；
- 每条突变跑完它自己用 sha256 自证还原，最后一行会打「异常 N 条」，**必须是 0**；
- 它自己向上找仓库根（`VERSION` 在哪就是哪），所以在本目录、在 `tmp/` 跑都一样 ——
  写死绝对路径或按「自身位置 + 固定层数」算，复制到别处就会静默指错。

## 这一版**没有**验证到的（说清楚）

整条「驻留 → 人处理 → 自动续跑」**没有在真机上跑过一轮**。上面的离线判据能证明
「判据本身不坏」与「它真的被接线接上了」（`--print` 真跑一遍入口，断言那一步与
`--will-resume` 出现在将要执行的命令行里），**证明不了**「40 分钟后人来把弹窗关掉，
它真的会认出来并只补那几家」。

第一次真跑的入口是 **08:14 那次定时**，条件是那天恰有一家店停在
`NEEDS_LOGIN` 或 `PAGE_OBSTRUCTED` 上 —— 也就是说它**可能连续几天不被考到**。
真跑的证据会落进 `evidence/daily-job-<目标日>/job.log`，判据是里面出现 `[驻留]` 开头的行。
