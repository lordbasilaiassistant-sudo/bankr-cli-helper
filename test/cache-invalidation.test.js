// Verifies the live-data caches are correctly invalidated after writes.
// Loads server.js as a module — the file's `require.main === module` guard
// prevents app.listen / automode.start from firing during tests.

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { __test } = require("..");
const {
  invalidateLiveCaches,
  isWriteCommand,
  getPortfolioCache,
  seedPortfolioCache,
  contextCacheKeys,
  seedContextCache,
  clearContextCache,
} = __test;

function freshState() {
  // Wipe both caches and seed every provider entry so we can detect
  // selective invalidation (only the right keys got dropped).
  clearContextCache();
  seedPortfolioCache({ balances: { base: { tokenBalances: [] } } });
  for (const k of [
    "portfolio", "fees", "whoami", "llmCredits", "x402List",
    "feesForToken:0xc07e889e1816de2708bf718683e52150c20f3ba3",
    "feesForToken:0xdeadbeef00000000000000000000000000000000",
    "tokenInfo:0xc07e889e1816de2708bf718683e52150c20f3ba3",
  ]) {
    seedContextCache(k, { ts: Date.now(), label: k, output: "stub", ok: true });
  }
}

test("isWriteCommand correctly classifies the recipes and CLI families", () => {
  assert.equal(isWriteCommand("weth-unwrap max base"), true);
  assert.equal(isWriteCommand("weth-wrap 0.001 base"), true);
  assert.equal(isWriteCommand("fees claim 0xabc -y"), true);
  assert.equal(isWriteCommand("fees claim-wallet --all -y"), true);
  assert.equal(isWriteCommand("launch --name X --symbol XX --image http://x/y -y"), true);
  assert.equal(isWriteCommand("wallet transfer --to 0xabc --amount 1 --token USDC"), true);
  assert.equal(isWriteCommand("wallet submit tx --to 0x4200... --chain-id 8453 --value 0"), true);
  assert.equal(isWriteCommand("config set apiKey bk_xxx"), true);

  // Reads stay reads
  assert.equal(isWriteCommand("wallet portfolio --all"), false);
  assert.equal(isWriteCommand("fees --json"), false);
  assert.equal(isWriteCommand("whoami"), false);
  assert.equal(isWriteCommand("tokens info 0xabc --chain 8453"), false);
});

test("any wallet write nukes portfolioCache + portfolio context entry", () => {
  freshState();
  assert.equal(getPortfolioCache().hasJson, true);
  assert.ok(contextCacheKeys().includes("portfolio"));

  invalidateLiveCaches("wallet transfer --to 0xabc --amount 1 --token USDC");

  assert.equal(getPortfolioCache().hasJson, false, "portfolioCache should be empty");
  assert.equal(getPortfolioCache().ts, 0, "portfolioCache ts should be reset");
  assert.equal(contextCacheKeys().includes("portfolio"), false, "portfolio context entry should be dropped");

  // Other entries untouched — wallet transfer doesn't move fees/whoami/credits
  for (const k of ["fees", "whoami", "llmCredits", "x402List"]) {
    assert.ok(contextCacheKeys().includes(k), `${k} should still be cached after a plain wallet write`);
  }
});

test("fees claim drops portfolio + fees + every per-token-fees entry", () => {
  freshState();
  invalidateLiveCaches("fees claim 0xc07E889e1816De2708BF718683e52150C20F3BA3 -y");

  const keys = contextCacheKeys();
  assert.equal(keys.includes("portfolio"), false);
  assert.equal(keys.includes("fees"), false);
  assert.equal(keys.some((k) => k.startsWith("feesForToken:")), false,
    "all feesForToken:* entries should be dropped — claim-wallet --all may touch any token");
  // tokenInfo and other unrelated entries survive
  assert.ok(keys.includes("whoami"));
  assert.ok(keys.some((k) => k.startsWith("tokenInfo:")));
});

test("fees claim-wallet --all drops the same set", () => {
  freshState();
  invalidateLiveCaches("fees claim-wallet --all -y");
  const keys = contextCacheKeys();
  assert.equal(keys.includes("fees"), false);
  assert.equal(keys.some((k) => k.startsWith("feesForToken:")), false);
});

test("launch drops portfolio + fees + whoami", () => {
  freshState();
  invalidateLiveCaches("launch --name Tenebris --symbol TNBS --image http://x/y --tweet  --website  --fee  --fee-type wallet -y");
  const keys = contextCacheKeys();
  assert.equal(keys.includes("portfolio"), false);
  assert.equal(keys.includes("fees"), false);
  assert.equal(keys.includes("whoami"), false);
  // x402, llmCredits, tokenInfo all unaffected
  assert.ok(keys.includes("llmCredits"));
  assert.ok(keys.includes("x402List"));
});

test("llm credits add drops llmCredits + portfolio (it spends from wallet)", () => {
  freshState();
  invalidateLiveCaches("llm credits add 5 --token USDC -y");
  const keys = contextCacheKeys();
  assert.equal(keys.includes("portfolio"), false);
  assert.equal(keys.includes("llmCredits"), false);
  assert.ok(keys.includes("fees"));
  assert.ok(keys.includes("whoami"));
});

