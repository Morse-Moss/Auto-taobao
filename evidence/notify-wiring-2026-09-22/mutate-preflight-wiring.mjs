// 突变验证：把源码改坏，确认判据真的红、而且**点名到期望的那一条**，再还原并自证逐字节一致。
// 动机：本项目反复出现「用例全绿 ≠ 接线接上了」。这三处突变对应的正是新加的接线本身，
// 如果改坏了用例还全绿，那就说明用例只是在复述实现，没在拦人。
//
// 用法：node tmp/_mutate-preflight-wiring.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const SOURCE = `${REPO}/runtime/xws-sku-auth-preflight.mjs`;
const CORE = `${REPO}/runtime/notify-feishu-core.mjs`;
const TEST = 'runtime/xws-sku-auth-preflight.test.mjs';

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

const MUTATIONS = [
  {
    file: SOURCE,
    name: '默认通知目标退回「不发」',
    from: '  return { command: process.execPath, args: [DEFAULT_NOTIFY_CLI] };',
    to: '  return null;',
    expectRedTest: '不给 --notify-command 时，默认出口就是仓库里那条投递 CLI',
  },
  {
    file: CORE,
    name: '标题表漏掉新增的 PAGE_UNAVAILABLE',
    from: "  XWS_PAGE_UNAVAILABLE: '采集用的商品页不在位',\n",
    to: '',
    expectRedTest: '预检能发出的每个 type 都要有人话标题',
  },
  {
    file: SOURCE,
    name: '「要叫人」名单漏掉 PAGE_UNAVAILABLE',
    from: "  'PAGE_UNAVAILABLE',\n",
    to: '',
    expectRedTest: '商品页不在位也要落一条可通知的告警',
  },
];

function runTests() {
  const result = spawnSync(process.execPath, ['--test', TEST], { cwd: REPO, encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

const original = new Map();
for (const file of [SOURCE, CORE]) original.set(file, readFileSync(file));
const shaBefore = new Map([...original].map(([file, buffer]) => [file, sha(buffer)]));
for (const [file, digest] of shaBefore) console.log(`原文件 sha256 ${file.split('/').pop()} = ${digest}`);

let failures = 0;
for (const mutation of MUTATIONS) {
  const buffer = original.get(mutation.file);
  const text = buffer.toString('utf8');
  if (!text.includes(mutation.from)) {
    console.log(`SKIP  ${mutation.name}：找不到锚点（改过源码后要同步改这里）`);
    failures += 1;
    continue;
  }
  const hits = text.split(mutation.from).length - 1;
  if (hits !== 1) {
    console.log(`SKIP  ${mutation.name}：锚点出现 ${hits} 次，不是唯一，不敢盲改`);
    failures += 1;
    continue;
  }
  writeFileSync(mutation.file, text.replace(mutation.from, mutation.to), 'utf8');
  const output = runTests();
  const red = output.split(/\r?\n/).filter((line) => line.startsWith('not ok '));
  const named = red.some((line) => line.includes(mutation.expectRedTest));
  console.log(`${named ? 'OK  ' : 'MISS'}  ${mutation.name} → 红了 ${red.length} 条；点名期望用例=${named}`);
  if (!named) {
    console.log(red.slice(0, 6).map((line) => `        ${line}`).join('\n'));
    failures += 1;
  }
  writeFileSync(mutation.file, buffer);
}

let restoreOk = true;
for (const [file, buffer] of original) {
  writeFileSync(file, buffer);
  const after = sha(readFileSync(file));
  const same = after === shaBefore.get(file);
  if (!same) restoreOk = false;
  console.log(`还原 ${file.split('/').pop()}：sha256 ${after}${same ? ' RESTORE-OK' : ' RESTORE-FAILED'}`);
}
if (!restoreOk) failures += 1;

const green = runTests();
const stillRed = green.split(/\r?\n/).filter((line) => line.startsWith('not ok ')).length;
console.log(`还原后重跑：not ok = ${stillRed}`);
if (stillRed !== 0) failures += 1;

console.log(failures === 0 ? 'MUTATION-VERIFY-PASS' : `MUTATION-VERIFY-FAIL (${failures} 项)`);
process.exitCode = failures === 0 ? 0 : 1;
