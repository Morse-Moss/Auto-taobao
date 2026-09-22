// 突变验证：「实际登录会员名」这一批判据到底会不会红、且**红在期望的那一条用例上**。
//
// 为什么必须做（本仓库的纪律）：函数级用例全绿 ≠ 接线接上了。「改坏了也绿的判据等于没写」——
// 所以每一条判据都要拿一次**真实的红灯**证明它是活的。做完逐字节还原，并用 sha256 自证。
//
// 两条踩过的坑写在这里：
//   · **别用 TAP 编号定位用例**（编号会被新增用例顶走）⇒ 一律按用例**名字**匹配 `not ok` 行；
//   · 写文件可能被**静默丢弃**（工具报成功、磁盘没变）⇒ 每次写完先回读自证，再跑用例。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'D:/Retire/sycm-automation';
const TEST = 'runtime/shop-window-label.test.mjs';
const MODULE = 'runtime/shop-window-label.mjs';
const HTML = 'runtime/shop-window-label.html';
const NODE = process.execPath;

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
const read = (rel) => readFileSync(`${ROOT}/${rel}`, 'utf8');
// 不许用 replace 的默认行为：要替换的片段**必须恰好出现一次**，否则说明我改的源码已经漂了。
function replaceOnce(text, from, to, label) {
  const parts = text.split(from);
  if (parts.length !== 2) {
    throw new Error(`[${label}] 待替换片段出现了 ${parts.length - 1} 次（期望 1 次）：${from.slice(0, 70)}`);
  }
  return parts.join(to);
}

const MUTATIONS = [
  {
    id: 'M1',
    why: '把 actual 的透传删掉（「契约齐、测试绿、接线没接上」的经典形态）',
    file: MODULE,
    from: 'const url = labelPageUrlFor({ shop, port, state, ok, member, actual });',
    to: 'const url = labelPageUrlFor({ shop, port, state, ok, member });',
    expect: '挂标签页时把「实际登录的会员名」一起带上（不透传的话那一行永远是空的）',
  },
  {
    id: 'M2',
    why: 'URL 不再带 actual（量到了也不写）',
    file: MODULE,
    from: "  const actualText = String(actual ?? '').trim();\n  if (actualText) query.set('actual', actualText);\n",
    to: '',
    expect: '标签页 URL：没读到实际会员名就整条不带 actual（不写占位）',
  },
  {
    id: 'M3',
    why: '判定的三态塌成两态：登记表里没有期望值也算「一致」',
    file: MODULE,
    from: "  if (!want) return 'unregistered';",
    to: "  if (!want) return 'match';",
    expect: '判定四种结果各不相同：「没量到」不是「一致」，「登记表没有期望值」也不下判定',
  },
  {
    id: 'M4',
    why: '只解一层包装（真代理是两层：value 里面还套着表达式自己 stringify 的那层）',
    file: MODULE,
    from: 'reading = JSON.parse(JSON.parse(raw).value);',
    to: 'reading = JSON.parse(raw);',
    expect: '读实际登录会员名：照真代理的两层包装解，读法复用采集链那一份表达式',
  },
  {
    id: 'M5',
    why: '读法不再复用采集链那一份表达式（另写一份选择器）',
    file: MODULE,
    from: 'method: \'POST\', body: alimamaIdentityExpression(), signal: AbortSignal.timeout(timeoutMs),',
    to: 'method: \'POST\', body: \'document.body.innerText\', signal: AbortSignal.timeout(timeoutMs),',
    expect: '读实际登录会员名：照真代理的两层包装解，读法复用采集链那一份表达式',
  },
  {
    id: 'M6',
    why: '页面上没有显示实际会员名的地方（元素整个删掉）',
    file: HTML,
    from: '<div class="x" id="actual"></div>\n',
    to: '',
    expect: '实际登录的会员名必须真的落到页面元素上，且与登记表不符时标红',
  },
  {
    id: 'M7',
    why: '页面不再「量到才显示」（无条件显示 ⇒ 量不到时留一行空的）',
    file: HTML,
    from: '  if (actual) {\n',
    to: '  if (actual || true) {\n',
    expect: '实际登录的会员名必须真的落到页面元素上，且与登记表不符时标红',
  },
  {
    id: 'M8',
    why: '页面把「登记表没有期望值」算成「一致」（用没核对过的判断题冒充核对过）',
    file: HTML,
    from: "    const verdict = !member ? 'unknown' : (actual === member ? 'match' : 'mismatch');",
    to: "    const verdict = !member ? 'match' : (actual === member ? 'match' : 'mismatch');",
    expect: '实际登录的会员名必须真的落到页面元素上，且与登记表不符时标红',
  },
  {
    id: 'M9',
    why: '页面不比对了（把逐字比较换成恒真）',
    file: HTML,
    from: "(actual === member ? 'match' : 'mismatch')",
    to: "(true ? 'match' : 'mismatch')",
    expect: '实际登录的会员名必须真的落到页面元素上，且与登记表不符时标红',
  },
  {
    id: 'M10',
    why: '页面不标红了（不一致时不挂 bad 类）',
    file: HTML,
    from: "el.className = 'x ' + (verdict === 'mismatch' ? 'bad' : verdict === 'match' ? 'ok' : '');",
    to: "el.className = 'x ' + (verdict === 'mismatch' ? 'ok' : verdict === 'match' ? 'ok' : '');",
    expect: '实际登录的会员名必须真的落到页面元素上，且与登记表不符时标红',
  },
];

