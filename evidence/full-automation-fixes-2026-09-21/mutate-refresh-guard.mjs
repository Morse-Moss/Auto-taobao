// 突变验证：把几处判据**故意改坏**，确认对应的用例真的变红、而且**红的是那一条**，然后逐字节还原。
//
// 为什么要做（这个仓库的规矩）：判据「写完了、跑绿了」不等于它拦得住东西。2026-09-21 就发生过
// 一次「函数级用例全绿，但真实调用点根本没接上」—— 那次的教训就是这条 harness 的由来。
//
// 每一条突变都写明「应当由哪一条用例抓住」。抓不住 = 那条用例是装饰。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = 'D:/Retire/sycm-automation';
const DRIVER = `${ROOT}/skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`;
const DRIVER_TEST = `${ROOT}/skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs`;
const REFRESH = `${ROOT}/runtime/refresh-shop-pages.mjs`;
const REFRESH_TEST = `${ROOT}/runtime/refresh-shop-pages.test.mjs`;
const NORMALIZE = `${ROOT}/runtime/page-normalize.mjs`;
const NORMALIZE_TEST = `${ROOT}/runtime/page-normalize.test.mjs`;

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const read = (file) => readFileSync(file, 'utf8');

/** 精确替换：目标必须出现恰好一次；写完回读自证（这个仓库的编辑工具会静默丢写）。 */
const swap = (file, from, to) => {
  const before = read(file);
  const count = before.split(from).length - 1;
  if (count !== 1) throw new Error(`替换目标出现 ${count} 次（应为 1 次）：${JSON.stringify(from.slice(0, 70))}`);
  const intended = before.split(from).join(to);
  writeFileSync(file, intended, 'utf8');
  // 回读比**整份内容**，不比某个子串：删除型突变（to === ''）下按子串数自证会永远为假。
  if (read(file) !== intended) throw new Error('写入没生效（静默丢写）');
};

const runTest = (file, pattern) => {
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { failed: [...output.matchAll(/^not ok \d+ - (.*)$/gmu)].map((m) => m[1].trim()) };
};

const CALL_SITE = '      record.recovery = await recoverFailedShop({ shopKey: key, logDir: shopLogDir, repoRoot: REPO_ROOT });\n';
const CLOSE_OF_IF = '      }\n    }\n  }\n\n  summary.finishedAt = new Date().toISOString();';

