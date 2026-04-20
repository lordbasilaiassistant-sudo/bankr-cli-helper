// Auto-mode engine — runs scheduled actions against the Bankr CLI on behalf of
// the user. Kill switch, budget caps, action log, resumable across restarts.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "automode.json");
const LOG_FILE = path.join(DATA_DIR, "automode-log.jsonl");
const QUEUE_FILE = path.join(DATA_DIR, "token-queue.json");

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
    console.error("[automode] corrupt state, resetting:", e.message);
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

// --- Action log (append-only JSONL) ---
function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_FILE, line + "\n");
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

async function actionRefreshWhoami(ctx) {
  const r = await ctx.runBankr("whoami", ctx.settings);
  ctx.log({ action: "refresh_whoami", ok: r.ok, bytes: r.output.length });
  return r;
}

async function actionSnapshotPortfolio(ctx) {
  const r = await ctx.runBankr("wallet portfolio --all --json", ctx.settings);
  let summary = null;
  if (r.ok) {
    try {
      const jsonMatch = r.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const p = JSON.parse(jsonMatch[0]);
        summary = {
          totalUsd: p.totalUsd ?? p.total ?? null,
          tokenCount: (p.tokens || p.balances || []).length,
          chains: p.chains ? Object.keys(p.chains) : undefined,
        };
      }
    } catch (_) {
      // portfolio may not be pure JSON; fall back to text preview
    }
    if (!summary) {
      summary = { preview: r.output.slice(0, 400) };
    }
    ctx.state.state.lastPortfolio = summary;
  }
  ctx.log({ action: "snapshot_portfolio", ok: r.ok, summary });
  return r;
}

async function actionClaimFees(ctx) {
  // First check claimable
  const read = await ctx.runBankr("fees --json", ctx.settings);
  let claimable = null;
  if (read.ok) {
    try {
      const m = read.output.match(/\{[\s\S]*\}/);
      if (m) {
        const j = JSON.parse(m[0]);
        claimable = j.totalClaimableUsd || j.claimableUsd || j.claimable || null;
      }
    } catch (_) {}
  }

  const threshold = ctx.state.limits.claimThresholdUsd;
  if (claimable !== null && claimable < threshold) {
    ctx.log({ action: "claim_fees", skipped: "below_threshold", claimable, threshold });
    return { ok: true, skipped: true };
  }

  // Attempt the claim
  const r = await ctx.runBankr("fees claim-wallet --all -y", ctx.settings);
  if (r.ok && claimable !== null) {
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
    // push token back to front of queue on failure
    queue.queue.unshift(token);
    saveQueue(queue);
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
  if (tickBusy) return;
  tickBusy = true;
  try {
    const state = loadState();
    if (!state.enabled || state.killSwitch) return;

    maybeRollDailyCounters(state);

    const due = Object.keys(ACTIONS).filter((a) => shouldRun(state, a));
    if (due.length === 0) return;

    const settings = loadSettingsRef();
    const ctx = {
      runBankr: runBankrRef,
      settings,
      state,
      log,
    };

    for (const action of due) {
      if (state.killSwitch) break;
      try {
        await ACTIONS[action](ctx);
      } catch (e) {
        log({ action, ok: false, error: e.message });
      }
      markRan(state, action);
    }
    saveState(state);
  } finally {
    tickBusy = false;
  }
}

function start({ runBankr, loadSettings }) {
  runBankrRef = runBankr;
  loadSettingsRef = loadSettings;
  if (timer) return;
  timer = setInterval(tick, 60_000); // every minute — cheap, mostly no-op
  // fire a tick shortly after startup so enabled jobs don't wait a full minute
  setTimeout(tick, 5_000);
  console.log("[automode] engine armed");
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
  const state = loadState();
  const settings = loadSettingsRef();
  const ctx = {
    runBankr: runBankrRef,
    settings,
    state,
    log,
  };
  const r = await ACTIONS[actionName](ctx);
  markRan(state, actionName);
  saveState(state);
  return r;
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
