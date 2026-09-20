# 阿里妈妈落位：冷挂载下被「第一次读取」打断（2026-09-20）

## 一句话

rerun3 里盖文淘宝 / 盖文天猫 两家停在 `alimama-date`，报出来的却是**页面读取表达式原样抛出**
（`alimama filter bar not ready; triggers=0` / `alimama date trigger ambiguous: []`）——
真因是 `settle` 里那次读取不在容错内：navigate 之后 1.2 秒读一次，读不到就直接穿透出整步，
那个写在注释里的「8 次重试」在唯一需要它的路径上**一次都没跑到**。
实测冷挂载要 6190ms（02），所以这不是「页面坏了」，是「等得不够」＋「等待循环其实没在等」。

## 凭什么说是这个原因（三级取证）

1. 现场日志（`01-live-failure.txt`，两家 stage 日志原文）
   错误文本是**页面表达式抛出的**，不是 `settle` 收尾那句 `state did not settle to …`；
   Node 调用栈顶是 `at async settle (date-picker.mjs:434:14)`，也就是那次 `readSiteState`。
   同时 `read-before-skipped` 的 detail 显示动作前也只有 `triggers=4`／`triggers=3` —— 页面当时本来就没渲染完。
2. 只读取证（`dump-alimama-state.mjs` 倒出当时的页面真值）
   失败之后两家页面都是**完全渲染**的：11 个可见 `.mx-trigger`，日期条文本是 ` 昨日`，
   无浮层、无遮罩。所以既不是登录态，也不是页面自身出问题。
3. 冷挂载实测（`02-cold-tab-experiment.txt`）
   新开的标签**不激活也自己渲染完**，序列 `0 → 0 → 0 → 11`，用时 **6190ms**。
   而链上只等了 1200ms。
4. 证伪另一条可能（`03-hash-change-inplace.txt`）
   「是不是 hash 变化把筛选栏拆了、多试几次就好？」—— 换到 09-16 再换回 09-19，
   全程 11 个 trigger 在位、只有日期那条文本变。所以「重试」不是靠运气好，是本来就没被允许发生。

## 改了什么（只有一处，`date-picker.mjs`）

- `settle` 里那次 `readSiteState` 移进 `try`：读不到＝「还没渲染好」＝再等一轮，而不是这一步输了。
- 预算从 8 次改成 `settleAttempts = 16`（× 1200ms ≈ 19s，实测 6.2s 的约 3 倍），并写进注释留依据。
- 等过不止一轮就记 `settle-retried { reads, readFailures }` 进 trace —— 「这一步为什么慢」以后查得到。
- 终态报错把两种「没落定」分开：`读了 N 次 × M ms；其中读不到 K 次; lastReadError=…; last=…`。

## 怎么验的

| 层 | 证据 | 结果 |
| --- | --- | --- |
| 离线用例 | `date-picker.test.mjs` 新增 4 条：现场序列回放 / 一直读不到 / 读到了但日期不对 / 源码级位置守卫 | 22/22（改前 18 条） |
| 突变验证 | `04-mutation.txt`：4 条突变逐条打坏，各自点名到期望用例；还原后 sha256 逐字节一致 | 全部命中 |
| 端到端（同条件复现） | `05-cold-mount-e2e.txt`：把两家店的阿里妈妈页关掉，用 `--open` 同一个 URL（`SITES.alimama.probeUrl`）重开冷标签后**立刻**跑那一步 | 两家都 `APPLIED`；淘宝 `reads:2, readFailures:1`、天猫 `reads:3, readFailures:2` |
| 整轮 | `06-rerun4-console.txt` | 五家全绿：5 家 × 11 阶段全部 status=0，整轮 exit=0（11m59s） |
| 全量离线套件 | `node scripts/run-test-suite.mjs <skills 或 runtime> --concurrency=1` | skills **739/739**、runtime **725/725**，退出码均 0（55 个文件、0 失败） |

用例数的来路（原样写下，免得下次又对不上）：能核到的上一份原始产物是
`probe-live/skills-suite-final.txt`（54 个文件、716 条、0 失败，02:10Z）；
716 + 新增 `feishu-shared-page.test.mjs`（13）+ `collect-core.test.mjs` 29→35（6）+ 本文件 18→22（4）= **739**，闭合。
仓库外找不到任何带「732」的原始输出，所以那个数不作为基线。`runtime` 本轮没碰，725 与之逐字一致。

端到端那一步是决定性的：旧版正好死在 `reads:1, readFailures:1` 上（`01-live-failure.txt` 的栈就是它），
新版在同一条件下自己等过去了，并把「等了几轮」写在 trace 里。

