// 千牛客服聊天记录 · 纯函数核心（2026-10-19）
//
// 这个文件只放判据，不放 IO。采集脚本（export-kefu-chat.mjs）与打包脚本
// （package-kefu-chat.mjs）都从这里取口径，测试也只测这里。
//
// 语义来源（2026-10-19 实测，证据见 tmp/kf-probe-*.mjs 与 SKILL.md）：
//   · conversation.list 按**会话创建时间**过滤 [beginDate, endDate]；
//     宽区间会被截断（8-01~9-30 只回 8 月那批）⇒ 必须按周切块查询。
//   · 单周查询是完整的：按天拆开求并集与单周结果逐 cid 相等。
//   · 会话创建时间早于本周、但本周有消息的，**不会被单周查询返回** ⇒
//     必须带回溯（实测 9-21~9-27 那周 159 场活跃会话里 36 场属于这类，全部落在 30 天内）。
//   · message.list 的 cursor 是起始时间戳、forward=true 向后翻页；不传结束边界，
//     会一直翻到「现在」⇒ 取回后必须按窗口过滤，且某页首条已越过窗口末尾即可停。
//   · userId 必须取会话行里的 userID.appUid；拿 cid 里的数字段当 userId 会被判
//     「not same shop::请输入完整的同店账号」。
//   · userNick 只需 `cntaobao<店铺全称>`（不带子账号也认，三种写法都实测通过）。

export const DAY_MS = 86400000;
export const SHANGHAI_OFFSET_MS = 8 * 3600000;

export const APP_PATH_FRAGMENT = 'im-history-search';
export const APP_URL = 'https://market.m.taobao.com/app/qn/im-history-search/index.html#/';

export const MTOP_API = Object.freeze({
  conversationList: 'mtop.taobao.wireless.amp2.paas.conversation.list',
  messageList: 'mtop.taobao.wireless.amp2.im.paas.message.list',
});

/** 实测有效且够用的默认值：30 天回溯覆盖了样本里全部「老会话本周活跃」的情形。 */
export const DEFAULT_LOOKBACK_DAYS = 30;
export const DEFAULT_CHUNK_DAYS = 7;
/** 会话列表单次请求的最大跨度（天）。宽区间会被后端截断，7 天是实测安全的粒度。 */
export const MAX_CHUNK_DAYS = 14;

const pad2 = (n) => String(n).padStart(2, '0');

/** 把毫秒时间戳换算成「上海墙上时间」的 Date（用 UTC 字段读，避免宿主时区影响）。 */
export function toShanghaiDate(ms) {
  return new Date(Number(ms) + SHANGHAI_OFFSET_MS);
}