const originals = new Map([MODULE, HTML, TEST].map((rel) => [rel, read(rel)]));
console.log(`还原基准：${[...originals].map(([rel, text]) => `${rel}=${sha(text)}`).join('  ')}\n`);

let bad = 0;
for (const m of MUTATIONS) {
  const before = read(m.file);
  const mutated = replaceOnce(before, m.from, m.to, m.id);
  writeFileSync(`${ROOT}/${m.file}`, mutated, 'utf8');
  // 回读自证：写没写进去（本机的 Write/Edit 有过「报成功但磁盘没变」）
  if (read(m.file) !== mutated) throw new Error(`[${m.id}] 突变没写进磁盘 —— 后面的绿灯全是假的`);

  const res = spawnSync(NODE, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const redNames = [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((x) => x[1].trim());
  const hitExpected = redNames.some((name) => name.includes(m.expect));
  const restored = originals.get(m.file);
  writeFileSync(`${ROOT}/${m.file}`, restored, 'utf8');
  if (read(m.file) !== restored) throw new Error(`[${m.id}] 还原失败 —— 工作区已经被弄脏，立刻停手`);

  const verdict = res.status !== 0 && hitExpected ? 'CAUGHT' : 'MISSED';
  if (verdict === 'MISSED') bad += 1;
  console.log(`${verdict}  [${m.id}] exit=${res.status}  红=${redNames.length}  ${m.why}`);
  console.log(`         期望命中：${hitExpected ? '是' : '否'}  ← ${m.expect}`);
  if (redNames.length > 0) console.log(`         红灯清单：${redNames.join(' | ')}`);
  console.log('');
}

// 全部还原之后再跑一遍：必须回到全绿（否则我「还原」的东西并不是原来那份）
const finalRun = spawnSync(NODE, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const finalOut = `${finalRun.stdout ?? ''}${finalRun.stderr ?? ''}`;
const pass = /^# pass (\d+)$/mu.exec(finalOut)?.[1] ?? '?';
const fail = /^# fail (\d+)$/mu.exec(finalOut)?.[1] ?? '?';
console.log(`还原后重跑：exit=${finalRun.status}  pass=${pass}  fail=${fail}`);
console.log(`还原自证：${[...originals].every(([rel, text]) => read(rel) === text)
  ? '三个文件都与基准逐字节一致' : '有文件与基准不一致！'}`);
console.log(bad === 0 ? '\n全部突变都被期望的用例抓到（CAUGHT=10/10）' : `\n有 ${bad} 个突变没被抓到`);
process.exit(bad === 0 && finalRun.status === 0 ? 0 : 1);
