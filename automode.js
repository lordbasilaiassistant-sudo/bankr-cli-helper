// Auto-mode engine — runs scheduled actions against the Bankr CLI on behalf of
// the user. Kill switch, budget caps, action log, resumable across restarts.

const fs = require("fs");
const path = require("path");
const dlog = require("./lib/logger").child("automode");

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "automode.json");
const LOG_FILE = path.join(DATA_DIR, "automode-log.jsonl");
const QUEUE_FILE = path.join(DATA_DIR, "token-queue.json");

// Cap log to 5 MB rolling — appendFileSync forever bloats and slows reads.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
// After this many consecutive failures, a token is quarantined (moved out of
// the active queue into queue.failed[]) so a single bad token can't burn
// through everyone's gas budget by infinitely retrying.
const MAX_TOKEN_FAILURES = 3;
// Bound the wallet-key fingerprint so we know if settings changed
// underneath us mid-tick. Auto-mode disables itself on detected drift.
let lastSeenKeyFingerprint = null;

// --- Default config ---
const DEFAULT_STATE = {
  enabled: false,
  killSwitch: false,
  strategy: "balanced", // conservative | balanced | aggressive
  limits: {
    maxLaunchesPerDay: 1,
    claimThresholdUsd: 5,
    maxUsdPerAction: 10,
    minEthReserveWei: "1000000000000000", // 0.001 ETH as safety floor
  },
  schedule: {
    claimFees: { intervalMin: 360, enabled: true },        // every 6 hours
    launchToken: { intervalMin: 1440, enabled: false },    // daily, OFF by default
    snapshotPortfolio: { intervalMin: 60, enabled: true }, // hourly
    refreshWhoami: { intervalMin: 720, enabled: true },    // twice a day
  },
  state: {
    lastRun: {},          // action name -> epoch ms
    launchesToday: 0,
    resetDay: null,
    lastPortfolio: null,  // last portfolio snapshot summary
    lastClaimUsd: null,
    totalClaimedUsd: 0,
    totalLaunches: 0,
  },
};

// --- Seed creative token name pool (ancient/dead-language per CLAUDE.md) ---
const DEFAULT_QUEUE = {
  queue: [
    { name: "Aethermind",   symbol: "AETHM", theme: "greek, mind of the aether" },
    { name: "Sibylla",      symbol: "SYBL",  theme: "oracle" },
    { name: "Tenebris",     symbol: "TNBS",  theme: "latin, darkness" },
    { name: "Nyxara",       symbol: "NYX",   theme: "night personified" },
    { name: "Eidolon",      symbol: "EIDO",  theme: "phantom/apparition" },
    { name: "Korvax",       symbol: "KRVX",  theme: "synthetic nordic" },
    { name: "Yggdrasir",    symbol: "YGGR",  theme: "world tree" },
    { name: "Morrigan",     symbol: "MRGN",  theme: "celtic battle crow" },
    { name: "Fenrirum",     symbol: "FNRM",  theme: "bound wolf" },
    { name: "Chaosphere",   symbol: "CHSP",  theme: "pre-order" },
    { name: "Vantablast",   symbol: "VBLT",  theme: "void" },
    { name: "Hypernova",    symbol: "HYPN",  theme: "stellar cataclysm" },
  ],
};

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2));
    return structuredClone(DEFAULT_STATE);
  }
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // merge with defaults in case new keys were added
    return deepMerge(structuredClone(DEFAULT_STATE), saved);
  } catch (e) {
    dlog.error("corrupt state — resetting", { err: e.message });
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function deepMerge(a, b) {
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) {
      a[k] = deepMerge(a[k] || {}, b[k]);
    } else {
      a[k] = b[k];
    }
  }
  return a;
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(DEFAULT_QUEUE, null, 2));
    return structuredClone(DEFAULT_QUEUE);
  }
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
  } catch (e) {
    return structuredClone(DEFAULT_QUEUE);
  }
}

function saveQueue(q) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}

