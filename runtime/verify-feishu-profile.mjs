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

async function inspectTable(headers, baseToken, tableId) {
  const [fields, records] = await Promise.all([
    getJson(headers, `/bitable/v1/apps/${baseToken}/tables/${tableId}/fields?page_size=200`),
    getJson(headers, `/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=1`),
  ]);
  const errors = [
    fields.body?.code !== 0 ? `fields ${fields.body.code} ${fields.body.msg}` : null,
    records.body?.code !== 0 ? `records ${records.body.code} ${records.body.msg}` : null,
  ].filter(Boolean);
  return {
    ok: errors.length === 0,
    ...fieldSignature(fields.body?.data?.items),
    recordCount: recordCountFrom(records.body),
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
  for (const key of STABLE_TABLE_KEYS) {
    const tableId = profile.tables[key];
    const tableName = tables.find((table) => table.tableId === tableId)?.name ?? null;
    const info = await inspectTable(headers, profile.competitorBase, tableId);
    result.stableTables[key] = { tableId, tableName, ...info };
    if (!info.ok) result.errors.push(`${key}(${tableId}): ${info.errors.join('; ')}`);
  }

  result.weeklyTables = {
    竞品: latestWeeklyTable(tables, '竞品')?.name ?? null,
    SKU: latestWeeklyTable(tables, 'SKU')?.name ?? null,
    问题库: latestWeeklyTable(tables, '问题库')?.name ?? null,
  };
  result.weeklyTableCount = tables.map(parseWeeklyTable).filter(Boolean).length;
  result.faqMasterTable = tables.find((table) => table.name === FAQ_MASTER_TABLE_NAME)?.tableId ?? null;

  // 应用对 base 的协作者身份：决定它能不能写（91403 的根因通常落在这里）。
  const members = await getJson(headers, `/drive/v1/permissions/${profile.competitorBase}/members?type=bitable`);
  result.shareMembers = members.body?.code === 0
    ? { status: members.status, count: (members.body?.data?.items ?? []).length }
    : { status: members.status, error: `${members.body?.code} ${members.body?.msg}` };

  result.ok = result.errors.length === 0;
  return result;
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
        : '-'}`,
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
