# 2026-09-23 · 证伪「登录页的协议勾选框点不中」

## 为什么查这一件事

嫌疑来自两份真跑回执，不是猜的：

- 商家浏览器那次：`afterGesture {idLen:8, passwordLen:9}`（值确实落进去了）
  → `captcha:false` → `agreementChecked:false` → 提交后**仍停在登录页** ⇒ `LOGIN_NOT_CONFIRMED`；
- 而淘宝**不勾协议点登录是不会走的**。

⇒ 假设：`centerOf(state,'agreement')` 算出来的点根本没落在那个勾选框上（比如元素是 0×0 的隐藏
`input`），于是「点了等于没点」，提交被静默拒掉，现场只留下一句「密码不对或平台要额外验证」——
**而这句会把排查引向密码，方向就错了。**

## 结论：假设不成立

```
#fm-agreement-checkbox checked=false rect=[531,568,16,16] visible=true
elementFromPoint(539, 576) = {"tag":"INPUT","id":"fm-agreement-checkbox","cls":"","text":"","isAgreementItself":true}
点完回读 checked=true rect=[531,568,16,16]
结论：{"checkboxExists":true,"checkboxVisible":true,"rect":[531,568,16,16],
       "checkedInitially":false,"checkedAfterCoordinateClick":true,"coordinateClickWorked":true}
```

用**与产品代码同一个手法**（`/clickPoint` 真机坐标点击）一点就 `false→true`，
`elementFromPoint` 在那个点位上返回的正是勾选框本身。

## 判「操作生效没」用的是哪个判据

不是页面文本，是 `elementFromPoint(x,y)` 在那个点位上返回的是**谁** ——
判「这一下点中了没有」用页面文本会被别处的文字骗到（本仓既有纪律）。

## 它顺带说明了一件更要紧的事

`LOGIN_NOT_CONFIRMED`（点了登录却没离开登录页）的成因**不在勾选这一步**。
盖文天猫 2026-09-23 的真机回执把这条收得更紧：它连"填值"那一步都到不了
（`NO_SAVED_CREDENTIAL`，凭据 origin 与登录页 origin 不同）——
见 `evidence/login-blocker-probe-2026-09-23/README.md`。

## 纪律

一次性实例：**未登记端口 19935 / 19945 ＋ 临时 profile**；端口先探空再起；
跑完 `taskkill /PID … /T /F` ＋端口回读（`浏览器=null 代理=null`）＋临时 profile 删除（`true`）。
**没有起停任何存活服务。**

## 产物

| 文件 | 是什么 |
|---|---|
| `probe-login-agreement.mjs` | 探针本体（一次性实例，自带释放与端口回读） |
| `probe-output.txt` | 逐字输出 |
| `probe-login-agreement.json` | 结构化明细（含每一步的 rect / 点位 / 回读值） |
| `shots/01-login-page-before.png` | 点之前 |
| `shots/02-after-coordinate-click.png` | 坐标点击之后（勾选框已勾上） |

复核：`node evidence/login-agreement-probe-2026-09-23/probe-login-agreement.mjs`（约 1 分钟）。
