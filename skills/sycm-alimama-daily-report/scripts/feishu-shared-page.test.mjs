// 五家共用那一页飞书页的判据与落位：纯函数 + 用假代理跑真行为。
//
// 为什么必须有一条**行为**用例（而不是只断言函数被调用过）：2026-09-20 这一轮真正的错
// 不是「判据写错了」，而是「进场只断言、不落位」—— 判据本身一直是对的。
// 所以这里用假代理跑一次 ensureTargetPage，断言它**真的发了导航**、且导航发生在复核之前；
// 把那一行删掉，这条用例就该红（突变验证的做法与 runtime 那批守卫一致）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';

import {
  assertOnTargetPage,
  buildTargetTableUrl,
  describePageSearchFailure,
  describeTargetMismatch,
  inspectPageUrl,
} from './feishu-shared-page.mjs';
import { ensureTargetPage } from './run-daily-report.mjs';

const SCRIPTS_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '../../..');

// 夹具用的就是当前生效的那一套 id（kcne 租户的「各店铺日报」）。
// 最后一条用例会把它们与 runtime/feishu-targets.mjs 的**源文本**对一遍 ——
// 配置改了而测试没跟，这里会当场红，而不是让这批用例对着旧夹具继续绿。
const APP_TOKEN = 'PTfHbPt9EaIzddsfL8Jcj238nrb';
const SOURCE_ID = 'tblkY3W8tnPWPcnh';
const SOURCE_VIEW = 'vewwg0rhjo';
const INQUIRY_ID = 'tblUnwn05vl8Wik9';
const INQUIRY_VIEW = 'vewHgmRhGR';
const ORIGIN = 'https://kcne618basvj.feishu.cn';
const pageUrl = (table, view) => `${ORIGIN}/base/${APP_TOKEN}?table=${table}&view=${view}`;

// 假代理：/targets 是页面清单，/navigate 只记录、不真的导航，/eval 返回注入的答案。
// 与 runtime/xws-sku-auth-preflight.test.mjs 里那套同形（listen 0，用完 close）。
async function fakeProxy({ pages, evalResult = () => 'ready' }) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/targets') {
      response.end(JSON.stringify(pages));
      return;
    }
    if (url.pathname === '/navigate') {
      response.end(JSON.stringify({ ok: true, url: url.searchParams.get('url') }));
      return;
    }
    if (url.pathname === '/eval') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => { response.end(JSON.stringify({ value: evalResult(body) })); });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: `unexpected path ${url.pathname}` }));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    proxy: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.close(resolve); }),
  };
}

// --- 一、纯判据 -------------------------------------------------------------

test('inspectPageUrl：授权 table/view 之外的一切都算「没落位」', () => {
  const expected = { appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW };

  assert.deepEqual(inspectPageUrl(pageUrl(SOURCE_ID, SOURCE_VIEW), expected), {
    url: pageUrl(SOURCE_ID, SOURCE_VIEW), parseable: true, onAppToken: true,
    actualTable: SOURCE_ID, actualView: SOURCE_VIEW,
    expectedTable: SOURCE_ID, expectedView: SOURCE_VIEW, onTarget: true,
  });

  // 停在别的表上（这就是 2026-09-20 那一轮的现场：上一家的 readback 没归位）。
  const wrongTable = inspectPageUrl(pageUrl(INQUIRY_ID, INQUIRY_VIEW), expected);
  assert.equal(wrongTable.onTarget, false);
  assert.equal(wrongTable.actualTable, INQUIRY_ID);
  assert.equal(wrongTable.onAppToken, true, '同一个 base，只是不在授权的那张表上');

  // 表对、视图不对，也算没落位。
  assert.equal(inspectPageUrl(pageUrl(SOURCE_ID, INQUIRY_VIEW), expected).onTarget, false);

  // 整页被切到了别的 base：仍然解析得出来，但不属于本 base。
  const otherBase = `${ORIGIN}/base/SomeOtherToken?table=${SOURCE_ID}&view=${SOURCE_VIEW}`;
  const away = inspectPageUrl(otherBase, expected);
  assert.equal(away.onAppToken, false);
  assert.equal(away.onTarget, false);

  // 参数缺失（例如被人手工粘成 …?table=xxx）：解析得出来，但没有 view 就不算落位。
  assert.equal(inspectPageUrl(`${ORIGIN}/base/${APP_TOKEN}?table=${SOURCE_ID}`, expected).onTarget, false);

  // 连 URL 都解析不出来：不许抛错（调用方要能把它原样写进报错里）。
  const broken = inspectPageUrl('http://', expected);
  assert.equal(broken.parseable, false);
  assert.equal(broken.onTarget, false);
});

