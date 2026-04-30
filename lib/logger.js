// Tiny structured logger — no deps. Console + rolling JSONL on disk so
// post-mortems are possible without re-running. Designed to be shouty when
// LOG_LEVEL=debug and quiet otherwise.
//
// Usage:
//   const log = require("./lib/logger").child("chat");
//   log.info("turn start", { threadId, message });
//   const stop = log.time("groq call");
//   ...
//   stop({ tokens });            // logs duration_ms + extras at debug
//
// Levels: trace < debug < info < warn < error. Default = info.
// Override with env: LOG_LEVEL=debug, LOG_FILE=0 to disable disk output.

const fs = require("node:fs");
const path = require("node:path");

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const ENV_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const MIN_LEVEL = LEVELS[ENV_LEVEL] ?? LEVELS.info;
const TO_FILE = process.env.LOG_FILE !== "0";

const LOG_DIR = path.join(__dirname, "..", "data");
const LOG_FILE = path.join(LOG_DIR, "logs.jsonl");
const LOG_MAX_BYTES = 5 * 1024 * 1024;

let writeCount = 0;
function maybeRotate() {
  if (!TO_FILE) return;
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    const all = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    const keep = all.slice(Math.floor(all.length / 2));
    fs.writeFileSync(LOG_FILE + ".tmp", keep.join("\n") + "\n");
    fs.renameSync(LOG_FILE + ".tmp", LOG_FILE);
  } catch (_) { /* swallow — logging must never crash */ }
}

function safeStringify(v) {
  // Defensive: redact obvious secret-shaped fields and avoid circular refs.
  const seen = new WeakSet();
  return JSON.stringify(v, (k, val) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[circular]";
      seen.add(val);
    }
    if (typeof val === "string" && /(?:bk_|gsk_|sk-)[A-Za-z0-9_-]{12,}/.test(val)) {
      return val.slice(0, 6) + "…REDACTED…" + val.slice(-4);
    }
    return val;
  });
}

function emit(level, tag, msg, extra) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const ts = new Date().toISOString();
  const line = { ts, level, tag, msg, ...(extra || {}) };
  const flat = `[${ts.slice(11, 23)}] ${level.toUpperCase().padEnd(5)} ${tag.padEnd(10)} ${msg}` +
    (extra && Object.keys(extra).length ? " " + safeStringify(extra) : "");
  if (level === "error" || level === "warn") {
    console.error(flat);
  } else {
    console.log(flat);
  }
  if (TO_FILE) {
    try {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, safeStringify(line) + "\n");
      if ((++writeCount & 0x3f) === 0) maybeRotate(); // every 64 writes
    } catch (_) {}
  }
}

function child(tag) {
  const t = String(tag).slice(0, 16);
  const api = {
    trace: (msg, extra) => emit("trace", t, msg, extra),
    debug: (msg, extra) => emit("debug", t, msg, extra),
    info:  (msg, extra) => emit("info",  t, msg, extra),
    warn:  (msg, extra) => emit("warn",  t, msg, extra),
    error: (msg, extra) => emit("error", t, msg, extra),
    // time(label) → stop({extra}). Logs at debug on stop with duration_ms.
    time(label) {
      const start = process.hrtime.bigint();
      api.trace(`${label}: start`);
      return (extra) => {
        const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
        api.debug(`${label}: ${ms}ms`, { duration_ms: ms, ...(extra || {}) });
        return ms;
      };
    },
    child: (sub) => child(`${t}/${sub}`),
  };
  return api;
}

module.exports = {
  child,
  level: ENV_LEVEL,
  LEVELS,
  // Test-only: lets a unit test inspect file output and rotate the file.
  __test: {
    LOG_FILE,
    forceRotate: maybeRotate,
  },
};
