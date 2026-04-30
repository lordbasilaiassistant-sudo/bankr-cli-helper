// Tests the intent-aware context loader's trigger predicates (which deicde
// what auxiliary CLI calls to make on a chat turn) and the pending-write
// stash that backs the confirm-before-broadcast flow.

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { __test } = require("..");
const {
  contextProviders,
  stashPending,
  takePending,
} = __test;

// --- Context loader trigger routing -----------------------------------

test("portfolio provider is always-on (trigger returns true regardless of message)", () => {
  const p = contextProviders().portfolio;
  assert.ok(p);
  assert.equal(p.trigger(""), true);
  assert.equal(p.trigger("anything"), true);
  assert.equal(p.trigger("buy me a sandwich"), true);
});

test("fees provider fires on fee-related keywords", () => {
  const p = contextProviders().fees;
  for (const msg of [
    "claim my fees",
    "what's my creator fee",
    "any earn from royalties yet?",
    "claimable today?",
    "show payouts",
    "which tokens have I bonded?",
    "list my launched tokens",
  ]) {
    assert.equal(p.trigger(msg), true, `should trigger on: ${msg}`);
  }
});

test("fees provider does not fire on unrelated chat", () => {
  const p = contextProviders().fees;
  for (const msg of [
    "hello how are you",
    "what is my eth balance",
    "send some usdc",
  ]) {
    assert.equal(p.trigger(msg), false, `should NOT trigger on: ${msg}`);
  }
});

test("fees provider handles plural / inflection forms (regression for \\bfee\\b miss)", () => {
  const p = contextProviders().fees;
  for (const msg of [
    "show fees",                  // plural
    "any payouts today?",          // plural
    "have I earned anything?",     // -ed inflection
    "what's claimable",            // existing word
    "how many tokens have I claimed", // -ed inflection
  ]) {
    assert.equal(p.trigger(msg), true, `should trigger on: ${msg}`);
  }
});

test("feesForToken fires when message has both an address AND a fee word", () => {
  const p = contextProviders().feesForToken;
  const msg = "claim fees on 0xc07E889e1816De2708BF718683e52150C20F3BA3";
  assert.equal(p.trigger(msg), true);
  // build returns the address-keyed cache + cmd
  const built = p.build(msg);
  assert.match(built.cmd, /^fees --token 0x[a-fA-F0-9]{40} --json$/);
  assert.match(built.cacheKey, /^feesForToken:0x[a-f0-9]{40}$/);
});

test("feesForToken does NOT fire on bare address without a fee keyword", () => {
  const p = contextProviders().feesForToken;
  // "info" is a tokenInfo trigger, not fees — a bare address with no
  // fee/claim/earn/creator/royalty word should leave fees alone.
  assert.equal(p.trigger("show me info on 0xc07E889e1816De2708BF718683e52150C20F3BA3"), false);
});

test("tokenInfo fires for buy/swap/price intents on a contract address", () => {
  const p = contextProviders().tokenInfo;
  const addr = "0xc07E889e1816De2708BF718683e52150C20F3BA3";
  for (const msg of [
    `buy ${addr}`,
    `swap into ${addr}`,
    `price of ${addr}`,
    `info ${addr}`,
    `chart ${addr}`,
    `how do I trade ${addr} on aerodrome`,
  ]) {
    assert.equal(p.trigger(msg), true, `tokenInfo should trigger: ${msg}`);
  }
});

test("whoami fires on identity/account questions", () => {
  const p = contextProviders().whoami;
  for (const msg of ["who am i?", "whoami", "what's my wallet", "my account address", "my profile", "club status", "my score"]) {
    assert.equal(p.trigger(msg), true, `whoami should trigger: ${msg}`);
  }
});

test("llmCredits fires on credits / gateway / topup wording", () => {
  const p = contextProviders().llmCredits;
  for (const msg of ["llm credits balance", "top up credits", "gateway status", "llm balance check"]) {
    assert.equal(p.trigger(msg), true, `llmCredits should trigger: ${msg}`);
  }
});

test("x402List fires on x402-specific words", () => {
  const p = contextProviders().x402List;
  assert.equal(p.trigger("show my x402 endpoints"), true);
  assert.equal(p.trigger("what paid endpoint do I have"), true);
  assert.equal(p.trigger("my api revenue"), true);
  assert.equal(p.trigger("show all my balances"), false);
});

// --- Pending stash ----------------------------------------------------

test("stashPending: returns a unique 16-char hex id", () => {
  const id = stashPending("wallet portfolio --all");
  assert.match(id, /^[a-f0-9]{16}$/);
});

test("takePending: retrieves a stashed command exactly once", () => {
  const cmd = "weth-unwrap 0.001 base";
  const id = stashPending(cmd);
  assert.equal(takePending(id), cmd);
  assert.equal(takePending(id), null, "second take must miss — single-use");
});

test("takePending: returns null for unknown id", () => {
  assert.equal(takePending("deadbeefdeadbeef"), null);
});

test("stashPending: many ids do not collide", () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = stashPending(`fees claim 0x${i.toString(16).padStart(40, "0")} -y`);
    assert.equal(ids.has(id), false, `collision on iteration ${i}`);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});
