# 分批形态的「留住现场等人」+ 驻留截止口径修正（2026-10-06）

基线：`9e292cf`（A 项：整轮被挡的告警不再把「共用窗口掉登录」说成「页面不齐」）。
本批 8 个源文件 + 本证据目录，未提交前。

## 一、这一批治的是什么

用户原话：**「既然掉登录了，又自动修复不了，就应该挂住等人过来登录啊」**。

「留住现场等人」这件事在**不分批**的链上早就有了（`scripts/hold-and-resume.mjs`），但：

1. **生产形态是分批**（定时任务的 `--batches 5`）。而 `scripts/run-batches.mjs` 里**一个
   `hold-and-resume` 字样都没有**（`git show HEAD:scripts/run-batches.mjs | grep -c hold-and-resume` = `0`）
   ⇒ 分批跑被整轮挡下时，每一批照旧 `stop` 掉自己的实例，最后什么都没留下。
2. 更要命的是：即便走到那条驻留分支，它**从来没有真正等过一秒**（见 §二）。

所以这一批做两件事：把驻留接进分批形态；修好那个「等着了但其实没等」的截止口径。

## 二、三个发现（都带取证）

### 2.1 驻留的截止是一个**已经过去的钟点** ⇒ 实际等待 0 秒

（`git show HEAD:runtime/hold-and-resume-plan.mjs`）

```
:18   export const DEFAULT_HOLD_UNTIL = '12:00';
:50   export function deadlineReached({ nowMinutes, untilMinutes }) {
```

`buildHoldResumeArgs`（`runtime/daily-job-plan.mjs`）只拼 `--date / --summary / --notify*`，
**从不传 `--until` 或 `--hold-hours`** ⇒ 截止恒为当天 12:00。

而日报定时任务是 **15:30** 起跑 ⇒ 第一轮循环里 `deadlineReached(now>=720)` 就为真
⇒ 立刻打印「到 12:00 还没等到」并退出（`HOLD_EXIT.TIMED_OUT` = 3）。

也就是说：**「挂住等人」这件事在这个仓库里从来没有发生过一次**，
日志与 `--print` 里那句「默认等到当天 12:00」是一句兑现不了的承诺。

修法：默认口径从「钟点」换成「时段」——`DEFAULT_HOLD_HOURS = 4`，绝对值算成毫秒
（跨零点安全）；`--until HH:MM` 保留为人工备用档，且**给一个已经过去的钟点会直接报错并
指向 `--hold-hours`**（不再静默退化成零等待）。

### 2.2 收尾告警点名了 **13 家**，而那一轮只在采 **8 家**

`scripts/hold-and-resume.mjs` 的默认店铺名单取的是 `shopBrowserKeys()`（登记表全量 = 13）。
用登记表全量的症状：收信人看到「13 家全缺数据」，而实际只有 8 家在采（销售1部）。

修法：默认改取 `collectingShopKeys()`（= 8 家，参与采集的口径）。

### 2.3 分批那档的驻留**该放在分批驱动里**，不是加一个计划步骤

证据：`evidence/batches-2026-10-05/batches.log` 里 b1 与 b2 **逐字节停在同一个地方**
（整轮被挡 ⇒ 对每一批是同一个结论）。

若把它做成计划里的一个独立步骤：剩下的批次会先白起白停一遍、并**重复发同一份告警**，
然后才轮到驻留。所以正确落点是 `scripts/run-batches.mjs` 内部：
**跑到哪一批被挡就停在哪一批**，其余批次不再跑，再委托给**同一个** `hold-and-resume.mjs`。

配套两条：

- 续跑入口回**分批驱动本身**（`--resume-via-batches --batch-size N`），不是直连链 ——
  分批下店铺实例是按批起停的，链跑完后实例已被 `stop` 放掉，直连链只会在「实例不在」的
  现场上再撞一次同一堵墙。
- 续跑默认带 `--no-hold`（`buildBatchResumeArgv` 的默认值），防「驻留套驻留」：
  第二层等的是另一份结论，而第一层的 `--date/--summary` 已经过期。

## 三、改动的文件

| 文件 | 改动 |
| --- | --- |
| `runtime/hold-and-resume-plan.mjs` | `DEFAULT_HOLD_UNTIL` → `DEFAULT_HOLD_HOURS=4`；新增 `resolveHoldDeadline` / `deadlineReachedAt` / `formatClock`，删 `deadlineReached`；`POLL_SECONDS_BY_CAUSE` 加 `ROUND_LOGIN_WALL:120`；新增 `buildBatchResumeArgv` |
| `scripts/hold-and-resume.mjs` | 默认名单 → `collectingShopKeys()`；`parseArgs(argv,{now})` 出 `deadlineMs/untilText/deadlineSource`；新增 `resumeArgvFor`（分批/非分批的唯一分叉点）；成因**优先读落盘**的 `roundCause`，缺失才按探针文本回落 |
| `runtime/batch-plan.mjs` | 新增纯函数 `batchRoundBlockOf(summary)` |
| `scripts/run-batches.mjs` | `hold` 默认开 + `--no-hold`；`readBatchRoundBlock`；`runBatchHold`；循环里被挡即 `break`；`batches.json` 增 `hold` 块；`--print` 增「整轮被挡怎么办」 |
| `runtime/daily-job-plan.mjs` | `buildBatchChainArgs` 透传 `hold`；`batchWithoutHold` 改名 `batchHoldInline` |
| `scripts/run-daily-job.mjs` | `--print` 文案改准（驻留在分批驱动内部）；修掉那句过期的「链失败则不主动释放」 |
| `runtime/hold-and-resume-plan.test.mjs` | 换掉 `DEFAULT_HOLD_UNTIL` 断言；新增时段默认、过去钟点拒绝、`--batch-size` 必填、`batchHoldInline` 透传、`buildBatchResumeArgv`、`batchRoundBlockOf`，以及**两条源码级接线守卫** |
| `runtime/daily-job-plan.test.mjs` | 旧「分批那一档不驻留」改成「驻留在分批驱动内部 + `--no-hold`」 |