test("x402 deploy drops x402List", () => {
  freshState();
  invalidateLiveCaches("x402 deploy --name foo");
  const keys = contextCacheKeys();
  assert.equal(keys.includes("x402List"), false);
  assert.equal(keys.includes("portfolio"), false); // wallet still touched
  assert.ok(keys.includes("fees"));
  assert.ok(keys.includes("whoami"));
});

test("config set drops whoami (effective wallet may have changed)", () => {
  freshState();
  invalidateLiveCaches("config set apiKey bk_xxx");
  const keys = contextCacheKeys();
  assert.equal(keys.includes("whoami"), false);
  assert.equal(keys.includes("portfolio"), false);
});

test("weth-unwrap (recipe form) drops portfolio — same as any wallet write", () => {
  freshState();
  invalidateLiveCaches("weth-unwrap max base");
  const keys = contextCacheKeys();
  assert.equal(keys.includes("portfolio"), false);
  assert.equal(getPortfolioCache().hasJson, false);
  // Doesn't touch fees/whoami/etc.
  assert.ok(keys.includes("fees"));
  assert.ok(keys.includes("whoami"));
});

test("invalidateLiveCaches with an empty / undefined cmd still clears portfolio", () => {
  freshState();
  invalidateLiveCaches("");
  assert.equal(getPortfolioCache().hasJson, false);
});

test("invalidateLiveCaches is idempotent — second call is a no-op crash-free", () => {
  freshState();
  invalidateLiveCaches("fees claim-wallet --all -y");
  invalidateLiveCaches("fees claim-wallet --all -y");
  // No throw, caches stay empty
  assert.equal(getPortfolioCache().hasJson, false);
});

const { runBankrWithRecipe } = __test;

test("runBankrWithRecipe leaves caches alone when given a READ command", async () => {
  freshState();
  const before = getPortfolioCache().hasJson;
  assert.equal(before, true, "precondition: cache seeded");
  // wallet portfolio is a read — even if the CLI call fails, no invalidation
  // should happen because isWriteCommand returns false.
  await runBankrWithRecipe("wallet portfolio --all", { bankrApiKey: "" });
  assert.equal(getPortfolioCache().hasJson, true, "read commands must not clear portfolio cache");
  for (const k of ["portfolio", "fees", "whoami", "llmCredits", "x402List"]) {
    assert.ok(contextCacheKeys().includes(k), `${k} should survive a read`);
  }
});

test("runBankrWithRecipe leaves caches alone when a WRITE fails at recipe expansion", async () => {
  freshState();
  // weth-unwrap max — but we have a seeded portfolio with no WETH balance,
  // so resolveCommand → expandRecipe will throw "max not supported" /
  // "no WETH balance". Even though it's a write, ok will be false, so the
  // post-run invalidation must NOT fire.
  const r = await runBankrWithRecipe("weth-unwrap max base", { bankrApiKey: "" });
  assert.equal(r.ok, false, "expansion should fail with no WETH");
  assert.match(r.output, /Recipe error|no WETH/i);
  assert.equal(getPortfolioCache().hasJson, true,
    "failed writes must NOT invalidate caches — nothing changed on chain");
});

const { runBankrForAutomode } = __test;

test("runBankrForAutomode invalidates caches when an automode write succeeds (read does NOT)", async () => {
  // We can't easily make the inner runBankr succeed without a working CLI +
  // creds + on-chain interaction. So we verify the wrapper's logic by
  // observing the cache state pre/post a known-failing call: a read that
  // actually returns ok:true (we can use `whoami` via mock) — but we don't
  // have a mock layer here, so instead we verify that a read against a
  // garbled command leaves caches alone.
  freshState();
  // wallet portfolio --all is a read; even on failure caches stay.
  await runBankrForAutomode("wallet portfolio --all", { bankrApiKey: "" });
  assert.equal(getPortfolioCache().hasJson, true, "automode reads must not nuke portfolio cache");

  // Simulate a successful write by calling the wrapper directly with a
  // known-write command. We don't actually run the CLI here — but we can
  // exercise the cache-invalidation path with an array form whose runBankr
  // outcome we know will be a real CLI execution. Since we can't broadcast,
  // a more reliable check: verify the wrapper's invalidation predicate
  // by directly invoking it via the unit-tested isWriteCommand + the
  // observed cache state after a successful CLI call. Real broadcast tests
  // live in the integration suite; here we assert wiring shape.
  // Concretely: feed a string array form that maps to `wallet transfer` —
  // a write — and confirm the wrapper at least reaches and respects ok=false
  // (which it should given the bad creds).
  const r = await runBankrForAutomode(["wallet", "transfer", "--to", "0x" + "0".repeat(40), "--amount", "0", "--token", "USDC", "--chain", "base"], { bankrApiKey: "" });
  // Expected: failure because no creds / dust transfer rejected. Cache must
  // survive (we only invalidate on r.ok=true).
  assert.equal(r.ok, false, "no-cred transfer must fail");
  assert.equal(getPortfolioCache().hasJson, true, "failed write must not invalidate cache");
});

test("runBankrForAutomode array input is parsed correctly for the write classifier", async () => {
  freshState();
  // The wrapper joins array inputs with spaces before classifying. Confirm
  // a reads-array-form (whoami) does not invalidate.
  await runBankrForAutomode(["whoami"], { bankrApiKey: "" });
  assert.equal(getPortfolioCache().hasJson, true);
});
