// Integration tests against the live dev server on 127.0.0.1:3847.
// These exercise the real HTTP routes — no gas spent (we never confirm
// staged writes). Skips cleanly if the server isn't up.

const assert = require("node:assert/strict");
const { test, before } = require("node:test");

const HOST = process.env.TEST_HOST || "127.0.0.1";
const PORT = process.env.TEST_PORT || "3847";
const BASE = `http://${HOST}:${PORT}`;

async function reachable() {
  try {
    const r = await fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

let alive = false;
before(async () => { alive = await reachable(); });

function skipIfDead(t) {
  if (!alive) t.skip("dev server not reachable on " + BASE);
}

async function postJson(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: r.status, json: await r.json() };
}

test("read command runs immediately (no staging)", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "wallet portfolio --all" });
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmRequired, undefined, "reads must not require confirmation");
  assert.equal(typeof r.json.ok, "boolean", "must include ok flag");
});

test("write command stages without executing", async (t) => {
  skipIfDead(t);
  // weth-unwrap with a tiny concrete amount — staged-only path. We never
  // confirm so no broadcast happens.
  const r = await postJson("/api/bankr", { command: "weth-unwrap 0.0001 base" });
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmRequired, true, "writes must stage for confirm");
  assert.ok(r.json.pendingId, "must return pendingId");
  assert.ok(r.json.command, "must include the resolved command in the response");
  assert.ok(r.json.summary, "must include a summary");
  // Recipe expansion happened: command should now reference wallet submit tx
  // form OR keep recipe shape — either is fine, but the summary must mark danger.
  assert.equal(r.json.summary.danger, true, "summary must flag write as dangerous");
});

test("write command with placeholder text is rejected", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "wallet transfer --to 0x... --amount <amount> --token USDC" });
  assert.equal(r.status, 400, "placeholders must be rejected before staging");
});

test("write recipe with bad max sentinel surfaces a recipe error", async (t) => {
  skipIfDead(t);
  // The wallet has no WETH, so weth-unwrap max should fail at concretize time.
  const r = await postJson("/api/bankr", { command: "weth-unwrap max base" });
  assert.equal(r.status, 200);
  // Recipe resolution failure surfaces as ok:false with an error string.
  if (r.json.confirmRequired) {
    // If the wallet now has WETH (from a recent claim) the recipe might resolve.
    // That's fine too — staging means no broadcast.
    assert.ok(r.json.pendingId);
  } else {
    assert.equal(r.json.ok, false);
    assert.match(r.json.error || r.json.output || "", /no WETH balance|max amount|portfolio/i);
  }
});

test("/api/automode reports state without crashing", async (t) => {
  skipIfDead(t);
  const r = await fetch(`${BASE}/api/automode`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(typeof j.enabled === "boolean");
  assert.ok(j.schedule);
  assert.ok(typeof j.queueSize === "number");
});

test("/api/overview returns whoami + portfolio output", async (t) => {
  skipIfDead(t);
  const r = await fetch(`${BASE}/api/overview`);
  assert.equal(r.status, 200);
  const j = await r.json();
  if (j.ok) {
    assert.ok(j.whoami);
    assert.ok(j.portfolio);
  }
});

test("invalid command root is rejected", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "rm -rf /" });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test("stale pendingId returns 404", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr/confirm", { pendingId: "deadbeefdeadbeef" });
  assert.equal(r.status, 404);
});

test("GET / serves the SPA shell with all 11 panels", async (t) => {
  skipIfDead(t);
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  // Every panel id present in the static markup so the hash router can hit it
  const expectedPanelIds = [
    "chatPanel", "walletPanel", "activityPanel", "ordersPanel",
    "autoPanel", "positionsPanel", "launchesPanel", "filesPanel",
    "rawPanel", "skillsPanel", "memoryPanel", "settingsPanel",
  ];
  for (const id of expectedPanelIds) {
    assert.ok(html.includes(`id="${id}"`), `missing panel id="${id}"`);
  }
  // Hash router constants are wired
  assert.ok(html.includes("PANEL_TO_HASH"), "hash router constants must be defined");
  assert.ok(html.includes("hashchange"), "hashchange listener must be wired");
  // Docs external link
  assert.ok(html.includes("docs.bankr.bot"), "Docs link to docs.bankr.bot must render");
});

test("Wallet panel scaffold has all expected elements (Phase 4)", async (t) => {
  skipIfDead(t);
  const html = await (await fetch(`${BASE}/`)).text();
  // Header + action bar + tabs + tab containers
  assert.ok(html.includes('id="walletHeader"'), "wallet header container");
  assert.ok(html.includes('walletSend()'), "Send button");
  assert.ok(html.includes('walletReceive()'), "Receive button");
  assert.ok(html.includes('walletWrap()'), "Wrap button");
  assert.ok(html.includes('walletUnwrap()'), "Unwrap button");
  assert.ok(html.includes('id="walletTabTokens"'), "Tokens tab container");
  assert.ok(html.includes('id="walletTabNfts"'), "NFTs tab container");
  assert.ok(html.includes('id="walletTabHistory"'), "History tab container");
  // Render functions are present in JS
  assert.ok(html.includes('async function refreshWallet'), "refreshWallet function");
  assert.ok(html.includes('function renderWalletTokens'), "renderWalletTokens function");
  assert.ok(html.includes('function setWalletTab'), "setWalletTab function");
  // Receive modal
  assert.ok(html.includes('id="receiveModal"'), "receive modal markup");
});
