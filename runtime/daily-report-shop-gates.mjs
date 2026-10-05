/**
 * 日报店铺运行前置状态。
 *
 * 2026-09-29：曾有 6 家因运营账号被阻断而放置（里可林淘宝 / 网林家居 / 保拉天猫 /
 * 安比龙头店 / 科塔龙头店 / 安比淘宝）。
 *
 * **2026-10-05 这张表清空**（用户指令「等待运营账号那个名单可以删了，现在就要跑销售1部这八家」）。
 * 清空后的口径变化：
 *   · 销售1部 8 家（里可林淘宝、网林天猫、盖文淘宝、盖文天猫、科塔淘宝、网林淘宝、
 *     里可林天猫、网林家居）现在**全部进入采集** ⇒ 这 8 家会真正跑起来；
 *   · 销售2部 5 家由 `runtime/browser-ports.mjs` 的 `SHOPS_NOT_COLLECTING_YET` 停采
 *     （那是「整部门停采」，与这张表「这家暂时放一放」不是一回事，两者互不替代）。
 *
 * 表**留着不删**：账号再次出问题时把店名填回来即可，它是日报链的「这家先放一放」闸门。
 * 注意它**只挡跑链**，不挡起实例/分批 —— 那条已知缺口（闸门下移或分批计划剔店）仍未修。
 */
export const WAITING_OPERATOR_ACCOUNT_SHOPS = Object.freeze([]);

// This registry is consumed only by the daily-report chain. It does not disable
// product, inquiry, weekly, or any other shop workflow.
export const GATE_SCOPE = 'daily-report';

export const WAITING_OPERATOR_ACCOUNT = 'WAITING_OPERATOR_ACCOUNT';

export function waitingOperatorAccountShops() {
  return [...WAITING_OPERATOR_ACCOUNT_SHOPS];
}

export function isWaitingOperatorAccountShop(shop) {
  return WAITING_OPERATOR_ACCOUNT_SHOPS.includes(shop);
}

export function waitingOperatorAccountRecord(shop) {
  if (!isWaitingOperatorAccountShop(shop)) return null;
  return {
    status: 'waiting',
    state: WAITING_OPERATOR_ACCOUNT,
    resumable: true,
    failedStage: 'shop-report',
    reason: '生意参谋日报需要运营账号处理，开发侧暂缓该店日报流程。',
    owner: '运营',
    resumeWhen: '运营更换并确认可用账号后，从日报店铺状态登记移除该店铺。',
    stages: [],
    source: {},
    shop,
  };
}

export function isWaitingOperatorAccountStatus(record) {
  return record?.state === WAITING_OPERATOR_ACCOUNT
    || record?.status === 'waiting' && record?.reason?.includes('运营账号');
}