## 整轮结果（rerun4，2026-09-20 08:28:10Z → 08:40:09Z，11m59s）

```
[驱动] 汇总：
  里可林淘宝：ok
  网林天猫：ok
  盖文淘宝：ok
  盖文天猫：ok
  科塔淘宝：ok
exit=0
```

五家 × 11 阶段全部 `status=0`，`summary.json` 里 `round.healthCheckDaily.ok = true`、五家 `status: "ok"`。
上一轮（rerun3）是同一件事上栽两家：盖文淘宝 / 盖文天猫 都停在 `alimama-date`。

这一轮各家的落位指纹（各自 `02-alimama-date.txt`）：

| 店铺 | 动作前读取 | 落位 | 等了几轮 |
| --- | --- | --- | --- |
| 里可林淘宝 | `triggers=2`（读不到，按设计缺省） | APPLIED | 一轮就成 |
| 网林天猫 | `triggers=2` | APPLIED | **reads=2，readFailures=1** |
| 盖文淘宝 | 读到了 | APPLIED | 一轮就成 |
| 盖文天猫 | 读到了 | APPLIED | 一轮就成 |
| 科塔淘宝 | `triggers=2` | APPLIED | 一轮就成 |

两点值得记住：

1. **「动作前页面还没渲染完」不是偶发，是常态**：5 家里 3 家在这一步的读取都撞上了半渲染
   （`triggers=2` 就是它的指纹）。它一直被 `read-before-skipped` 容忍着，所以以前没人注意它 ——
   而同一件事发生在 `settle` 里时就变成整步失败。
2. **网林天猫这次是靠重试过去的**：它的 settle 第一次读也没读成（`readFailures=1`）。
   换回上一版代码，它就会在第一次读取处直接失败 —— 也就是 rerun3 里盖文两家死掉的那个位置。
   所以这处修复不只在「刻意复现」时有用，正常一轮里就会被用到。

## 改动文件哈希（sha256）

| 文件（均在 `skills/sycm-alimama-daily-report/` 下） | sha256 | 这轮动了吗 |
| --- | --- | --- |
| `scripts/date-picker.mjs` | `9376b7854ac49ce02954530a7d7cfa22d574d0218b6619da519b9f5cdbec6690` | 是（本轮唯一功能改动） |
| `scripts/date-picker.test.mjs` | `dcea3ecc20b9768b6c5e447d362b686e135c8599d073eef02dc13106f06b6ad1` | 是（+4 条用例，18→22） |
| `scripts/feishu-shared-page.mjs` | `0fecdcfbc8c0026946f892c6c64f2803e81e5e2e3df5ac8cdcf125071f840a95` | 否（同日早前的共用页修复） |
| `scripts/feishu-shared-page.test.mjs` | `e477503ce77222d6e250a5d108a421917c395668399824f054903304f2357fd6` | 否（同上，新增文件） |
| `scripts/run-daily-report.mjs` | `e7f46a1725365aa63268439226f1dfd10a03c5a2a49715c39377583f12d887d2` | 否（同上） |
| `scripts/readback-daily-report.mjs` | `7e07458da8d6e46cd47ecc566ce791af82e8ab9999bd7828e7697ea6c3307072` | 否（同上） |
| `scripts/collect-promotion-report.mjs` | `890f474e223f99222e6729458b01fbf63577742da4d65c42cb5ec4e3453bf23c` | 否（同上） |
| `scripts/collect-core.test.mjs` | `a83c83b5fa98129ba2b024cba5012e2ae107629bf354dbeda81632900688b092` | 否（同上，HEAD 29→35） |

## 同一类风险、这次没动的

- `date-picker.mjs` 里生意参谋侧的**页签读取**（`--expect-tab` 那条）同样在容错之外，
  读不到会立刻抛。本轮 3 家实跑都通过，所以按「不许凭直觉改」不动它，只在这里记一笔：
  下次它报 `sycm tab 询单到付款` 找不到时，先怀疑同一件事（页面刚到、还没渲染完）。
- `probe-live/` 下另有几个只读探针（`dump-alimama-state.mjs`、`measure-hash-rebuild.mjs`、
  `cold-tab-experiment.mjs`、`cold-mount-e2e.mjs`、`mutate-settle-retry.mjs`），
  与 `runtime/shop-pages.mjs` 的前身一样住在仓库外 —— 如果「冷挂载要等」这条还会再犯，值得收编进仓库。
