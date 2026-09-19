# 2026-09-18 四家店日报一轮（2026-09-19 实跑，`--commit`）

## 结果：四家全通

底单 **1879 → 1883**（+4）。2026-09-18 命中 4 行：

| 店铺（运营叫法） | 底单里的店名（取自源产物） | 询单量 | 同层同行询单量 |
| --- | --- | --- | --- |
| 里可林淘宝 | 里可林家居 | 4 | 6 |
| 网林天猫 | 网林家居旗舰店 | 6 | 12 |
| 盖文淘宝 | 盖文全卫定制 | 6 | 6 |
| 科塔淘宝 | 科塔全卫定制 | 5 | 6 |

每家的 11 个阶段（`health-check` … `readback`）逐条落在 `<店铺>/NN-<阶段>.txt`：

```
里可林淘宝/01-health-check.txt … 11-readback.txt
网林天猫/ 盖文淘宝/ 科塔淘宝/ 同上
00-health-check-daily.txt      ← 商家浏览器那一份（整轮一次）
```

**注意这里是「合三份读」才能得出「全通」**：首轮 `summary.json` 记的是
`里可林淘宝 failed / 网林天猫 ok / 盖文淘宝 failed / 科塔淘宝 ok` ——
两家失败，各补跑一次之后才成。**`summary.json` 不会因为后来补跑成功而回写。**

## 中途两次失败（都不是链本身的问题）

### 1. 里可林停在 `push` —— 开飞书页时漏了 table/view（我的准备失误）

症状：

```
Error: Feishu page is not on authorized table/view:
  …?table=tblUnwn05vl8Wik9&view=vewHgmRhGR
```

根因：起浏览器之后我开的是**裸 base 页**（不带 `table`/`view`），飞书默认把它停在
**询单表**（`tblUnwn05vl8Wik9` / `vewHgmRhGR`）上，而 `run-daily-report.mjs` 的 `inspectTarget`
要的是**底单表**（`tblkY3W8tnPWPcnh` / `vewwg0rhjo`，来自 `dailyReportTargets()`）。

修：`D:/Retire/probe-live/90-fix-feishu-page.mjs` 导航到正确的 table/view（值全部从
`feishu-targets.mjs` 读，不抄报错里那串），回读一致；然后用已经采好的产物补跑
（`--only push,sycm-reset,sycm-date-again,backfill,readback --shop-xlsx … --promotion-zip …`），
一次通过。已写进 SOP §1.4。

### 2. 盖文停在 `promotion-submit` —— 平台自己的全屏弹窗压住了整页

症状（**稳定复现，两次逐字相同**）：

```
采集失败：「下载报表」复核未通过（not-hit，y=339，视口内=true，视口内采样=25/25，
  命中自己=0，rect=[1350,339,48,12]，视口=[1455,691]，遮挡物={"tag":"DIV","cls":""}）
```

诊断（`91-diagnose-blocked-click.mjs` / `92-inspect-blocker.mjs`）：遮挡物是 `#wrapper_dlg_982`
（`data-owner-id=universalBP_tool_auto_dlg`），`position:fixed`、`width/height:100%`、
`z-index:99999` —— **阿里妈妈自己的推广引导弹窗**「优质计划防停投」。整页被盖住 ⇒ 页面上
任何按钮都点不到（不止这一个）。

修：`D:/Retire/probe-live/93-close-blocker.mjs` 点它自己的关闭按钮（16×16，在弹窗右上角）。
探针的两条纪律：**先复核「关闭按钮中心点命中它自己」**再真点；**点完回读弹窗是否真的消失**，
并顺手回读「下载报表」现在能不能点到了。再一次通过。已写进 SOP §10.2。

**「稳定复现」这一条很重要**：SOP 原来那条「等一会儿重跑」针对的是会自己收起的浮层，
对这类**不会自己好** —— 等多久都一样，必须显式关掉。

## 起跑前做的事（下轮照做）

1. 起五台浏览器 + 五个代理：商家链 19022/19023，四家店 19031-19034 / 19041-19044；
2. **工作页要显式开** —— 新起的浏览器 profile 里只有登录态、没有页面，而 `date-picker`
   只在已有页里找（不会新建），体检也会对缺失的期望页报 blocking。命令见
   `D:/Retire/probe-live/86-open-shop-pages.mjs`（`--dry-run` 先看要开什么）。SOP §1.4；
3. **身份逐字对**（`87-identity-all.mjs`）：四家的生意参谋页头 + 阿里妈妈会员名，
   与 `shop-identities.mjs` **全部一致**（这一轮四台新起的浏览器登录态都在）；
4. 目标日干净：底单 0 行；询单表 09-18 的 12 行都在、`询单量` 与 `同层同行询单量` 全空；
5. 挂店名标签页（四台，`pinned: true`）。

## 这一轮暴露的、还没做的

- 上面第 2 步与那个「关弹窗」动作，目前都住在**仓库外的探针**里
  （`D:/Retire/probe-live/86`、`90`、`93`），没进仓库、也没进驱动 ⇒ 下一个人得先知道它们在哪。
  要么并进 §1 的启动流程，要么做成驱动里的一个阶段。
- 盖文那个全屏弹窗目前靠人工关。可以让 `promotion-submit` 在复核失败时先尝试关掉这类层，
  但那是**代码改动**，按本仓库纪律要配突变验证（「关掉之后复核通过」这条判据要能被打坏并变红）。
