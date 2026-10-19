// 千牛客服聊天记录核心判据 · 离线用例（2026-10-19）
// 只测纯函数，不碰浏览器、不碰数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS, buildListChunks, buildShopStats, buildUserNick, classifyDirection, agentNameOf,
  computeShopSideUids, dedupeConversations, dedupeMessages, filterMessagesToWindow,
  formatShanghai, inferBuyerUid, isRobotCid, isoWeekId, normalizeMessage, notifyCommand,
  parseIsoDate, parseMessageText, resolveWeek,
  startOfWeek, toDateKey, toIsoDate, transferNamesOf,
} from './kefu-chat-core.mjs';

test('时间格式一律 +08，不受宿主时区影响', () => {
  const ms = parseIsoDate('2026-10-12');
  assert.equal(toDateKey(ms), '20261012');
  assert.equal(toIsoDate(ms), '2026-10-12');
  assert.equal(formatShanghai(ms), '10-12 00:00:00');
  assert.equal(formatShanghai(ms + 9 * 3600 * 1000 + 65 * 1000), '10-12 09:01:05');
});

test('parseIsoDate 严格：非法输入直接抛，不猜', () => {
  assert.throws(() => parseIsoDate('2026/10/12'), /YYYY-MM-DD/u);
  assert.throws(() => parseIsoDate(''), /YYYY-MM-DD/u);
  assert.throws(() => parseIsoDate(null), /YYYY-MM-DD/u);
});

test('周起点是周一（周日属于上一周）', () => {
  assert.equal(toIsoDate(startOfWeek(parseIsoDate('2026-10-19'))), '2026-10-19'); // 周一
  assert.equal(toIsoDate(startOfWeek(parseIsoDate('2026-10-18'))), '2026-10-12'); // 周日
  assert.equal(toIsoDate(startOfWeek(parseIsoDate('2026-10-12'))), '2026-10-12');
});

test('resolveWeek：默认取上一完整自然周；给了 date 就取那天所在周', () => {
  const now = parseIsoDate('2026-10-19') + 10 * 3600 * 1000; // 周一上午
  const last = resolveWeek({ now });
  assert.equal(last.startDate, '2026-10-12');
  assert.equal(last.endDate, '2026-10-18');
  assert.equal(last.weekId, '2026-W42');

  const byDate = resolveWeek({ date: '2026-09-21', now });
  assert.equal(byDate.startDate, '2026-09-21');
  assert.equal(byDate.endDate, '2026-09-27');
});

test('ISO 周编号与日历对齐（2026-01-01 是周四 ⇒ W01；10-12 是 W42）', () => {
  assert.equal(isoWeekId(parseIsoDate('2026-01-01')), '2026-W01');
  assert.equal(isoWeekId(parseIsoDate('2026-10-12')), '2026-W42');
  assert.equal(isoWeekId(parseIsoDate('2027-01-04')), '2027-W01');
});

test('回溯切块：首尾相接、无空档、末段正好到周日', () => {
  const week = resolveWeek({ date: '2026-10-12' });
  const chunks = buildListChunks({ startMs: week.startMs, endMs: week.endMs, lookbackDays: 30 });
  assert.equal(chunks[0].beginDate, '20260912'); // 10-12 往前 30 天
  assert.equal(chunks.at(-1).endDate, '20261018'); // 周日
  for (let i = 1; i < chunks.length; i += 1) {
    const prevEnd = parseIsoDate(`${chunks[i - 1].endDate.slice(0, 4)}-${chunks[i - 1].endDate.slice(4, 6)}-${chunks[i - 1].endDate.slice(6, 8)}`);
    assert.equal(parseIsoDate(`${chunks[i].beginDate.slice(0, 4)}-${chunks[i].beginDate.slice(4, 6)}-${chunks[i].beginDate.slice(6, 8)}`), prevEnd + DAY_MS, '段与段必须首尾相接');
  }
  assert.ok(chunks.every((chunk) => chunk.beginDate <= chunk.endDate));
});

