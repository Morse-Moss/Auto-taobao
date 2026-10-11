# 三链对齐与系统重构方案（日报 / 商品 / 推广）

日期：2026-10-11
作者：接线员（总执行人）
背景：07:00 推广轮事故复盘（缺陷㊶＋薄壳链问题）后的系统性梳理。
最终目标映射：可持续运行（失败自愈＋告警兜底）、可拓展（新链接入只写业务不写机制）、维护性健壮性高（一个能力一个家、契约先行）。

---

## 一、三链现状矩阵

| 能力维度 | 日报链 | 商品链 | 推广链 |
|---|---|---|---|
| 入口编排 | run-daily-job → run-batches → run-multi-shop-day（2655 行） | run-product-data-job（自编排，不走 run-batches） | run-batches 直连 → run-promotion-sales1（101 行） |
| 互斥锁 | 有（run-daily-job 抢 workflow-lock） | 有（自己抢 workflow-lock） | **无**（绕过 run-daily-job，直连 run-batches） |
| 批次编排 | run-batches（三链共用，1.8.0 统一） | 自带 planBatches | run-batches（共用） |
| 登录编排 | ensure-merchant-login（宿主层）＋批次 login-preflight | runBatchLogin（--login/--json，复用 login-merchant-core 的 SITES） | 仅批次 login-preflight，链内无登录恢复 |
| 失败感知 | failure-perception（失败→事实＋截图） | 无 | 无 |
| 分诊 | remediation-table（成因→方向＋闸门） | 无 | 无 |
| 自修 | repair-actions / repair-shop-stage（候选闭合集） | 无 | 无 |
| escalation | gaveUp→agent 派单→飞书叫人（10 处） | 无 | 无 |
| 飞书告警 | notify-feishu＋alert-throttle（30 处） | alert-throttle（7 处） | **零** |
| 回执 | run-receipt-v1（1.8.0 外壳层）＋链内 summary | workflow-receipt（**另一套 schema**） | run-receipt-v1（外壳层，链内只有 error.message） |
| 释放/托住 | 按 unfixable 信号判定（gaveUp/candidates/noActionRequired） | 自管窗口 | **恒释放**（信号源不存在 ⇒ unfixableShopsOf 恒空） |
| 幂等/台账 | 底单行＋同日重复行闸门 | sourceRows 收据 | promotion-task-ledger（新写，判定口径有㊶ 缺陷） |
| run-root 取证 | 1.8.0 已接（回执＋manifest） | 未接 | 1.8.0 已接（外壳层） |

内核复用硬数字（grep 命中数 escalation/repair/notify/unfixable/gaveUp）：日报 9/71/30/2/10，商品 0/5/7/0/0，推广 0/0/0/0/0。

## 二、冲突点与不一致清单（按风险定级）

1. **P0｜失败处理内核三档配置**。感知→分诊→修复→escalation→notify 只在日报链的私有文件里。任何新链要这套能力没有物理载体可 import（除非跨目录引日报链的肉）。这是「每条新链重新发明、重新踩坑」的结构性根因，07:00 事故是它的第一次大规模发作。
2. **P0｜推广链无互斥锁**。锁在 run-daily-job 层，推广轮直连 run-batches 绕过。手动并发触发两条链会撞浏览器资源（同店代理端口只有一个）。
3. **P0｜㊶ 确认口径分裂**。推广链用「提交后任务列表差集 added==1」判成功，实际一律读不到新任务（重试 10 次×6 秒含 reload 仍失败）；日报链同类问题的正确判据是「按业务日读列表、找到同参生成成功任务即成功」（换通道逻辑＋locate-only 复用判据）。同一业务问题两套判据，一套是错的。
4. **P1｜回执契约两套并存**。workflow-receipt（商品链、周报在用）vs run-receipt-v1（1.8.0 新建，日报/推广在用）。监控、审计、调度侧读取口径分裂，长期必然出「哪份回执才算数」的事故。
5. **P1｜登录编排三种实现**。ensure-merchant-login / runBatchLogin / 仅批次 preflight。掉线恢复能力三档。
6. **P1｜告警出口三档**。日报满配、商品有 throttle 无链内 notify、推广零。07:00 的「无人知晓」直接由此而来。
7. **P1｜释放/托住信号契约不存在**。unfixableShopsOf 读 summary.shops[].autoRepair.gaveUp / repairRequest.candidates / noActionRequired——这是日报链私有的字段路径，不是三链共享 schema。推广链不产这些字段 ⇒ 永远判「没有需要人看现场的失败」⇒ 恒释放。
8. **P2｜共享资产放错层**。resolveTargetDate、login-merchant-core 的 SITES 等通用件住在 skills/日报链目录里，商品链只能跨目录 import（正是当前 arch-boundary 红项的成因）。层放错了，白名单只是止痛药。
9. **P2｜EBUSY 散布**。链内 spawnSync 默认 stdio 的坑散布多处（import 已修 1 处、run-promotion-daily-report fetch 分支未修）。同一坑每条链重踩一遍。
10. **P2｜时间/静止点口径散落**。11:20 CSV 静止点、时区（ISO Z 是 UTC）、「早跑低值不可重推」等约束散在各链文档与代码注释里，没有一处权威登记。

## 三、对齐方案（优先级＋步骤）

### P0 止血（本周内，目标：推广链达到「失败不沉默、现场不丢失」下限）

