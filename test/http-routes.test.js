// HTTP-route tests covering memory + threads + settings + automode + queue +
// confirm + chat-validation paths. Hits the live dev server. No gas spent.

const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const HOST = process.env.TEST_HOST || "127.0.0.1";
const PORT = process.env.TEST_PORT || "3847";
const BASE = `http://${HOST}:${PORT}`;

const MEMORY_FILE = path.join(__dirname, "..", "data", "memory.json");

let alive = false;
let savedMemory = null;
before(async () => {
  try {
    const r = await fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(2000) });
    alive = r.ok;
  } catch { alive = false; }
  if (alive && fs.existsSync(MEMORY_FILE)) {
    savedMemory = fs.readFileSync(MEMORY_FILE, "utf8");
  }
});

function skipIfDead(t) { if (!alive) t.skip("dev server not reachable"); }

async function fetchJson(path, init) {
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, json: await r.json() };
}

async function postJson(path, body) {
  return fetchJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

// --- Memory routes ---------------------------------------------------

test("GET /api/memory returns object with the expected schema", async (t) => {
  skipIfDead(t);
  const r = await fetchJson("/api/memory");
  assert.equal(r.status, 200);
  const m = r.json;
  assert.ok(typeof m === "object" && !Array.isArray(m));
  for (const k of ["wallets", "tokens", "facts", "preferences"]) {
    assert.ok(k in m, `memory must have key: ${k}`);
  }
});

test("POST /api/memory enforces schema and rejects malformed shape", async (t) => {
  skipIfDead(t);
  // Express body-parser strict mode rejects non-object/array JSON at the
  // bouncer layer with HTML — that's still a 400, just not from our route.
  // Parse leniently so we can also assert the in-handler array-rejection
  // returns a JSON 400.
  const lenient = async (path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status };
  };
  const r1 = await lenient("/api/memory", "not an object");
  assert.equal(r1.status, 400, "string at top level rejected");
  const r2 = await postJson("/api/memory", []);
  assert.equal(r2.status, 400);
  assert.match(r2.json.error || "", /Invalid/i);
});

test("POST /api/memory accepts and persists valid memory; restore after", async (t) => {
  skipIfDead(t);
  const original = fs.existsSync(MEMORY_FILE) ? JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")) : { wallets: {}, tokens: {}, facts: [], preferences: {} };
  // Submit a payload that exercises trimming: facts has too-long string + non-string entries
  const longFact = "x".repeat(1000);
  const payload = {
    wallets: { test_evm: "0xabc" },
    tokens: {},
    facts: ["short fact", longFact, 12345 /* dropped */],
    preferences: { theme: "dark" },
    extraField: "ignored",
  };
  const r = await postJson("/api/memory", payload);
  assert.equal(r.status, 200);
  // Read back via API
  const after = (await fetchJson("/api/memory")).json;
  assert.equal(after.wallets.test_evm, "0xabc");
  assert.equal(after.preferences.theme, "dark");
  assert.equal(after.facts.includes("short fact"), true);
  assert.equal(after.facts.includes(longFact), false, "facts > 500 chars must be filtered");
  assert.equal(after.facts.includes(12345), false, "non-string facts must be filtered");
  assert.equal(after.extraField, undefined, "unknown keys must be dropped");
  // Restore
  await postJson("/api/memory", original);
});

// --- Threads routes --------------------------------------------------

test("GET /api/threads returns an array of {id, preview, updatedAt, messageCount}", async (t) => {
  skipIfDead(t);
  const r = await fetchJson("/api/threads");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  if (r.json.length) {
    const first = r.json[0];
    for (const k of ["id", "preview", "updatedAt", "messageCount"]) {
      assert.ok(k in first, `thread summary must have ${k}`);
    }
  }
});

test("GET /api/threads/<unknown> returns []", async (t) => {
  skipIfDead(t);
  const r = await fetchJson("/api/threads/this-thread-doesnt-exist");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
});

test("DELETE /api/threads/<unknown> is idempotent ok:true", async (t) => {
  skipIfDead(t);
  const r = await fetchJson("/api/threads/this-thread-doesnt-exist", { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

// --- Settings -------------------------------------------------------

test("GET /api/settings masks keys without leaking", async (t) => {
  skipIfDead(t);
  const r = await fetchJson("/api/settings");
  assert.equal(r.status, 200);
  const s = r.json;
  // Keys are returned as <prefix>...<suffix> when set; never raw.
  if (s.groqApiKey) assert.match(s.groqApiKey, /\.\.\./);
  if (s.bankrApiKey) assert.match(s.bankrApiKey, /\.\.\./);
});

test("POST /api/settings rejects masked-form values (no overwrite via masked echo)", async (t) => {
  skipIfDead(t);
  // Submitting the masked form should NOT clear the real key.
  const before = (await fetchJson("/api/settings")).json;
  await postJson("/api/settings", { groqApiKey: "gsk_aaa...zzzz" });
  const after = (await fetchJson("/api/settings")).json;
  assert.equal(after.groqApiKeySet, before.groqApiKeySet, "masked-form payload must not change the underlying key");
});

test("POST /api/settings rejects keys with the wrong prefix", async (t) => {
  skipIfDead(t);
  const before = (await fetchJson("/api/settings")).json;
  // Wrong prefix — should be silently ignored
  await postJson("/api/settings", { groqApiKey: "wrong_prefix_aaaaaaaaaaaaaaaa" });
  const after = (await fetchJson("/api/settings")).json;
  assert.equal(after.groqApiKeySet, before.groqApiKeySet);
});

// --- Confirm path ---------------------------------------------------

test("POST /api/bankr/confirm with no pendingId returns 404", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr/confirm", { pendingId: "" });
  assert.equal(r.status, 404);
});

// --- Automode queue --------------------------------------------------

test("GET /api/automode/queue returns the current queue", async (t) => {
  skipIfDead(t);
  const r = await fetchJson("/api/automode/queue");
  assert.equal(r.status, 200);
  assert.ok(r.json.queue);
  assert.ok(Array.isArray(r.json.queue));
});

test("POST /api/automode/queue validates entries and rejects bad shapes", async (t) => {
  skipIfDead(t);
  // Save original queue
  const original = (await fetchJson("/api/automode/queue")).json;
  // Try a payload with mixed valid/invalid entries — invalid filtered out.
  const payload = {
    queue: [
      { name: "Aethermind", symbol: "AETHM", theme: "valid" },
      { name: "bad symbol", symbol: "lower", theme: "invalid sym" }, // SYMBOL_RE fails
      { name: "x".repeat(60), symbol: "TOOLONGNAME", theme: "name too long" },
      { symbol: "NOPE" }, // missing name
    ],
  };
  const r = await postJson("/api/automode/queue", payload);
  assert.equal(r.status, 200);
  assert.equal(r.json.queue.length, 1, "only the well-formed entry should survive");
  assert.equal(r.json.queue[0].name, "Aethermind");
  // Restore original
  await postJson("/api/automode/queue", original);
});

test("POST /api/automode/queue rejects non-array body with 400", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/automode/queue", { queue: "not an array" });
  assert.equal(r.status, 400);
});

// --- Automode log ----------------------------------------------------

test("GET /api/automode/log returns array of recent entries", async (t) => {
  skipIfDead(t);
  const r = await fetchJson("/api/automode/log");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
});

// --- Chat validation -------------------------------------------------

test("POST /api/chat with no message returns 400", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/chat", {});
  assert.equal(r.status, 400);
  assert.match(r.json.error, /message/i);
});
