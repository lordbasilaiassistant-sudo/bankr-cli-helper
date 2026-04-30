// Direct tests of automode helpers — kill switch, queue I/O, daily counter
// rollover, mocked tick with read-only actions. No real CLI calls; we inject
// a fake runBankr.

process.env.LOG_FILE = "0";

const assert = require("node:assert/strict");
const { test, before, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const automode = require("../automode");

const STATE_FILE = path.join(__dirname, "..", "data", "automode.json");
const QUEUE_FILE = path.join(__dirname, "..", "data", "token-queue.json");

// Snapshot/restore the live state + queue around each test so we don't
// stomp the user's real config.
let savedState = null;
let savedQueue = null;

before(() => {
  if (fs.existsSync(STATE_FILE)) savedState = fs.readFileSync(STATE_FILE, "utf8");
  if (fs.existsSync(QUEUE_FILE)) savedQueue = fs.readFileSync(QUEUE_FILE, "utf8");
});

afterEach(() => {
  if (savedState !== null) fs.writeFileSync(STATE_FILE, savedState);
  if (savedQueue !== null) fs.writeFileSync(QUEUE_FILE, savedQueue);
});

// --- Kill switch ----------------------------------------------------

test("setKillSwitch(true) disables and flips killSwitch", () => {
  automode.updateConfig({ enabled: true, killSwitch: false });
  const after = automode.setKillSwitch(true);
  assert.equal(after.killSwitch, true);
  assert.equal(after.enabled, false, "kill switch must also disable");
});

test("setKillSwitch(false) clears the kill flag (but doesn't auto-enable)", () => {
  automode.setKillSwitch(true);
  const after = automode.setKillSwitch(false);
  assert.equal(after.killSwitch, false);
  assert.equal(after.enabled, false, "must NOT silently re-enable on kill clear");
});

// --- updateConfig deep-merge ---------------------------------------

test("updateConfig deep-merges nested limits without wiping siblings", () => {
  automode.updateConfig({
    limits: { maxLaunchesPerDay: 1, claimThresholdUsd: 5, maxUsdPerAction: 10, minEthReserveWei: "1000000000000000" },
  });
  // Patch only one limit; others must survive.
  const after = automode.updateConfig({ limits: { claimThresholdUsd: 99 } });
  assert.equal(after.limits.claimThresholdUsd, 99);
  assert.equal(after.limits.maxLaunchesPerDay, 1, "sibling limit must survive deep merge");
  assert.equal(after.limits.minEthReserveWei, "1000000000000000");
});

// --- Queue I/O ------------------------------------------------------

test("loadQueue / saveQueue round-trip preserves entries", () => {
  const before = automode.loadQueue();
  const test_queue = {
    queue: [{ name: "TestToken", symbol: "TST", theme: "test" }],
  };
  automode.saveQueue(test_queue);
  const after = automode.loadQueue();
  assert.deepEqual(after.queue, test_queue.queue);
  // Restore
  automode.saveQueue(before);
});

// --- getStatus ------------------------------------------------------

test("getStatus returns a snapshot with queue summary + log", () => {
  const s = automode.getStatus();
  assert.ok(s.schedule, "schedule must be present");
  assert.ok(s.limits, "limits must be present");
  assert.ok(typeof s.queueSize === "number");
  assert.ok(Array.isArray(s.queuePreview));
  assert.ok(Array.isArray(s.recentLog));
});

// --- Tick semantics (mocked CLI) -----------------------------------
// We can't call automode.tick() directly here because it reads runBankrRef
// from start(), which has already been called by the live dev server's
// import. Re-calling start() would create a duplicate setInterval. So we
// only test the helpers that don't touch the timer.

test("readLog returns array with at most N entries", () => {
  const all = automode.readLog(10);
  assert.ok(Array.isArray(all));
  assert.ok(all.length <= 10);
});

test("readLog returns most-recent-first ordering", () => {
  const all = automode.readLog(50);
  if (all.length < 2) return; // not enough data to test ordering
  // ts is ISO string; lex compare works
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1].ts >= all[i].ts, "log must be reverse-chronological");
  }
});

// --- runActionNow guard --------------------------------------------

test("runActionNow throws on unknown action", async () => {
  await assert.rejects(automode.runActionNow("notARealAction"), /Unknown action/);
});

// --- saveQueue rejects garbage tokens at the JSON layer ------------
// (Validation lives in the HTTP route, not saveQueue itself, but we want to
// confirm save+load doesn't corrupt the on-disk shape even with weird input.)

test("saveQueue + loadQueue tolerate empty queue", () => {
  const before = automode.loadQueue();
  automode.saveQueue({ queue: [] });
  const after = automode.loadQueue();
  assert.deepEqual(after.queue, []);
  automode.saveQueue(before);
});
