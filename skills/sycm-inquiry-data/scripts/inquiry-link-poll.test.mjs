import test from 'node:test';
import assert from 'node:assert/strict';
import { planLinkPollStep, pollInquiryLink } from './inquiry-core.mjs';

// ---------------------------------------------------------------------------
// 「导出链接」轮询的判据（2026-10-21 加）
// ---------------------------------------------------------------------------
// 病根：`link` 是 React fiber 的 `memoizedProps.link`，要等报表数据请求回来才被填；
// 而原版**只读一次**就判死。2026-10-20 网林家居现场读到的正是
// `{shop:'网林定制家居',hasInquiry:true,date:'2026-10-20',daySelected:true,link:''}` ——
// 身份对、日期对、入口在，只有 link 空。19 分钟后同一家店同一条命令一次成功。
//
// 这些用例钉的是「判据」，不是实现细节：三态怎么分、超时怎么回、日期错要不要早退。

test('拿到 link 就是 done —— 不为等满窗口空转', () => {
  assert.equal(planLinkPollStep({ link: 'https://x/export', date: '2026-10-20', expectedDate: '2026-10-20' }), 'done');
});

test('复刻 2026-10-20 网林家居现场：入口/日期/日按钮都对，只有 link 空 ⇒ 必须继续等，不许判死', () => {
  const scene = { shop: '网林定制家居', hasInquiry: true, date: '2026-10-20', daySelected: true, link: '' };
  assert.equal(planLinkPollStep({ link: scene.link, date: scene.date, expectedDate: '2026-10-20' }), 'wait');
});

test('link 是纯空白也算没填好（平台可能先塞空格）', () => {
  assert.equal(planLinkPollStep({ link: '   ', date: '2026-10-20', expectedDate: '2026-10-20' }), 'wait');
});

test('日期不是目标日 ⇒ 立刻 wrong-date，不耗完整个窗口', () => {
  assert.equal(planLinkPollStep({ link: 'https://x', date: '2026-10-19', expectedDate: '2026-10-20' }), 'wrong-date');
});

test('日期错优先于 link 空：两者同时不满足时先报日期', () => {
  assert.equal(planLinkPollStep({ link: '', date: '2026-10-19', expectedDate: '2026-10-20' }), 'wrong-date');
});

test('空对象（页签没了）也算 wait，不当成错', () => {
  assert.equal(planLinkPollStep({}), 'wait');
});

test('轮询：第 3 次读到 link 就返回，正好读 3 次不多读', async () => {
  let clock = 0;
  let calls = 0;
  const states = [{ link: '' }, { link: ' ' }, { link: 'https://x/export' }];
  const result = await pollInquiryLink({
    read: async () => { const s = states[calls] ?? { link: 'https://x/export' }; calls += 1; return s; },
    expectedDate: '2026-10-20',
    timeoutMs: 20000,
    intervalMs: 1000,
    now: () => clock,
    delay: async (ms) => { clock += ms; },
  });
  assert.equal(result.step, 'done');
  assert.equal(result.reads, 3);
  assert.equal(result.state.link, 'https://x/export');
  assert.equal(result.timedOut, false);
});

test('轮询：一直空 ⇒ timedOut=true 且**不抛**，把最后读数与读次数交回去', async () => {
  let clock = 0;
  const result = await pollInquiryLink({
    read: async () => ({ link: '', date: '2026-10-20', shop: '网林定制家居' }),
    expectedDate: '2026-10-20',
    timeoutMs: 3000,
    intervalMs: 1000,
    now: () => clock,
    delay: async (ms) => { clock += ms; },
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.step, 'wait');
  assert.ok(result.reads >= 2, `应该读过多次，实际 ${result.reads}`);
  assert.equal(result.state.link, '');
});

test('轮询：日期错立刻返回，不看 timedOut', async () => {
  let clock = 0;
  const result = await pollInquiryLink({
    read: async () => ({ link: 'https://x', date: '2026-10-19' }),
    expectedDate: '2026-10-20',
    timeoutMs: 20000,
    intervalMs: 1000,
    now: () => clock,
    delay: async (ms) => { clock += ms; },
  });
  assert.equal(result.step, 'wrong-date');
  assert.equal(result.reads, 1);
});

test('轮询：缺 read() 直接报错（调用方传错的接线错误不该静默空转）', async () => {
  await assert.rejects(() => pollInquiryLink({ expectedDate: '2026-10-20' }), /需要 read\(\)/u);
});

test('轮询：timeoutMs 为负直接报错，不允许「负超时」被解释成立刻超时', async () => {
  await assert.rejects(
    () => pollInquiryLink({ read: async () => ({ link: 'x' }), timeoutMs: -1 }),
    /必须是非负数/u,
  );
});
