// 全仓统一提醒词表的守卫（2026-10-13 统一预警机制）。
//
// 这一层判据错一次，收信人收到的就是一条**对不上现场**的消息 —— 而它看起来完全正常。
// 所以这里钉的全是「形状」：编号域、方框词、白名单、闭集互锁、fail-closed 的抛错方向。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DAILY_ACTION_BY_CAUSE, DAILY_FAILURE_CAUSES, DAILY_HUMAN_REQUIRED_CAUSES, DAILY_REASON_BY_CAUSE,
  DAILY_RESUME_SENTENCE, FLOWS, buildFlowOkAlert, buildTechBlock, dailyCauseCopy, dateStampOf,
  flowFallbackCopy, flowOf,
} from './alert-copy.mjs';
import { TECH_BLOCK_KEYS } from './notify-feishu-core.mjs';

describe('FLOWS：四条流程的登记', () => {
  it('键与 workflow-catalog 的 workflow id 逐字一致', () => {
    assert.deepEqual(Object.keys(FLOWS).sort(),
      ['daily-report', 'product-daily', 'promotion-daily', 'weekly-report']);
  });

  it('每条流程都有标题方框词、周期叫法、编号前缀', () => {
    assert.equal(FLOWS['daily-report'].label, '店铺日报');
    assert.equal(FLOWS['promotion-daily'].label, '推广日报');
    assert.equal(FLOWS['product-daily'].label, '商品数据');
    assert.equal(FLOWS['weekly-report'].label, '周报');
    assert.equal(FLOWS['daily-report'].periodLabel, '统计日');
    assert.equal(FLOWS['promotion-daily'].periodLabel, '业务日');
    for (const flow of Object.values(FLOWS)) {
      assert.ok(flow.idPrefix, `${flow.key} 缺 idPrefix`);
      assert.ok(flow.capability, `${flow.key} 缺 capability`);
    }
  });

  it('未登记的流程当场抛错，绝不回退到默认流程', () => {
    assert.throws(() => flowOf('competitor-weekly'), /未登记的流程/u);
    assert.throws(() => flowOf(null), /未登记的流程/u);
    assert.throws(() => buildFlowOkAlert({ flow: 'nope', date: '2026-10-12' }), /未登记的流程/u);
  });

  it('日期戳只用一种形状', () => {
    assert.equal(dateStampOf('2026-10-12'), '20261012');
    assert.equal(dateStampOf(null), '');
  });
});

