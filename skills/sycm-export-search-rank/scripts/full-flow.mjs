const SYCM_ORIGIN = "https://sycm.taobao.com";
const ALLOWED_PATHS = new Set([
  "/portal/home.htm",
  "/mc/free/market_rank",
  "/mc/free/search_rank",
]);

export const HOME_URL = `${SYCM_ORIGIN}/portal/home.htm`;
export const MARKET_SELECTOR = 'a.top-name-wrapper[href*="/mc/free/market_rank"]';
export const SEARCH_RANK_SELECTOR = 'li.menuItem .nameWrapper[data-spm="d13860"]';

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
  clickAt,
  waitForPath,
  guardSession,
}) {
  await navigate(HOME_URL);
  let state = await waitForPath("/portal/home.htm");
  guardSession(state);
  assertState(state, "/portal/home.htm");

  await clickAt(MARKET_SELECTOR);
  state = await waitForPath("/mc/free/market_rank", { cateId, category });
  guardSession(state);
  assertState(state, "/mc/free/market_rank", cateId, category);

  await clickAt(SEARCH_RANK_SELECTOR);
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