/** 'YYYYMMDD'（接口入参格式，+08）。 */
export function toDateKey(ms) {
  const d = toShanghaiDate(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD'（人读格式，+08）。 */
export function toIsoDate(ms) {
  const d = toShanghaiDate(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 'MM-DD HH:mm:ss'（交付物里的时间列，+08）。 */
export function formatShanghai(ms) {
  const d = toShanghaiDate(ms);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** 严格解析 'YYYY-MM-DD' 为 +08 当日零点；非法输入直接抛，不做模糊猜测。 */
export function parseIsoDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(text ?? '').trim());
  if (!m) throw new Error(`日期格式必须是 YYYY-MM-DD：${JSON.stringify(text)}`);
  const [, y, mo, d] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T00:00:00+08:00`);
  if (!Number.isFinite(ms)) throw new Error(`日期不存在：${text}`);
  return ms;
}

/** 周一为一周起点（+08 零点）。 */
export function startOfWeek(ms) {
  const d = toShanghaiDate(ms);
  const dow = d.getUTCDay(); // 0=周日
  const sinceMonday = (dow + 6) % 7;
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - SHANGHAI_OFFSET_MS;
  return midnight - sinceMonday * DAY_MS;
}

/**
 * 解析目标周。
 *   date 给了 ⇒ 该日期所在自然周（周一起）；
 *   没给且 lastWeek ⇒ 上一个完整自然周（周一跑就是上一周）。
 * 返回的 endMs 是**下周一零点**（半开区间），endDate 是周日（人读）。
 */
export function resolveWeek({ date = null, lastWeek = true, now = Date.now() } = {}) {
  const base = date ? parseIsoDate(date) : Number(now);
  let start = startOfWeek(base);
  if (!date && lastWeek) start -= 7 * DAY_MS;
  const end = start + 7 * DAY_MS;
  return {
    startMs: start,
    endMs: end,
    startDate: toIsoDate(start),
    endDate: toIsoDate(end - 1),
    weekId: isoWeekId(start),
    label: `${toIsoDate(start)} ~ ${toIsoDate(end - 1)}`,
  };
}

/** ISO 周编号（如 2026-W42），用作归档目录名。 */
export function isoWeekId(ms) {
  const d = toShanghaiDate(ms);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum); // 本周周四
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target - yearStart) / DAY_MS + 1) / 7);
  return `${target.getUTCFullYear()}-W${pad2(week)}`;
}

/**
 * 把「窗口 + 回溯」切成若干段，供 conversation.list 逐段查询。
 * 入参 beginDate/endDate 都是闭区间的 YYYYMMDD。
 * 不变式：段与段首尾相接、无空档、无重叠，最后一段的 endDate = 窗口最后一天。
 */
export function buildListChunks({ startMs, endMs, lookbackDays = DEFAULT_LOOKBACK_DAYS, chunkDays = DEFAULT_CHUNK_DAYS } = {}) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error('buildListChunks: startMs/endMs 必须是数字');
  if (endMs <= startMs) throw new Error('buildListChunks: endMs 必须晚于 startMs');
  if (!(lookbackDays >= 0)) throw new Error('buildListChunks: lookbackDays 不能为负');
  if (!(chunkDays >= 1) || chunkDays > MAX_CHUNK_DAYS) {
    throw new Error(`buildListChunks: chunkDays 必须在 1..${MAX_CHUNK_DAYS}（更宽的区间会被后端截断）`);
  }
  const from = startMs - lookbackDays * DAY_MS;
  const lastDayStart = endMs - DAY_MS;
  const chunks = [];
  let cursor = from;
  while (cursor <= lastDayStart) {
    const chunkEnd = Math.min(cursor + chunkDays * DAY_MS - 1, lastDayStart);
    chunks.push({ beginDate: toDateKey(cursor), endDate: toDateKey(chunkEnd) });
    cursor = chunkEnd + 1;
  }
  return chunks;
}

/** 会话行的 cid（字符串）。 */
export function conversationCid(row) {
  const cid = row?.cid?.appCid ?? row?.cid ?? null;
  return cid === null ? null : String(cid);
}

/**
 * 会话行里的 userID.appUid 是**店侧**账号（实测「里可林家居:小俊」那一侧），
 * 不是买家。message.list 的 userId 必须传它，但方向判定里它是 agent。
 */
export function conversationShopUid(row) {
  const uid = row?.userID?.appUid ?? null;
  return uid === null ? null : String(uid);
}

/** 同一个 cid 在多个回溯段里会重复出现，保留 modifyTime 最新的一条。 */
export function dedupeConversations(rows) {
  const byCid = new Map();
  for (const row of rows ?? []) {
    const cid = conversationCid(row);
    if (!cid) continue;
    const prev = byCid.get(cid);
    if (!prev || Number(row.modifyTime) > Number(prev.modifyTime)) byCid.set(cid, row);
  }
  return [...byCid.values()];
}

/** 从消息 content（JSON 字符串）里取可读文本；取不到就返回原文前 500 字。 */
export function parseMessageText(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed;
    for (const key of ['text', 'summary', 'title']) {
      if (typeof parsed?.[key] === 'string') return parsed[key];
    }
    return null;
  } catch {
    return text.slice(0, 500);
  }
}

/** 把接口返回的一条消息压成稳定形状（方向判定在拿到全店会话后再做）。 */
export function normalizeMessage(raw) {
  const senderUid = raw?.senderId?.appUid ?? null;
  // message.list 顶层 senderName 经常是空的，真正的昵称在 content.extensions.sender_nick
  // （形如 `cntaobao里可林家居:小俊` / `cntaobaofabworkspace`）。去掉 cntaobao 前缀后
  // 买家那侧正好等于 displayName，客服那侧正好是「店名:子账号」。
  let extNick = null;
  try {
    const parsed = JSON.parse(String(raw?.content ?? ''));
    extNick = parsed?.extensions?.sender_nick ?? null;
  } catch { extNick = null; }
  const strippedNick = extNick ? String(extNick).replace(/^cntaobao/u, '') : null;
  return {
    sendTime: Number(raw?.sendTime),
    senderUid: senderUid === null ? null : String(senderUid),
    senderName: raw?.senderName ?? strippedNick ?? null,
    contentType: raw?.contentType ?? null,
    text: parseMessageText(raw?.content),
    raw: raw?.content ?? null,
  };
}

/** 只保留 sendTime ∈ [startMs, endMs) 的消息（半开区间）。 */
export function filterMessagesToWindow(messages, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error('filterMessagesToWindow: 窗口必须是数字');
  return (messages ?? []).filter((m) => Number.isFinite(m.sendTime) && m.sendTime >= startMs && m.sendTime < endMs);
}

/** 重跑/分页边界可能带来重复消息；键取「时间 + 发送方 + 类型 + 文本前缀」。 */
export function dedupeMessages(messages) {
  const seen = new Set();
  const out = [];
  for (const m of messages ?? []) {
    const key = `${m.sendTime}|${m.senderUid ?? ''}|${m.contentType ?? ''}|${String(m.text ?? '').slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/**
 * 店侧 uid 集合（客服/机器人账号）。两条证据任一即算：
 *   ① 发送方昵称带冒号（形如 `里可林家居:小虫`）——实测最硬的一条；
 *   ② 会话行的 userID.appUid（店侧账号）。
 * 实测每家店 2-5 个；2026-10-19 之前把它当成「跨会话出现的非买家 uid」是错的，
 * 那样会话行里的店账号会被漏掉，买家消息反而被算成系统。
 */
export function computeShopSideUids(sessions) {
  const uids = new Set();
  for (const session of sessions ?? []) {
    if (session.shopUid !== null && session.shopUid !== undefined) uids.add(String(session.shopUid));
    for (const m of session.messages ?? []) {
      const uid = m.senderUid === null || m.senderUid === undefined ? null : String(m.senderUid);
      if (!uid) continue;
      if (m.senderName && String(m.senderName).includes(':')) uids.add(uid);
    }
  }
  return [...uids];
}

/**
 * 推断一场会话里的买家 uid：优先「昵称对得上 displayName 的发送方」，
 * 其次「非店侧 uid 里出现最多的那个」——一对一聊天里除店侧外只剩买家。
 * 推不出来（整场都是店侧主动触达）返回 null。
 */
export function inferBuyerUid(session, shopSideUids = []) {
  const shopSet = shopSideUids instanceof Set ? shopSideUids : new Set((shopSideUids ?? []).map(String));
  const named = (session.messages ?? []).find((m) => m.senderName && session.displayName && m.senderName === session.displayName);
  if (named && named.senderUid !== null && named.senderUid !== undefined) return String(named.senderUid);
  const counts = new Map();
  for (const m of session.messages ?? []) {
    const uid = m.senderUid === null || m.senderUid === undefined ? null : String(m.senderUid);
    if (!uid || shopSet.has(uid)) continue;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

/**
 * 消息方向：buyer / agent / system。
 *   客服 = 店侧 uid 集里的（或昵称带「店名:」）；
 *   买家 = 本场推断出来的买家 uid；
 *   其余（含无发送方）= 系统。
 * 实测四家店：买家约 43-45%、客服约 55%、系统 < 1%。
 */
export function classifyDirection({ senderUid = null, senderName = null, buyerUid = null, shopSideUids = [], shopName = null } = {}) {
  const uid = senderUid === null || senderUid === undefined ? null : String(senderUid);
  if (!uid) return 'system';
  if (shopSideUids instanceof Set ? shopSideUids.has(uid) : (shopSideUids ?? []).map(String).includes(uid)) return 'agent';
  if (senderName && String(senderName).includes(':')) return 'agent';
  if (senderName && shopName && String(senderName) === String(shopName)) return 'agent';
  if (buyerUid !== null && buyerUid !== undefined && uid === String(buyerUid)) return 'buyer';
  return 'system';
}

/** '店名:子账号' → '子账号'；取不到就返回 null。 */
export function agentNameOf(senderName, shopName = null) {
  if (!senderName) return null;
  const name = String(senderName);
  if (name.includes(':')) {
    const tail = name.split(':').pop()?.trim();
    return tail || null;
  }
  if (shopName && name === String(shopName)) return null;
  return name.trim() || null;
}

/** 「由 A 转交给 B」里的两个客服名（实测出现在系统消息文本里）。 */
export function transferNamesOf(text) {
  if (!text) return [];
  const out = [];
  const re = /由\s*([^\s，。]+?)\s*转交给\s*([^\s，。]+?)(?=\s|$|，|。)/gu;
  for (const m of String(text).matchAll(re)) out.push(m[1], m[2]);
  return out.filter(Boolean);
}

/** 机器人会话：cid 里带 #11005（店小蜜）。 */
export function isRobotCid(cid) {
  return String(cid ?? '').includes('#11005');
}

/** userNick 只需 cntaobao + 店铺全称（实测不带子账号也认）。 */
export function buildUserNick(fullName) {
  if (!fullName) throw new Error('buildUserNick: 缺少店铺全称');
  return `cntaobao${fullName}`;
}

/** 汇总一个店的交付统计（用于 manifest 与飞书摘要）。 */
export function buildShopStats(sessions) {
  let messages = 0; let buyer = 0; let agent = 0; let system = 0; let robotSessions = 0; let noBuyer = 0;
  const agents = new Set();
  let first = null; let last = null;
  for (const s of sessions ?? []) {
    messages += s.messages.length;
    if (isRobotCid(s.cid)) robotSessions += 1;
    let hasBuyer = false;
    for (const m of s.messages) {
      if (m.dir === 'buyer') { buyer += 1; hasBuyer = true; }
      else if (m.dir === 'agent') { agent += 1; if (m.agentName) agents.add(m.agentName); }
      else system += 1;
      if (first === null || m.sendTime < first) first = m.sendTime;
      if (last === null || m.sendTime > last) last = m.sendTime;
    }
    if (!hasBuyer) noBuyer += 1;
  }
  return {
    sessions: (sessions ?? []).length,
    messages,
    buyerMessages: buyer,
    agentMessages: agent,
    systemMessages: system,
    robotSessions,
    noBuyerSessions: noBuyer,
    agents: [...agents].sort(),
    first: first === null ? null : formatShanghai(first),
    last: last === null ? null : formatShanghai(last),
  };
}

/**
 * 拼「把告警交给共享通知模块」的那一跳。
 *
 * 两条都是踩过的坑，别简化：
 * ① `--notify-dry-run` 必须把 `--dry-run` 真传给下游 —— 不传就是真发送；
 * ② stdin 必须 ignore —— 本机沙箱下 spawnSync 给 stdin 管道会 EBUSY，
 *    现象是「通知静默无输出、status 为 null」，看起来像通知模块自己坏了。
 */
export function notifyCommand({ nodePath, notifyScript, alertFile, dryRun = false }) {
  return {
    file: nodePath,
    args: [notifyScript, '--alert-file', alertFile, ...(dryRun ? ['--dry-run'] : [])],
    options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  };
}
