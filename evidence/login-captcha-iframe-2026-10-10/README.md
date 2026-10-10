# 证据：滑块在 iframe 里，脚本的判据看不见它（1.7.17，2026-10-10）

这一批修的是缺陷 **㉟**：网林天猫从 2026-09-23 首次验收起就恒报 `LOGIN_NOT_CONFIRMED`
（「可能是密码不对」），半个月一字未变；真因是**淘宝风控的滑块长在一个 iframe 内部**，
而判据只在顶层文档里找它。

## 真机现场（2026-10-08 / 10-10 实测）
- 登录页顶层文档里有一个 iframe：
  `https://login.taobao.com//havanaone/loginLegacy/password/login.do/_____tmd_____/punish?x5s=…`，
  `<title>验证码拦截</title>`，rect `[1039,453,370,34]`，**与登录页同源**（`contentDocument` 可读）。
- iframe 内手柄 = `SPAN#nc_1_n1z.nc_iconfont.btn_slide`，提示 `SPAN.nc-lang-cnt` = 「向右滑动验证」。
- **它是点过「登录」之后才被拉起的**：2026-10-10 09:42 冷启动两家实例实测，刚打开的登录页上
  `sliderVisible=false`、顶层没有 `punish` iframe。⇒ 只在「提交前」查一次的判据，
  在**时机上**就不可能看到它。

## 这一批的两处改动
1. `login-merchant-core.mjs` 的 `FORM_STATE_EXPRESSION`：顶层与**同源 iframe** 一起查；
   读不到内容的 iframe 若地址/标题像风控页，留线索到新字段 `captchaFrame`。
2. `login-merchant.mjs` 第六步：`stillOnLogin` 分支里**再回读一次**表单状态，
   有验证码 ⇒ `CAPTCHA_REQUIRED`（并告诉人「密码已填好，去滑一下」）；确实没有才落 `LOGIN_NOT_CONFIRMED`。

## 这个目录里的文件
| 文件 | 是什么 |
|---|---|
| `mutation-check-captcha.mjs` | 突变验证脚本，**从任意目录可跑**（仓库根由上两级解析） |
| `mutation-check-output.txt` | 它的真实输出（两条突变都被抓住、还原后 sha 一致） |

## 怎么复跑
```bash
cd <仓库根>
node evidence/login-captcha-iframe-2026-10-10/mutation-check-captcha.mjs
```
期望：两段都 `判红=true` + `期望用例被点名：YES`，最后 `突变验证结论：两条突变都被测试抓住 ✅`，
并且 `还原后 sha` 与开头那个 sha 相同（不一致就立刻 `git checkout` 那个文件）。

## 跑法纠正（也写进了 CHANGELOG 1.7.17）
这个 skill 的 `scripts/*.test.mjs` **要从仓库根跑**：
```bash
node --test "skills/sycm-alimama-daily-report/scripts/*.test.mjs"   # 511/511
```
从 skill 目录里跑会多出 3 条**假红** —— 那几个用例用 `fs.readFile('./skills/…')` 相对路径读源码，
CWD 一变就 ENOENT（实测：同一条命令从仓库根 11/11、从 skill 目录 8/11）。

## 未覆盖的部分（说实话）
本批**没有真机验收**：它是判据修复，要等下一次平台真的拉起滑块才会走到那段新代码。
真机现场证据是 2026-10-08 那一轮（见 `.workbuddy/memory/2026-10-10.md` 与 `LOGIN-NOTES.md`）。
