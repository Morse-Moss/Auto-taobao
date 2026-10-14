// 「某个阶段跑在哪一台浏览器上」—— 唯一实现（2026-10-14 建）。
//
// 为什么必须有这个叶子：这条链是**一店一实例 + 一台共用实例**混跑的。九个阶段跑在**这家店自己的**
// 浏览器上（`shopInstance(店).proxyPort`），而**两个**阶段跑在**共用商家浏览器**上
// （`PROJECT_PORTS.dailyReportProxy`）—— 因为它们的作业对象是**五家店共用的那一页飞书底单**
// （`feishu-shared-page.mjs` 文件头写的就是这件事）。
//
// 这件事原先只活在 `run-multi-shop-day.mjs` 的 `buildShopStages` 里（两处 `add(...)` 各写一次
// `dailyProxy`），于是**链之外的三处**（派单单子 `buildRepairRequest` 的 `execHint`、
// 派单单子里的 `instancePrecondition`、自动修复的 `execRepair`）全都按「店名 ⇒ 这家店的代理」
// 取实例，而 `repair-shop-stage.mjs` 的一致性闸门又**禁止**「`--shop X` + 共用代理」这一组。
// 合起来的后果实测过一次（2026-10-13，目标日 10-13，网林淘宝，报告在
// `evidence/batches-2026-10-13/b2/网林淘宝/97-repair-agent-report.md`）：
//   · 失败的是第 11 步 `readback`（跑在 19023 上，报「找不到飞书底单页」）；
//   · 而框架能对它执行的修复动作，落点在**店铺实例** 19060 的**店铺标识页**上 ——
//     即「动作执行成功了（`applied:true`），但动不到真正出问题的那一页」；
//   · 单子上的 `instancePrecondition` 还叫 agent 去确认 19060 在不在 —— 与失败无关的那一台。
// 三处都必须与链同源，否则「按阶段选实例」这条规则会被实现两遍、然后漂开。
//
// ⚠️ 这不是「多一个便利函数」，而是**把一条已经存在的规则收成一处**：`buildShopStages` 里
// 那两处 `dailyProxy` 仍是权威的作业现场，本文件的常量与它由 `run-multi-shop-day.mjs` 里的
// 一条互锁钉住（阶段表里每个阶段的 `CDP_PROXY_PORT` 必须与 `stageUsesSharedPage()` 判断一致），
// 漂了当场抛错，而不是让修复动作悄悄落回店铺实例。
//
// 依赖方向：skills → runtime（`browser-ports.mjs` 是机制层叶子，只登记端口与 profile，
// 不反向依赖 skills），与这一族其它脚本（`expected-pages.mjs` / `ensure-inquiry-rows.mjs` 等）同向。
import { PROJECT_PORTS, shopBrowserKeys, shopInstance } from '../../../runtime/browser-ports.mjs';

/**
 * 跑在**共用商家浏览器**上的阶段。**闭集**。
 *
 * 只有这两个：`push`（第 7 步，往飞书底单写一行）与 `readback`（第 11 步，换一条通路回读）。
 * 判据不是「名字像」而是「这一步的作业对象在谁的窗口里」——
 * 它们用 `--proxy` 指向**共用实例**，而其余九个阶段指向**这家店自己的**实例。
 *
 * 加第三个之前先回答一个问题：那一步是不是在操作**五家店共用的那一页**？
 * 不是的话它就不该进这张表（`run-multi-shop-day.mjs` 的互锁会当场拦下）。
 */
export const SHARED_PAGE_STAGES = Object.freeze(['push', 'readback']);

/** 这个阶段是不是跑在共用商家浏览器上。认不出来的阶段名 ⇒ false（保守：当成店铺实例）。 */
export function stageUsesSharedPage(stage) {
  return SHARED_PAGE_STAGES.includes(stage ?? null);
}

/**
 * 这个阶段该连哪一台浏览器的代理。**唯一口径**，链、派单单子、修复执行器都用它。
 *
 * 三种情形（顺序即优先级）：
 *   ① 共用阶段（`push` / `readback`）⇒ 共用商家浏览器，**与有没有店名无关** ——
 *      它的目标页本来就在那台机器上，指向店铺实例等于对着另一台做事；
 *   ② 其余阶段 + **登记表里认得的店名** ⇒ 这家店自己的代理；
 *   ③ 其余情况（没给店名，或店名不在登记表里）⇒ 回落共用商家浏览器。
 *      ③ 是**旧口径**（`--shop` 出现之前的裸调用就是这个默认值），刻意保持不变：
 *      改掉它会让「没点名的调用」从「共用」变成「报错」，而那不是这次要修的东西。
 *
 * 返回的是**完整 URL**（`http://127.0.0.1:<port>`），与 argv / `--proxy` 里的写法逐字一致 ——
 * 各处自己拼字符串正是本文件要消掉的那种第二份实现。
 */
export function proxyForStage({ stage = null, shopKey = null } = {}) {
  const shared = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
  if (stageUsesSharedPage(stage)) return shared;
  if (shopKey && shopBrowserKeys().includes(shopKey)) {
    return `http://127.0.0.1:${shopInstance(shopKey).proxyPort}`;
  }
  return shared;
}

/**
 * 一句人话：「这个阶段跑在哪台实例上」。**只用在报错与单子里**，
 * 所以它必须能回答「那台是谁的」—— 只说一个端口号，读单子的人仍然不知道改哪个。
 */
export function describeStageBrowser({ stage = null, shopKey = null } = {}) {
  return stageUsesSharedPage(stage)
    ? `阶段「${stage ?? '?'}」跑在共用商家浏览器上（${proxyForStage({ stage })}）`
    : `阶段「${stage ?? '?'}」跑在「${shopKey}」这家店自己的浏览器上（${proxyForStage({ stage, shopKey })}）`;
}
