// Recipe expansion + ether-wei parsing + command-validation tests.
// These exercise the layer that translates LLM-emitted short forms
// (weth-unwrap, weth-wrap) into the actual `wallet submit tx` argv,
// and rejects malformed / placeholder input before it hits the CLI.

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { __test } = require("..");
const {
  parseEtherWei,
  parseBankrArgs,
  expandRecipe,
  resolveCommand,
  isValidBankrCommand,
  looksLikePlaceholder,
  isWriteCommand,
  summarizeWrite,
  WETH_ADDRESSES,
  WETH_WITHDRAW_SELECTOR,
  WETH_DEPOSIT_SELECTOR,
} = __test;

test("parseEtherWei: integers", () => {
  assert.equal(parseEtherWei("1"), 1_000_000_000_000_000_000n);
  assert.equal(parseEtherWei("0"), 0n);
  assert.equal(parseEtherWei("100"), 100_000_000_000_000_000_000n);
});

test("parseEtherWei: decimals are padded to 18 places", () => {
  assert.equal(parseEtherWei("0.5"), 500_000_000_000_000_000n);
  assert.equal(parseEtherWei("0.000001"), 1_000_000_000_000n);
  assert.equal(parseEtherWei("0.000000000000000001"), 1n); // 1 wei
});

test("parseEtherWei: extra precision past 18 places truncates (no rounding)", () => {
  // 0.1234567890123456789 — 19 digits. The 19th digit is dropped.
  assert.equal(parseEtherWei("0.1234567890123456789"), 123_456_789_012_345_678n);
});

test("parseEtherWei: rejects garbage", () => {
  assert.throws(() => parseEtherWei("max"), /bad amount/);
  assert.throws(() => parseEtherWei("1.2.3"), /bad amount/);
  assert.throws(() => parseEtherWei(""), /bad amount/);
  assert.throws(() => parseEtherWei("-1"), /bad amount/);
  assert.throws(() => parseEtherWei("1e18"), /bad amount/);
});

test("parseBankrArgs: respects single + double quotes", () => {
  assert.deepEqual(
    parseBankrArgs(`launch --name "Tokens of Yore" --symbol TOY -y`),
    ["launch", "--name", "Tokens of Yore", "--symbol", "TOY", "-y"]
  );
  assert.deepEqual(
    parseBankrArgs(`launch --name 'AET hM' --symbol AET`),
    ["launch", "--name", "AET hM", "--symbol", "AET"]
  );
});

test("expandRecipe: weth-unwrap builds correct calldata", () => {
  const argv = expandRecipe(["weth-unwrap", "0.001", "base"]);
  // Expected calldata: 0x2e1a7d4d + uint256(0.001 ether)
  // 0.001 ether = 10^15 wei = 0x38d7ea4c68000
  const want = WETH_WITHDRAW_SELECTOR + "00000000000000000000000000000000000000000000000000038d7ea4c68000";
  assert.equal(argv[0], "wallet");
  assert.equal(argv[1], "submit");
  assert.equal(argv[2], "tx");
  const dataIdx = argv.indexOf("--data");
  const toIdx = argv.indexOf("--to");
  const valueIdx = argv.indexOf("--value");
  assert.equal(argv[dataIdx + 1], want);
  assert.equal(argv[toIdx + 1].toLowerCase(), WETH_ADDRESSES.base.address.toLowerCase());
  assert.equal(argv[valueIdx + 1], "0", "unwrap must not send value");
});

test("expandRecipe: weth-wrap puts value=wei and uses deposit() selector", () => {
  const argv = expandRecipe(["weth-wrap", "0.5", "base"]);
  const dataIdx = argv.indexOf("--data");
  const valueIdx = argv.indexOf("--value");
  assert.equal(argv[dataIdx + 1], WETH_DEPOSIT_SELECTOR, "wrap data is just the deposit() selector");
  assert.equal(argv[valueIdx + 1], "500000000000000000", "wrap value carries wei amount");
});

test("expandRecipe: rejects unsupported chain", () => {
  assert.throws(() => expandRecipe(["weth-unwrap", "1", "doge"]), /unsupported chain/);
});

test("resolveCommand passes non-recipes through unchanged", () => {
  assert.deepEqual(resolveCommand("wallet portfolio --all"), ["wallet", "portfolio", "--all"]);
  assert.deepEqual(resolveCommand("fees --json"), ["fees", "--json"]);
});

