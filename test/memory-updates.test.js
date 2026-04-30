// Tests applyMemoryUpdates — the parser that takes the LLM's raw response,
// extracts ```memory-update``` blocks, validates them, and produces a
// new memory object. This is the only path by which the LLM can mutate
// long-term memory, so it has to be airtight against:
//   - oversized values blowing the prompt budget
//   - overwrites of existing wallet/token bindings (injection persistence)
//   - non-JSON or malformed blocks
//   - unknown categories
//   - duplicate facts
//   - facts list growth past 200

process.env.LOG_FILE = "0";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { __test } = require("..");
const { applyMemoryUpdates } = __test;

const baseMem = () => ({ wallets: {}, tokens: {}, facts: [], preferences: {} });

function block(obj) {
  return "```memory-update\n" + JSON.stringify(obj) + "\n```";
}

test("applyMemoryUpdates: returns unchanged + changed=false when response has no blocks", () => {
  const r = applyMemoryUpdates(baseMem(), "just a normal answer with no memory updates");
  assert.equal(r.changed, false);
  assert.deepEqual(r.memory.facts, []);
});

test("applyMemoryUpdates: appends a single fact", () => {
  const r = applyMemoryUpdates(baseMem(), block({ action: "set", category: "facts", value: "User prefers brevity" }));
  assert.equal(r.changed, true);
  assert.deepEqual(r.memory.facts, ["User prefers brevity"]);
});

test("applyMemoryUpdates: drops oversized fact strings (>500 chars)", () => {
  const big = "x".repeat(501);
  const r = applyMemoryUpdates(baseMem(), block({ action: "set", category: "facts", value: big }));
  assert.equal(r.changed, false);
  assert.equal(r.memory.facts.length, 0);
});

test("applyMemoryUpdates: dedupes facts on append", () => {
  const mem = baseMem();
  mem.facts.push("known");
  const r = applyMemoryUpdates(mem, block({ action: "set", category: "facts", value: "known" }));
  assert.equal(r.changed, false);
  assert.equal(r.memory.facts.length, 1);
});

test("applyMemoryUpdates: trims facts to last 200 entries", () => {
  const mem = baseMem();
  for (let i = 0; i < 199; i++) mem.facts.push(`old fact ${i}`);
  const resp = block({ action: "set", category: "facts", value: "new at boundary" }) +
               block({ action: "set", category: "facts", value: "one more pushes over" });
  const r = applyMemoryUpdates(mem, resp);
  assert.equal(r.changed, true);
  assert.equal(r.memory.facts.length, 200);
  assert.equal(r.memory.facts[r.memory.facts.length - 1], "one more pushes over");
});

test("applyMemoryUpdates: sets a preference (overwriting allowed)", () => {
  const mem = baseMem();
  mem.preferences.theme = "light";
  const r = applyMemoryUpdates(mem, block({ action: "set", category: "preferences", key: "theme", value: "dark" }));
  assert.equal(r.changed, true);
  assert.equal(r.memory.preferences.theme, "dark");
});

test("applyMemoryUpdates: rejects oversized preference values", () => {
  const r = applyMemoryUpdates(baseMem(), block({
    action: "set", category: "preferences", key: "blob",
    value: "x".repeat(1000),
  }));
  assert.equal(r.changed, false);
});

test("applyMemoryUpdates: rejects oversized preference keys", () => {
  const r = applyMemoryUpdates(baseMem(), block({
    action: "set", category: "preferences", key: "k".repeat(80), value: "ok",
  }));
  assert.equal(r.changed, false);
});

test("applyMemoryUpdates: empty preference key rejected", () => {
  const r = applyMemoryUpdates(baseMem(), block({
    action: "set", category: "preferences", key: "", value: "ok",
  }));
  assert.equal(r.changed, false);
});

test("applyMemoryUpdates: wallets are append-only — existing key cannot be overwritten", () => {
  const mem = baseMem();
  mem.wallets.main_evm = "0xrealwallet";
  const r = applyMemoryUpdates(mem, block({
    action: "set", category: "wallets", key: "main_evm", value: "0xATTACKER0000",
  }));
  assert.equal(r.changed, false, "must not overwrite existing wallet binding");
  assert.equal(r.memory.wallets.main_evm, "0xrealwallet");
});

test("applyMemoryUpdates: new wallet key accepted", () => {
  const r = applyMemoryUpdates(baseMem(), block({
    action: "set", category: "wallets", key: "test_wallet", value: "0xabc",
  }));
  assert.equal(r.changed, true);
  assert.equal(r.memory.wallets.test_wallet, "0xabc");
});

test("applyMemoryUpdates: tokens are append-only", () => {
  const mem = baseMem();
  mem.tokens.thryx = { address: "0xc07E889e1816De2708BF718683e52150C20F3BA3", chain: "base" };
  const r = applyMemoryUpdates(mem, block({
    action: "set", category: "tokens", key: "thryx", value: { address: "0xfake" },
  }));
  assert.equal(r.changed, false);
  assert.equal(r.memory.tokens.thryx.address, "0xc07E889e1816De2708BF718683e52150C20F3BA3");
});

test("applyMemoryUpdates: silently drops unknown category", () => {
  const r = applyMemoryUpdates(baseMem(), block({
    action: "set", category: "secrets", key: "k", value: "v",
  }));
  assert.equal(r.changed, false);
});

test("applyMemoryUpdates: silently drops malformed JSON", () => {
  const resp = "```memory-update\n{not json}\n```";
  const r = applyMemoryUpdates(baseMem(), resp);
  assert.equal(r.changed, false);
});

test("applyMemoryUpdates: silently drops missing action / category", () => {
  const r = applyMemoryUpdates(baseMem(), block({ category: "facts", value: "no action" }));
  assert.equal(r.changed, false);
});

test("applyMemoryUpdates: silently drops action != 'set'", () => {
  const r = applyMemoryUpdates(baseMem(), block({
    action: "delete", category: "facts", value: "anything",
  }));
  assert.equal(r.changed, false);
});

test("applyMemoryUpdates: handles multiple blocks in one response", () => {
  const resp = block({ action: "set", category: "facts", value: "f1" }) +
               "\nsome prose\n" +
               block({ action: "set", category: "preferences", key: "theme", value: "dark" }) +
               "\n" +
               block({ action: "set", category: "wallets", key: "alt", value: "0xdef" });
  const r = applyMemoryUpdates(baseMem(), resp);
  assert.equal(r.changed, true);
  assert.deepEqual(r.memory.facts, ["f1"]);
  assert.equal(r.memory.preferences.theme, "dark");
  assert.equal(r.memory.wallets.alt, "0xdef");
});

test("applyMemoryUpdates: tolerates malformed input memory shape", () => {
  // Real-world: memory.json could become corrupted between turns. The
  // function should normalize broken shapes instead of throwing.
  const r = applyMemoryUpdates({ wallets: "wrong", facts: "also wrong" }, block({
    action: "set", category: "facts", value: "first fact",
  }));
  assert.equal(r.changed, true);
  assert.deepEqual(r.memory.facts, ["first fact"]);
  assert.deepEqual(r.memory.wallets, {});
});

test("applyMemoryUpdates: doesn't accept facts.value that's not a string", () => {
  const r = applyMemoryUpdates(baseMem(), block({
    action: "set", category: "facts", value: { not: "a string" },
  }));
  assert.equal(r.changed, false);
});
