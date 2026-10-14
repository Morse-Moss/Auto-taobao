# CRLF 排练记录（1.9.1 修 CI 红）

1.9.0 推上去之后 CI 红了：`fast-gate` 与 `skill-tests (sycm-alimama-daily-report)` 各挂一条。
两条都是**只在 CRLF 检出下才发作**的问题，本机（LF）工作区怎么跑都是绿的。
所以这一次不能再用「本机全绿」交差 —— 得先把 CI 那个环境**搬出来**，在它里面复现、再在里面复验。

## 一、怎么造出「CI 那个环境」

本机 `core.autocrlf = true`（`git config core.autocrlf` 实测）。这意味着**任何一次全新检出都会是 CRLF**，
而当前工作区是 LF（文件是我用编辑器写进去的，LF）。所以：

```
git worktree add --detach D:/Retire/sycm-crlf-probe 03becbd
```

得到的就是一份**纯 CRLF** 的工作树，与 CI runner 的检出同条件。实测确认过（不是"应该"）：

| 文件 | CRLF 处数 | 裸 LF 处数 |
|---|---|---|
| `runtime/daily-job-plan.mjs` | 883 | 0 |
| `skills/sycm-alimama-daily-report/scripts/stage-browsers.mjs` | 77 | 0 |
| `runtime/hold-and-resume-plan.test.mjs` | 729 | 0 |
| `VERSION` | 1 | 0 |

**另外补了一步**：裸 worktree 没有 `node_modules`（它在 `.gitignore` 里），而 CI 会先 `npm ci`。
不补这一块，跑出来的红可能来自「缺依赖」而不是「换行符」，那就把噪声当成了信号。
补法是把它联到主仓那一份（`New-Item -ItemType Junction`），没有复制、没有新增依赖。

## 二、先后两次跑（顺序不能反）

### 1. 先复现（在**未修**的 1.9.0 内容上）

```
cd D:/Retire/sycm-crlf-probe
node --test "skills/sycm-alimama-daily-report/scripts/stage-browsers.test.mjs" \
           "runtime/hold-and-resume-plan.test.mjs"
```

→ `not ok 29`、`not ok 52`，`# pass 50 / # fail 2`，`EXIT=1`。原始输出：`crlf-rehearsal-before.txt`。

**两条用例名与 CI 报的逐字相同**：

- `接线：定时计划里真的有「驻留」这一步，且它只在链失败时才执行`
- `接线：共用端口来自 browser-ports，本文件里不许出现第二个 19023`

⚠️ 序号不同（这里是 29/52，CI 里是 509/594）—— 因为这里只跑了那两个文件，CI 跑的是整套，
序号是**整套里的位置**。**判据是名字，不是编号**（这也是为什么不能拿编号去定位用例）。

### 2. 再复验（把修好的文件按 CRLF 放回去）

```
node --test "skills/sycm-alimama-daily-report/scripts/stage-browsers.test.mjs" \
           "runtime/hold-and-resume-plan.test.mjs" \
           "runtime/daily-job-plan.test.mjs"
node --test "skills/sycm-alimama-daily-report/scripts/*.test.mjs"
node scripts/run-test-suite.mjs unit --concurrency=2
```

→ 原始输出分别是 `crlf-rehearsal-after-tests.txt`、`crlf-rehearsal-after-skills.txt`、`crlf-rehearsal-unit.txt`。

| 跑的东西 | 结果 | 同一套在 CI 上（1.9.0） |
|---|---|---|
| 三个受影响的用例文件 | 129 tests / 129 pass / 0 fail | — |
| 日报技能集整集 | **594 tests / 594 pass / 0 fail** | 594 / 593 / **1 fail** |
| `unit` 套件 | **1322 tests / 1321 pass / 1 skipped / 0 fail**（`UNIT_EXIT=0`） | 1322 / 1320 / **1 fail** |

两条 CI 红在 CRLF 检出下都转绿了 —— 这就是"修好了"的判据。

## 三、根因（两条，都不是新知识）

### ① EOL 脆弱的源码级断言

`stage-browsers.test.mjs` 剥注释时写的是 `split('\n')` + `/\/\/.*$/`。`$` 在**没有 `m` 标志**时
只在字符串末尾匹配，而 `.` **不匹配 `\r`** ⇒ 遇上 CRLF 的行（行尾是 `\r`）这个正则根本匹配不上
⇒ **注释压根没被剥掉**。而那段注释里恰好写着端口号 `19060`，于是
「代码里不许出现端口字面量」这条断言就红了。