// --- Action log (append-only JSONL with size-based rotation) ---
// `kind` is the source of the entry — "auto" by default since this logger
// is owned by the automode engine. The Activity page (Phase 5) uses this
// field to filter entries; future chat/manual writes should write through
// here too with kind: "chat" / "manual" so they show up in the same feed.
function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), kind: "auto", ...entry });
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
    // Cheap rotation: every ~50 writes, check size. If exceeded, keep
    // last half. Avoids unbounded growth without paying stat() per call.
    if (Math.random() < 0.02) maybeRotateLog();
  } catch (e) {
    // Logging must never crash the engine. Swallow.
    dlog.warn("jsonl write failed", { err: e.message });
  }
}

function maybeRotateLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    const all = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    const keep = all.slice(Math.floor(all.length / 2));
    fs.writeFileSync(LOG_FILE + ".tmp", keep.join("\n") + "\n");
    fs.renameSync(LOG_FILE + ".tmp", LOG_FILE);
    dlog.info(`jsonl rotated`, { kept: keep.length, total: all.length });
  } catch (e) {
    dlog.warn("jsonl rotate failed", { err: e.message });
  }
}

// Find the first balanced JSON object in a string. Replaces the previous
// greedy /\{[\s\S]*\}/ which matched from the first { to the LAST },
// merging multiple JSON blobs in CLI output and producing parse errors —
// the kind of "intermittent fees claim" failure that's nearly impossible
// to reproduce because it depends on the order CLI prints things.
function extractFirstJsonObject(s) {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// Settings fingerprint — short hash of the bankr key suffix so we can
// detect "key was rotated mid-cycle" without ever logging the key itself.
function keyFingerprint(settings) {
  const k = settings && settings.bankrApiKey ? settings.bankrApiKey : "";
  if (!k) return "(none)";
  return k.slice(0, 4) + "…" + k.slice(-4);
}

function readLog(lastN = 100) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-lastN)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean)
    .reverse();
}

// --- Utilities ---
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function maybeRollDailyCounters(state) {
  const today = todayKey();
  if (state.state.resetDay !== today) {
    state.state.resetDay = today;
    state.state.launchesToday = 0;
    saveState(state);
  }
}

function shouldRun(state, action) {
  const schedule = state.schedule[action];
  if (!schedule || !schedule.enabled) return false;
  const last = state.state.lastRun[action] || 0;
  const intervalMs = schedule.intervalMin * 60_000;
  return Date.now() - last >= intervalMs;
}

function markRan(state, action) {
  state.state.lastRun[action] = Date.now();
  saveState(state);
}

// --- Actions ---
// Each action is an async fn given a ctx { runBankr, settings, state, log }

// Bounded read retry — Bankr's read endpoints occasionally 500. Without a
// retry, every transient failure marks the action ran (markRan updates
// lastRun), so the action sleeps for a full interval before being retried.
// Three tries with linear backoff covers the typical blip without burning
// minutes on a real outage.
async function readWithRetry(ctx, cmd, maxAttempts = 3) {
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    last = await ctx.runBankr(cmd, ctx.settings);
    if (last.ok) return last;
    if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return last;
}

async function actionRefreshWhoami(ctx) {
  const r = await readWithRetry(ctx, "whoami");
  ctx.log({ action: "refresh_whoami", ok: r.ok, bytes: r.output.length });
  return r;
}

