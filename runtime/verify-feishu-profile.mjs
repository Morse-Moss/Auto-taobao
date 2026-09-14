#!/usr/bin/env node
// 只读验证：核对飞书目标 profile 的「配置 → 真实 base」是否对得上。
//
// 为什么需要它：搬迁到新租户后，「代码里写的那串 id 究竟落在哪个 base 的哪张表上」
// 只能靠运行时实测回答。把源码 grep 一遍说明不了任何事——那只能证明字面量长什么样。
//
// 只发 GET（外加一次 auth POST 换 token），不发任何写请求，所以可以随时对生产 base 跑；
// 换 DEFAULT_PROFILE 之后也可以拿它当回滚前的核对（两个租户同时查、逐表对比字段签名）。
//
// 用法：
//   node runtime/verify-feishu-profile.mjs                  # 两个 profile 都查，并做结构对比
//   node runtime/verify-feishu-profile.mjs --profile kcne   # 只查一个（接受别名）
//   node runtime/verify-feishu-profile.mjs --json           # 只输出 JSON，供其它程序消费
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_PROFILE,
  loadFeishuCredentials,
  PROFILES,
  PROFILE_ENV_VAR,
  STABLE_TABLE_KEYS,
  resolveProfileName,
} from './feishu-targets.mjs';
import { FAQ_MASTER_TABLE_NAME, latestWeeklyTable, parseWeeklyTable } from './weekly-table-target.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const READ_ONLY_NOTE = '只读：除换取 tenant_access_token 外不发任何写请求';

export function shortDigest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// 字段签名 = 「字段名:类型」排序后取摘要。名字和类型都要算进去，副本最容易在这两处缩水。
export function fieldSignature(fieldItems) {
  const items = fieldItems ?? [];
  return {
    fieldCount: items.length,
    fieldNames: items.map((field) => field.field_name),
    signature: shortDigest(items.map((field) => `${field.field_name}:${field.type}`).sort().join('\n')),
  };
}

export function recordCountFrom(body) {
  const total = body?.data?.total;
  // 空值不是零：读不到 total 与「这张表 0 行」是两件不同的事，不要合并。
  return total === null || total === undefined ? null : total;
}

const TABLE_ID_PATTERN = /tbl[A-Za-z0-9]{8,}/gu;

// 公式(type 20)/lookup(type 19) 字段的表达式把表 id 写死在 property 里。
// 复制 base 时这些引用**未必**被一起改写——若仍指向另一个 base 的表，字段会算出空值/报错，
// 而单看「字段名与类型是否一致」是发现不了的（类型照样是 20/19）。
// 判据：表达式里出现的表 id 必须都属于**同一个 base**；不在其中的就是悬空引用。
export function danglingTableRefs(fieldItems, knownTableIds) {
  const known = new Set(knownTableIds ?? []);
  const dangling = [];
  for (const field of fieldItems ?? []) {
    const property = field?.property;
    if (property === null || property === undefined) continue;
    const refs = [...new Set(String(JSON.stringify(property)).match(TABLE_ID_PATTERN) ?? [])];
    for (const ref of refs) {
      if (!known.has(ref)) dangling.push({ field: field.field_name, type: field.type, ref });
    }
  }
  return dangling;
}