test('buildTargetTableUrl：只在原 origin 上拼回 base 表地址，形状与 readback 一致', () => {
  const built = buildTargetTableUrl(pageUrl(INQUIRY_ID, INQUIRY_VIEW),
    { appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW });
  assert.equal(built, pageUrl(SOURCE_ID, SOURCE_VIEW));
  // origin 跟着页面走（同一个 base 可能在多个域名上打开），不写死 host。
  assert.equal(buildTargetTableUrl(`https://example.feishu.cn/base/${APP_TOKEN}?table=x`,
    { appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW }),
  `https://example.feishu.cn/base/${APP_TOKEN}?table=${SOURCE_ID}&view=${SOURCE_VIEW}`);
});

test('describeTargetMismatch：同时报出「当前」与「期望」，并点出这一页是上一家留下的', () => {
  const message = describeTargetMismatch(pageUrl(INQUIRY_ID, INQUIRY_VIEW), {
    appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW,
    knownTables: { [SOURCE_ID]: '源表（总数据来源底单）', [INQUIRY_ID]: '询单表' },
  });

  // 前缀保留：历史证据与文档里都按这条 grep（evidence/multi-shop-2026-09-19/科塔淘宝/07-push.txt）。
  assert.match(message, /^Feishu page is not on authorized table\/view/u);
  assert.match(message, new RegExp(INQUIRY_ID, 'u'), '要写清现在停在哪张表');
  assert.match(message, /询单表/u, '登记过的表要给可读名，不能只甩 id');
  assert.match(message, new RegExp(SOURCE_ID, 'u'), '要写清期望哪张表');
  assert.match(message, /共用这一页/u, '要点明这一页是五家共用的');
  assert.match(message, /上一家/u, '要点出最可能的原因：上一家的阶段没收尾');
  assert.match(message, /ensureTargetPage/u, '要指向本步的落位动作，才知道下一步查哪');
});

test('describeTargetMismatch：view 不同时的说法与「停在别张表」分开，不许混成一句', () => {
  const message = describeTargetMismatch(pageUrl(SOURCE_ID, INQUIRY_VIEW),
    { appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW });
  assert.match(message, /只有 view 不同/u);
  assert.equal(/上一家/u.test(message), false, '表是对的，就不该把锅甩给上一家');
});

test('describePageSearchFailure：got 0 的两种成因要能分开，且列出 /targets 看到的页面', () => {
  const empty = describePageSearchFailure([], { appToken: APP_TOKEN });
  assert.match(empty, /expected one Feishu page for target base, got 0/u);
  assert.match(empty, /一个页面都没认到/u);
  assert.match(empty, /别猜/u);

  const elsewhere = describePageSearchFailure([
    { targetId: 'p1', type: 'page', url: `${ORIGIN}/base/AnotherToken?table=x` },
  ], { appToken: APP_TOKEN });
  assert.match(elsewhere, /got 0/u);
  assert.match(elsewhere, /p1/u, '要把当前认到的页面列出来');
  assert.match(elsewhere, /被切到了别的 base/u);

  const two = describePageSearchFailure([
    { targetId: 'p1', type: 'page', url: pageUrl(SOURCE_ID, SOURCE_VIEW) },
    { targetId: 'p2', type: 'page', url: pageUrl(SOURCE_ID, SOURCE_VIEW) },
  ], { appToken: APP_TOKEN });
  assert.match(two, /got 2/u);
  assert.match(two, /p1[\s\S]*p2/u);
});

test('assertOnTargetPage：在授权表上原样返回判据，否则抛那条带诊断的错', () => {
  const options = { appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW };
  assert.equal(assertOnTargetPage(pageUrl(SOURCE_ID, SOURCE_VIEW), options).onTarget, true);
  assert.throws(() => assertOnTargetPage(pageUrl(INQUIRY_ID, INQUIRY_VIEW), options),
    (error) => /not on authorized table\/view/u.test(error.message)
      && new RegExp(INQUIRY_ID, 'u').test(error.message));
});

// --- 二、真行为：用假代理跑一次落位 -----------------------------------------

test('ensureTargetPage：这一页停在别张表上时，进场自己导航回源表（导航在复核之前）', async () => {
  const fake = await fakeProxy({
    pages: [{ targetId: 'page-1', type: 'page', url: pageUrl(INQUIRY_ID, INQUIRY_VIEW) }],
  });
  try {
    const result = await ensureTargetPage(
      { proxy: fake.proxy, appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW },
      { wait: { attempts: 3, delayMs: 5 } },
    );

    assert.equal(result.navigated, true);
    const navigations = fake.requests.filter((entry) => entry.startsWith('GET /navigate'));
    assert.equal(navigations.length, 1, '恰好导航一次');
    const navigated = new URL(new URL(navigations[0].split(' ')[1], 'http://127.0.0.1').searchParams.get('url'));
    assert.equal(navigated.searchParams.get('table'), SOURCE_ID);
    assert.equal(navigated.searchParams.get('view'), SOURCE_VIEW);

    // 顺序：先落位、后复核。删掉导航（或把它挪到复核之后），这一条必红。
    assert.ok(fake.requests.findIndex((entry) => entry.startsWith('GET /navigate'))
      < fake.requests.findIndex((entry) => entry.startsWith('POST /eval')),
    '落位必须发生在探页面模型之前');
  } finally {
    await fake.close();
  }
});