test("isValidBankrCommand: accepts all command roots", () => {
  for (const cmd of [
    "wallet portfolio --all",
    "tokens info 0xabc",
    "fees --json",
    "whoami",
    "llm credits",
    "skills",
    "config get",
    "launch --name X --symbol XX --image http://x -y",
    "sounds",
    "agent skills",
    "x402 list",
    "update --check",
    "weth-unwrap 0.1 base",
    "weth-wrap 0.1 base",
    "weth-unwrap max base",
    "weth-wrap all base",
  ]) {
    assert.equal(isValidBankrCommand(cmd), true, `should accept: ${cmd}`);
  }
});

test("isValidBankrCommand: rejects unknown roots, agent prompt, placeholders", () => {
  for (const cmd of [
    "rm -rf /",
    "agent prompt 'hi'",       // costs $$
    "agent default-text",       // costs $$
    "wallet transfer --to 0x... --amount <amount>",  // placeholder text
    "weth-unwrap",              // missing amount
    "weth-unwrap notanamount base", // bad amount
    "wallet sign --message 'hi from <address>'", // placeholder
    "",
  ]) {
    assert.equal(isValidBankrCommand(cmd), false, `should reject: ${cmd}`);
  }
});

test("isValidBankrCommand: agent skills/status/cancel/profile are allowed (free)", () => {
  for (const cmd of ["agent skills", "agent status abc123", "agent cancel abc", "agent profile"]) {
    assert.equal(isValidBankrCommand(cmd), true, `should allow free: ${cmd}`);
  }
});

test("looksLikePlaceholder catches LLM cargo-cult patterns", () => {
  const yes = [
    "wallet transfer --to 0x... --amount 1",
    "wallet transfer --to <address> --amount 1",
    "wallet transfer --to your-wallet --amount 1",
    "tokens info 0xEVIL",
    "wallet transfer --to 0x... --amount 1 ... --token USDC",
  ];
  const no = [
    "wallet portfolio --all",
    "tokens info 0xc07E889e1816De2708BF718683e52150C20F3BA3",
    "fees claim 0xdeadbeef00000000000000000000000000000000 -y", // 0xdeadbeef alone OK; real pattern below
  ];
  for (const c of yes) assert.equal(looksLikePlaceholder(c), true, `placeholder: ${c}`);
  for (const c of no) assert.equal(looksLikePlaceholder(c), false, `not placeholder: ${c}`);
});

test("isWriteCommand: write families flagged correctly", () => {
  // Already covered in cache tests — re-asserting the boundary so future
  // additions to WRITE_PATTERNS show up here too.
  assert.equal(isWriteCommand("wallet sign --type personal_sign --message hi"), true);
  assert.equal(isWriteCommand("sounds enable"), true);
  assert.equal(isWriteCommand("sounds list"), false);
  assert.equal(isWriteCommand("x402 call http://x"), true);
  assert.equal(isWriteCommand("x402 list"), false);
  assert.equal(isWriteCommand("x402 search query"), false);
});

test("summarizeWrite: surfaces flag values for confirm UI", () => {
  const s = summarizeWrite("wallet transfer --to 0xc07E889e1816De2708BF718683e52150C20F3BA3 --amount 1.5 --token USDC --chain base");
  assert.equal(s.to, "0xc07E889e1816De2708BF718683e52150C20F3BA3");
  assert.equal(s.amount, "1.5");
  assert.equal(s.token, "USDC");
  assert.equal(s.danger, true, "wallet transfer is dangerous");
});

test("summarizeWrite: recipe form includes the recipe block AND the expanded args", () => {
  const s = summarizeWrite("weth-unwrap 0.1 base");
  assert.equal(s.recipe.name, "weth-unwrap");
  assert.equal(s.recipe.amount, "0.1");
  assert.equal(s.recipe.chain, "base");
  // Underlying expansion makes it a wallet submit tx — danger is true.
  assert.equal(s.danger, true);
});

test("summarizeWrite: launch surfaces --name / --symbol / --simulate", () => {
  const s = summarizeWrite(`launch --name "Tenebris" --symbol TNBS --image http://x --tweet "" --website "" --fee "" --fee-type wallet -y --simulate`);
  assert.equal(s.name, "Tenebris");
  assert.equal(s.symbol, "TNBS");
  assert.equal(s.simulate, true);
});
