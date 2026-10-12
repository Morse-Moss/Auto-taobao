# HEAD 与工作区：双版本调查报告（只读）

日期：2026-10-12
性质：**纯只读**。本次调查只跑了 git 读命令，没有修改任何文件、没有起停任何进程、没有产生任何提交。
HEAD：`cd278d9`（1.8.6，2026-10-12 09:37:22）
工作区：dirty 417 个文件

---

## 0. 结论先行

1. **严格说不是"两套完整代码"，而是"一套能跑 + 一套缺件"。** 磁盘上只有一份文件（工作区那份），它是完整的；git HEAD 那份是**残缺**的——它引用了一个从未进入过任何提交的函数，以至于**干净 clone 出来的推广链连模块都加载不了**（SyntaxError，跑都跑不起来，不是跑错）。
2. **"新旧混合"有两个不同层面的成因，别混为一谈：**
   - 层面 A（运行时）：同一份磁盘文件被不同启动时刻的进程读走。Node 在进程启动时读并编译模块，之后**永不回读磁盘**。所以一个 09:24 启动的进程和 09:42 启动的进程，可以同时跑着"改动前 / 改动后"两份代码。这是长驻编排器 + `spawnSync` 驱动的必然结果。
   - 层面 B（仓库）：工作区里有一部分"新代码"**根本没进 git**。所以 HEAD 和工作区天然就是两份，跟你什么时候重启进程无关。
3. **层面 B 是这次调查的真问题**：HEAD 的推广链是坏的，而且坏了不止一处。

---

## 1. HEAD 的推广链坏在哪（三重，逐条有证据）

### 1.1 driver 引用了一个 git 里不存在的导出

```
$ git show HEAD:.../run-promotion-daily-report.mjs | sed -n '6p'
import { pendingForKind, readLedger } from './promotion-task-ledger.mjs';

$ git show HEAD:.../promotion-task-ledger.mjs | grep -n "pendingForKind"
（空）
```

`pendingForKind` 从未被导出过：

```
$ git log -S "export function pendingForKind" --all --oneline -- '*.mjs'
（空 —— 定义侧一次都没提交过）

$ git grep -n "pendingForKind" HEAD -- '*.mjs'
HEAD:.../run-promotion-daily-report.mjs:6:    import { pendingForKind, readLedger } from './promotion-task-ledger.mjs';
HEAD:.../run-promotion-daily-report.mjs:172:  const pending = pendingForKind(ledger, {...});
HEAD:.../run-promotion-sales1.mjs:13:  import { pendingForKind, readLedger } from './promotion-task-ledger.mjs';
HEAD:.../run-promotion-sales1.mjs:199:      const keywordPending = pendingForKind(ledger, {...});
HEAD:.../run-promotion-sales1.mjs:200:      const audiencePending = pendingForKind(ledger, {...});
```

全是消费侧，零定义侧。静态具名 import 在**链接期**就抛
`SyntaxError: The requested module './promotion-task-ledger.mjs' does not provide an export named 'pendingForKind'`
—— 模块加载即死，连 main() 都进不去。

### 1.2 编排器（sales1）同样中招

`run-promotion-sales1.mjs` 在第 13 行 import、199/200 行调用，同一个病。所以 HEAD 上**入口和驱动都起不来**。

### 1.3 就算前两条修好，第三步取件也过不去

```
$ git show HEAD:.../collect-core.mjs | grep -n "reportKind\|report-kind"
（空 —— HEAD 的 collect-core 不认识 --report-kind）
```

而 driver 在 fetch 阶段会 spawn：

```js
spawnSync(process.execPath, [COLLECT, '--date', ..., '--report-kind', args.kind, '--shop-key', args.shop, ...])
```

`collect-core.mjs` 的参数解析是硬拒绝的（`else throw new Error('unknown argument: ' + key)`），所以 HEAD 上取件阶段会直接 `unknown argument: --report-kind`。

**结论：HEAD 的推广链是三重坏，且坏点全部集中在"供货侧没提交"这一件事上。**

---

## 2. 为什么会这样：两次"半提交"

### 2.1 半提交 A —— 供货侧 6 个文件从 2026-10-05 起就没有再进过 git

供货侧三个文件的最后提交全部停在 `c38b61b`（**2026-10-05 18:04:03**）：

```
$ git log --oneline -3 -- .../promotion-task-ledger.mjs
c38b61b fix(daily-report): ★推广取件「换通道」+ shop-report 查键改用运营叫法
59e418d 平台侧副作用台账：推广取件不再猜「列表里最新那条」+ 一键刷新五店页面

$ git log --oneline -3 -- .../collect-core.mjs
c38b61b ...
$ git log --oneline -3 -- .../collect-promotion-report.mjs
c38b61b ...
```

而消费侧被反复改：