async function actionSnapshotPortfolio(ctx) {
  const r = await readWithRetry(ctx, "wallet portfolio --all --json");
  let summary = null;
  if (r.ok) {
    try {
      const blob = extractFirstJsonObject(r.output);
      if (blob) {
        const p = JSON.parse(blob);
        // Sum native balances + total per chain — gives a realistic "total
        // wallet value" instead of relying on a single field that the CLI
        // may or may not include depending on flags.
        let totalUsd = 0;
        const chains = [];
        if (p.balances && typeof p.balances === "object") {
          for (const [chain, data] of Object.entries(p.balances)) {
            chains.push(chain);
            totalUsd += Number(data.total || data.nativeUsd || 0);
          }
        }
        // Track native ETH on Base — used by preflightLaunch to refuse
        // launches that would drain gas reserves.
        const baseEthWei = (p.balances && p.balances.base && p.balances.base.nativeBalance)
          ? String(p.balances.base.nativeBalance) : null;
        summary = {
          totalUsd: totalUsd || null,
          tokenCount: chains.reduce((acc, c) => acc + ((p.balances[c].tokenBalances || []).length), 0),
          chains,
          baseEthWei,
        };
      }
    } catch (_) {}
    if (!summary) summary = { preview: r.output.slice(0, 400) };
    ctx.state.state.lastPortfolio = summary;
  }
  ctx.log({ action: "snapshot_portfolio", ok: r.ok, summary, error: r.ok ? undefined : r.output.slice(0, 200) });
  return r;
}

async function actionClaimFees(ctx) {
  const read = await readWithRetry(ctx, "fees --json");
  // CRITICAL: if the fees read fails, do NOT proceed to claim. The previous
  // code treated read-failure as "unknown claimable" and claimed anyway,
  // which on a stale wallet just wasted gas on a no-op fees claim-wallet.
  if (!read.ok) {
    ctx.log({ action: "claim_fees", skipped: "read_failed", error: read.output.slice(0, 200) });
    return { ok: false, skipped: true, reason: "read_failed" };
  }
  let claimable = null;
  try {
    const blob = extractFirstJsonObject(read.output);
    if (blob) {
      const j = JSON.parse(blob);
      claimable = j.totalClaimableUsd ?? j.claimableUsd ?? j.claimable ?? null;
      // Doppler / Clanker payload doesn't expose totalClaimableUsd — sum
      // per-token if needed. Falls back to "claim anyway" only if we
      // truly can't parse anything.
      if (claimable === null && Array.isArray(j.tokens)) {
        claimable = j.tokens.reduce((acc, t) => acc + Number(t.claimableUsd || t.usd || 0), 0);
      }
    }
  } catch (e) {
    ctx.log({ action: "claim_fees", note: "json_parse_failed", error: e.message });
  }

  const threshold = ctx.state.limits.claimThresholdUsd;
  if (claimable !== null && claimable < threshold) {
    ctx.log({ action: "claim_fees", skipped: "below_threshold", claimable, threshold });
    return { ok: true, skipped: true };
  }

  const r = await ctx.runBankr("fees claim-wallet --all -y", ctx.settings);
  if (r.ok && claimable) {
    ctx.state.state.totalClaimedUsd = (ctx.state.state.totalClaimedUsd || 0) + claimable;
    ctx.state.state.lastClaimUsd = claimable;
  }
  ctx.log({ action: "claim_fees", ok: r.ok, claimable, output: r.output.slice(0, 500) });
  return r;
}

const NAME_RE = /^[A-Za-z0-9 _\-]{1,40}$/;
const SYMBOL_RE = /^[A-Z0-9]{1,10}$/;

