// Phase 3 — danger-gate extension. Every value-moving write must:
//   1. Be classified as a WRITE (so /api/bankr stages instead of executing)
//   2. Have summary.danger = true (so the UI demands the verify-last-4 step)
// Every paired READ must:
//   3. NOT be classified as a WRITE
//   4. NOT have danger:true (would be a false positive nag for harmless reads)
//
// File operations (files write/rm/edit) are WRITES but NOT value-moving —
// they get a normal confirm box without verify-last-4.

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { __test } = require("..");
const { isWriteCommand, summarizeWrite, isValidBankrCommand } = __test;

// --- WRITE classification ----------------------------------------------

test("Phase3 WRITE: files mutations flagged as writes", () => {
  for (const cmd of [
    "files write /foo.txt hello",
    "files rm /tmp.json",
    "files edit /skill.md",
    "files mv /a /b",
    "files rename /a /b",
    "files mkdir /new",
    "files upload /local.png /remote.png",
  ]) {
    assert.equal(isWriteCommand(cmd), true, `must be write: ${cmd}`);
  }
});

test("Phase3 READ: files reads NOT flagged as writes", () => {
  for (const cmd of [
    "files ls /",
    "files cat /foo.txt",
    "files storage",
    "files info /foo.txt",
    "files search README",
    "files download /foo.txt /local.txt", // download = READ in our model
  ]) {
    assert.equal(isWriteCommand(cmd), false, `must NOT be write: ${cmd}`);
  }
});

test("Phase3 WRITE: webhooks mutations flagged as writes", () => {
  for (const cmd of [
    "webhooks init",
    "webhooks add foo",
    "webhooks configure foo",
    "webhooks deploy foo",
    "webhooks pause foo",
    "webhooks resume foo",
    "webhooks delete foo",
    "webhooks env set FOO bar",
  ]) {
    assert.equal(isWriteCommand(cmd), true, `must be write: ${cmd}`);
  }
});

test("Phase3 READ: webhooks reads NOT flagged as writes", () => {
  for (const cmd of [
    "webhooks list",
    "webhooks logs foo",
    "webhooks env",      // listing env, no `set` arg
  ]) {
    assert.equal(isWriteCommand(cmd), false, `must NOT be write: ${cmd}`);
  }
});

test("Phase3 WRITE: club mutations flagged as writes", () => {
  assert.equal(isWriteCommand("club signup"), true);
  assert.equal(isWriteCommand("club signup --yearly"), true);
  assert.equal(isWriteCommand("club cancel"), true);
});

test("Phase3 READ: club status NOT flagged as a write", () => {
  assert.equal(isWriteCommand("club status"), false);
});

// --- DANGER classification (the verify-last-4 trigger) ------------------

test("Phase3 DANGER: launch is value-moving", () => {
  const s = summarizeWrite(`launch --name "Foo" --symbol FOO`);
  assert.equal(s.danger, true, "launch deploys + pays gas — danger:true");
  assert.equal(s.symbol, "FOO");
});

test("Phase3 DANGER: fees claim is value-moving", () => {
  const s = summarizeWrite("fees claim 0xc07E889e1816De2708BF718683e52150C20F3BA3");
  assert.equal(s.danger, true);
  // We capture the positional address as `target` so the verify gate can
  // require last-4 of the token address before confirming.
  assert.equal(s.target, "0xc07E889e1816De2708BF718683e52150C20F3BA3");
});

test("Phase3 DANGER: fees claim-wallet is value-moving", () => {
  const s = summarizeWrite("fees claim-wallet 0xabcdef --all -y");
  assert.equal(s.danger, true);
  assert.equal(s.target, "0xabcdef");
});

test("Phase3 DANGER: club signup pulls from wallet", () => {
  assert.equal(summarizeWrite("club signup --yearly -y").danger, true);
});

test("Phase3 DANGER: llm credits add pulls USDC", () => {
  const s = summarizeWrite("llm credits add 5 --token USDC -y");
  assert.equal(s.danger, true);
  assert.equal(s.amount, undefined,
    "llm credits add 5: 5 is positional not --amount, that's fine — danger gate doesn't need it");
});

test("Phase3 DANGER: x402 call spends USDC", () => {
  assert.equal(summarizeWrite("x402 call https://api.example.com/path").danger, true);
});

// --- NOT-DANGER (writes that aren't value-moving) ----------------------

test("Phase3 NOT-DANGER: files write is a write but not value-moving", () => {
  // We don't go through summarizeWrite for non-value-moving writes today;
  // the assertion is that IF we did, danger should NOT trip. This guards
  // against future regressions where a too-broad predicate marks file ops
  // as needing the verify-last-4 ceremony.
  const s = summarizeWrite("files write /foo.txt hello");
  assert.equal(s.danger, false, "file mutations are not value-moving");
});

test("Phase3 NOT-DANGER: webhooks deploy is a write but not value-moving", () => {
  const s = summarizeWrite("webhooks deploy myhook");
  assert.equal(s.danger, false, "webhooks mutations are not value-moving");
});

test("Phase3 NOT-DANGER: config set is a write but not value-moving", () => {
  const s = summarizeWrite("config set apiKey bk_xyz");
  assert.equal(s.danger, false);
});

test("Phase3 NOT-DANGER: sounds enable is a write but not value-moving", () => {
  const s = summarizeWrite("sounds enable");
  assert.equal(s.danger, false);
});

// --- READ predicates: must remain readable -----------------------------

test("Phase3 READ: club status / files ls / webhooks list / agent skills are valid commands", () => {
  for (const cmd of [
    "club status",
    "files ls /",
    "files cat /foo.txt",
    "webhooks list",
    "agent skills",
    "llm credits",
    "x402 list",
    "x402 search foo",
    "login --url",
  ]) {
    assert.equal(isValidBankrCommand(cmd), true, `must be valid: ${cmd}`);
  }
});

test("Phase3 READ: paid agent invocations remain blocked", () => {
  for (const cmd of [
    "agent prompt hello",
    "agent claude something",
    "agent foo bar",         // unknown subcommand
    "login email user@x.com",
    "login siwe",
  ]) {
    assert.equal(isValidBankrCommand(cmd), false, `must be invalid: ${cmd}`);
  }
});