test('ensureTargetPage：已经在授权的 table/view 上时一个导航请求都不发，但仍等模型加载', async () => {
  const fake = await fakeProxy({
    pages: [{ targetId: 'page-1', type: 'page', url: pageUrl(SOURCE_ID, SOURCE_VIEW) }],
  });
  try {
    const result = await ensureTargetPage(
      { proxy: fake.proxy, appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW },
      { wait: { attempts: 3, delayMs: 5 } },
    );
    assert.equal(result.navigated, false);
    assert.equal(result.wanted, null);
    assert.equal(fake.requests.filter((entry) => entry.includes('/navigate')).length, 0);
    // 「URL 对」不等于「表已经加载出来」：上一个阶段可能刚导航回来。
    // 这里必须仍然等一次，否则同一个「还在加载」会换个面目报在 inspectTarget 里。
    assert.equal(fake.requests.filter((entry) => entry.startsWith('POST /eval')).length, 1);
  } finally {
    await fake.close();
  }
});

test('ensureTargetPage：导航之后表一直没加载出来时当场炸，并报出等了几次', async () => {
  const fake = await fakeProxy({
    pages: [{ targetId: 'page-1', type: 'page', url: pageUrl(INQUIRY_ID, INQUIRY_VIEW) }],
    evalResult: () => 'table-not-loaded',
  });
  try {
    await assert.rejects(
      ensureTargetPage(
        { proxy: fake.proxy, appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW },
        { wait: { attempts: 3, delayMs: 5 } },
      ),
      (error) => /一直没加载出表/u.test(error.message)
        && /等了 3 次/u.test(error.message)
        && new RegExp(SOURCE_ID, 'u').test(error.message),
    );
  } finally {
    await fake.close();
  }
});

test('ensureTargetPage：base 上一个页面都没有时，报错要带上 /targets 的实况', async () => {
  const fake = await fakeProxy({ pages: [{ targetId: 'p1', type: 'page', url: `${ORIGIN}/base/AnotherToken` }] });
  try {
    await assert.rejects(
      ensureTargetPage({ proxy: fake.proxy, appToken: APP_TOKEN, tableId: SOURCE_ID, viewId: SOURCE_VIEW }),
      (error) => /got 0/u.test(error.message) && /p1/u.test(error.message),
    );
  } finally {
    await fake.close();
  }
});

// --- 三、接线（改回去就红） --------------------------------------------------

test('接线：push 的 main 先落位、再复核（删掉 ensureTargetPage 这一行必红）', () => {
  const source = readFileSync(path.join(SCRIPTS_DIR, 'run-daily-report.mjs'), 'utf8');
  const ensureAt = source.indexOf('await ensureTargetPage(args);');
  const inspectAt = source.indexOf('const target = await inspectTarget(args);');
  assert.ok(ensureAt > 0, 'main 里必须有落位这一步');
  assert.ok(inspectAt > 0, '复核那一步不该被删掉');
  assert.ok(ensureAt < inspectAt, '落位必须在复核之前 —— 顺序反了就等于没修');
  assert.match(source, /\/navigate\?target=/u, 'push 自己导航，不许只留断言');
});

test('接线：readback 的归位写在 finally 里，且失败时自己吞掉（不能顶掉原始错误）', () => {
  const source = readFileSync(path.join(SCRIPTS_DIR, 'readback-daily-report.mjs'), 'utf8');
  assert.match(source, /\}\s*finally\s*\{[\s\S]{0,1500}result\.page\.leftOn/u,
    '归位必须在 finally 里：写在成功路径末尾，一失败就不执行（2026-09-20 就是这条）');
  assert.match(source, /\[leaveOn\] 归位失败/u, '归位失败要出声');
  assert.match(source, /页面\*\*没有\*\*归位/u, '最后那行总结不许把没归位说成归位');
});

test('接线：夹具用的 id 与 runtime/feishu-targets.mjs 同源（配置改了就当场红）', () => {
  const config = readFileSync(path.join(REPO_ROOT, 'runtime', 'feishu-targets.mjs'), 'utf8');
  // 只对**配置里登记过**的那几个：询单表的视图 id 不在配置里（当日取值来自日志证据），
  // 硬把它塞进这份清单会让这条守卫在配置改动时误报。
  for (const id of [APP_TOKEN, SOURCE_ID, SOURCE_VIEW, INQUIRY_ID]) {
    assert.ok(config.includes(id), `${id} 已不在配置里 —— 配置改了，这批用例的夹具要跟着改`);
  }
});