describe('buildFlowOkAlert：完成通知（纯业务、不带技术定位块）', () => {
  const base = {
    flow: 'daily-report', date: '2026-10-12', shops: ['盖文淘宝', '盖文天猫'],
    okCount: 2, total: 2, tables: [{ name: '底单', rows: 2 }, { name: '询单表', rows: 8 }],
    now: () => new Date('2026-10-13T03:30:00Z'),
  };

  it('标题第一段是流程名，severity 是 INFO，action 是「无需处理」', () => {
    const alert = buildFlowOkAlert(base);
    assert.equal(alert.type, 'FLOW_COMPLETED');
    assert.equal(alert.severity, 'INFO');
    assert.equal(alert.title, '【店铺日报】采集完成（统计日 2026-10-12）');
    assert.equal(alert.action, '无需处理。');
    assert.equal(alert.reason.includes('2/2 家全部收齐。'), true);
    assert.equal(alert.reason.includes('写了：底单 2 行、询单表 8 行。'), true);
  });

  it('编号域 <flow>-ok-<业务日>；指纹是成功数/总数', () => {
    const alert = buildFlowOkAlert(base);
    assert.equal(alert.alertId, 'daily-ok-20261012');
    assert.equal(alert.fingerprint, '2/2');
    assert.equal(buildFlowOkAlert({ ...base, flow: 'promotion-daily' }).alertId, 'promotion-ok-20261012');
    assert.equal(buildFlowOkAlert({ ...base, flow: 'product-daily' }).alertId, 'product-ok-20261012');
    assert.equal(buildFlowOkAlert({ ...base, flow: 'weekly-report' }).alertId, 'weekly-ok-20261012');
  });

  it('成功通知**故意不带 tech**（技术定位块只在失败时出现）', () => {
    assert.equal(buildFlowOkAlert(base).tech, undefined);
    assert.equal('tech' in buildFlowOkAlert(base), false);
  });

  it('早先发过失败告警、现在补齐了 ⇒ 改发「已恢复」，编号换成 ok 域', () => {
    const alert = buildFlowOkAlert({ ...base, recovered: true });
    assert.equal(alert.type, 'ROUND_RESOLVED');
    assert.equal(alert.title, '【店铺日报】已恢复（统计日 2026-10-12）');
    assert.equal(alert.reason.includes('今天早些时候这一流程有一次没收齐，现在已全部收齐。'), true);
    // 编号与「完成」不同 ⇒ 去重窗挡不住它（设计文档 §5.1 第二行）。
    assert.notEqual(alert.alertId, 'daily-round-20261012');
  });

  it('周期叫法按流程走：推广是「业务日」，周报是「周期」', () => {
    assert.equal(buildFlowOkAlert({ ...base, flow: 'promotion-daily' }).title, '【推广日报】采集完成（业务日 2026-10-12）');
    assert.equal(buildFlowOkAlert({ ...base, flow: 'weekly-report' }).title, '【周报】采集完成（周期 2026-10-12）');
  });

  it('0 对象不许发「完成」（整部门停采时那是纯噪声）', () => {
    assert.throws(() => buildFlowOkAlert({ ...base, shops: [], total: 0, okCount: 0 }), /至少跑了 1 个采集对象/u);
  });

  it('业务日必须是 YYYY-MM-DD，否则当场抛', () => {
    assert.throws(() => buildFlowOkAlert({ ...base, date: 'yesterday' }), /YYYY-MM-DD/u);
    assert.throws(() => buildFlowOkAlert({ ...base, date: null }), /YYYY-MM-DD/u);
  });

  it('没有表数字时「写了哪几张表」整行不输出', () => {
    const alert = buildFlowOkAlert({ ...base, tables: [] });
    assert.equal(alert.reason.includes('写了：'), false);
    assert.equal(alert.reason.includes('2/2 家全部收齐。'), true);
  });
});

describe('buildTechBlock：技术定位块（只在失败告警的第二段）', () => {
  it('白名单外的键当场抛（静默丢键＝收信人看不到，而你以为发出去了）', () => {
    assert.throws(() => buildTechBlock({ runId: 'r', machine: 'X' }), /渲染器不认识的键/u);
    assert.throws(() => buildTechBlock({ hostname: 'X' }), /渲染器不认识的键/u);
  });

  it('五个键都在白名单里', () => {
    assert.deepEqual([...TECH_BLOCK_KEYS].sort(), ['evidenceDir', 'exitCode', 'runId', 'stage', 'version']);
    const block = buildTechBlock({
      runId: '2026-10-12-x', evidenceDir: 'evidence/daily-job-2026-10-12', stage: '05-shop-report', exitCode: 1, version: '1.8.11',
    });
    // 值一律走 String()：这一块是纯文本渲染，不猜类型（数字列不回写字符串那条纪律的反面教材）。
    assert.deepEqual(block, {
      runId: '2026-10-12-x', evidenceDir: 'evidence/daily-job-2026-10-12', stage: '05-shop-report', exitCode: '1', version: '1.8.11',
    });
  });

  it('机器名一类的值当场抛（按窗口标题找，不按 hostname 找）', () => {
    assert.throws(() => buildTechBlock({ runId: 'DESKTOP-ABC123-run' }), /机器名/u);
    assert.throws(() => buildTechBlock({ evidenceDir: 'evidence/x-Administrator' }), /机器名/u);
  });

  it('一个值都没有时返回 null（调用方据此不挂这个块，而不是挂一个空段）', () => {
    assert.equal(buildTechBlock({}), null);
    assert.equal(buildTechBlock({ runId: '   ' }), null);
    assert.equal(buildTechBlock(null), null);
  });

  it('缺值的键整行不输出（不给空行）', () => {
    assert.deepEqual(buildTechBlock({ runId: 'r', stage: '' }), { runId: 'r' });
  });
});