async function getJson(headers, path) {
  const response = await fetch(`${API_ROOT}${path}`, { headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function tenantToken(appId, appSecret) {
  const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await response.json().catch(() => ({}));
  if (body.code !== 0) throw new Error(`auth failed: ${body.code} ${body.msg}`);
  return body.tenant_access_token;
}

async function listTables(headers, baseToken) {
  const { body } = await getJson(headers, `/bitable/v1/apps/${baseToken}/tables?page_size=100`);
  if (body.code !== 0) throw new Error(`list tables failed: ${body.code} ${body.msg}`);
  return (body.data?.items ?? []).map((table) => ({ tableId: table.table_id, name: table.name }));
}

async function inspectTable(headers, baseToken, tableId, knownTableIds) {
  const [fields, records] = await Promise.all([
    getJson(headers, `/bitable/v1/apps/${baseToken}/tables/${tableId}/fields?page_size=200`),
    getJson(headers, `/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=1`),
  ]);
  const errors = [
    fields.body?.code !== 0 ? `fields ${fields.body.code} ${fields.body.msg}` : null,
    records.body?.code !== 0 ? `records ${records.body.code} ${records.body.msg}` : null,
  ].filter(Boolean);
  const items = fields.body?.data?.items ?? [];
  const dangling = danglingTableRefs(items, knownTableIds);
  if (dangling.length) {
    errors.push(`dangling table refs: ${dangling.map((d) => `${d.field}→${d.ref}`).join(', ')}`);
  }
  return {
    ok: errors.length === 0,
    ...fieldSignature(items),
    recordCount: recordCountFrom(records.body),
    danglingRefs: dangling,
    errors,
  };
}

async function inspectProfile(profileName) {
  const profile = PROFILES[profileName];
  const result = {
    profile: profileName,
    label: profile.label,
    host: profile.host,
    envFile: profile.envFile,
    baseToken: profile.competitorBase,
    keywordBaseToken: profile.keywordBase,
    writeVerified: profile.writeVerified,
    ok: false,
    errors: [],
  };

  let credentials;
  try {
    credentials = loadFeishuCredentials(profileName);
  } catch (error) {
    result.errors.push(`credentials: ${error.message}`);
    return result;
  }
  result.appId = credentials.appId;

  let headers;
  try {
    headers = {
      Authorization: `Bearer ${await tenantToken(credentials.appId, credentials.appSecret)}`,
      'Content-Type': 'application/json',
    };
  } catch (error) {
    result.errors.push(error.message);
    return result;
  }

  const app = await getJson(headers, `/bitable/v1/apps/${profile.competitorBase}`);
  if (app.body?.code !== 0) result.errors.push(`base ${app.body?.code} ${app.body?.msg}`);
  result.baseName = app.body?.data?.app?.name ?? null;

  let tables = [];
  try {
    tables = await listTables(headers, profile.competitorBase);
  } catch (error) {
    result.errors.push(error.message);
  }
  result.tableCount = tables.length;
  result.tableNames = tables.map((table) => table.name);

  result.stableTables = {};
  const knownTableIds = tables.map((table) => table.tableId);
  for (const key of STABLE_TABLE_KEYS) {
    const tableId = profile.tables[key];
    const tableName = tables.find((table) => table.tableId === tableId)?.name ?? null;
    const info = await inspectTable(headers, profile.competitorBase, tableId, knownTableIds);
    result.stableTables[key] = { tableId, tableName, ...info };
    if (!info.ok) result.errors.push(`${key}(${tableId}): ${info.errors.join('; ')}`);
  }
  result.danglingRefCount = Object.values(result.stableTables)
    .reduce((sum, table) => sum + (table.danglingRefs?.length ?? 0), 0);

  result.weeklyTables = {
    竞品: latestWeeklyTable(tables, '竞品')?.name ?? null,
    SKU: latestWeeklyTable(tables, 'SKU')?.name ?? null,
    问题库: latestWeeklyTable(tables, '问题库')?.name ?? null,
  };
  result.weeklyTableCount = tables.map(parseWeeklyTable).filter(Boolean).length;
  result.faqMasterTable = tables.find((table) => table.name === FAQ_MASTER_TABLE_NAME)?.tableId ?? null;

  result.keywordTables = await inspectKeywordBase(profile, headers);
  if (result.keywordTables.errors.length) {
    result.errors.push(`keyword base: ${result.keywordTables.errors.join('; ')}`);
  }

  // 应用对 base 的协作者身份：决定它能不能写（91403 的根因通常落在这里）。
  const members = await getJson(headers, `/drive/v1/permissions/${profile.competitorBase}/members?type=bitable`);
  result.shareMembers = members.body?.code === 0
    ? { status: members.status, count: (members.body?.data?.items ?? []).length }
    : { status: members.status, error: `${members.body?.code} ${members.body?.msg}` };

  result.ok = result.errors.length === 0;
  return result;
}

// 关键词库是**另一张独立的 base**（复制竞品 base 不会带上它），所以它有独立的 token，
// 也必须独立查：竞品 base 全绿完全不能证明词库那一串 token 指的是对的那张表。
// 判据与竞品 base 同一套：能读到名字、表数量、每张表的字段签名、行数，以及
// 公式/lookup 的跨表引用是否悬空（词库的分析表大量用公式引用同 base 内的表）。
async function inspectKeywordBase(profile, headers) {
  const baseToken = profile.keywordBase;
  const info = { baseToken, baseName: null, tableCount: 0, tables: [], danglingRefCount: 0, errors: [] };
  if (!baseToken) {
    info.errors.push('no keywordBase configured for this profile');
    return info;
  }

  const app = await getJson(headers, `/bitable/v1/apps/${baseToken}`);
  if (app.body?.code !== 0) info.errors.push(`keyword base ${app.body?.code} ${app.body?.msg}`);
  info.baseName = app.body?.data?.app?.name ?? null;

  let tables = [];
  try {
    tables = await listTables(headers, baseToken);
  } catch (error) {
    info.errors.push(`keyword tables: ${error.message}`);
  }
  info.tableCount = tables.length;
  const knownTableIds = tables.map((table) => table.tableId);
  for (const table of tables) {
    const tableInfo = await inspectTable(headers, baseToken, table.tableId, knownTableIds);
    info.tables.push({ tableId: table.tableId, name: table.name, ...tableInfo });
    info.danglingRefCount += tableInfo.danglingRefs?.length ?? 0;
    if (!tableInfo.ok) info.errors.push(`keyword ${table.name}(${table.tableId}): ${tableInfo.errors.join('; ')}`);
  }
  return info;
}

// 两个租户的词库副本逐表比字段签名（按表名配对，不比行数——行数随时间增长，
// 不是结构不变量；结构才是「副本有没有缩水」的判据）。
export function compareKeywordBases(profiles) {
  const names = Object.keys(profiles ?? {});
  if (names.length < 2) return [];
  const [leftName, rightName] = names;
  const byName = (side) => new Map((profiles?.[side]?.keywordTables?.tables ?? []).map((table) => [table.name, table]));
  const left = byName(leftName);
  const right = byName(rightName);
  const diffs = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const leftTable = left.get(name);
    const rightTable = right.get(name);
    if (!leftTable || !rightTable) {
      diffs.push({ name, verdict: 'ONLY_ONE_SIDE', [leftTable ? rightName : leftName]: 'missing' });
      continue;
    }
    if (leftTable.signature === rightTable.signature) continue;
    diffs.push({
      name,
      verdict: 'DIFFERENT',
      [leftName]: leftTable.signature,
      [rightName]: rightTable.signature,
      onlyLeft: leftTable.fieldNames.filter((field) => !rightTable.fieldNames.includes(field)),
      onlyRight: rightTable.fieldNames.filter((field) => !leftTable.fieldNames.includes(field)),
    });
  }
  return diffs;
}

export function compareStructures(profiles) {
  const names = Object.keys(profiles ?? {});
  if (names.length < 2) return [];
  const [leftName, rightName] = names;
  const diffs = [];
  for (const key of STABLE_TABLE_KEYS) {
    const left = profiles[leftName]?.stableTables?.[key];
    const right = profiles[rightName]?.stableTables?.[key];
    if (!left || !right) {
      diffs.push({ key, verdict: 'NOT_INSPECTED' });
      continue;
    }
    if (left.signature === right.signature) continue;
    diffs.push({
      key,
      verdict: 'DIFFERENT',
      [leftName]: left.signature,
      [rightName]: right.signature,
      onlyLeft: left.fieldNames.filter((name) => !right.fieldNames.includes(name)),
      onlyRight: right.fieldNames.filter((name) => !left.fieldNames.includes(name)),
    });
  }
  return diffs;
}

export function render(report) {
  const lines = [];
  for (const [name, info] of Object.entries(report.profiles)) {
    lines.push(`── ${name}  ${info.label}`);
    lines.push(`   host           ${info.host}`);
    lines.push(`   env file       ${info.envFile}   app ${info.appId ?? '(未加载)'}`);
    lines.push(`   base           ${info.baseToken}   ${info.baseName ?? '(读不到名称)'}`);
    lines.push(`   writeVerified  ${info.writeVerified}   (配置里的声明值，不是本次实测)`);
    lines.push(`   表数量         ${info.tableCount ?? '-'}`);
    for (const key of STABLE_TABLE_KEYS) {
      const table = info.stableTables?.[key] ?? {};
      lines.push(
        `   · ${String(key).padEnd(15)} ${table.tableId ?? '-'}  ${table.tableName ?? '(该 id 不在表清单里)'}`
        + `  字段 ${table.fieldCount ?? '-'}  记录 ${table.recordCount ?? '-'}  sig ${table.signature ?? '-'}`,
      );
      for (const dangling of table.danglingRefs ?? []) {
        lines.push(`       悬空引用: 字段「${dangling.field}」(type=${dangling.type}) → ${dangling.ref}（不属于本 base）`);
      }
    }
    lines.push(`   悬空表引用     ${info.danglingRefCount ?? 0}`);
    const keyword = info.keywordTables;
    if (keyword) {
      lines.push(`   keyword base   ${keyword.baseToken ?? '-'}   ${keyword.baseName ?? '(读不到名称)'}   ${keyword.tableCount ?? '-'} 张表`);
      for (const table of keyword.tables ?? []) {
        lines.push(
          `   · 词库 ${String(table.name ?? '-').padEnd(22)} ${table.tableId ?? '-'}`
          + `  字段 ${table.fieldCount ?? '-'}  记录 ${table.recordCount ?? '-'}  sig ${table.signature ?? '-'}`,
        );
        for (const dangling of table.danglingRefs ?? []) {
          lines.push(`       悬空引用: 字段「${dangling.field}」(type=${dangling.type}) → ${dangling.ref}（不属于本 base）`);
        }
      }
      lines.push(`   词库悬空引用   ${keyword.danglingRefCount ?? 0}`);
    }
    lines.push(`   最新周表       竞品 ${info.weeklyTables?.竞品 ?? '-'} | SKU ${info.weeklyTables?.SKU ?? '-'} | 问题库 ${info.weeklyTables?.问题库 ?? '-'}`);
    lines.push(`   周表数量       ${info.weeklyTableCount ?? '-'}`);
    lines.push(`   问题主库       ${info.faqMasterTable ?? '-'}`);
    const members = info.shareMembers;
    lines.push(
      `   协作者接口     ${members
        ? members.error
          ? `拒绝 ${members.error}`
          : `OK（${members.count} 个成员）`
        : '-'}   [仅供参考：列成员需要更宽的 drive 权限，被拒不影响读写]`,
    );
    lines.push(`   结论           ${info.ok ? 'OK' : `有错误 → ${info.errors.join(' | ')}`}`);
    lines.push('');
  }

  if (Object.keys(report.profiles).length > 1) {
    if (report.structuralDiffs.length === 0) {
      lines.push(`结构对比：${STABLE_TABLE_KEYS.length} 张稳定表的字段签名逐一相同。`);
    } else {
      for (const diff of report.structuralDiffs) {
        lines.push(`结构对比：${diff.key} ${diff.verdict} ${JSON.stringify(diff)}`);
      }
    }
    // 词库是另一张 base，单独给一行结论：竞品侧一致不代表词库侧一致。
    // 「没查到表」与「查到了且一致」必须分开说——空结果不等于相同结论。
    const keywordDiffs = report.keywordDiffs ?? [];
    const withKeyword = Object.values(report.profiles).filter((info) => info.keywordTables);
    const tableCounts = withKeyword.map((info) => (info.keywordTables.tables ?? []).length);
    if (withKeyword.length < Object.keys(report.profiles).length || tableCounts.some((count) => count === 0)) {
      lines.push('词库对比：跳过（至少一侧没查到词库的表）。');
    } else if (keywordDiffs.length === 0) {
      lines.push(`词库对比：两侧副本逐表字段签名相同（各 ${tableCounts[0]} 张表）。`);
    } else {
      for (const diff of keywordDiffs) {
        lines.push(`词库对比：${diff.name} ${diff.verdict} ${JSON.stringify(diff)}`);
      }
    }
  } else {
    lines.push('结构对比：跳过（只查了一个 profile）。');
  }
  lines.push(`(mode=${report.mode}; ${report.note})`);
  return lines.join('\n');
}

export async function verifyFeishuProfiles({ profiles = null, env = process.env } = {}) {
  const names = profiles ?? Object.keys(PROFILES);
  const inspected = {};
  for (const name of names) {
    const resolved = resolveProfileName(name);
    inspected[resolved] = await inspectProfile(resolved);
  }
  return {
    mode: 'READ_ONLY',
    note: READ_ONLY_NOTE,
    activeProfile: env?.[PROFILE_ENV_VAR] ?? null,
    defaultProfile: DEFAULT_PROFILE,
    profiles: inspected,
    structuralDiffs: compareStructures(inspected),
    keywordDiffs: compareKeywordBases(inspected),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const jsonOnly = argv.includes('--json');
  const index = argv.indexOf('--profile');
  const requested = index >= 0 ? argv[index + 1] : null;
  const report = await verifyFeishuProfiles({ profiles: requested ? [requested] : null });
  console.log(jsonOnly ? JSON.stringify(report, null, 2) : render(report));
  return report;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