## 四、验证（都是实测）

### 4.1 突变验证 4/4（`mutation-verify.mjs` → `mutation-output.txt`）

```
[M1 分批驱动读到整轮被挡却不停手]             红=true 点名期望串=true
[M2 --no-hold 不再转发到分批驱动]              红=true 点名期望串=true
[M3 驻留截止退回「立刻到点」]                  红=true 点名期望串=true
[M4 分批续跑不带 --no-hold]                    红=true 点名期望串=true
还原：sha256 全部一致
突变 全部被抓住；最终 测试复绿
```

判红口径是 TAP 的 `# fail [1-9]`，并把「点名到你期望的那条断言」当独立条件 ——
不把「子进程抛了」当红（本机沙箱下 `spawnSync` 给 stdin 管道会 `EBUSY`，
那样会造出全绿假红，这个坑本轮踩过一次并已写进脚本注释）。

### 4.2 套件

| 组 | 结果 | 落盘 |
| --- | --- | --- |
| 定向纯函数（hold/resume + daily-job-plan + batch-plan） | **103/103** | 本地复跑确认 |
| runtime 组 | **1084/1084，fail 0** | `suite-runtime.txt` |
| 日报技能组 | **440/440，fail 0** | `suite-skill-daily-report.txt` |

注：103 那条第一次跑出 `not ok 98` 是**我自己造的竞态** —— 突变脚本与测试并行跑，
测试读到了突变中途的 `run-batches.mjs`。单独复跑即 103/103。

### 4.3 真机演示（只读、非侵入：`--no-release` 不发飞书、不释放；`--notify-print` 只打印）

命令见 `hold-live-demo.txt`。打的是**真实的**被挡结论 `evidence/batches-2026-10-05/b1/summary.json`：

- 新的截止行：`[驻留] 截止 16:14（现在 16:14）｜口径：从现在起挂 0.005 小时｜轮询 5 秒一次`
  —— 旧形态这里是 `截止 12:00（现在 16:14）` 并当场收尾。
- 计时对照：`--hold-hours 0.005`（18 秒）⇒ **实际等待 21 秒**（多出的 3 秒是 5 秒轮询粒度的
  向上取整 + 首轮探针）。旧形态是 0 秒。**这是「真的等了」的硬证据。**
- 收尾告警里的店铺名单是**8 家**（里可林淘宝、网林天猫、盖文淘宝、盖文天猫、科塔淘宝、
  网林淘宝、里可林天猫、网林家居），不是 13 家。§2.2 的修法在产物上可见。
- 该结论是 A 项提交**之前**的产物（无 `roundCause` 字段）⇒ 顺带验证了「优先读落盘、缺失才回落探针」
  那条回落路径：没有把「读不到」误报成「掉登录」。

`print-copy.txt` 收了三份 `--print` 文案（分批驱动默认 / 分批驱动 `--no-hold` / 定时入口两档），
以及 `--no-hold` 从定时入口透传到分批驱动的实证。

## 五、没验证到什么（边界要说清）

- **端到端的驻留没有真跑过**：那需要在商家浏览器真掉登录或真有挡不住的弹窗时，
  让一批真的跑起来并停在半路。本轮没有起任何浏览器（也**不允许**在无人授权时起停进程），
  所以验到的是「判据 + 接线 + 真的会等」这一层，不是「现场那一晚它真的挂住了」。
- `stop-all --yes` 的释放路径没有在新代码里被触发（演示一律带 `--no-release`），
  所以「放掉没有」仍然只能靠**回读端口**判，不能看退出码（已知假绿）。

## 六、复现

```bash
# 突变（4/4，含字节级还原）
node evidence/batch-hold-2026-10-06/mutation-verify.mjs

# 定向纯函数
node --test runtime/hold-and-resume-plan.test.mjs runtime/daily-job-plan.test.mjs runtime/batch-plan.test.mjs

# 真机演示（只读；--no-release 保证不碰任何进程）
node scripts/hold-and-resume.mjs --date 2026-10-05 \
  --summary evidence/batches-2026-10-05/b1/summary.json \
  --hold-hours 0.005 --poll-seconds 5 --no-release --notify-print

# 文案
node scripts/run-batches.mjs --date 2026-10-05 --print
node scripts/run-batches.mjs --date 2026-10-05 --print --no-hold
node scripts/run-daily-job.mjs --date 2026-10-05 --batches 5 --print
node scripts/run-daily-job.mjs --date 2026-10-05 --batches 5 --print --no-hold
```

**给运维的一句话**：这一批之后，分批跑遇到「整轮被挡」会**停在被挡的那一批**并把共用窗口留住，
人处理完自动按批重跑；要退回旧行为（发完告警就结束）给 `--no-hold`。