const MUTATIONS = [
  {
    name: '刷新：去掉 yesterday 的格式校验（null===null 会把「读不到」判成「已是昨日」）',
    file: REFRESH,
    edits: [['  if (!/^\\d{4}-\\d{2}-\\d{2}$/u.test(String(yesterday ?? \'\'))) {', '  if (false) {']],
    test: REFRESH_TEST,
    expect: '刷新判定：缺了 yesterday 直接抛',
  },
  {
    name: '刷新：把「读数读不到」也算 ready',
    file: REFRESH,
    edits: [['  if (resolved === yesterday) {', '  if (resolved === yesterday || applied === null) {']],
    test: REFRESH_TEST,
    expect: '刷新判定：读数是昨日才算 ready',
  },
  {
    name: '刷新：汇总时忘掉「还有一家要刷新」',
    file: REFRESH,
    edits: [['  return { ...presence, stale, ok: presence.ok && stale.length === 0 };',
      '  return { ...presence, stale, ok: presence.ok };']],
    test: REFRESH_TEST,
    expect: '刷新汇总：在位性沿用 shop-pages 的判据',
  },
  {
    name: '刷新：重载改用 /navigate（同 URL 导航＝同文档导航，浏览器什么都不做）',
    file: REFRESH,
    edits: [['`${base}/eval?target=${encodeURIComponent(targetId)}`', '`${base}/navigate?target=${encodeURIComponent(targetId)}`']],
    test: REFRESH_TEST,
    expect: '重载：走的是页面自己 reload',
  },
  {
    name: '驱动：失败路径的收尾整个不接',
    file: DRIVER,
    edits: [[CALL_SITE, '']],
    test: DRIVER_TEST,
    expect: '失败收尾：驱动里真的接上了',
  },
  {
    name: '驱动：收尾被挪到「停整轮」之后（默认策略下唯一失败的那家不会被收尾）',
    file: DRIVER,
    edits: [[CALL_SITE, ''],
      [CLOSE_OF_IF, CLOSE_OF_IF.replace('  }\n\n  summary.finishedAt',
        `  }\n\n  if (summary.shops[Object.keys(summary.shops).pop()]?.status !== 'ok') {\n${CALL_SITE}  }\n  summary.finishedAt`)]],
    test: DRIVER_TEST,
    expect: '失败收尾：驱动里真的接上了',
  },
  {
    name: '体检：归位整个不接（退回成「只看不修」）',
    file: DRIVER,
    edits: [['    normalize = await normalizePages({ proxyPort: proxyPortForBrowser(key), expected: pages });', '']],
    test: DRIVER_TEST,
    expect: '驱动：体检真的接上了「先归位、再检查」',
  },
  {
    name: '体检：归位被挪到体检调用之后（先判不过、再修，结论永远修不上）',
    file: DRIVER,
    edits: [
      ['    normalize = await normalizePages({ proxyPort: proxyPortForBrowser(key), expected: pages });\n    log(`归位：${normalize.verdict.detail}`);\n', ''],
      ['    result = await check({});',
        '    result = await check({});\n    normalize = await normalizePages({ proxyPort: proxyPortForBrowser(key), expected: pages });'],
    ],
    test: DRIVER_TEST,
    expect: '驱动：体检真的接上了「先归位、再检查」',
  },
  {
    name: '体检：归位结论不进收据（事后从 summary 分不出「本来就好」与「脚本修好的」）',
    file: DRIVER,
    edits: [['        pageNormalize: result.normalize?.verdict?.detail ?? null });', '      });']],
    test: DRIVER_TEST,
    expect: '驱动：体检真的接上了「先归位、再检查」',
  },
  {
    name: '归位：只读口径丢了（dry 也真去导航/新建）',
    file: NORMALIZE,
    edits: [['  const actions = planPageActions({ urls: beforeUrls, expected, urlByName, dry });',
      '  const actions = planPageActions({ urls: beforeUrls, expected, urlByName, dry: false });']],
    test: NORMALIZE_TEST,
    expect: '归位：只读时一个写请求都不发',
  },
  {
    name: '归位：动作没做成也算 ok（把「领回失败」洗成「就位」）',
    file: NORMALIZE,
    edits: [['  if (notDone.length) {', '  if (false) {']],
    test: NORMALIZE_TEST,
    expect: '归位判定：就位与否看页签数量',
  },
];

const lines = [];
let caught = 0;
for (const mutation of MUTATIONS) {
  const originals = [...new Set([...mutation.edits.map(() => mutation.file)])].map((file) => [file, read(file)]);
  const beforeHash = sha(mutation.file);
  const beforeBytes = Buffer.byteLength(read(mutation.file));
  try {
    for (const [from, to] of mutation.edits) swap(mutation.file, from, to);
    const { failed } = runTest(mutation.test, mutation.expect);
    const hit = failed.some((name) => name.includes(mutation.expect));
    if (hit) caught += 1;
    lines.push(`${hit ? 'CAUGHT' : 'MISSED'}  ${mutation.name}`);
    lines.push(`          应红的是「${mutation.expect}」；实际红的是：${failed.length ? failed.join(' | ') : '（一条都没红）'}`);
  } catch (error) {
    lines.push(`ERROR   ${mutation.name}\n          ${error.message}`);
  } finally {
    for (const [file, text] of originals) writeFileSync(file, text, 'utf8');
    const afterHash = sha(mutation.file);
    const afterBytes = Buffer.byteLength(read(mutation.file));
    const restored = afterHash === beforeHash && afterBytes === beforeBytes;
    if (!restored) lines.push(`        !! 还原失败：${beforeHash.slice(0, 12)}→${afterHash.slice(0, 12)}，${beforeBytes}→${afterBytes} 字节`);
    else lines.push(`        （已还原，sha256 ${afterHash.slice(0, 12)}，${afterBytes} 字节，逐字节一致）`);
  }
  lines.push('');
}

lines.push(`突变验证：${caught}/${MUTATIONS.length} 被抓住`);
console.log(lines.join('\n'));
