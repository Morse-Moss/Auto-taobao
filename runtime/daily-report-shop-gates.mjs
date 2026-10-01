/**
 * 日报店铺运行前置状态。
 *
 * 2026-09-29：以下店铺在生意参谋 shop-report 阶段被运营账号阻断。
 * 这不是代码故障，也不能靠重试或自动登录绕过；先把日报链放置，避免拖住其他店铺。
 * 运营更换账号并确认可用后，从 WAITING_OPERATOR_ACCOUNT_SHOPS 移除对应店铺即可恢复。
 */
export const WAITING_OPERATOR_ACCOUNT_SHOPS = Object.freeze([
  '里可林淘宝',
  '网林家居',
  '保拉天猫',
  '安比龙头店',
  '科塔龙头店',
  '安比淘宝',
]);

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
