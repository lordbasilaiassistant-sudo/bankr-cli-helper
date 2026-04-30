// Tests concretizeRecipe with a seeded portfolio (so the resolveMaxAmount
// path actually exercises the address-filter / scam-shadow guard end to
// end) plus the /api/logs HTTP endpoint.

process.env.LOG_FILE = "0";

const assert = require("node:assert/strict");
const { test, before } = require("node:test");

const { __test } = require("..");
const {
  concretizeRecipe,
  seedPortfolioCache,
  WETH_ADDRESSES,
} = __test;

// --- concretizeRecipe with seeded portfolio --------------------------

test("concretizeRecipe(weth-unwrap max base) substitutes the canonical WETH balance", async () => {
  seedPortfolioCache({
    balances: {
      base: {
        nativeBalance: "0.05",
        nativeUsd: 150,
        tokenBalances: [
          // Real WETH at canonical address
          { symbol: "WETH", address: WETH_ADDRESSES.base.address, balance: "0.000164", usd: 0.5 },
        ],
      },
    },
  });
  const out = await concretizeRecipe("weth-unwrap max base", { bankrApiKey: "" });
  assert.equal(out, "weth-unwrap 0.000164 base", "max must be substituted with real balance");
});

test("concretizeRecipe: scam-shadow guard wins — picks canonical WETH not the imposter", async () => {
  seedPortfolioCache({
    balances: {
      base: {
        nativeBalance: "0.05",
        nativeUsd: 150,
        tokenBalances: [
          // Imposter listed FIRST claiming WETH symbol but at a fake address.
          { symbol: "WETH", address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", balance: "999", usd: 9999 },
          // Real WETH at canonical address.
          { symbol: "WETH", address: WETH_ADDRESSES.base.address, balance: "0.001", usd: 3 },
        ],
      },
    },
  });
  const out = await concretizeRecipe("weth-unwrap max base", { bankrApiKey: "" });
  assert.equal(out, "weth-unwrap 0.001 base", "must pick canonical address, NOT the scam-token's 999");
});

test("concretizeRecipe(weth-unwrap max base) throws if no WETH in portfolio", async () => {
  seedPortfolioCache({ balances: { base: { tokenBalances: [] } } });
  await assert.rejects(
    () => concretizeRecipe("weth-unwrap max base", { bankrApiKey: "" }),
    /no WETH balance/
  );
});

test("concretizeRecipe(weth-wrap max base) reserves gas and substitutes ETH minus reserve", async () => {
  seedPortfolioCache({
    balances: { base: { nativeBalance: "0.01", nativeUsd: 30, tokenBalances: [] } },
  });
  const out = await concretizeRecipe("weth-wrap max base", { bankrApiKey: "" });
  assert.match(out, /^weth-wrap 0\.0095 base$/, "max ETH minus 0.0005 gas reserve");
});

test("concretizeRecipe(weth-wrap max) refuses when ETH below the reserve", async () => {
  seedPortfolioCache({
    balances: { base: { nativeBalance: "0.0001", nativeUsd: 0.3, tokenBalances: [] } },
  });
  await assert.rejects(
    () => concretizeRecipe("weth-wrap max base", { bankrApiKey: "" }),
    /below the .* gas reserve/
  );
});

test("concretizeRecipe passes concrete amounts through unchanged", async () => {
  // Non-max recipe — no portfolio lookup needed, no substitution.
  const out = await concretizeRecipe("weth-unwrap 0.05 base", { bankrApiKey: "" });
  assert.equal(out, "weth-unwrap 0.05 base");
});

test("concretizeRecipe passes non-recipes through unchanged", async () => {
  const out = await concretizeRecipe("wallet transfer --to 0xabc --amount 1 --token USDC", { bankrApiKey: "" });
  assert.equal(out, "wallet transfer --to 0xabc --amount 1 --token USDC");
});

// --- /api/logs endpoint ----------------------------------------------

const HOST = process.env.TEST_HOST || "127.0.0.1";
const PORT = process.env.TEST_PORT || "3847";
const BASE = `http://${HOST}:${PORT}`;

let alive = false;
before(async () => {
  try {
    const r = await fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(2000) });
    alive = r.ok;
  } catch { alive = false; }
});

function skipIfDead(t) { if (!alive) t.skip("dev server not reachable"); }

test("/api/logs returns recent log entries reverse-chronologically", async (t) => {
  skipIfDead(t);
  const r = await fetch(`${BASE}/api/logs?n=5`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j));
  if (j.length >= 2) {
    // entry shape
    for (const e of j) {
      assert.ok(typeof e.ts === "string");
      assert.ok(typeof e.level === "string");
      assert.ok(typeof e.tag === "string");
      assert.ok(typeof e.msg === "string");
    }
    // ordering — newer first
    for (let i = 1; i < j.length; i++) {
      assert.ok(j[i - 1].ts >= j[i].ts, "logs must be reverse-chronological");
    }
  }
});

test("/api/logs respects ?level filter", async (t) => {
  skipIfDead(t);
  const r = await fetch(`${BASE}/api/logs?n=20&level=info`);
  assert.equal(r.status, 200);
  const j = await r.json();
  for (const e of j) {
    assert.equal(e.level, "info", "all entries must match filter");
  }
});

test("/api/logs respects ?tag filter (partial match)", async (t) => {
  skipIfDead(t);
  const r = await fetch(`${BASE}/api/logs?n=20&tag=automode`);
  assert.equal(r.status, 200);
  const j = await r.json();
  for (const e of j) {
    assert.match(e.tag, /automode/i);
  }
});

test("/api/logs caps n at 500", async (t) => {
  skipIfDead(t);
  const r = await fetch(`${BASE}/api/logs?n=99999`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.length <= 500, `should cap at 500, got ${j.length}`);
});

test("/api/logs treats invalid n as default", async (t) => {
  skipIfDead(t);
  const r = await fetch(`${BASE}/api/logs?n=abc`);
  assert.equal(r.status, 200);
});
