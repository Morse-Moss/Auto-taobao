# sop-runtime：出厂排期改名之后，唯一读出厂配置的那条用例过期了（红 → 绿）

## 一句话

「补跑全量套件」这条建议本身抓到了一个**真实的红**：
2026-09-22 那次排期改名（`weekly-competitor` → `weekly-keyword`，提交 `b7d4c95`）改了 `runtime/round-schedule.json`，
但 `runtime/sop-runtime/round-schedule.test.mjs` 里那条**唯一读出厂配置**的断言没有跟着改 ⇒ `sop-runtime` 397/398。

## 怎么发现的（证据链）

1. `node scripts/run-test-suite.mjs runtime --concurrency=1` ⇒ **860/860/0**（15.4 秒，零失败）。
   见 `04-runtime-suite-first-run.txt`。
2. 按既有纪律 `runtime/sop-runtime` **必须单跑**（`run-test-suite.mjs` 不递归子目录）⇒
   `node tmp/run-sop-runtime.mjs` ⇒ **STATUS=1、397/398**，唯一红的是：
   ```
   not ok 260 - the shipped config file is valid and its period matches the real SOP week
     location: runtime/sop-runtime/round-schedule.test.mjs:296:1（断言在 :303）
     error: 'the shipped schedule must describe the weekly competitor round'
   ```
   见 `01-sop-runtime-RED-before-fix.txt`。
3. 归因（`02-diag-commits-and-shipped-config.txt`）：
   - `git log -1 -- runtime/round-schedule.json` ⇒ `b7d4c95`（2026-09-22，就是改名那次）
   - `git log -1 -- runtime/sop-runtime/round-schedule.test.mjs` ⇒ `b02b6e9`（2026-09-18，**没跟上**）
   - `git diff --stat HEAD -- <这两个文件>` ⇒ 空 ⇒ 工作区干净，**这是一次已经提交进来的红**，不是本地未提交的失误
   - 出厂配置里现在只有一条排期：`name=weekly-keyword enabled=false capability=sycm.feishu.weekly storeId=bathtub-industry`

## 先确认「改名没错、是用例过期」（不然就会改错方向）

决定性的一条：**改名不影响业务幂等键**。

- `runtime/sop-runtime/round-schedule.mjs:61` ⇒ `DEFAULT_BUSINESS_KEY_TEMPLATE = '{capability}/{storeId}/{windowKey}'`
- 出厂条目**没有** `businessKeyTemplate` 字段（`runtime/round-schedule.json`）⇒ 走默认模板
- 默认模板里**没有 `{name}`** ⇒ 名字改了，键不变

`round-schedule.mjs:55-60` 的注释里已经论证过同一件事（「还没有在任何一台机器上接上叫醒者 ⇒
没有任何一个已产出的生产业务键会因这次改名而对不上」）。

⇒ 结论：改的是**期望值**，不是判据口径。反过来做（把配置名改回 `weekly-competitor`）才是错的：
那个名字与它实际借用的能力 `sycm.feishu.weekly` 不符，是历史遗留。

## 改了什么

| 文件 | 改动 | 为什么 |
|-|-|-|
| `runtime/sop-runtime/round-schedule.test.mjs` | 期望名 `weekly-competitor` → `weekly-keyword`，断言文案同步；**补一段注释**说明改名日期、为什么不影响业务键、以及「名字再变这条就该红，那正是想要的效果」 | 唯一读出厂配置的断言 |
| `README.md` | 可复制的命令 `--round weekly-competitor` → `weekly-keyword` | 旧名会让照抄的人拿到「不存在的轮次」 |
| `docs/ops/SYSTEM-OVERVIEW-AND-DEPLOYMENT.md` | 同上，并就地标注改名日期 | 同上 |

**刻意没改**：用例内那些**合成 fixture** 里的 `weekly-competitor`
（`round-schedule.test.mjs` 的 `entry()` 默认名，以及 :180 / :229 / :267 的断言）。
它们是不依赖出厂配置的假数据，改名只会制造无谓 diff。

## 验证

- 改前：`sop-runtime` **397/398**（唯一红点名到 `round-schedule.test.mjs:303`）⇒ 这本身就是突变证据。
- 改后：`sop-runtime` **398/398/0**、`STATUS=0`。见 `03-sop-runtime-GREEN-after-fix.txt`。
- 最终树再跑一次 `run-test-suite.mjs runtime` ⇒ **860/860/0**。见 `05-runtime-suite-final.txt`。
  （重跑的原因：`runtime/deployment-runbook-paths.test.mjs` 会读 `SYSTEM-OVERVIEW-AND-DEPLOYMENT.md`，
  而我改了那份文档，所以改动之后的 runtime 结论必须重新取一次，不能沿用改动前那次。）

## 顺手暴露的一条结构性缺口（本次不是它的锅，但值得记）

`node scripts/run-test-suite.mjs runtime` **不递归 `runtime/sop-runtime/`** ⇒
**398 条用例不在「runtime 全量」的收集范围内**。也就是说：一份只跑了
`run-test-suite.mjs runtime` 的绿灯报告，对 `runtime/sop-runtime/` 里的任何改动**没有任何覆盖**，
而这份报告完全有理由被读成「全量绿」。

⇒ 纪律：报「runtime 全量绿」时必须**另外**说明 `sop-runtime` 跑了没有、结果是多少，
否则那个绿灯是局部绿灯。

## 复核命令

```bash
# 单跑 sop-runtime（脚本内的仓库路径是绝对路径，本机可直接跑）
node evidence/sop-runtime-shipped-schedule-test-2026-09-22/run-sop-runtime.mjs

# runtime 全量（不含 sop-runtime，两者必须分开报）
node scripts/run-test-suite.mjs runtime --concurrency=1
```
