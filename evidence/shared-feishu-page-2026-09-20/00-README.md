# 共用飞书页 · 弹窗视口 —— 落地与验收（2026-09-20）

这一目录只放**验收证据**。设计与根因分析在：
- `docs/ops/VIEWPORT-AND-FEISHU-SHARED-PAGE-2026-09-20.md`（机制、方案 A1-A4 / B1-B5、已落地章节）
- `evidence/rootcause-2026-09-20-multi-shop-rehearsal.md`（那一轮排练失败的逐条根因）

## 这一轮改了什么（用户批准范围：A1、A3、B1、B2、B3）

| 项 | 文件 | 内容 |
| --- | --- | --- |
| A1 | `collect-promotion-report.mjs` | `waitForConfirmButton`：「确定」在但点不着 ⇒ 先 `scrollIntoView` 一次，下一轮按**原判据**重判；`scrolls` 进日志与报错 |
| A3 | 同上 | `DIALOG_BUTTONS_EXPRESSION` 增报 `rect`/`centerY`/`viewport`；新增 `describeDialogCandidates`（日志与报错共用一行摘要） |
| B1 | `run-daily-report.mjs` + 新增 `feishu-shared-page.mjs` | `main()` 里 `ensureTargetPage(args)` 排在 `inspectTarget(args)` 之前；断言退化为回读校验 |
| B3 | 同上 | 停错表的诊断同时报「当前/期望 table+view」「五家共用这一页」「多半是上一家没收尾」；`got 0/2` 也不再只报数字 |
| B2 | `readback-daily-report.mjs` | 读两张表整段包 `try/finally`，归位在 `finally` 里且自己吞错出声；末行总结不再把「没归位」印成已归位 |

一个实现中另发现并修掉的缺口：**URL 对 ≠ 页面模型已加载**。所以 `ensureTargetPage`
在「已经在授权 table/view 上」时仍然等一次模型（`waitForTargetModel`，判据与 readback 的
`waitForModel` 同源：等目标表那个**键**，不等 `base.tables` 变成真对象）。

## 验收

- `01-mutation.txt`：5 条突变各自**只**点名一条用例，还原后逐字节一致（sha 对照写在里面）。
- 针对性：`node --test feishu-shared-page.test.mjs collect-core.test.mjs` → 48/48 绿。
- 全量离线套件（改动之后跑）：`skills` 732/732 绿、`runtime` 725/725 绿，退出码均 0。
  注：runtime 的条数从当日早先记下的基线 709 涨到 725，是**今天另外几个提交**加了 runtime 测试
  （关键词需求文档守卫、内容热度写入器用例等）；本轮改动没有碰 `runtime/` 下任何文件（见 `git status`）。

## 最终文件哈希

```
0fecdcfbc8c0026946f892c6c64f2803e81e5e2e3df5ac8cdcf125071f840a95  skills/sycm-alimama-daily-report/scripts/feishu-shared-page.mjs
e477503ce77222d6e250a5d108a421917c395668399824f054903304f2357fd6  skills/sycm-alimama-daily-report/scripts/feishu-shared-page.test.mjs
e7f46a1725365aa63268439226f1dfd10a03c5a2a49715c39377583f12d887d2  skills/sycm-alimama-daily-report/scripts/run-daily-report.mjs
7e07458da8d6e46cd47ecc566ce791af82e8ab9999bd7828e7697ea6c3307072  skills/sycm-alimama-daily-report/scripts/readback-daily-report.mjs
890f474e223f99222e6729458b01fbf63577742da4d65c42cb5ec4e3453bf23c  skills/sycm-alimama-daily-report/scripts/collect-promotion-report.mjs
a83c83b5fa98129ba2b024cba5012e2ae107629bf354dbeda81632900688b092  skills/sycm-alimama-daily-report/scripts/collect-core.test.mjs
```

改动尚未提交（`git status` 里是 4 个 M ＋ 2 个 ??）。提交与否由用户定。

## 没做的（等条件，不许先写代码）

- **A2** 给店铺浏览器定窗口尺寸：`--window-size` 与 profile 记忆谁说了算**还没实测**。
- **A4** 阿里妈妈能否绕开弹窗：需要活的报表页；仓库里 grep `one.alimama.com` 只有 3 个页面级 URL、
  **没有任何 XHR 记录**，所以只能现场探。
- **仍缺的两块现场证据**：网林 readback 的 `last=false`（为什么 30 秒没等到询单表）、
  那 36px（内容高度 vs 视口高度）的来源。两项都要起浏览器，未动。
