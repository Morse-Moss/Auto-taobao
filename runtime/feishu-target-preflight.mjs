// 飞书目标「这张 base 认不认这份凭据」的开工前体检（2026-10-17 加）。
//
// 为什么要有它：
// 2026-10-16 17:54 把 10 月商品 base 换到别的组织（rcnbpuvafkct），但写入口仍用本组织凭据。
// 2026-10-17 10:04 那一轮的表现是：**8 家店采集 15 分钟全部成功、24 次导入全部 403/91403、
// 飞书一个字没写**。环境预检当时是绿的，因为它只验「凭据文件存在」——
// 文件在、能解析、appId 也对，只是这张 base 根本不认它。
//
// 判据的分层（这条链的既有纪律：读不到 ≠ 没有）：
//   · AUTH_DENIED  = 服务端明确说「你没权限」（403 / 91403 / 1063004 / Forbidden / 无权限）
//   · UNREACHABLE  = 别的原因读不到（网络、超时、网关页）
// 只有 AUTH_DENIED 是**确定性**的：重试一万次也还是拒绝 ⇒ 值得在开工前就拦下来。
// UNREACHABLE 可能是网络抖动 ⇒ 只记一笔、不拦（否则一次 DNS 抖动就让整轮不采数据）。
const AUTH_PATTERN = /forbidden|无权限|权限不够|not\s+authorized|(?:^|[^0-9])(?:403|91403|1063004)(?:[^0-9]|$)/iu;

export function isFeishuAuthError(message) {
  return AUTH_PATTERN.test(String(message ?? ''));
}

/**
 * 逐个目标做一次「读字段名」探针（只读，零写入）。
 *
 * targets 形状：`[{ label, baseToken, envFile, tables: [{ name, tableId }] }]`
 * 同一 base 只探一次 —— 权限在 base（文档）这一层，探三张表只是多两次请求。
 * 探的是**每张将被写的表**（表级权限确实存在），所以按 base 分组、组内逐表探。
 */
export async function probeFeishuTargets({ targets, credentialsFor, FeishuClient, now = () => new Date() }) {
  if (typeof credentialsFor !== 'function') throw new Error('probeFeishuTargets 需要 credentialsFor(target)');
  if (typeof FeishuClient !== 'function') throw new Error('probeFeishuTargets 需要 FeishuClient 构造器');
  const results = [];
  for (const target of targets) {
    const entry = { label: target.label, baseToken: target.baseToken, envFile: target.envFile ?? null, tables: [] };
    let credentials;
    try {
      credentials = credentialsFor(target);
    } catch (error) {
      // 凭据文件不在/缺字段：同样是确定性失败，而且比 403 更早、更好修。
      entry.status = 'CREDENTIALS_UNUSABLE';
      entry.detail = String(error?.message ?? error);
      results.push(entry);
      continue;
    }
    for (const table of target.tables) {
      const row = { name: table.name, tableId: table.tableId };
      try {
        const client = new FeishuClient({ appId: credentials.appId, appSecret: credentials.appSecret, appToken: target.baseToken, tableId: table.tableId });
        const fields = await client.listFields();
        row.status = 'OK';
        row.fieldCount = Array.isArray(fields) ? fields.length : null;
      } catch (error) {
        const message = String(error?.message ?? error);
        row.status = isFeishuAuthError(message) ? 'AUTH_DENIED' : 'UNREACHABLE';
        row.detail = message.slice(0, 200);
      }
      entry.tables.push(row);
    }
    // base 级结论由表级结论汇总：任一张表被拒 ⇒ 这个 base 现在写不了。
    const statuses = entry.tables.map((row) => row.status);
    entry.status = statuses.includes('AUTH_DENIED') ? 'AUTH_DENIED'
      : statuses.every((status) => status === 'OK') ? 'OK'
        : statuses.includes('UNREACHABLE') ? 'UNREACHABLE' : 'UNKNOWN';
    results.push(entry);
  }
  return {
    version: 1,
    checkedAt: now().toISOString(),
    ok: results.every((entry) => entry.status === 'OK'),
    // 只有「确定性拒绝」才值得拦路；不可达只记一笔（见文件头）。
    blocking: results.filter((entry) => entry.status === 'AUTH_DENIED' || entry.status === 'CREDENTIALS_UNUSABLE'),
    targets: results,
  };
}

/** 把探针结果压成一句人话（告警与 job.log 共用，别各写一份）。 */
export function describeTargetProbeFailures(report) {
  return (report?.blocking ?? []).map((entry) => {
    if (entry.status === 'CREDENTIALS_UNUSABLE') return `${entry.label}：凭据文件用不了（${entry.detail}）`;
    const denied = entry.tables.filter((row) => row.status === 'AUTH_DENIED');
    const detail = denied[0]?.detail ? `（${denied[0].detail}）` : '';
    return `${entry.label}：这张 base 不认当前凭据${detail}；凭据文件 ${entry.envFile ?? '未登记'}`;
  });
}
