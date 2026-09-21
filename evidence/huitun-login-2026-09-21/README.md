# 灰豚登录：页签已打开，等人工扫码（2026-09-21）

## 现状

- 目标浏览器：**商家浏览器**（`19022` 浏览器 / `19023` 代理，browser id `edge-daily-report`），
  灰豚这条路按路线表归它（与生意参谋搜索排行同住一个浏览器）。
- 打开方式（用项目自己的代理，未直连调试端口）：

  ```
  /new?url=https%3A%2F%2Fdy.huitun.com%2Fapp%2F%23%2Fdashboard&label=huitun-login&pinned=1
  /pin?target=<targetId>
  ```

  实测：`/health` → `browser.id=edge-daily-report`、`connected=true`；
  新建前该浏览器 2 个页签、灰豚 0 个；新建后 3 个、灰豚 1 个。
  `targetId = C05DDCA0FB83FC4AC2128B5ABC459684`，`/pin` 回 `{"pinned":true}`。
- **钉住是必须的**：不钉的页会被代理在闲置 15 分钟后回收（见
  `runtime/isolated-proxy/cdp-proxy.mjs` 的「钉住的标签页」那段），症状是「人还没登完，页自己没了」，
  且全程不报错。
- 登录框已打开：页面上的弹窗是 **「扫码登录 / 欢迎使用灰豚数据 / 请使用微信扫码登录，新用户自动注册」**，
  二维码可见（`login-dialog.png`）。

## 两个容易误判的观察点

1. `login-page.png` 是**加载中**的白页（只有转圈）：`/new` 的「等待加载」对 SPA 会提前返回，
   渲染要再等几秒。第一次读 `document.body.innerText` 是空串，就是撞在这个窗口上。
2. 点「登录/注册」那一下**是成功的**，但最初被误读成失败：读可见文本时截了前 400 字，
   而弹窗文本排在很长的导航文案之后，没读到。后来用「查点位上是哪个元素」的办法才看清
   （`login-entry-diagnose.txt`：`elementFromPoint` 命中的是 `div.ant-modal-wrap.ant-modal-centered`，
   文字就是扫码登录那段）。
   ⇒ 教训：**别用「文本有没有变」当点击生效的判据**，那依赖你截取的位置；要点名去查元素。

## 为什么停在这里

登录/滑块/验证码一律交给人：脚本不代填凭据、不绕验证（`skills/huitun-to-feishu-keyword-heat`
的 Safety 一节就是这条）。扫码完成后，重跑采集段即可
（`tmp/collect-huitun-2026-09-21.mjs`，队列里那一个候选是「泡澡浴缸」）。

## 本目录文件

- `login-page.png` —— 刚建时的加载态（转圈）。
- `login-dialog.png` —— 扫码登录弹窗（当前状态）。
- `open-tab.txt` —— 建页/钉页的完整 stdout（含动前后页签清单）。
- `login-entry-diagnose.txt` —— 「点位上是哪个元素」的诊断输出。