async function actionLaunchToken(ctx) {
  maybeRollDailyCounters(ctx.state);
  const cap = ctx.state.limits.maxLaunchesPerDay;
  if (ctx.state.state.launchesToday >= cap) {
    ctx.log({ action: "launch_token", skipped: "daily_cap", cap });
    return { ok: true, skipped: true };
  }

  // Reserve check — refuse to launch if Base ETH balance is below the
  // configured floor. A failed launch still costs gas; better to skip and
  // let the user top up than to grind their wallet to zero on retries.
  const reserveWei = BigInt(ctx.state.limits.minEthReserveWei || "0");
  const baseEthStr = ctx.state.state.lastPortfolio && ctx.state.state.lastPortfolio.baseEthWei;
  if (reserveWei > 0n && baseEthStr) {
    let baseWei;
    try { baseWei = BigInt(baseEthStr); } catch (_) { baseWei = null; }
    if (baseWei !== null && baseWei < reserveWei) {
      ctx.log({ action: "launch_token", skipped: "below_eth_reserve", baseWei: baseEthStr, reserveWei: reserveWei.toString() });
      return { ok: true, skipped: true, reason: "below_eth_reserve" };
    }
  }

  const queue = loadQueue();
  if (!queue.queue || queue.queue.length === 0) {
    ctx.log({ action: "launch_token", skipped: "empty_queue" });
    return { ok: false, skipped: true, reason: "empty_queue" };
  }

  const token = queue.queue.shift();
  saveQueue(queue);

  // Defensive re-validation even though POST /queue validates — queue file
  // is JSON on disk and may have been edited externally.
  if (!token || !NAME_RE.test(token.name || "") || !SYMBOL_RE.test(token.symbol || "")) {
    ctx.log({ action: "launch_token", skipped: "invalid_token", token });
    return { ok: false, skipped: true, reason: "invalid_token" };
  }

  // Array form — no string concatenation, no shell. All optional flags are
  // explicitly set (with "" placeholders) so the CLI's interactive prompt
  // layer — which ignores piped stdin in TUI mode — never activates.
  const args = [
    "launch",
    "--name", token.name,
    "--symbol", token.symbol,
    "--image", `https://placehold.co/512x512/1a1a26/6c5ce7/png?text=${encodeURIComponent(token.symbol)}`,
    "--tweet", "",
    "--website", "",
    "--fee", "",
    "--fee-type", "wallet",
    "-y",
  ];

  const r = await ctx.runBankr(args, ctx.settings);
  if (r.ok) {
    ctx.state.state.launchesToday += 1;
    ctx.state.state.totalLaunches = (ctx.state.state.totalLaunches || 0) + 1;
  } else {
    // Failure quarantine: track per-token failure count. After
    // MAX_TOKEN_FAILURES the token is moved into queue.failed[] so it
    // stops eating launch slots / gas on every tick. The user can
    // inspect queue.failed and reinstate manually if they want to try
    // again with different params.
    const q2 = loadQueue();
    token._failures = (token._failures || 0) + 1;
    if (token._failures >= MAX_TOKEN_FAILURES) {
      q2.failed = q2.failed || [];
      q2.failed.unshift({ ...token, lastError: r.output.slice(0, 300), quarantinedAt: new Date().toISOString() });
      ctx.log({ action: "launch_token", ok: false, token, quarantined: true, failures: token._failures });
    } else {
      q2.queue.unshift(token);
      ctx.log({ action: "launch_token", ok: false, token, failures: token._failures, output: r.output.slice(0, 500) });
    }
    saveQueue(q2);
    return r;
  }
  ctx.log({ action: "launch_token", ok: r.ok, token, output: r.output.slice(0, 500) });
  return r;
}

const ACTIONS = {
  refreshWhoami:     actionRefreshWhoami,
  snapshotPortfolio: actionSnapshotPortfolio,
  claimFees:         actionClaimFees,
  launchToken:       actionLaunchToken,
};

// --- Engine ---
let timer = null;
let tickBusy = false;
let runBankrRef = null;
let loadSettingsRef = null;