| 提交 | 时间 | 对消费侧做了什么 | 有没有带上供货侧 |
|---|---|---|---|
| `ef629d0` | 2026-10-10 20:19:38 | driver 加 `pendingForKind` import + `reusablePromotionTask` import/调用 | 只提 4 个消费文件，**没有** |
| `9a3285b` | 2026-10-11 11:14:29（1.8.1） | sales1 加 `pendingForKind` 用法；同时**误删** driver 的 `reusablePromotionTask` import | 没有 ledger |
| `c2552d7` | 2026-10-11 18:00:18（1.8.5） | sales1 继续改 | 没有 |
| `cd278d9` | 2026-10-12 09:37:22（1.8.6） | 补回 `reusablePromotionTask` import | 没有 |

`ef629d0` 的文件清单（4 个，全是消费侧）：

```
.../scripts/import-promotion-daily-report.mjs      |  9 ++-
.../scripts/promotion-daily-report-core.mjs        | 36 +++++----
.../scripts/promotion-daily-report-core.test.mjs   | 80 +++++++++++++++++---
.../scripts/run-promotion-daily-report.mjs         | 85 +++++++++++++++++++---
```

**从 `ef629d0` 那一刻起，HEAD 就已经不可加载了**（driver 引用了尚不存在于 git 的 `pendingForKind`）。

### 2.2 半提交 B —— 1.7.18 有文档、无代码，且没有对应提交

```
$ grep -n "^## \[1\.7\.1[89]\]\|^## \[1\.8\.6\]" CHANGELOG.md
18:## [1.8.6] - 2026-10-12
505:## [1.7.19] - 2026-10-10
574:## [1.7.18] - 2026-10-10

$ git log --oneline --all | grep -i "1\.7\.18"
（无 1.7.18 提交）

$ git log -S "源空态" ...  实际命令：git log -S "sourceEmptyAllowed" --all --oneline -- '*.mjs'
（空）
```

1.7.18 说明的"询单空态不许填 0"这套代码，正在工作区里（5 个文件），但**从未提交**。CHANGELOG 里 1.7.19 排在 1.7.18 上面（也就是 1.7.18 的条目是事后补写的），而唯一相关的那次提交 `a5a52b2` 写的是 1.7.19。也就是说 1.7.18 这一版**只存在于 CHANGELOG 叙事里**，代码是搭在后续提交的工作区里。

### 2.3 一个需要更正的说法

07:13 那次只读检查把 `reusablePromotionTask is not defined` 的账记在 `ef629d0` 头上。**这个归因不准确**，按 diff 应该是：

- `ef629d0` 把 `reusablePromotionTask` 加进 core import 块（`+  reusablePromotionTask,`），当时是对的（该版本出现 3 次 = 1 导入 + 2 调用）。
- `9a3285b`（1.8.1）重写该 import 块时**删掉了这一项**（diff 里 `-  reusablePromotionTask,`），同时删掉了两个调用点中的一个，剩下那个调用**没有导入**（该版本出现 1 次）。

```
$ for c in ef629d0 9a3285b c2552d7 HEAD; do
    git show $c:.../run-promotion-daily-report.mjs | grep -c "reusablePromotionTask"; done
ef629d0: 3
9a3285b: 1     ← 从这里开始当雷，1.8.1~1.8.5 一直带
c2552d7: 1
HEAD:    2     ← 1.8.6(cd278d9) 补回 import 后
```

准确的表述是：**ef629d0 引入了新函数并正确导入；1.8.1 把导入删了、调用留着**，于是从 1.8.1 到 1.8.5 一直潜伏，10-12 07:00 首次真机整轮运行才炸。

---

## 3. 为什么这件事一直没被发现

1. **所有人跑的都是工作区，不是 HEAD。** 工作区这 6+5 个文件是完整的，所以本地真机、本地手工跑，全都正常。
2. **测试也跑工作区。** `node --test` 读的是磁盘，不是 git 对象。所以 `promotion-task-ledger.test.mjs` 那 19 条、`promotion-daily-report-core.test.mjs`、`run-promotion-sales1.test.mjs` 全绿 —— 它们测的是"工作区那份"，对"HEAD 缺件"完全无感。
3. **提交时用的是显式路径，天然会漏。** 显式路径提交是为了不扫到别的会话在半空的文件（这条纪律本身没错），但代价是：多文件改动一旦只列了一部分，就会形成一个"能编译、能吃代码、只有 clean checkout 才炸"的半提交。
4. **CI 存在但不咬这个。** `.github/workflows/ci.yml` 在（2026-09-26 建），但它只在 push 时跑；只要本地提交没推到 `origin`（`github.com/Morse-Moss/Auto-taobao.git`），它就永远不会读到这个坏状态。
5. **要暴露它，只有四种动作：clean clone / `git stash` / `git checkout <file>` / HEAD-based CI。** 这四种动作在"一直在工作区里开发"的节奏下几乎不会发生。

---

## 4. 顺带查到的另一处红（不是我改的）

