// Phase 2 — read-only API routes for the new sidebar pages.
// All these routes spawn the bankr CLI to read state. They must:
//   1. Return 200 + JSON shape {ok: bool, ...}
//   2. Never stage a write
//   3. Refuse without a Bankr API key configured (400)
//   4. Honor the login --url whitelist (login email/siwe must NOT pass)
//
// Skips cleanly if the dev server isn't reachable.

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

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(60_000) });
  return { status: r.status, json: await r.json() };
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

const READ_ROUTES = [
  "/api/wallet/portfolio",
  "/api/agent/skills",
  "/api/files/storage",
  "/api/files/list?path=/",
  "/api/club/status",
  "/api/llm/credits",
  "/api/webhooks/list",
  "/api/x402/list",
];

for (const route of READ_ROUTES) {
  test(`GET ${route} returns ok-shape JSON`, async (t) => {
    skipIfDead(t);
    const r = await getJson(route);
    assert.equal(r.status, 200, `${route} must respond 200`);
    assert.equal(typeof r.json.ok, "boolean", `${route} must include ok flag`);
    // We don't assert ok:true because the wallet may genuinely return ok:false
    // (e.g. CLI exit code != 0 due to network) — what we want is the shape.
    // No confirmRequired field — these are reads, not stages.
    assert.equal(r.json.confirmRequired, undefined, `${route} must not stage`);
  });
}

test("GET /api/files/cat without path returns 400", async (t) => {
  skipIfDead(t);
  const r = await getJson("/api/files/cat");
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test("GET /api/files/search without query returns 400", async (t) => {
  skipIfDead(t);
  const r = await getJson("/api/files/search");
  assert.equal(r.status, 400);
});

test("GET /api/files/search with query returns ok shape", async (t) => {
  skipIfDead(t);
  const r = await getJson("/api/files/search?q=README");
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.ok, "boolean");
});

test("GET /api/files/list with shell-meta in path is sanitized", async (t) => {
  skipIfDead(t);
  // semicolons / backticks / pipes are stripped before being passed to bankr
  const r = await getJson("/api/files/list?path=/;rm%20-rf%20/`");
  assert.equal(r.status, 200);
  // The path that came back should NOT contain the dangerous chars
  assert.equal(/[;`|<>$\\]/.test(r.json.path || ""), false,
    `path must not contain shell metacharacters: ${r.json.path}`);
});

test("login --url is allowed (read-only)", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "login --url" });
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmRequired, undefined, "login --url is a read, must not stage");
});

test("login email is rejected (only --url allowed)", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "login email user@example.com" });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test("login siwe is rejected (only --url allowed)", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "login siwe" });
  assert.equal(r.status, 400);
});

test("files ls passes through /api/bankr (read, no stage)", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "files ls /" });
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmRequired, undefined, "files ls is a read");
});

test("files storage passes through /api/bankr (read, no stage)", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "files storage" });
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmRequired, undefined);
});

test("club status passes through /api/bankr (read, no stage)", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "club status" });
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmRequired, undefined);
});

test("webhooks list passes through /api/bankr (read, no stage)", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/bankr", { command: "webhooks list" });
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmRequired, undefined);
});

test("agent skills cache flag is honored on second call", async (t) => {
  skipIfDead(t);
  // Force-refresh once so the cache is fresh, then call again to hit cache
  await getJson("/api/agent/skills?force=1");
  const r2 = await getJson("/api/agent/skills");
  assert.equal(r2.status, 200);
  // Note: we don't strictly require cached:true because the test runner may
  // be the first to populate the cache — what we assert is shape.
  assert.equal(typeof r2.json.cached, "boolean");
});

// === Phase 14 — file upload endpoint ===
test("POST /api/files/upload stages a write (no execute)", async (t) => {
  skipIfDead(t);
  const content = Buffer.from("phase 14 test payload").toString("base64");
  const r = await postJson("/api/files/upload", {
    remotePath: "/__test-upload.txt",
    filename: "__test-upload.txt",
    contentB64: content,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.confirmRequired, true);
  assert.ok(r.json.pendingId, "must return pendingId");
  assert.ok(r.json.command.includes("files upload"));
  assert.equal(r.json.summary.target, "/__test-upload.txt");
  assert.equal(r.json.summary.bytes, 21);
  // file uploads write data but don't move funds — danger:false (no verify-last-4)
  assert.equal(r.json.summary.danger, false);
});

test("POST /api/files/upload rejects missing fields", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/files/upload", { remotePath: "/x.txt" });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, "missing_fields");
});

test("POST /api/files/upload sanitizes shell-meta in filename", async (t) => {
  skipIfDead(t);
  const r = await postJson("/api/files/upload", {
    remotePath: "/safe.txt",
    filename: "evil;rm -rf;.txt",
    contentB64: "aGVsbG8=",
  });
  assert.equal(r.status, 200);
  // shell-metas stripped to underscores
  assert.equal(/[;`$|<>]/.test(r.json.summary.filename), false,
    `filename must not contain shell metacharacters: ${r.json.summary.filename}`);
});

test("POST /api/files/upload rejects oversized payloads", async (t) => {
  skipIfDead(t);
  // 6MB+ base64 string — over the express.json 6mb limit
  const huge = "A".repeat(7 * 1024 * 1024);
  const r = await fetch(`${BASE}/api/files/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remotePath: "/big", filename: "big", contentB64: huge }),
    signal: AbortSignal.timeout(30_000),
  });
  // Either body-parser rejects with 413, or our validator catches it
  assert.ok(r.status === 413 || r.status === 400, `expected 413/400, got ${r.status}`);
});
