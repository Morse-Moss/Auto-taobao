import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertAllowedSycmUrl,
  enterSearchRankFromHome,
  resolveSycmTarget,
  selectSycmTarget,
  waitForVisibleOption,
  waitForSycmPath,
} from "./full-flow.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

test("accepts only the approved SYCM workflow routes", () => {
  assert.equal(
    assertAllowedSycmUrl("https://sycm.taobao.com/portal/home.htm").pathname,
    "/portal/home.htm",
  );
  assert.equal(
    assertAllowedSycmUrl("https://sycm.taobao.com/mc/free/search_rank?cateId=50002411").pathname,
    "/mc/free/search_rank",
  );
  assert.throws(() => assertAllowedSycmUrl("C:\\Users\\Administrator"), /not an allowed SYCM URL/u);
  assert.throws(() => assertAllowedSycmUrl("file:///C:/Users/Administrator/"), /not an allowed SYCM URL/u);
  assert.throws(() => assertAllowedSycmUrl("https://example.com/portal/home.htm"), /not an allowed SYCM URL/u);
});

test("rejects an explicit target outside SYCM", () => {
  const targets = [
    { targetId: "external", type: "page", url: "https://example.com/" },
    { targetId: "sycm", type: "page", url: "https://sycm.taobao.com/portal/home.htm" },
  ];

  assert.throws(() => selectSycmTarget(targets, "external", true), /does not belong to SYCM/u);
  assert.equal(selectSycmTarget(targets, "sycm", true).targetId, "sycm");
});

test("current-page mode requires a search-ranking tab", () => {
  const targets = [
    { targetId: "home", type: "page", url: "https://sycm.taobao.com/portal/home.htm" },
    { targetId: "rank", type: "page", url: "https://sycm.taobao.com/mc/free/search_rank?cateId=50002411" },
  ];

  assert.equal(selectSycmTarget(targets, "", false).targetId, "rank");
  assert.throws(() => selectSycmTarget(targets.slice(0, 1), "", false), /search-ranking tab/u);
});

test("runs only the approved home to search-ranking transition order", async () => {
  const actions = [];
  const states = [
    { url: "https://sycm.taobao.com/portal/home.htm", cateId: "", categoryTitle: "" },
    { url: "https://sycm.taobao.com/mc/free/market_rank?cateId=50002411", cateId: "50002411", categoryTitle: "普通浴缸" },
    { url: "https://sycm.taobao.com/mc/free/search_rank?cateId=50002411", cateId: "50002411", categoryTitle: "普通浴缸" },
  ];
  const result = await enterSearchRankFromHome({
    cateId: "50002411",
    category: "普通浴缸",
    navigate: async (url) => actions.push(["navigate", url]),
    clickAt: async (selector) => actions.push(["click", selector]),
    waitForPath: async (path) => {
      actions.push(["wait", path]);
      return states.shift();
    },
    guardSession: () => {},
  });

  assert.match(result.url, /\/mc\/free\/search_rank/u);
  assert.deepEqual(actions.map(([action]) => action), ["navigate", "wait", "click", "wait", "click", "wait"]);
});

test("does not click anything after home navigation fails", async () => {
  const clicks = [];
  await assert.rejects(
    enterSearchRankFromHome({
      cateId: "50002411",
      navigate: async () => {},
      clickAt: async (selector) => clicks.push(selector),
      waitForPath: async () => { throw new Error("home did not load"); },
      guardSession: () => {},
    }),
    /home did not load/u,
  );
  assert.deepEqual(clicks, []);
});

test("stops before search-ranking when market category is wrong", async () => {
  const clicks = [];
  const states = [
    { url: "https://sycm.taobao.com/portal/home.htm", cateId: "" },
    { url: "https://sycm.taobao.com/mc/free/market_rank?cateId=wrong", cateId: "wrong" },
  ];
  await assert.rejects(
    enterSearchRankFromHome({
      cateId: "50002411",
      navigate: async () => {},
      clickAt: async (selector) => clicks.push(selector),
      waitForPath: async () => states.shift(),
      guardSession: () => {},
    }),
    /category does not match/u,
  );
  assert.equal(clicks.length, 1);
});

