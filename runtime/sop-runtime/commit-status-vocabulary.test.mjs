// 提交状态词表守卫：运行时 COMMIT_STATUS 必须被库约束全部接受。
//
// 为什么需要这个文件：两边是**两个文件**、**两套实现**——
//   运行时的值域在 runtime/sop-runtime/side-effect-ledger.mjs（COMMIT_STATUS），
//   库侧的权威值域在 db/migrations/00N-*.sql 的 supervisor_commit_records_status_check。
// 而所有离线测试都用内存 store，它的 updateCommit 是 Object.assign(patch)，对值域不做任何校验。
// 于是「运行时写了一个库不接受的状态」永远不会在测试里露头，只会在真实 PG 上炸——
// 而且是炸在**失败路径**上：handler 一失败，账本想记 FAILED，CHECK 拒绝，异常穿出 ledger.commit，
// 连 two-stage-receipt.json 都写不出来。（2026-09-14 真实跑发布段时踩到，见 006 迁移注释。）
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMIT_STATUS, createSideEffectLedger } from './side-effect-ledger.mjs';
import { createMemoryStore } from './stores/memory-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '..', '..', 'db', 'migrations');
const CONSTRAINT = 'supervisor_commit_records_status_check';

// 取「最终生效」的那份定义：正向迁移按文件名顺序执行，最后一个 ADD CONSTRAINT 覆盖前面的。
// 两条口径必须写死，否则会静默取错：
//   1) 只认带 ADD CONSTRAINT 的那一份——001 的列内联 CHECK 没有名字，本来也不该被当成权威定义读到；
//   2) **排除 *-rollback.sql**——回滚脚本是人工撤销入口，不在正向序列里；
//      而且 `006-commit-….sql` 与 `006-rollback.sql` 按字典序排是 rollback 在后，
//      只看文件名顺序就会把「回滚后的 6 值」误判成现状（本条由第一次运行该守卫时实测抓到）。
export function effectiveCommitStatusVocabulary() {
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql') && !file.includes('-rollback'))
    .sort();
  let latest = null;
  for (const file of files) {
    const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    let index = text.indexOf(CONSTRAINT);
    while (index !== -1) {
      const end = text.indexOf(';', index);
      const statement = text.slice(index, end === -1 ? undefined : end);
      const values = [...statement.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
      if (values.length > 0) latest = { file, values };
      index = text.indexOf(CONSTRAINT, index + 1);
    }
  }
  return latest;
}

test('运行时提交状态词表必须被库约束全部接受', () => {
  const effective = effectiveCommitStatusVocabulary();
  assert.ok(effective, `在 db/migrations 里找不到 ${CONSTRAINT} 的 ADD CONSTRAINT 定义`);
  const allowed = new Set(effective.values);
  const missing = COMMIT_STATUS.filter((status) => !allowed.has(status));
  assert.deepEqual(
    missing,
    [],
    `库约束（${effective.file}）不接受这些运行时状态：${missing.join(', ')}——补一次迁移，不要改运行时词表去迁就库`,
  );
});

test('FAILED 必须同时存在于运行时词表与库约束里', () => {
  const allowed = new Set(effectiveCommitStatusVocabulary().values);
  assert.ok(COMMIT_STATUS.includes('FAILED'), '运行时词表丢了 FAILED');
  assert.ok(allowed.has('FAILED'), '库约束丢了 FAILED：发布段的失败路径会重新变成「写不出收据」');
});

test('账本在 handler 确定性失败时写出的状态，必须是库约束接受的那个', async () => {
  const store = createMemoryStore();
  const ledger = createSideEffectLedger({ store });
  const { commitKey } = await ledger.prepare({
    runId: '99999999-9999-4999-8999-999999999999',
    target: 'https://example.feishu.cn/base/appToken',
    businessKey: 'vocabulary-guard',
  });
  const result = await ledger.commit({
    commitKey,
    businessKey: 'vocabulary-guard',
    handler: async () => {
      const error = new Error('确定性拒绝：调用方没备好目标');
      error.failureClass = 'POLICY_DENIED';
      throw error;
    },
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failureClass, 'POLICY_DENIED');
  const allowed = new Set(effectiveCommitStatusVocabulary().values);
  assert.ok(allowed.has(result.status), `账本写出的 ${result.status} 不被库约束接受`);
});

test('结果未知与确定性失败必须是两个不同的值（否则对账与重试分不开）', async () => {
  const store = createMemoryStore();
  const ledger = createSideEffectLedger({ store });
  const unknown = await ledger.prepare({
    runId: '88888888-8888-4888-8888-888888888888',
    target: 'https://example.feishu.cn/base/appToken',
    businessKey: 'unknown-branch',
  });
  const result = await ledger.commit({
    commitKey: unknown.commitKey,
    businessKey: 'unknown-branch',
    handler: async () => {
      const error = new Error('提交结果未知');
      error.unknown = true;
      throw error;
    },
  });
  assert.equal(result.status, 'UNKNOWN');
  assert.notEqual(result.status, 'FAILED');
  const allowed = new Set(effectiveCommitStatusVocabulary().values);
  assert.ok(allowed.has('UNKNOWN') && allowed.has('FAILED'));
});
