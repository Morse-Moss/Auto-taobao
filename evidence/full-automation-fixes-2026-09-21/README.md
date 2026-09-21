# 证据：完全自动化四轮修复的收口（2026-09-21 晚）

这一份只放**可核产物**。结论正文在 `docs/ops/FULL-AUTOMATION-STATE-CONTRACT-2026-09-21.md` §九。
**本轮没有跑采集、没有写飞书、没有起停任何进程。**

## 怎么读这些文件

| 文件 | 它证明什么 |
|---|---|
| `f-driver.txt` | 驱动单文件 `run-multi-shop-day.test.mjs` **43/43**（含新加的三条失败收尾 + 一条归位接线判据） |
| `f-normalize.txt` | `runtime/page-normalize.test.mjs` **6/6**：写侧用**有状态的假代理**逐条钉住（缺页先领回且零新建 / 多页零写请求 / 一页都没有才新建且必须 `pinned=1` / 只读时零写请求） |
| `f-refresh.txt` | `runtime/refresh-shop-pages.test.mjs` **7/7**：读不到读数判 `stale` 绝不判 `ready`；`yesterday` 缺失或格式不对直接抛；重载走 `/eval` 的 `window.location.reload()` 而**不**走 `/navigate` |
| `f-shoppages.txt` | `runtime/shop-pages.test.mjs` **33/33**（叶子模块搬迁后重跑，确认没把 shop-pages 改坏） |
| `unit-2026-09-21-c.txt` | **全量 `unit` 整跑，exit 0**：`unit:skills` **761/761**、`unit:runtime` **794/794**，`not ok` **零行**。改动前 runtime 半是 793 通过 / 1 失败，失败的就是下面这个守卫 |
| `guard-now.txt` → `guard-after.txt` | 跨目录守卫 `runtime/arch-boundary.test.mjs`：**先红**（新增 `runtime/expected-pages.mjs`、`runtime/refresh-shop-pages.mjs` 等，处置里明说「先问一句这东西是不是该留在能力的目录里」）→ **后绿 3/3**（把叶子搬回能力目录 + 按守卫要求显式登记两条依赖并写明理由）。顺序在这里是证据：登记不是为了让测试变绿 |
| `mutation-leaf.txt` + `mutate-leaf-location.mjs` | 新判据的突变验证 **2/2 被抓住**，两次都点名到 `驱动：体检真的接上了「先归位、再检查」…（接线判据）`；还原后驱动 sha256 逐字节一致（`79cb78550d916ebcd5f9d926317680e1ecefc623026140f069010983ad4b702f`） |

## 两个容易误读的地方

1. `guard-now.txt` 里的「新增」是**当时的事实**，不是遗留缺陷 —— 它被后面那次搬迁消掉了。
   判「现在对不对」看 `guard-after.txt`，别拿 `guard-now.txt` 当现状。
2. 突变验证第一次刻意用**真副本**（`expected-pages-alias.mjs`）而不是直接改写导入路径：
   改成不存在的路径会让整个测试文件在 import 阶段就崩，**报不出是哪一条判据拦下的**。
   第二次（负向判据）用注释注入，它证明的是**机制**在，不是语义 —— 别把它读成更强的结论。

## 不在本目录里、但同样要紧的现场

`evidence/multi-shop-2026-09-20/summary.json` 是今早那一轮的真实收据：
`mode=commit`，`health-check` / `alimama-date` / `promotion-submit` 三步全 0，
停在第 4 步 `sycm-date`（`state did not settle to 2026-09-20`，页面读数停在 `统计时间 2026-09-19`），
`shops` 里**只有里可林一家**（默认第一家失败即停整轮）⇒ **push 从未执行 ⇒ 飞书 09-20 零写入**。

---

## 第二轮（2026-09-21 晚第二轮）：代理重试 + 科塔的页面被平台弹回

结论正文在 `docs/ops/FULL-AUTOMATION-STATE-CONTRACT-2026-09-21.md` §十。
这一轮同样**没有跑采集、没有写飞书、没有起停任何进程**；浏览器侧只发生了两件事 ——
第二轮排练失败收尾自己做的回位（四家店成功），以及我对科塔那一个页签做的一次 `navigate` 探针。

| 文件 | 它证明什么 |
|---|---|
| `proxy-retry-tests.txt` | 驱动单文件 `run-multi-shop-day.test.mjs` **46/46**（新增 3 条：重试判据 / 重试接线 / 重试行为） |
| `proxy-retry-mutation.txt` | 突变 **7/7 CAUGHT_AND_NAMED**，还原后 sha256 逐字节一致（脚本 `run-multi-shop-day.mutation.mjs`） |
| `proxy-retry-mutation-first-try.txt` | 第一次跑只有 **5/6**：M3 的突变方式没被点到正确的那一条。我改的是**突变方式**（让它真的变成孤岛）而不是放宽期望 —— 留着当方法上的证据 |
| `proxy-connectivity-probe.txt` | 只读探针：5 家店 + 商家浏览器 **90/90 次 TCP 全通、6/6 次 `GET /targets` 全 200** ⇒ `fetch failed` 不是「代理死了」 |
| `shop-targets-after-rehearsal2.txt` | 四家店现场干净（性能页 + 阿里妈妈下载列表 + downloads-hub 各一）；**科塔只有 2 个页签**，SYCM 那个停在 `/mc/free/sycm` |
| `shop-pages-after-rehearsal2.txt` | 官方只读诊断（`runtime/shop-pages.mjs`，exit 2）：四家齐、**科塔缺「生意参谋工作页」** |
| `keta-19044-drifted-page.txt` | 只读读一次 DOM：标题「生意参谋 - 零售电商大数据产品平台」、正文有店名「科塔全卫定制 主店」与「退出」、`hasLoginForm:false` ⇒ **已登录，不是登录页** |
| `keta-19044-reclaim-attempt.txt` | `navigate` 返回 **HTTP 200**，但 3s/7s/15s/30s **四个点全部**仍在 `/mc/free/sycm` ⇒ 平台弹回并弹住（不是「没导航过去」、也不是「等不够久」） |
| `target-0920-facts.txt` | 09-20 那一轮的既有事实：`mode=commit`、停在里可林第 4 步、`shops` 里只有一家 ⇒ 飞书零写入 |
| `concurrent-writer-check.txt` | **另一个会话在并发写这个仓库**（14:42–14:55），且它的灰豚运行自报用的是 `edge-daily-report` —— 与本链的 `push` / `readback` 是同一个浏览器 |