1. **㊶ 根修**：submit 确认口径改为「提交后按业务日读列表，找到同参『生成成功』任务即成功」。判据直接复用 locate-only 已有实现。同文件顺修 fetch 分支 EBUSY（stdio ['ignore','pipe','pipe']）。
2. **推广链接 notify-feishu**：失败才投递，走 alert-throttle 防重复轰炸（spec §2.1 本来就要求复用）。
3. **释放兜底**：链非 0 且 summary 缺 repairRequest 字段 ⇒ 不默认释放，改驻留＋告警。改 run-batches / hold-and-resume-plan（本轮文件）。判据：宁可白托一次窗口，不可再清一次现场。
4. **推广链接锁**：run-batches 入口抢 workflow-lock（或调度改走带锁宿主）。锁名按 workflow 区分，防跨链误伤。

### P1 对齐（1–2 周，目标：三链同一套契约）

5. **统一 summary schema**（这是所有下游能力的前提）：shops[].{status, error, failureClass, autoRepair.gaveUp, repairRequest.candidates, noActionRequired, evidence}。三链产出同一 schema 后，unfixableShopsOf、托住、告警、回执全部只认 schema 不认链私有路径。
6. **统一回执**：workflow-receipt 包一层 adapter 转 run-receipt-v1（或直接迁移商品链），收敛到一份契约。调度侧只读 run-receipt-v1。
7. **统一登录编排**：三链共用一个登录守卫入口（机制进 runtime，掉线分流判据留 skills）。

### P2 重构（见第四节）

### 抢救收尾（与上并行，当天）

8. 剩余 6 家补提交人群（会误报但实际成功，靠 locate-only 确认）＋盖文天猫补关键词，取件导入，补齐 10-10 数据。

## 四、重构整体思路

### 目标架构（三层，能力各归其位）

- **L1 平台内核层（runtime/）——机制的家**：批次编排、互斥锁、登录守卫机制、失败感知机制（失败→事实＋截图）、分诊执行器（读判据表）、自修执行器（读候选表）、escalation 编排（gaveUp→agent→飞书）、notify＋throttle、统一回执 run-receipt-v1、run-root 取证、托住判定。只含「怎么做」，不含「什么算什么」。
- **L2 业务判据层（skills/<链>/）——判据的家**：步骤清单（链的 11 步/8 步/几步）、分诊表（哪些成因→哪个方向）、修复候选表（闭合集）、noActionRequired 口径、字段映射、目标表、时间约束（静止点/业务日口径）。
- **L3 调度层**：workflow-catalog＋统一入口（--mode/--commit），已落地（1.8.0）。

**核心不变量：新链接入＝写判据＋写步骤，不写机制。** 机制只有一份，写一次、修一次、所有链受益。

### 迁移策略：绞杀者模式，不重写、只搬家

不推倒日报链。每一步把一块机制从日报链的肉里抽到 runtime/，日报链改为 import 抽出的模块，行为不变量测试＋--print 基线逐字节对比钉住「搬家前后行为不变」。搬完一块，商品/推广链接一块。顺序按依赖：summary schema → 感知 → 分诊/自修 → escalation → 登录守卫。每个能力一次独立提交，可单独回滚。

### 验收门（写进规范，防再发生）

新链接入生产调度前必须答「失败出口四问」：失败会不会告警？会不会自修？修不动会不会托住？summary 里有没有 unfixable 信号？四问答不上来的链不许挂定时任务。附「机制/判据分离检查」：新链文件里出现 escalation/感知/修复机制的实现代码（而非 import）即不通过。

## 五、风险控制措施

1. **行为不变量**：每次搬家前后 --print 基线逐字节对比（本仓已验证的手法）；定向套件＋突变验证（改坏必须红在点名用例）。
2. **小步提交**：一个能力一个 commit，git revert 即回滚；显式路径提交，不碰并行线在飞文件（动前盘 mtime＋归属，被持有先请示）。
3. **新旧并存过渡**：回执统一用 adapter 而非硬切；schema 统一先加字段后删旧路径，两轮观察期。
4. **真机验证顺序**：单店→单批→全量；每项落地后的下一个调度轮就是真机验收（07:00/10:00/11:30 三轮天然是验收窗口）。
5. **数据安全**：飞书写前量基线＋写后回读；dry-run 优先于 apply；不删生产数据（删需单独授权）；换通道配额每业务日 1 次不超。
6. **并发安全**：锁先于一切接线（P0-4 在 P1 之前）；托住兜底宁可误托不可漏托。
7. **验收判据独立**：释放只认两次端口回读；回执 COMMITTED_AND_VERIFIED 也要独立回读——不信任何自报。

## 六、待拍板项

1. P0 四件（㊶ 根修／notify／释放兜底／锁）今天开始做？其中 run-promotion-sales1.mjs、import-promotion-daily-report.mjs 仍被并行线持有，需授权我碰。推荐：授权，改完显式路径提交。
2. 抢救收尾继续今天做完（6 家人群＋盖文天猫关键词）？推荐：继续。
3. P1 统一 summary schema 的草案由我先出、你批？推荐：是。
4. 「失败出口四问＋机制/判据分离」验收门写进 AGENTS.md？推荐：写。
5. 时间口径权威登记（静止点/业务日/时区约束集中一处）随 P1 一起做？推荐：随 P1。
