// 告警投递公共出口的守卫（2026-10-13 统一预警机制）。
//
// 这一层钉的是四条从事故里换来的硬规矩：走文件不走 stdin、stdio 显式、
// 只认真送出去才记账、去重不过投递层。每一条错了都不会自己报错 ——
// 症状是「出事的时候连一条告警都发不出去」，而日志里只有一句退出码 null。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { dispatchAlert } from './deliver-alert.mjs';
import { buildFlowOkAlert } from './alert-copy.mjs';

function tmpThrottle() {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'deliver-alert-')), 'throttle.json');
}

const okAlert = () => buildFlowOkAlert({
  flow: 'daily-report', date: '2026-10-12', shops: ['盖文淘宝'], okCount: 1, total: 1,
  now: () => new Date('2026-10-13T03:30:00Z'),
});

describe('dispatchAlert：三档动作', () => {
  it('off 档一个字节都不发（没给 --notify 的默认档）', () => {
    let calls = 0;
    const result = dispatchAlert({ alert: okAlert(), action: 'off', exec: () => { calls += 1; return { status: 0 }; } });
    assert.equal(calls, 0);
    assert.deepEqual(result, { delivered: false, suppressed: false, reason: 'off', receipt: null });
  });

  it('print 档不起进程（--notify-print 排练档）', () => {
    let calls = 0;
    const result = dispatchAlert({ alert: okAlert(), action: 'print', exec: () => { calls += 1; return { status: 0 }; } });
    assert.equal(calls, 0);
    assert.equal(result.reason, 'print');
  });

  it('不是告警对象当场抛（调用方判定错误不许静默通过）', () => {
    assert.throws(() => dispatchAlert({ alert: null, action: 'send' }), /需要一条告警对象/u);
    assert.throws(() => dispatchAlert({ alert: 'x', action: 'send' }), /需要一条告警对象/u);
  });
});

describe('dispatchAlert：投递本身', () => {
  it('真投：走 --alert-file，且 stdio 显式（EBUSY 教训）', () => {
    const seen = [];
    const result = dispatchAlert({
      alert: okAlert(), action: 'send', throttleFile: tmpThrottle(),
      exec: (bin, args, opts) => {
        seen.push({ bin, args, opts });
        return { status: 0, stdout: '{"status":"SENT"}' };
      },
    });
    assert.equal(result.delivered, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].args[0].endsWith('notify-feishu.mjs'), true);
    assert.equal(seen[0].args[1], '--alert-file');
    // 默认 stdio 恰是会被宿主沙箱掐断的那一形态（stdin 管道）⇒ 必须显式 ignore。
    assert.deepEqual(seen[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
  });

  it('只认真送出去才记账（送失败还记账 ⇒ 下一次重跑被自己的记录挡掉）', () => {
    const file = tmpThrottle();
    const failed = dispatchAlert({
      alert: okAlert(), action: 'send', throttleFile: file,
      exec: () => ({ status: 1, stderr: 'NOT_CONFIGURED' }),
    });
    assert.equal(failed.delivered, false);
    assert.throws(() => readFileSync(file, 'utf8'), '投递失败不该留节流记录');

    const sent = dispatchAlert({
      alert: okAlert(), action: 'send', throttleFile: file,
      exec: () => ({ status: 0, stdout: '{"status":"SENT"}' }),
    });
    assert.equal(sent.delivered, true);
    const state = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(state.byAlertId['daily-ok-20261012'], '送成功必须记账（否则同一天重复成功会再发一条）');
  });

  it('窗口内同编号同指纹再发一次 ⇒ 被去重挡下，且一次投递都不发生', () => {
    const file = tmpThrottle();
    const exec = () => ({ status: 0, stdout: '{"status":"SENT"}' });
    dispatchAlert({ alert: okAlert(), action: 'send', throttleFile: file, exec, now: () => new Date('2026-10-13T03:30:00Z') });
    let calls = 0;
    const second = dispatchAlert({
      alert: okAlert(), action: 'send', throttleFile: file,
      exec: () => { calls += 1; return { status: 0 }; },
      now: () => new Date('2026-10-13T05:30:00Z'),
    });
    assert.equal(calls, 0, '6 小时窗口内不许再投一次');
    assert.equal(second.suppressed, true);
    assert.equal(second.delivered, false);
  });

  it('指纹变了（成功数变了）⇒ 是新信息，不该被挡掉', () => {
    const file = tmpThrottle();
    const exec = () => ({ status: 0, stdout: '{"status":"SENT"}' });
    dispatchAlert({
      alert: buildFlowOkAlert({
        flow: 'daily-report', date: '2026-10-12', shops: ['盖文淘宝', '盖文天猫'], okCount: 2, total: 2,
        now: () => new Date('2026-10-13T03:30:00Z'),
      }),
      action: 'send', throttleFile: file, exec, now: () => new Date('2026-10-13T03:30:00Z'),
    });
    let calls = 0;
    dispatchAlert({
      alert: buildFlowOkAlert({
        flow: 'daily-report', date: '2026-10-12', shops: ['盖文淘宝', '盖文天猫'], okCount: 1, total: 2,
        now: () => new Date('2026-10-13T04:30:00Z'),
      }),
      action: 'send', throttleFile: file,
      exec: () => { calls += 1; return { status: 0 }; },
      now: () => new Date('2026-10-13T04:30:00Z'),
    });
    assert.equal(calls, 1, '指纹变了必须放行');
  });

  it('投递结论写进日志（事后复盘唯一能对上「他看到了什么」的地方）', () => {
    const lines = [];
    dispatchAlert({
      alert: okAlert(), action: 'send', throttleFile: tmpThrottle(),
      exec: () => ({ status: 0, stdout: '{"status":"SENT"}' }), log: (line) => lines.push(line),
    });
    assert.equal(lines.join('\n').includes('告警投递退出码=0'), true);
  });
});

describe('dispatchAlert：与完成通知的接线形状', () => {
  it('完成通知的编号与指纹能直接被它投（不需要再包一层）', () => {
    const seen = [];
    const result = dispatchAlert({
      alert: okAlert(), action: 'send', throttleFile: tmpThrottle(),
      exec: (bin, args) => {
        // 落盘的那个临时文件就是收信人将看到的全文（形状由渲染器定，这里只确认它存在）。
        const payload = JSON.parse(readFileSync(args[2], 'utf8'));
        seen.push(payload);
        return { status: 0, stdout: '{"status":"SENT"}' };
      },
    });
    assert.equal(result.delivered, true);
    assert.equal(seen[0].title, '【店铺日报】采集完成（统计日 2026-10-12）');
    assert.equal(seen[0].severity, 'INFO');
    assert.equal(seen[0].tech, undefined, '完成通知不带技术定位块');
  });
});

// 临时目录清理由操作系统负责；这里只保证没有把节流状态写进仓库。
describe('dispatchAlert：不碰仓库里的节流状态文件', () => {
  it('用例注入的 throttleFile 在临时目录（不写 runtime/alert-throttle.json）', () => {
    const file = tmpThrottle();
    dispatchAlert({
      alert: okAlert(), action: 'send', throttleFile: file,
      exec: () => ({ status: 0, stdout: '{"status":"SENT"}' }),
    });
    assert.equal(file.startsWith(os.tmpdir()), true);
    rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
