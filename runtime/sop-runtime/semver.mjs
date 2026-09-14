// 确定性 semver 子集：只服务于 Skill manifest 的版本与依赖区间校验。
// 不引入第三方依赖，纯函数，可重复执行结果一致。
// 支持：精确版本、^、~、>=、<=、>、<、=、* 、区间并用（空格/逗号）、|| 或。

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const match = VERSION_RE.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    build: match[5] ?? null,
    raw: value,
  };
}

export function isValidVersion(raw) {
  return parseVersion(raw) !== null;
}

function comparePrerelease(a, b) {
  // 无 prerelease 的版本更高（release > prerelease）。
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = a.split('.');
  const right = b.split('.');
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (ln !== rn) {
      // 数字标识符优先级低于字母标识符。
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

// 返回 -1 / 0 / 1；任一侧非法版本抛错，避免静默比较。
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`invalid version compare: ${a} vs ${b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function lowerBound(version) {
  return { version, inclusive: true };
}

function caretUpper(p) {
  if (p.major > 0) return `${p.major + 1}.0.0`;
  if (p.minor > 0) return `0.${p.minor + 1}.0`;
  return `0.0.${p.patch + 1}`;
}

function tildeUpper(p) {
  if (p.minor !== undefined && p.minor !== null && p.patch !== null) return `${p.major}.${p.minor + 1}.0`;
  if (p.minor !== null) return `${p.major}.${p.minor + 1}.0`;
  return `${p.major + 1}.0.0`;
}

function parsePartial(raw) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(raw).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? null : Number(match[2]),
    patch: match[3] === undefined ? null : Number(match[3]),
  };
}

// 单个比较器 -> { test(version) }
function parseComparator(token) {
  const raw = String(token).trim();
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') return { test: () => true, allowsPrerelease: true };

  let op = '';
  let body = raw;
  for (const candidate of ['>=', '<=', '>', '<', '=', '^', '~']) {
    if (raw.startsWith(candidate)) {
      op = candidate;
      body = raw.slice(candidate.length);
      break;
    }
  }

  const partial = parsePartial(body);
  const exact = parseVersion(body);

  if (op === '' && exact) {
    return { test: (v) => compareVersions(v, exact.raw) === 0, allowsPrerelease: Boolean(exact.prerelease) };
  }

  if (op === '' && partial) {
    // 缺省裸版本：1 -> >=1.0.0 <2.0.0；1.2 -> >=1.2.0 <1.3.0
    const lower = `${partial.major}.${partial.minor ?? 0}.${partial.patch ?? 0}`;
    const upper = partial.minor === null ? `${partial.major + 1}.0.0` : `${partial.major}.${partial.minor + 1}.0`;
    return {
      test: (v) => compareVersions(v, lower) >= 0 && compareVersions(v, upper) < 0,
      allowsPrerelease: false,
    };
  }

  if (op === '^') {
    if (!exact) return null;
    const upper = caretUpper(exact);
    return {
      test: (v) => compareVersions(v, exact.raw) >= 0 && compareVersions(v, upper) < 0,
      allowsPrerelease: Boolean(exact.prerelease),
    };
  }

  if (op === '~') {
    const lower = partial
      ? `${partial.major}.${partial.minor ?? 0}.${partial.patch ?? 0}`
      : null;
    if (!lower) return null;
    const upper = partial.minor === null ? `${partial.major + 1}.0.0` : `${partial.major}.${partial.minor + 1}.0`;
    return {
      test: (v) => compareVersions(v, lower) >= 0 && compareVersions(v, upper) < 0,
      allowsPrerelease: Boolean(exact?.prerelease),
    };
  }

  if (!exact) return null;
  switch (op) {
    case '>=':
      return { test: (v) => compareVersions(v, exact.raw) >= 0, allowsPrerelease: Boolean(exact.prerelease) };
    case '<=':
      return { test: (v) => compareVersions(v, exact.raw) <= 0, allowsPrerelease: Boolean(exact.prerelease) };
    case '>':
      return { test: (v) => compareVersions(v, exact.raw) > 0, allowsPrerelease: Boolean(exact.prerelease) };
    case '<':
      return { test: (v) => compareVersions(v, exact.raw) < 0, allowsPrerelease: Boolean(exact.prerelease) };
    case '=':
      return { test: (v) => compareVersions(v, exact.raw) === 0, allowsPrerelease: Boolean(exact.prerelease) };
    default:
      return null;
  }
}

export function isValidRange(range) {
  if (typeof range !== 'string') return false;
  return parseRange(range) !== null;
}

function parseRange(range) {
  const groups = String(range)
    .split('||')
    .map((group) => group.trim().split(/[\s,]+/).filter(Boolean));
  const parsed = [];
  for (const group of groups) {
    const comparators = [];
    for (const token of group) {
      const comparator = parseComparator(token);
      if (!comparator) return null;
      comparators.push(comparator);
    }
    parsed.push(comparators.length ? comparators : [{ test: () => true, allowsPrerelease: true }]);
  }
  return parsed;
}

// version 是否满足 range。非法 range 抛错（fail-closed，不做静默放行）。
export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`invalid version: ${version}`);
  const groups = parseRange(range);
  if (groups === null) throw new Error(`invalid range: ${range}`);
  for (const comparators of groups) {
    const allowsPrerelease = comparators.some((c) => c.allowsPrerelease);
    if (!allowsPrerelease && parsed.prerelease) continue;
    if (comparators.every((c) => c.test(parsed.raw))) return true;
  }
  return false;
}

// 从候选版本中选出满足 range 的最高版本；无匹配返回 null。
export function maxSatisfying(versions, range) {
  const matches = versions.filter((v) => {
    try {
      return satisfies(v, range);
    } catch {
      return false;
    }
  });
  if (!matches.length) return null;
  return matches.reduce((best, current) => (compareVersions(current, best) > 0 ? current : best));
}
