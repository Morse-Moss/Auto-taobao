const SYCM_ORIGIN = "https://sycm.taobao.com";
const ALLOWED_PATHS = new Set([
  "/portal/home.htm",
  "/mc/free/market_rank",
  "/mc/free/search_rank",
]);

export const HOME_URL = `${SYCM_ORIGIN}/portal/home.htm`;
export const MARKET_SELECTOR = 'a.top-name-wrapper[href*="/mc/free/market_rank"]';
export const SEARCH_RANK_SELECTOR = 'li.menuItem .nameWrapper[data-spm="d13860"]';
const DAY_MS = 24 * 60 * 60 * 1000;
export const PERIOD_SELECTED_CLASS_PATTERN = /(^|[-_\s])(active|selected|checked)(?:$|[-_\s])|\bant-btn-primary\b/iu;

export function isSelectedPeriodOption(states) {
  return Array.isArray(states) && states.some((state) =>
    state?.ariaSelected === "true" ||
    state?.ariaPressed === "true" ||
    state?.ariaChecked === "true" ||
    PERIOD_SELECTED_CLASS_PATTERN.test(String(state?.className || ""))
  );
}

export function parseReportingWindow(value) {
  const dates = Array.from(String(value || "").matchAll(/\d{4}-\d{2}-\d{2}/gu), (match) => match[0]);
  if (!dates.length) return null;
  const startDate = dates[0];
  const endDate = dates.at(-1);
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const dayCount = Math.round((endMs - startMs) / DAY_MS) + 1;
  return {
    startDate,
    endDate,
    dayCount,
    dateRange: startDate === endDate ? startDate : `${startDate} ~ ${endDate}`,
  };
}

function verifiedSevenDayState(state) {
  const option = state?.periodOptions?.find((item) => item.label === "7天");
  const reportingWindow = parseReportingWindow(state?.currentDate);
  if (!option?.selected || reportingWindow?.dayCount !== 7) return null;
  return { state, period: "7天", ...reportingWindow };
}

export async function ensureSevenDayPeriod({
  inspect,
  clickPeriod,
  guardPage,
  sleep,
  timeoutMs = 15000,
}) {
  let state = await inspect();
  guardPage(state);
  const verified = verifiedSevenDayState(state);
  if (verified) return verified;
  if (!state.periodOptions?.some((item) => item.label === "7天")) {
    throw new Error("Could not find the 7-day reporting period option");
  }
  await clickPeriod("7天");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    state = await inspect();
    guardPage(state);
    const next = verifiedSevenDayState(state);
    if (next) return next;
    await sleep(250);
  }
  throw new Error("Could not verify selected 7-day reporting period");
}

export function assertAllowedSycmUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === SYCM_ORIGIN && ALLOWED_PATHS.has(url.pathname)) return url;
  } catch {
    // Fall through to the single fail-closed error below.
  }
  throw new Error(`Value is not an allowed SYCM URL: ${value}`);
}

function isSycmPage(target) {
  if (target?.type !== "page" || !target.targetId) return false;
  try {
    return new URL(target.url).origin === SYCM_ORIGIN;
  } catch {
    return false;
  }
}

export function selectSycmTarget(targets, explicitTarget, fromHome) {
  const pages = Array.isArray(targets) ? targets.filter(isSycmPage) : [];
  if (explicitTarget) {
    const selected = targets.find((target) => target?.targetId === explicitTarget);
    if (!selected || !isSycmPage(selected)) throw new Error("Explicit target does not belong to SYCM");
    return selected;
  }
  if (fromHome) {
    const selected = pages.find((target) => /\/portal\/home\.htm/u.test(target.url)) || pages[0];
    if (!selected) throw new Error("No SYCM tab is available");
    return selected;
  }
  const rankPage = pages.find((target) => /\/mc\/free\/search_rank/u.test(target.url));
  if (!rankPage) throw new Error("No SYCM search-ranking tab is available");
  return rankPage;
}

export async function rediscoverSycmTarget({ expectedTarget, listTargets }) {
  const targets = await listTargets();
  try {
    return selectSycmTarget(targets, expectedTarget, true);
  } catch {
    throw new Error("The expected SYCM target is no longer available");
  }
}

export async function resolveSycmTarget({
  targets,
  explicitTarget,
  fromHome,
  createHomeTab,
  listTargets,
}) {
  try {
    return selectSycmTarget(targets, explicitTarget, fromHome);
  } catch (error) {
    if (!fromHome || explicitTarget) throw error;
    const created = await createHomeTab();
    if (!created?.targetId) throw new Error("SYCM tab creation returned no target id");
    const refreshedTargets = await listTargets();
    return selectSycmTarget(refreshedTargets, created.targetId, true);
  }
}

function assertState(state, expectedPath, cateId = "", category = "") {
  const url = assertAllowedSycmUrl(state?.url || "");
  if (url.pathname !== expectedPath) throw new Error(`SYCM page did not reach ${expectedPath}`);
  if (cateId && state.cateId !== cateId) {
    throw new Error(`SYCM category does not match: expected ${cateId}, got ${state.cateId || "empty"}`);
  }
  if (category && !String(state.categoryTitle || "").includes(category)) {
    throw new Error(`SYCM visible category does not match: expected ${category}, got ${state.categoryTitle || "empty"}`);
  }
  return state;
}

export async function enterSearchRankFromHome({
  cateId,
  category,
  navigate,
  waitForSelector,
  click,
  waitForPath,
  guardSession,
}) {
  await navigate(HOME_URL);
  let state = await waitForPath("/portal/home.htm");
  guardSession(state);
  assertState(state, "/portal/home.htm");

  await waitForSelector(MARKET_SELECTOR);
  await click(MARKET_SELECTOR);
  state = await waitForPath("/mc/free/market_rank", { cateId, category });
  guardSession(state);
  assertState(state, "/mc/free/market_rank", cateId, category);

  await waitForSelector(SEARCH_RANK_SELECTOR);
  await click(SEARCH_RANK_SELECTOR);
  state = await waitForPath("/mc/free/search_rank", { cateId, category, requireDataTable: true });
  guardSession(state);
  return assertState(state, "/mc/free/search_rank", cateId, category);
}

export async function waitForSycmPath({
  expectedPath,
  cateId = "",
  category = "",
  requireDataTable = false,
  inspect,
  guardSession,
  sleep,
  timeoutMs = 15000,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspect();
    guardSession(state);
    try {
      const pathMatches = assertAllowedSycmUrl(state.url).pathname === expectedPath;
      const idMatches = !cateId || state.cateId === cateId;
      const titleMatches = !category || String(state.categoryTitle || "").includes(category);
      const tableReady = !requireDataTable || (state.hasDataTable && state.rowCount > 0);
      if (pathMatches && idMatches && titleMatches && tableReady) return state;
    } catch {
      // Keep waiting only for non-sensitive intermediate navigation pages.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${expectedPath}`);
}

export async function waitForVisibleOption({
  readOption,
  sleep,
  timeoutMs = 10000,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await readOption()) return true;
    await sleep(250);
  }
  throw new Error("Timed out waiting for visible page-size option 50");
}