同一个文件、同一段代码的对照实验：

| 输入 | `code.match(/19\d{3}/gu)` |
|---|---|
| LF | `null` |
| CRLF | `['19023', '19060', '19060']` |

仓库里**早就有正确写法**：`runtime/browser-ports.test.mjs` 的 `stripComments()` 用的是
`split(/\r?\n/)`。本批次没有沿用它，另起了一份。`AGENTS.md`「Line-ending note」也明文写着
「每个源码级断言都必须在匹配前 `replace(/\r\n/g, '\n')`」—— 规矩在，执行漏了。

### ② 同一份事实钉在两处

步骤序列在 `runtime/daily-job-plan.test.mjs`（含分批形态，多处）与
`runtime/hold-and-resume-plan.test.mjs`（单跑形态，一处）里各钉一份。1.9.0 加了第 0 步
`viewport-gate`，只改了前者 ⇒ CI 的 `Full unit tests (main)` 红在 `not ok 509`
（差集就是多出来的那一个 `viewport-gate`）。两个文件里现在各加了一段指向对方的注释。

## 四、第一次 `unit` 跑出来 2 条失败（如实记下）

第一次在裸 worktree（**没有** `node_modules`）上跑 `unit`，结果是
`1095 tests / 1093 pass / 2 fail`。当时的输出只留了尾部 25 行，**那 2 条的用例名没有留下**。
接上 `node_modules` 联接后，同一条命令在同一检出上变成 `1322 / 1321 / 1 skipped / 0 fail`。

为什么可以断定这 2 条**不是**本批代码引入的：CI 已经在**同一套**（1322）上跑过 1.9.0 的 CRLF 检出，
整套只红 1 条。若真有 2 条额外的 EOL 失败，CI 也会红 —— 它没有。
所以那 2 条最可能是「裸检出缺依赖」造成的环境噪声。

留这个坑在这里的意义：**裸 worktree ≠ CI 环境**。造排练场时要对着 CI 的步骤逐条补齐
（CI 有 `npm ci`，排练场就得有 `node_modules`），否则会拿噪声去解释真信号。

## 五、这次排练**没有**证明什么

- 没有真机运行：日报链本身一次都没跑（按约定，驻留窗口期不手工重跑、也不起停进程）。
- 没有覆盖 `integration` / `runtime` / `sop-runtime` 套件（它们要活体浏览器或库，CI 也不跑）。
- **不替代 CI**：这份排练只说明「这两条在 CRLF 下确实由这两个改动治好」，
  最终判据仍然是推上去之后那个 run 的结论。
- 没有加自动化守卫：这类「只在 CRLF 下红」的断言目前**没有**静态守卫，唯一能抓到它的是 CI 本身。

## 六、排练场已回收（顺带踩到一个坑）

先拆 `node_modules` 联接（**只删链接、不递归**：`[System.IO.Directory]::Delete($p, $false)`）,
核对主仓依赖未受损（`node_modules` 条目数 121 → 121、`pg` / `@grpc` 都在）——
**不能用「递归删除」去删一个联接**，那有连带删掉目标目录内容的风险。

然后 `git worktree remove --force D:/Retire/sycm-crlf-probe`。**这条在 7762 个文件上跑到一半被杀掉了**
（前台执行返回 SIGTERM），结果是：`.git` 已经删掉、顶层还剩 13 个条目 ⇒ `git worktree list` 里它变成
`prunable`。收尾是两步：

```
git worktree prune --dry-run -v   # 先预演：只列出 sycm-crlf-probe 一条，别的会话的工作树不动
git worktree prune -v             # 再真删登记项
rm -rf /d/Retire/sycm-crlf-probe  # 最后清残留目录（带路径守卫，只允许以 sycm-crlf-probe 结尾的路径）
```

两个教训：
- 这个仓库里还有**别的工作树**（`D:/Retire/sycm-ci-check`、`D:/codex/worktrees/...`、
  `D:/Retire/worktrees/...`），属于别的会话/用途 —— 所以 `prune` 之前**必须先 `--dry-run` 看它想删谁**，
  不能直接跑。
- 大工作树的 `worktree remove` 要按「可能中途被打断」来设计：先 `--dry-run` 确认影响面，
  收尾时用 `prune` + 带守卫的目录删除，而不是指望一条命令跑完。
