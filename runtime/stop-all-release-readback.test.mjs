// 判据：`scripts/stop-all.mjs` 的「停后回读」必须是**当场重读**的证据，不能拿杀之前那份快照充数。
//
// 为什么要有这条测试（2026-09-19 实测到的事实）：
//   当晚用户授权「全部杀了重跑」，第一次真跑 `--yes` 时，输出里同时出现了两句互相矛盾的话：
//     `停后盘点到:missing`（CDP 端口回读，说明浏览器确实没了）
//     `（这些 pid 仍在进程表里：33812, 32464）`（拿**循环开始前**那份进程表过滤出来的）
//   后者永远为真 —— 它过滤的是一份杀之前的快照，于是**每一个** pid 都会被报成「仍在」。
//   这与 HTTP 200 假成功是同一形态：回读必须回读到**当下**，否则「回读」只是装饰。
//
// 这条判据扫源码，用的是与 arch-boundary 守卫同一份 stripComments（唯一实现），
// 免得自己写的解释性注释把守卫判红（项目里踩过这个坑）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { REPO_ROOT, stripComments } from './arch-boundary-scan.mjs';

const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'scripts/stop-all.mjs'), 'utf8');
const CODE = stripComments(SOURCE);

test('停后回读会当场重读一次进程表（而不是复用循环前那份快照）', () => {
  const calls = [...CODE.matchAll(/readProcessTable\s*\(/gu)].length;
  assert.ok(
    calls >= 2,
    `scripts/stop-all.mjs 里 readProcessTable 只出现了 ${calls} 次；`
    + '停后判存活必须当场重读一次（第一次读是为了拿父子关系），否则判据是陈旧快照',
  );
});

test('不得用杀之前那份进程表去判「还活着」', () => {
  // 杀之前那份表的变量名是 processRows。它只该用于：读父子关系（findAncestorByPid）、
  // 认代理身份（找 pid 那一行）。拿它去 filter 存活状态就是上面那个假判据。
  assert.ok(
    !/processRows\s*\.some\s*\(/u.test(CODE),
    'scripts/stop-all.mjs 用 processRows（杀之前的快照）判存活了 —— 这会让每个 pid 都被报成「仍在」，'
    + '而旁边那句「盘点到 missing」来自另一处回读，两句会互相矛盾',
  );
});

test('进程表读不出来时不冒充证据，而是标成「没有证据」', () => {
  assert.ok(
    /stillAlive\s*===\s*null/u.test(CODE),
    'scripts/stop-all.mjs 没有区分「停后进程表读不出来」与「确实都停了」；'
    + '前者必须标成没有证据（null），不能渲染成「已停干净」',
  );
  assert.ok(
    /stillAlive/u.test(CODE) && /processTableErrorAfter/u.test(CODE),
    'scripts/stop-all.mjs 的停后回读没有把读表失败带出来',
  );
});

test('停不干净要反映到退出码，不能只看「拒停」项', () => {
  assert.ok(
    /hardFail[\s\S]{0,240}stillAlive/u.test(CODE),
    'scripts/stop-all.mjs 的 hardFail 没把 stillAlive 算进去 ⇒ 「说停掉了其实还活着」会退出 0，'
    + '调用方会把没停干净当成功',
  );
});