test('切块粒度上限：超过 14 天必须拒绝（宽区间会被后端截断）', () => {
  const week = resolveWeek({ date: '2026-10-12' });
  assert.throws(() => buildListChunks({ startMs: week.startMs, endMs: week.endMs, chunkDays: 30 }), /chunkDays/u);
  assert.throws(() => buildListChunks({ startMs: week.endMs, endMs: week.startMs }), /endMs/u);
});

test('会话去重：同一 cid 保留 modifyTime 更新的一条', () => {
  const rows = [
    { cid: { appCid: 'a' }, modifyTime: 1, tag: 'old' },
    { cid: { appCid: 'a' }, modifyTime: 2, tag: 'new' },
    { cid: { appCid: 'b' }, modifyTime: 1, tag: 'only' },
  ];
  const out = dedupeConversations(rows);
  assert.equal(out.length, 2);
  assert.equal(out.find((row) => row.cid.appCid === 'a').tag, 'new');
});

test('消息文本解析：字符串/正文/摘要/标题，坏 JSON 退回原文', () => {
  assert.equal(parseMessageText('"纯文本"'), '纯文本');
  assert.equal(parseMessageText(JSON.stringify({ text: '正文' })), '正文');
  assert.equal(parseMessageText(JSON.stringify({ summary: '摘要' })), '摘要');
  assert.equal(parseMessageText(JSON.stringify({ title: '标题' })), '标题');
  assert.equal(parseMessageText('not-json'), 'not-json');
  assert.equal(parseMessageText(null), null);
});

test('消息归一化：昵称从 content.extensions.sender_nick 回退，并去掉 cntaobao 前缀', () => {
  const agent = normalizeMessage({
    sendTime: 1, senderId: { appUid: 'u1' }, content: JSON.stringify({ extensions: { sender_nick: 'cntaobao里可林家居:小俊' }, text: '您好' }),
  });
  assert.equal(agent.senderName, '里可林家居:小俊');
  const buyer = normalizeMessage({
    sendTime: 2, senderId: { appUid: 'u2' }, content: JSON.stringify({ extensions: { sender_nick: 'cntaobaofabworkspace' }, text: '人呢' }),
  });
  assert.equal(buyer.senderName, 'fabworkspace');
  assert.equal(buyer.text, '人呢');
});

test('窗口过滤是半开区间：起点含、终点不含', () => {
  const start = parseIsoDate('2026-10-12');
  const end = start + 7 * DAY_MS;
  const messages = [{ sendTime: start - 1 }, { sendTime: start }, { sendTime: end - 1 }, { sendTime: end }];
  assert.deepEqual(filterMessagesToWindow(messages, start, end).map((m) => m.sendTime), [start, end - 1]);
});

test('消息去重：同一条重复出现只留一条', () => {
  const m = { sendTime: 1, senderUid: 'u', contentType: '1', text: 'hi' };
  assert.equal(dedupeMessages([m, { ...m }, { ...m, text: 'other' }]).length, 2);
});

test('店侧 uid：会话行店账号 + 昵称带冒号的发送方，任一即算', () => {
  const sessions = [
    { shopUid: 'shop1', messages: [{ senderUid: 'shop1' }, { senderUid: 'agent2', senderName: '某店:小虫' }] },
    { shopUid: 'shop1', messages: [{ senderUid: 'buyer1' }] },
  ];
  assert.deepEqual(computeShopSideUids(sessions).sort(), ['agent2', 'shop1']);
});

test('买家 uid 推断：昵称对得上优先，其次取非店侧众数，推不出返回 null', () => {
  const shopSideUids = ['shop1'];
  assert.equal(inferBuyerUid({ displayName: '小明', messages: [{ senderUid: 'b1', senderName: '小明' }, { senderUid: 'shop1' }] }, shopSideUids), 'b1');
  assert.equal(inferBuyerUid({ displayName: '别的名字', messages: [{ senderUid: 'b2' }, { senderUid: 'b2' }, { senderUid: 'shop1' }] }, shopSideUids), 'b2');
  assert.equal(inferBuyerUid({ displayName: 'yyy', messages: [{ senderUid: 'shop1' }] }, shopSideUids), null);
});

