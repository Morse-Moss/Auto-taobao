// 「体检/落位/补页/刷新」四方共用的期望页面清单。**唯一权威**，从这里取，别抄第二份。
//
// 2026-09-21 抽出，并且**刻意住在能力目录里**（`runtime/arch-boundary.test.mjs` 的守卫把这件事问对了）：
//   1) 它回答的是**这条日报链的业务词汇**（这家店该有哪些页、飞书那一页长什么样），不是机制层的知识；
//   2) 谁需要它：驱动（本目录）＋ `runtime/shop-pages.mjs`（补页）＋ `runtime/refresh-shop-pages.mjs`（刷新）。
//      放在 `runtime/` 里会让**每一个**用它的 runtime 文件都变成「runtime → skills」，而守卫对那个方向
//      的原话是「业务倒灌机制层」；放在这里则只有一条 `skills → runtime`（本文件要飞书目标登记表），
//      方向是正常的。
//   3) 抽出来同时解掉一个环：驱动要用 `shop-pages`，而 `shop-pages` 要用这份清单
//      ⇒ 清单留在驱动里就成了 `驱动 ⇄ shop-pages`。抽成叶子之后依赖是单向的：
//      `驱动 → 补页/刷新 → 这里`，以及 `补页 → 这里`。
//
// 两个清单的片段都从**各自唯一的权威**取：站点片段来自 date-picker 的 SITES，
// 飞书那一页来自 `feishu-targets.mjs` 的登记表。
import { siteAdapter } from './date-picker.mjs';
import { dailyReportTargets } from '../../../runtime/feishu-targets.mjs';

// 体检要「恰好各一个」的页面。
//
// 为什么不用体检模块的 `--route=dailyReport`：那是**宿主级**片段（`sycm.taobao.com`），
// 而店家浏览器上天然有两个 sycm 页面（门户首页 + 工作页）⇒ 必然报「不唯一」；
// 且多店铺下阿里妈妈页在**各店自己的**浏览器上，商家浏览器根本没有它 ⇒ 必然报「不在」。
// 2026-09-18 晚实测：`--route=dailyReport` 对 19023 报 2 项 blocking，两条都是判据与现场不匹配
// （假红）。假红比不检查更坏：它训练人去忽略这个信号。
export function expectedPagesForShop() {
  return [
    { name: '生意参谋工作页', urlFragment: siteAdapter('sycm').urlFragment },
    { name: '阿里妈妈报表页', urlFragment: siteAdapter('alimama').urlFragment },
  ];
}

export function expectedPagesForDailyBrowser() {
  return [
    { name: '生意参谋工作页', urlFragment: siteAdapter('sycm').urlFragment },
    { name: '飞书底单页', urlFragment: `feishu.cn/base/${dailyReportTargets().baseToken}` },
  ];
}