async function tick() {
  if (tickBusy) {
    dlog.trace("tick skipped — busy");
    return;
  }
  tickBusy = true;
  const stopTick = dlog.time("tick");
  try {
    let state = loadState();
    if (!state.enabled || state.killSwitch) {
      dlog.trace("tick noop", { enabled: state.enabled, killSwitch: state.killSwitch });
      return;
    }

    maybeRollDailyCounters(state);

    const settings = loadSettingsRef();

    // Preflight #1: refuse to act if the Bankr API key is missing. Without
    // it the CLI can't authenticate any action and we'd just spam failures.
    if (!settings || !settings.bankrApiKey) {
      log({ action: "tick_halt", reason: "missing_bankr_key" });
      // Auto-disable so the engine doesn't keep firing every minute.
      state.enabled = false;
      saveState(state);
      return;
    }

    // Preflight #2: detect key rotation mid-cycle. If the user changed
    // their bankr key (e.g. through Settings), we refuse to keep running
    // automated actions on the new wallet without explicit re-enable.
    // First-tick captures the fingerprint; subsequent ticks compare.
    const fp = keyFingerprint(settings);
    if (lastSeenKeyFingerprint && lastSeenKeyFingerprint !== fp) {
      log({ action: "tick_halt", reason: "wallet_key_rotated", from: lastSeenKeyFingerprint, to: fp });
      state.enabled = false;
      saveState(state);
      lastSeenKeyFingerprint = fp;
      return;
    }
    lastSeenKeyFingerprint = fp;

    const due = Object.keys(ACTIONS).filter((a) => shouldRun(state, a));
    if (due.length === 0) {
      dlog.trace("nothing due");
      return;
    }
    dlog.info("tick: actions due", { due });

    const ctx = {
      runBankr: runBankrRef,
      settings,
      state,
      log,
    };

    for (const action of due) {
      // Re-read state BEFORE each action so a kill or disable from the UI
      // takes effect immediately, not at the next 60s tick. The UI writes
      // straight to disk via setKillSwitch / updateConfig, so loadState
      // here picks it up. Also re-pin ctx.state so action handlers see fresh.
      const fresh = loadState();
      if (!fresh.enabled || fresh.killSwitch) {
        const remaining = due.slice(due.indexOf(action));
        log({ action: "tick_halt", reason: fresh.killSwitch ? "kill_switch" : "disabled", skipped: remaining });
        state = fresh;
        break;
      }
      ctx.state = fresh;
      state = fresh;
      const stopAction = dlog.time(`action ${action}`);
      try {
        const r = await ACTIONS[action](ctx);
        stopAction({ ok: r && r.ok !== false, skipped: r && r.skipped, reason: r && r.reason });
      } catch (e) {
        stopAction({ error: e.message });
        dlog.error(`action threw: ${action}`, { err: e.message });
        log({ action, ok: false, error: e.message });
      }
      markRan(state, action);
    }
    saveState(state);
  } finally {
    tickBusy = false;
    stopTick();
  }
}

function start({ runBankr, loadSettings }) {
  runBankrRef = runBankr;
  loadSettingsRef = loadSettings;
  if (timer) return;
  timer = setInterval(tick, 60_000); // every minute — cheap, mostly no-op
  // fire a tick shortly after startup so enabled jobs don't wait a full minute
  setTimeout(tick, 5_000);
  dlog.info("engine armed", { interval_ms: 60_000 });
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function getStatus() {
  const state = loadState();
  const queue = loadQueue();
  return {
    ...state,
    queueSize: queue.queue.length,
    queuePreview: queue.queue.slice(0, 3),
    recentLog: readLog(20),
  };
}

function updateConfig(partial) {
  const state = loadState();
  const merged = deepMerge(state, partial);
  saveState(merged);
  return merged;
}

function setKillSwitch(on) {
  const state = loadState();
  state.killSwitch = !!on;
  if (on) state.enabled = false;
  saveState(state);
  log({ action: "kill_switch", on: !!on });
  return state;
}

async function runActionNow(actionName) {
  if (!ACTIONS[actionName]) throw new Error(`Unknown action: ${actionName}`);
  dlog.warn("runActionNow invoked (manual override)", { action: actionName });
  const stopAct = dlog.time(`runActionNow ${actionName}`);
  const state = loadState();
  const settings = loadSettingsRef();
  const ctx = {
    runBankr: runBankrRef,
    settings,
    state,
    log,
  };
  try {
    const r = await ACTIONS[actionName](ctx);
    stopAct({ ok: r && r.ok !== false, skipped: r && r.skipped, reason: r && r.reason });
    markRan(state, actionName);
    saveState(state);
    return r;
  } catch (e) {
    stopAct({ error: e.message });
    dlog.error(`runActionNow threw: ${actionName}`, { err: e.message });
    throw e;
  }
}

module.exports = {
  start,
  stop,
  tick,
  getStatus,
  updateConfig,
  setKillSwitch,
  runActionNow,
  loadState,
  saveState,
  loadQueue,
  saveQueue,
  readLog,
};