describe('daily 分支：从日报链并入的三张词表', () => {
  it('闭集三张表互锁（加载期已查，这里再钉一次形状）', () => {
    assert.equal(DAILY_FAILURE_CAUSES.length, 10);
    for (const cause of DAILY_FAILURE_CAUSES) {
      assert.ok(DAILY_REASON_BY_CAUSE[cause], `${cause} 缺原因`);
      assert.equal(typeof DAILY_ACTION_BY_CAUSE[cause], 'function', `${cause} 缺下一步`);
    }
    for (const cause of DAILY_HUMAN_REQUIRED_CAUSES) {
      assert.ok(DAILY_FAILURE_CAUSES.includes(cause), `${cause} 不在结论闭集里`);
    }
    assert.deepEqual([...DAILY_HUMAN_REQUIRED_CAUSES], ['NEEDS_LOGIN', 'PAGE_OBSTRUCTED']);
  });

  it('dailyCauseCopy：成因不在表里直接抛，不静默退化', () => {
    assert.throws(() => dailyCauseCopy('NOT_A_CAUSE'), /daily 词表里没有成因/u);
    const copy = dailyCauseCopy('STAGE_FAILED', { date: '2026-10-12', shops: ['盖文淘宝'] });
    assert.equal(typeof copy.reason, 'string');
    assert.equal(typeof copy.action, 'string');
  });

  it('续跑承诺只在真有驻留进程时出现（willResume 由调用方说了才算）', () => {
    const withResume = dailyCauseCopy('NEEDS_LOGIN', { date: '2026-10-12', shops: ['盖文淘宝'], willResume: true });
    const without = dailyCauseCopy('NEEDS_LOGIN', { date: '2026-10-12', shops: ['盖文淘宝'] });
    assert.equal(withResume.action.includes('系统会自己接着'), true);
    assert.equal(without.action.includes('系统会自己接着'), false);
    assert.ok(DAILY_RESUME_SENTENCE.NEEDS_LOGIN);
  });

  it('「不用做任何事」的两类结论，下一步里明说不许重跑', () => {
    assert.equal(dailyCauseCopy('DUPLICATE_TARGET', { date: '2026-10-12' }).action.includes('不用处理'), true);
    assert.equal(dailyCauseCopy('SOURCE_NO_ROW_FOR_DATE', { date: '2026-10-12' }).action.includes('不用重跑'), true);
  });
});

describe('其余三条流程的兜底文案', () => {
  it('四条流程各有一句兜底（缺一句 ⇒ 失败时退化成谁都不想看的话）', () => {
    for (const key of Object.keys(FLOWS)) {
      const copy = flowFallbackCopy(key);
      assert.ok(copy.reason && copy.action, `${key} 缺兜底文案`);
    }
  });

  it('未登记的流程当场抛', () => {
    assert.throws(() => flowFallbackCopy('nope'), /未登记的流程/u);
  });

  it('兜底措辞不写英文阶段名、不写路径与命令', () => {
    for (const key of Object.keys(FLOWS)) {
      const copy = flowFallbackCopy(key);
      assert.equal(/[A-Z_]{6,}/u.test(copy.reason + copy.action), false, `${key} 的兜底文案里出现了机读码`);
      assert.equal(copy.action.includes('start-all'), false, `${key} 的兜底文案里出现了命令`);
      assert.equal(/[A-Z]:\\/u.test(copy.reason + copy.action), false, `${key} 的兜底文案里出现了盘符路径`);
    }
  });
});