test("stops when the visible category is not ordinary bathtub", async () => {
  const states = [
    { url: "https://sycm.taobao.com/portal/home.htm", cateId: "", categoryTitle: "" },
    { url: "https://sycm.taobao.com/mc/free/market_rank?cateId=50002411", cateId: "50002411", categoryTitle: "按摩浴缸" },
  ];
  await assert.rejects(
    enterSearchRankFromHome({
      cateId: "50002411",
      category: "普通浴缸",
      navigate: async () => {},
      clickAt: async () => {},
      waitForPath: async () => states.shift(),
      guardSession: () => {},
    }),
    /visible category does not match/u,
  );
});

test("official exporter exposes the from-home workflow", () => {
  const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, "export-search-rank.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--from-home/u);
});

test("route waiting stops immediately on a login or risk handoff", async () => {
  let inspections = 0;
  await assert.rejects(
    waitForSycmPath({
      expectedPath: "/portal/home.htm",
      inspect: async () => {
        inspections += 1;
        return { url: "https://sycm.taobao.com/custom/login.htm", loginLike: true };
      },
      guardSession: (state) => {
        if (state.loginLike) throw new Error("HUMAN_REQUIRED: login");
      },
      sleep: async () => {},
      timeoutMs: 100,
    }),
    /HUMAN_REQUIRED/u,
  );
  assert.equal(inspections, 1);
});

test("from-home mode creates an allowlisted SYCM tab when none exists", async () => {
  let created = 0;
  const target = await resolveSycmTarget({
    targets: [{ targetId: "external", type: "page", url: "https://example.com/" }],
    explicitTarget: "",
    fromHome: true,
    createHomeTab: async () => {
      created += 1;
      return { targetId: "created" };
    },
    listTargets: async () => [
      { targetId: "created", type: "page", url: "https://sycm.taobao.com/portal/home.htm" },
    ],
  });
  assert.equal(target.targetId, "created");
  assert.equal(created, 1);
});

test("current-page mode never creates a missing tab", async () => {
  let created = 0;
  await assert.rejects(
    resolveSycmTarget({
      targets: [],
      explicitTarget: "",
      fromHome: false,
      createHomeTab: async () => { created += 1; },
    }),
    /search-ranking tab/u,
  );
  assert.equal(created, 0);
});

test("route waiting ignores an intermediate page until ordinary bathtub is stable", async () => {
  const states = [
    { url: "https://sycm.taobao.com/mc/free/market_rank", cateId: "", categoryTitle: "" },
    { url: "https://sycm.taobao.com/mc/free/market_rank?cateId=50002411", cateId: "50002411", categoryTitle: "普通浴缸" },
  ];
  const result = await waitForSycmPath({
    expectedPath: "/mc/free/market_rank",
    cateId: "50002411",
    category: "普通浴缸",
    inspect: async () => states.shift(),
    guardSession: () => {},
    sleep: async () => {},
    timeoutMs: 100,
  });
  assert.equal(result.cateId, "50002411");
  assert.equal(states.length, 0);
});

test("search-ranking route waits for its data table before returning", async () => {
  const states = [
    { url: "https://sycm.taobao.com/mc/free/search_rank?cateId=50002411", cateId: "50002411", categoryTitle: "普通浴缸", hasDataTable: false, rowCount: 0 },
    { url: "https://sycm.taobao.com/mc/free/search_rank?cateId=50002411", cateId: "50002411", categoryTitle: "普通浴缸", hasDataTable: true, rowCount: 50 },
  ];
  const result = await waitForSycmPath({
    expectedPath: "/mc/free/search_rank",
    cateId: "50002411",
    category: "普通浴缸",
    requireDataTable: true,
    inspect: async () => states.shift(),
    guardSession: () => {},
    sleep: async () => {},
    timeoutMs: 100,
  });
  assert.equal(result.rowCount, 50);
});

test("page-size selection waits for the 50 option to become visible", async () => {
  let reads = 0;
  await waitForVisibleOption({
    readOption: async () => { reads += 1; return reads === 2; },
    sleep: async () => {},
    timeoutMs: 100,
  });
  assert.equal(reads, 2);
});
