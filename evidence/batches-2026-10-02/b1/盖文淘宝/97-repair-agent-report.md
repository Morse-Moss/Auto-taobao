# 修复 agent 报告 · 盖文淘宝

- 目标日：2026-10-02
- 批次：b1（`--batches 5`）
- 失败阶段：`health-check`（exit 2）
- 请求单成因：`SHOP_BLOCKED`
- 该店代理（登记表 `runtime/browser-ports.mjs` shopInstance().proxyPort）：`http://127.0.0.1:19043`
- 报告执行时间：2026-10-03 16:00–16:02（本地）

---

## 1. 最终结论

**修不动（agent 本轮无法修复）**，且**根因不是候选动作能触达的形态**。

两条独立判据：

1. **现场是登录墙，不是页面漂移。** `98-failure-state.json` 抓到的页签 URL 是
   `https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop`
   （title=`生意参谋`，body class=`esycm-wrapper login-page-new`）。`99-recovery.txt` 里还有一个
   `https://login.taobao.com/havanaone/login/login.htm?bizName=taobao` 页签。
   ⇒ 这家店的**登录态已掉**，生意参谋工作页被服务端弹回登录页，所以 health-check 报
   `TARGET_PAGE_MISSING`（`01-health-check.txt`：按片段 `sycm.taobao.com/qos/service/frame/shop/performance` 找到 0 个）。
   候选菜单里的 `RESET_PAGES` / `RELOAD_PAGE` 都只在**已登录的页面**上做页签归位/重载，
   **换不出登录态**（`repair-actions.mjs` 的 `describeUnreadable()` 也正是这么判的：
   url 命中 `login.htm` ⇒ “页面类修复对它无效，真正要做的是登录”）。
   真正要做的是**人在这台机器上重新登录盖文淘宝**（登录动作刻意不进修复闭集）。
2. **本轮店铺实例已被释放，动作根本连不上。** 见第 3 节端口盘点。

---

## 2. 读到的现场（只读）

| 文件 | 关键事实 |
| --- | --- |
| `97-repair-request.json` | stage=health-check，cause=SHOP_BLOCKED，candidates=[RESET_PAGES, RELOAD_PAGE]，execHint 代理 19043 |
| `98-failure-state.json` | url=`.../custom/login.htm?...`；title=生意参谋；可见文本=生意参谋登录/官网页；`dialogs:[]`；`domSummary.totalElements=292` |
| `98-failure-state.txt` | 全 `?`（已知缺陷：字段没取到 `state.value`）——**不作为事实** |
| `01-health-check.txt` | 阻断项 `TARGET_PAGE_MISSING`：生意参谋工作页 0 个、阿里妈妈报表页 1 个；归位后仍不齐（`reclaim` 找到 0 个） |
| `99-recovery.txt` | 停手时停 `custom/login.htm`；另有 `login.taobao.com/.../login.htm` 页签 |

> 注：请求单里 `stateSummary.url` 为 `null`（规划时未接现场事实），所以菜单没带「现场是登录页」的 note；
> 但 `98-failure-state.json` 里 URL 明确是登录页 —— 这是本轮最硬的判据。

---

## 3. 端口盘点（只读探测，未启停任何进程）

`curl -s -m 2 http://127.0.0.1:<port>/json/version`：

```
19031..19035 -> 000   19041..19045 -> 000   19050..19057 -> 000   19060..19067 -> 000
19022 -> 200（共享商家浏览器调试口，活）   19023 -> 404（共享商家 CDP 代理，活）
```

即：**26 个店铺实例端口全部 free**（`000` = 连接被拒），只有共享商家浏览器 19022/19023 在。
与作业指导书的预判一致：`--batches` 跑完已释放全部店铺实例。

---

## 4. 试过的候选动作（闭集内，逐个真跑）

命令模板：
`node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs --shop 盖文淘宝 --proxy http://127.0.0.1:19043 --stage health-check --cause SHOP_BLOCKED --action <动作> --log-dir evidence/batches-2026-10-02/b1/盖文淘宝`

| 动作 | 运行 | applied | 退出码 | detail |
| --- | --- | --- | --- | --- |
| `RESET_PAGES` | `--dry-run` | false | 0 | 排练：会执行 RESET_PAGES，一个写请求都不发（dry-run 不连页面） |
| `RESET_PAGES` | 真跑 | false | 1 | `修复动作自己出错：fetch failed`（normalizePages 连 19043 失败） |
| `RELOAD_PAGE` | `--dry-run` | false | 3 | `读不到页签（代理连不上）：fetch failed` |
| `RELOAD_PAGE` | 真跑 | false | 3 | `读不到页签（代理连不上）：fetch failed` |

- 两个候选都 `applied !== true` ⇒ 按流程**不重试 `health-check`**（原样重放不算修复）。
- 候选耗尽 ⇒ 判定「agent 也修不动」。
- 证据落盘：`97-repair.json` / `97-repair.txt`（脚本自动写，内容为最后一次动作 `RELOAD_PAGE`）。

---

## 5. 是否改代码

**没有改仓库代码。** 根因是登录态（运维动作）+ 实例已释放（编排前提），都不是代码缺陷；
也没有任何仓库内改动能把这家的登录态换回来。

---

## 6. 转人 / 下一步

1. **人**：在这台机器上重新登录「盖文淘宝」这家店（profile `D:/Retire/edge-profiles/suixin-custom`）。
2. **编排侧**：本轮的硬阻塞是「实例已释放 ⇒ 任何页面级修复都连不上」。
   推荐做法：**在同一个运行窗口内、店铺实例存活时派修复 agent**
   （即带 `--no-release`（或等价「驻留」）跑，别先释放再派）；否则修复 agent 只会得到
   `fetch failed`，拿不到任何可修的现场。
3. 若第 2 点做不到、需重启实例才能修，按规则**不在本 agent 内启停任何实例**，转人工/编排处理。
