# 根因定死：命中判据把 `document` 的方法挂到了 `window` 上

> 2026-10-05 13:05–13:20，一次性实例真机取证。修复提交 `a4245c2`。
> 相关：`ROUND-8SHOPS-FAILED.md`（本轮 8 家失败的现场总账）、`runtime/browser-ports.mjs` 的更正注释（`52d867d`）。

## 一句话

`elementFromPoint` 是 **`document` 的方法**，`window` 上根本没有它。
`b29f64c` 把命中判据从 `document.elementFromPoint` 改成「元素自己那个窗口」的
`win.elementFromPoint` ⇒ 恒为 `undefined` ⇒ 25 个采样点 + 中心点全部拿到 `null`
⇒ `命中自己=0` ⇒ `not-hit` ⇒ 8 家店全停在第 2 步 `promotion-submit`。

## 真机实测（一次性实例，未登记端口 19997 + 临时 profile）

```
typeof window.elementFromPoint   === 'undefined'    ← window 上根本没有这个方法
typeof document.elementFromPoint === 'function'
```

探针与原始输出：`probe-elementfrompoint.mjs` / `probe-hitcheck-ab.mjs`、
`hitcheck-ab-transcript.txt`、`hitcheck-ab-report.json`。
（脚本里的路径是取证当时那台机器的绝对路径，形态：未登记端口 + 临时 profile + 用完即杀。）

## 同现场 A/B（同一目标、同一时刻，只换命中判据那一处）

broken 版 = 把 `hitCheckExpression` 源码里的 `doc.elementFromPoint` 换回 `win.elementFromPoint`
（即线上代码的实际行为，共 5 处）：

```text
broken（win.elementFromPoint）: {"ok":false,"reason":"not-hit","matches":1,"hiddenSiblings":0,"y":314,
  "inViewport":true,"rect":[1400,314,48,12],"inViewportSamples":25,"insideSamples":0,"firstHit":null,
  "centerIsSelf":false,"viewport":[1506,642],"inScope":"outer","blocker":null}

fixed （doc.elementFromPoint）: {"ok":true,"reason":null,"matches":1,"hiddenSiblings":0,"y":314,
  "inViewport":true,"rect":[1400,314,48,12],"inViewportSamples":25,"insideSamples":20,
  "firstHit":[1424,320],"centerIsSelf":true,"viewport":[1506,642],"inScope":"outer","blocker":null}
```

**broken 那一行与线上 8 家的失败读数逐字一致**（同一个 `rect=[1400,314,48,12]`、同一个
`viewport=[1506,642]`、同一个 `reason=not-hit`、同一个 `blocker=null`）⇒ 复现闭环。

## 为什么这解释得了「现场像被遮挡」

`blocker` 的取值式是：`centerIsSelf ? null : (centerPoint ? {tag,cls} : (centerInViewport ? null : 'center-outside-viewport'))`。
`centerPoint` 也来自那个拿不到的方法 ⇒ 恒 `null` ⇒ `blocker` 恒 `null`
⇒ `describeHitMiss` **根本不打印「遮挡物=」那一段**。

所以失败信息里只有「视口内采样=25/25，命中自己=0」，没有遮挡物 ——
现场读起来像「有个东西盖住了按钮」，于是编排去重载页面、换新现场。
**其实从头到尾没有任何遮挡。**

## 改了什么（提交 `a4245c2`）

| 文件 | 改动 |
|---|---|
| `collect-core.mjs` | `hitCheckExpression` 的 25 点采样与 `centerPoint`、`overlayAfterExpression` 的 25 点采样 → `doc.elementFromPoint`。**尺寸仍用 `win.innerWidth/innerHeight`**（元素在 iframe 里时尺寸取外层窗口才是错的，那一半原判断是对的） |
| `collect-shop-report.mjs` | `findPreview` 的 `hitOk` 同理（同族第三处，今天没走到第 5 步所以未暴露，一并修掉） |
| `collect-core.test.mjs` | 三处夹具改成**真实 DOM 的形状**（`document` 上有 `elementFromPoint`、`window` 上不挂）+ 一条**独立**守卫 |

关键副作用：`1ff609e` 曾把 `overlayAfterExpression` 也「统一」到了同一个写法上，
于是两侧一致地判错。**它统一到了错误的一侧**；该改的是 `hitCheckExpression`。

## 为什么原有 44 条用例全绿

**三份夹具都给 `defaultView` 挂了一个 `elementFromPoint`**，而真实 `window` 上没有它。
源码照着一份现实中不存在的 DOM 写，测试自然全绿 —— 这是 09-14 那份教训里
「测试缝开在缺陷后面」的同一族。夹具已改回真实形状，并新增一条独立守卫
（独立成用例：写在别的用例内部时，前面任一断言先红它就永远跑不到）。

## 验证清单

1. `collect-core.test.mjs` **45/45**。
2. 日报技能定向组 **415 条 414 绿**；唯一那条红是 `run-multi-shop-day.test.mjs:1270` 的
   `{0,400}` 字符窗口判据，**预先存在**：它只读 `run-multi-shop-day.mjs`，而那个文件本次一字未动。
3. **突变验证 1/1**：把 `doc.elementFromPoint` 改回 `win.elementFromPoint` ⇒ 3 条用例如期变红，
   守卫独立点名「源码若调了 window.elementFromPoint，这里会拿到 null 而变红（2026-10-05 真机事故）」；
   还原后 sha256 逐字节一致（`6edce40e…`）。
4. **真机 A/B 6/6 PASS**（见上）。
5. 收尾：探针端口回读 `FREE`、临时 profile 已删、无残留 `msedge` 进程。

## 仍未做

跑 8 家真机全链验证（要另起 8 个实例，约 9 分钟，并写飞书）。
本次只到「判据在真机上判对了」这一步 —— 这一条界限必须说清楚，别把「判据绿」当成「链跑通」。