```
$ git diff -- runtime/arch-boundary.test.mjs
@@ -51,9 +51,6 @@ const SKILLS_TO_RUNTIME = Object.freeze([
-  // 2026-10-06 推广日报复用主线目标配置与 Feishu 客户端；两条入口的跨目录依赖显式登记。
-  'skills/sycm-alimama-daily-report/scripts/import-promotion-daily-report.mjs',
-  'skills/sycm-alimama-daily-report/scripts/run-promotion-daily-report.mjs',
```

工作区里把这两条登记删了，而这两个文件**仍然 import `../../../runtime/*`**（alert-throttle、unified-summary-schema 等），所以守卫"依赖清单与登记逐字一致"必红。这是**别的会话的在飞改动**，本次调查一个字没碰。

---

## 5. 当前状态对照表

| 文件 | HEAD 版本 | 工作区版本 | 差额 |
|---|---|---|---|
| promotion-task-ledger.mjs | 10-05 (c38b61b) | +45/-…（含 `pendingForKind`/`kind` 穿参/`REPORT_TASK_PATTERN`） | 供货侧缺失 |
| collect-core.mjs | 10-05 (c38b61b) | +2（`reportKind` 参数） | 供货侧缺失 |
| collect-promotion-report.mjs | 10-05 (c38b61b) | +32/-29（`--report-kind`/`taskPattern`） | 供货侧缺失 |
| promotion-task-ledger.test.mjs | 10-05 (c38b61b) | +18 | 供货侧缺失 |
| run-promotion-daily-report.mjs | cd278d9（仍 import 失效的 `pendingForKind`） | 同 HEAD | 消费侧已提交但依赖不存在 |
| run-promotion-sales1.mjs | c2552d7（仍 import 失效的 `pendingForKind`） | 同 HEAD | 同上 |
| inquiry-core.mjs / .test.mjs / remediation-table.mjs / run-inquiry-backfill.mjs / SKILL.md | 无 1.7.18 代码 | +12/+23/+6/+31/-6 | 1.7.18 整体未提交 |
| arch-boundary.test.mjs | 完整登记 | 少 2 条登记 | 别的会话在飞 |

工作区 `skills/sycm-alimama-daily-report` 整目录 diffstat：9 files changed, 138 insertions(+), 37 deletions(-)。

---

## 6. 需要你拍板（本次未动任何文件）

1. **供货侧 6 个文件怎么办** — 推荐：先做只读逐字核对（确认工作区这份就是 `ef629d0` 缺的那半、没有夹带别的会话的改动），核对通过后单独开一个"补齐 ef629d0 供给侧"的提交。不核就提交的风险是把它人的半成品一起打包进去。
2. **1.7.18 怎么收口** — 推荐：CHANGELOG 的 `[1.7.18]` 条目并入 1.7.19 说明（或标注"随 1.7.19 一并交付"），同时把工作区那 5 个文件提交，让版本叙事和代码一致。
3. **arch-boundary 那两条删除** — 推荐：不动，等它的作者自己收，避免两个会话互相覆盖。
4. **要不要把 HEAD 修到"干净 clone 也能跑"** — 推荐：要，但这就是第 1 条，排在你点头之后。
5. **10-11 缺口的 3 家店（网林淘宝 / 里可林天猫 / 网林家居）** — 推荐：等 HEAD 补齐后再补跑，现在补跑等于继续消耗工作区那份"没进 git 的代码"。

---

## 附：本次调查用到的全部命令（可复现）

```bash
git log --oneline -5
git remote -v
git status --porcelain | wc -l
git show --stat --oneline ef629d0
git log -S "export function pendingForKind" --all --oneline -- '*.mjs'
git log -S "pendingForKind" --all --oneline -- '*.mjs'
git log -S "keywordPending" --all --oneline -- '*.mjs'
git log -S "sourceEmptyAllowed" --all --oneline -- '*.mjs'
git grep -n "pendingForKind" HEAD -- '*.mjs'
git show HEAD:.../promotion-task-ledger.mjs | grep -n "pendingForKind\|kind"
git show HEAD:.../collect-core.mjs | grep -n "reportKind\|report-kind"
git show HEAD:.../collect-promotion-report.mjs | grep -n "reportKind\|taskPattern"
for f in promotion-task-ledger.mjs collect-core.mjs collect-promotion-report.mjs \
         promotion-task-ledger.test.mjs run-promotion-daily-report.mjs; do
  git log --oneline -3 -- "skills/sycm-alimama-daily-report/scripts/$f"; done
git show ef629d0 -- .../run-promotion-daily-report.mjs | sed -n '15,35p'
git show 9a3285b -- .../run-promotion-daily-report.mjs | grep -n "reusablePromotionTask"
for c in ef629d0 9a3285b c2552d7 HEAD; do
  git show $c:.../run-promotion-daily-report.mjs | grep -c "reusablePromotionTask"; done
git diff --stat -- skills/sycm-alimama-daily-report
git diff -- runtime/arch-boundary.test.mjs
grep -n "^## \[1\.7\.1[89]\]" CHANGELOG.md
git log --oneline --all | grep -i "1\.7\.18"
```
