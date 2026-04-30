// End-to-end chat tests — actually call the live server which actually
// calls Groq + Bankr CLI. Slow (~10-30s/test). Skipped if either key is
// missing in settings.

const assert = require("node:assert/strict");
const { test, before } = require("node:test");

const HOST = process.env.TEST_HOST || "127.0.0.1";
const PORT = process.env.TEST_PORT || "3847";
const BASE = `http://${HOST}:${PORT}`;

let alive = false;
let groqSet = false;
let bankrSet = false;
before(async () => {
  try {
    const r = await fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const j = await r.json();
      alive = true;
      groqSet = !!j.groqApiKeySet;
      bankrSet = !!j.bankrApiKeySet;
    }
  } catch {}
});

function skipIfDead(t) {
  if (!alive) t.skip("dev server not reachable");
  if (!groqSet) t.skip("no Groq API key configured");
  if (!bankrSet) t.skip("no Bankr API key configured");
}

async function chat(message, threadId) {
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, threadId }),
    signal: AbortSignal.timeout(120_000),
  });
  return { status: r.status, json: await r.json() };
}

test("chat: a simple balance question gets a non-empty response", async (t) => {
  skipIfDead(t);
  const id = `__test_chat_${Date.now()}`;
  const r = await chat("what's my eth balance on base?", id);
  assert.equal(r.status, 200);
  assert.ok(typeof r.json.response === "string");
  assert.ok(r.json.response.length > 0, "response should be non-empty");
  assert.equal(r.json.threadId, id);
  // No write proposed for a balance question
  assert.deepEqual(r.json.pendingConfirms, []);
});

test("chat: a 'unwrap weth' message gets staged with a pendingConfirm OR a clear no-WETH explanation", async (t) => {
  skipIfDead(t);
  const id = `__test_unwrap_${Date.now()}`;
  const r = await chat("unwrap my weth", id);
  assert.equal(r.status, 200);
  // One of two valid outcomes:
  // (a) wallet has WETH → staged write with pendingId
  // (b) no WETH → response says so, no staged write
  if (r.json.pendingConfirms && r.json.pendingConfirms.length) {
    assert.match(r.json.pendingConfirms[0].command, /weth-unwrap/);
    assert.ok(r.json.pendingConfirms[0].pendingId);
    assert.equal(r.json.pendingConfirms[0].summary.danger, true);
  } else {
    // Plain English explanation expected.
    assert.match(r.json.response, /WETH|unwrap|0|no/i);
  }
});

test("chat: contract-address question doesn't crash", async (t) => {
  skipIfDead(t);
  const id = `__test_addr_${Date.now()}`;
  const r = await chat("tell me about 0xc07E889e1816De2708BF718683e52150C20F3BA3", id);
  assert.equal(r.status, 200);
  assert.ok(r.json.response.length > 0);
});

test("chat: rejects huge messages with a graceful 400", async (t) => {
  skipIfDead(t);
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "a".repeat(2 * 1024 * 1024) }), // 2MB
    signal: AbortSignal.timeout(10_000),
  });
  // Express body-parser default limit is 1mb — should reject before reaching us
  assert.ok(r.status === 413 || r.status === 400);
});

test("chat: response excludes internal blocks (bankr-run, memory-update)", async (t) => {
  skipIfDead(t);
  const id = `__test_clean_${Date.now()}`;
  const r = await chat("what can you do?", id);
  assert.equal(r.status, 200);
  assert.equal(r.json.response.includes("```bankr-run"), false, "raw bankr-run blocks must not leak to user");
  assert.equal(r.json.response.includes("```memory-update"), false);
});
