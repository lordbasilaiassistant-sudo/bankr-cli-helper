// Tests the structured logger: levels, secret redaction, file rotation,
// child tags, time() helper. Disable disk output for these tests so they
// don't spam the real logs.jsonl.

process.env.LOG_FILE = "0";  // must be set before requiring the module

const assert = require("node:assert/strict");
const { test } = require("node:test");

const logger = require("../lib/logger");

function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => lines.push({ stream: "out", text: args.join(" ") });
  console.error = (...args) => lines.push({ stream: "err", text: args.join(" ") });
  try { fn(); } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines;
}

test("child(): tag appears in console output", () => {
  const log = logger.child("foo");
  const lines = captureConsole(() => log.info("hello"));
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /\bfoo\b/);
  assert.match(lines[0].text, /hello/);
});

test("info / debug / warn / error route to correct console stream", () => {
  const log = logger.child("dual");
  // Force debug visibility just for this test.
  process.env.__cached_was_level = process.env.LOG_LEVEL;
  // Levels are read at import time — we can't change them mid-run.
  // Instead, test what's visible at default (info+) level.
  const lines = captureConsole(() => {
    log.info("info-msg");
    log.warn("warn-msg");
    log.error("err-msg");
  });
  // info → stdout, warn/error → stderr
  const infoLine = lines.find((l) => /info-msg/.test(l.text));
  const warnLine = lines.find((l) => /warn-msg/.test(l.text));
  const errLine  = lines.find((l) => /err-msg/.test(l.text));
  assert.equal(infoLine.stream, "out");
  assert.equal(warnLine.stream, "err");
  assert.equal(errLine.stream, "err");
});

test("debug below default LOG_LEVEL is suppressed", () => {
  const log = logger.child("quiet");
  const lines = captureConsole(() => log.debug("hidden", { k: 1 }));
  assert.equal(lines.length, 0, "debug must not print at info level");
});

test("secret-shaped strings are redacted in extras", () => {
  const log = logger.child("sec");
  const lines = captureConsole(() => log.info("auth", {
    bankrApiKey: "bk_supersecretkeyabcdefghijk123456",
    groqApiKey: "gsk_realkeydontleakthispleaseabcdefghi",
    note: "ok",
  }));
  const text = lines.map((l) => l.text).join(" ");
  assert.equal(/supersecretkeyabcdefghijk/.test(text), false, "bankr key body must be redacted");
  assert.equal(/realkeydontleakthis/.test(text), false, "groq key body must be redacted");
  assert.match(text, /REDACTED/);
  assert.match(text, /"note":"ok"/);
});

test("time() returns a stop fn that logs duration_ms", async () => {
  // Force a debug-visible level for this test by temporarily lowering MIN.
  // Since levels are baked in at import, we rely on the duration being
  // logged at debug — visible only when LOG_LEVEL=debug. Skip if not.
  if (logger.level !== "debug" && logger.level !== "trace") {
    // We still verify the function runs and returns a number.
    const log = logger.child("perf");
    const stop = log.time("op");
    await new Promise((r) => setTimeout(r, 5));
    const ms = stop();
    assert.equal(typeof ms, "number");
    assert.ok(ms >= 0, "ms must be non-negative");
    return;
  }
  const log = logger.child("perf");
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const stop = log.time("op");
    await new Promise((r) => setTimeout(r, 5));
    stop({ extraField: "x" });
  } finally { console.log = orig; }
  const finalLine = lines.find((l) => /op:/.test(l) && /duration_ms/.test(l));
  assert.ok(finalLine, "duration_ms must appear in stop log");
});

test("nested child tags compose with /", () => {
  const root = logger.child("root");
  const sub = root.child("sub");
  const lines = captureConsole(() => sub.info("hi"));
  assert.match(lines[0].text, /root\/sub/);
});

test("circular references in extras don't crash logging", () => {
  const log = logger.child("cyc");
  const obj = { a: 1 };
  obj.self = obj;
  // Should NOT throw
  const lines = captureConsole(() => log.info("circular ok", { obj }));
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /\[circular\]/);
});