test('方向判定：店侧 uid 优先判客服；买家由推断值判定；其余系统', () => {
  const shopSideUids = ['shop1'];
  assert.equal(classifyDirection({ senderUid: 'shop1', buyerUid: 'b1', shopSideUids }), 'agent');
  assert.equal(classifyDirection({ senderUid: 'b1', buyerUid: 'b1', shopSideUids }), 'buyer');
  assert.equal(classifyDirection({ senderUid: 'x', senderName: '某店:小虫', buyerUid: 'b1', shopSideUids }), 'agent');
  assert.equal(classifyDirection({ senderUid: 'x', senderName: null, buyerUid: 'b1', shopSideUids }), 'system');
  assert.equal(classifyDirection({ senderUid: null, buyerUid: 'b1', shopSideUids }), 'system');
});

test('客服名提取与转交识别', () => {
  assert.equal(agentNameOf('里可林家居:小虫', '里可林家居'), '小虫');
  assert.equal(agentNameOf('里可林家居', '里可林家居'), null);
  assert.equal(agentNameOf(null), null);
  assert.deepEqual(transferNamesOf('该会话由 小虫 转交给 小可'), ['小虫', '小可']);
  assert.deepEqual(transferNamesOf('正常消息'), []);
});

test('机器人会话与 userNick 口径', () => {
  assert.equal(isRobotCid('123.1-456.1#11005'), true);
  assert.equal(isRobotCid('123.1-456.1#11001'), false);
  assert.equal(buildUserNick('里可林家居'), 'cntaobao里可林家居');
  assert.throws(() => buildUserNick(null));
});

test('店铺统计：会话/消息/方向/客服名/首末时间', () => {
  const sessions = [
    {
      cid: 'a.1-2.1#11005', messages: [
        { sendTime: parseIsoDate('2026-10-12') + 1000, dir: 'buyer', agentName: null },
        { sendTime: parseIsoDate('2026-10-12') + 2000, dir: 'agent', agentName: '小虫' },
      ],
    },
    {
      cid: 'b.1-2.1#11001', messages: [
        { sendTime: parseIsoDate('2026-10-13'), dir: 'agent', agentName: '小可' },
      ],
    },
  ];
  const stats = buildShopStats(sessions);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.messages, 3);
  assert.equal(stats.buyerMessages, 1);
  assert.equal(stats.agentMessages, 2);
  assert.equal(stats.robotSessions, 1);
  assert.equal(stats.noBuyerSessions, 1);
  assert.deepEqual(stats.agents, ['小可', '小虫']);
  assert.equal(stats.first, '10-12 00:00:01');
});

// 通知那一跳必须钉住两件事：dry-run 要真传下去、stdin 必须 ignore。
// 2026-10-19 实测踩过：不给 stdio 时 spawnSync 在本机 EBUSY，通知静默失败、status 为 null。
test('notifyCommand：--notify-dry-run 必须把 --dry-run 真传给下游', () => {
  const dry = notifyCommand({ nodePath: 'node', notifyScript: 'notify.mjs', alertFile: 'a.json', dryRun: true });
  assert.equal(dry.file, 'node');
  assert.deepEqual(dry.args, ['notify.mjs', '--alert-file', 'a.json', '--dry-run']);

  const real = notifyCommand({ nodePath: 'node', notifyScript: 'notify.mjs', alertFile: 'a.json' });
  assert.deepEqual(real.args, ['notify.mjs', '--alert-file', 'a.json'], '默认不能带 --dry-run，否则该发的不发');
  assert.equal(real.args.includes('--dry-run'), false);
});

test('notifyCommand：stdin 必须是 ignore，否则本机 spawnSync 会 EBUSY', () => {
  const command = notifyCommand({ nodePath: 'node', notifyScript: 'notify.mjs', alertFile: 'a.json' });
  assert.equal(command.options.stdio[0], 'ignore');
  assert.equal(command.options.stdio[1], 'pipe');
  assert.equal(command.options.encoding, 'utf8');
});
