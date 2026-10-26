/**
 *  ================================================================
 *  PUMP.FUN MIGRATION SNIPER — FINAL BUILD
 *
 *  Watches: 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg
 *  Buy:     PumpSwap SDK — direct on-chain, no external API
 *  Sell:    PumpSwap SDK — direct on-chain, no external API
 *  Data:    DexScreener with fast retry
 *  Detect:  WebSocket (primary) + RPC poll (backup)  
 *
 *  AGE-AWARE FILTERS:
 *  Vol/MCap:   0s-30s=0.05x  30s-2m=0.15x  2m-10m=0.3x  10m+=0.8x
 *  Top10%:     0s-30s<50%    30s-2m<45%    2m-10m<40%   10m+<20%
 *  LP/holder:  flat $40+    Min holders: 30
 *
 *  WATCHLIST:
 *  5+/7 → fast scan every 8s for 5min → drops
 *  Auto-buys if score reaches 7/7 with positive slope
 *
 *  TELEGRAM BUTTONS:
 *  Long-polling with 409 guard — retries with backoff
 *  Refresh shows live score + all checks
 *  Force Buy bypasses filters
 * ================================================================
 */

const dotenv = require("dotenv");
dotenv.config();

// Helius RPC — fallback to env RPC_URL if HELIUS_API_KEY not set
if (!process.env.RPC_URL && !process.env.HELIUS_API_KEY) { console.error("❌ Missing RPC_URL or HELIUS_API_KEY"); process.exit(1); }
if (!process.env.RPC_URL) process.env.RPC_URL = "https://mainnet.helius-rpc.com/?api-key=" + (process.env.HELIUS_API_KEY || "0528a525-35e6-4fb9-8c54-90fcaf29a7ca");
if (!process.env.WALLET_PRIVATE_KEY) { console.error("❌ Missing WALLET_PRIVATE_KEY"); process.exit(1); }

const {
  Connection, PublicKey, Keypair,
  LAMPORTS_PER_SOL, Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");

const {
  getAssociatedTokenAddressSync,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const axios          = require("axios");
const bs58           = require("bs58");
const WebSocket      = require("ws");
const brain          = require("./brain");

// ── Jupiter API headers — top-level so checkHoneypot/checkSellViable can use them ──
const JUP_HEADERS = process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {};
const { executeJitoBuy } = require("./jitoExecutor");
const { logPaperTrade, checkPaperPositions, paperTrades } = require("./paperLog");

// ================================================================
//  CONFIG — edit these values to tune the bot
// ================================================================
const CONFIG = {
  RPC_URL:            process.env.RPC_URL,
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID,

  MIGRATION_PROGRAM: "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
  WSOL:              "So11111111111111111111111111111111111111112",
  PUMP_AMM_PK:       "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  PUMP_PROGRAM_PK:   "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",

  // ── Trade ──────────────────────────── ADJUSTABLE
  BUY_AMOUNT_SOL:             0.0025,
  PRIORITY_FEE_MICROLAMPORTS: 250000,

  // ── Base filters (overridden by age-aware logic in runFilters) ──
  MIN_LIQUIDITY_USD: 10000,
  MAX_LIQUIDITY_USD: 20000,
  LIQUIDITY_DRAIN_PCT: 0.40, LIQUIDITY_DRAIN_CONFIRM_MS: 20000, LIQUIDITY_ABS_FLOOR: 2000,
  MIN_VOLUME_USD:    30000,
  MIN_MCAP_USD:      10000,
  MAX_AGE_HOURS:     0.25,
  MIN_HOLDERS:       60,     // minimum total holder count
  MIN_LP_PER_HOLDER: 65,     // flat LP/holder threshold (replaces age-tiered)

  // ── Protection ─────────────────────── ADJUSTABLE
  STOP_LOSS_PCT:   -25,
  VOLUME_DROP_PCT: 0.65, 

  // ── Cluster ────────────────────────── ADJUSTABLE
  CLUSTER_WALLETS:   20,
  CLUSTER_DIFF:      0.5,
  CLUSTER_EXIT_GAIN: 20,

  // ── Profit lock — trailing floor ───── ADJUSTABLE
  // Once gain hits trigger, floor is set. If price drops to floor → sell 100%
  PROFIT_LOCK_TRIGGERS: [
  { gain: 30,    floor: 15    },  // locks 50%
  { gain: 50,    floor: 30    },  // locks 60%
  { gain: 60,    floor: 40    },  // locks 67%
  { gain: 80,    floor: 60    },  // locks 75%
  { gain: 100,   floor: 75    },  // locks 75%
  { gain: 150,   floor: 120   },  // locks 80%
  { gain: 220,   floor: 180   },  // locks 82%
  { gain: 300,   floor: 250   },  // locks 83%
  { gain: 500,   floor: 425   },  // locks 85%
  { gain: 700,   floor: 600   },  // locks 86%
  { gain: 1000,  floor: 870   },  // locks 87%
  { gain: 1500,  floor: 1320  },  // locks 88%
  { gain: 2000,  floor: 1780  },  // locks 89%
  { gain: 3000,  floor: 2700  },  // locks 90%
  { gain: 5000,  floor: 4550  },  // locks 91%
  { gain: 7000,  floor: 6440  },  // locks 92%
  { gain: 10000, floor: 9300  },  // locks 93%
],

  TRAIL_STALL_MS: 180000,        // 30s no new high → exit at current gain

  // ── Position management ─────────────── ADJUSTABLE
  MAX_POSITIONS:         2,    // never hold more than 2 at once
  BREAKEVEN_EXIT:        true, // sell immediately if price returns to buy price
  PRE_BUY_STALL_MS:      45000, // if active pos hasn't hit T1 after 1min, sell it first

  // ── Timing ─────────────────────────── ADJUSTABLE
  POST_MIGRATION_DELAY_MS: 200,
  RESCAN_DELAY_MS:         13000,
  RESCAN_MAX:              5,
  MONITOR_INTERVAL_MS:     2000,
  POLL_INTERVAL_MS:        1500,

  // ── Momentum slope (#1) ────────────── ADJUSTABLE
  // Requires at least SLOPE_MIN_READINGS mcap snapshots before evaluating
  SLOPE_MIN_READINGS:      3,
  // Slope must be >= this value (0 = any upward movement required)
  SLOPE_MIN:               800,
  SLOPE_RECHECK_MS:        1200,  // wait before the 7/7 rescore at migration (auto-buy path 2)

  // ── Watchlist scan timing ── ADJUSTABLE
  // Scans every WATCH_SCAN_MS (timer). A coin younger than WATCH_FAST_WINDOW_MS is
  // scanned on every tick; older coins are scanned at most every WATCH_SLOW_MS.
  // Each scan costs DexScreener/GeckoTerminal and RPC calls, so faster = more 429s.
  WATCH_SCAN_MS:           6000,
  WATCH_FAST_WINDOW_MS:    3 * 60 * 1000,
  WATCH_SLOW_MS:           8000,

  // ── Wash trading (#3) ──────────────── ADJUSTABLE
  // Only flag wash if 5m volume exceeds this threshold (avoids false positives on new coins)
  WASH_VOL_THRESHOLD:      1000, // only flag if meaningful 5m volume present
  // Minimum unique buy txns in 5m — below this with high volume = wash
  WASH_MIN_UNIQUE_BUYS:    3,

  // ── Honeypot simulation (#4) ───────── ADJUSTABLE
  // Max acceptable price impact % on simulated sell — above this = skip
  HONEYPOT_MAX_IMPACT_PCT: 8, // tighter threshold — legit coins post-migration are well under 8%

  // ── Re-entry after stop loss (#6) ─── ADJUSTABLE
  REENTRY_WINDOW_MS:       0, // 2 minutes to watch for recovery
  REENTRY_SIZE_PCT:        0,     // buy at 50% of normal BUY_AMOUNT_SOL on re-entry

  // ── Brain advisor ──────────────────── ADJUSTABLE
  // Set false to disable completely — bot behaves exactly as before
  BRAIN_ENABLED:           true,

  // ── Dead position cleaner ──────────── ADJUSTABLE
  // Sweeps positions that are bleeding early with no momentum
  DEAD_HOLD_MS:          10 * 60 * 1000, // 10min minimum before cleaner fires
  DEAD_MAX_PEAK_PCT:     5,              // only cleans if peak gain never exceeded 5%
  DEAD_EXIT_THRESHOLD:   -25,            // sell if current gain <= -25%

  // ── Bundle detection ───────────────── ADJUSTABLE
  // Scans first txs after migration for coordinated sniper wallets
  BUNDLE_TX_LIMIT:       15,   // how many txs to scan (more = slower but thorough)
  BUNDLE_SAME_SLOT:      3,    // min wallets buying in same slot = bundle flag
  BUNDLE_SIZE_DIFF_PCT:  15,   // max % difference in buy size to count as coordinated
  BUNDLE_MAX_SCORE:      2,    // block if this many bundle signals fire (0=disable)

  // ── Bonding curve history rug check ── ADJUSTABLE
  // Exactly 2 RPC calls per migration:
  //   call 1 = signatures on the bonding curve account (full bonding history)
  //   call 2 = ONE batched getParsedTransactions on the oldest + newest txs
  // Runs in parallel with POST_MIGRATION_DELAY_MS, so it adds no extra delay.
  BONDING_RUG_CHECK:         false,
  BONDING_SIG_LIMIT:         1000, // call 1: max signatures pulled from the curve
  BONDING_TX_SAMPLE:         50,   // call 2: txs parsed in one batch (half oldest, half newest)
  BONDING_DEV_SOLD_PCT:      50,   // creator sold >= this % of what they bought = dev dump (worth 2 pts)
  BONDING_TOP_BUYER_PCT:     35,   // one wallet >= this % of sampled buy SOL = flag (1 pt)
  BONDING_EARLY_SLOT_BUYERS: 4,    // >= this many wallets buying in the first 2 slots = flag (1 pt)
  BONDING_MIN_UNIQUE_BUYERS: 8,    // fewer unique buyers in the sample = flag (1 pt)
  BONDING_MAX_SCORE:         2,    // block when points >= this (0 = disable)

  // ── Conviction exits ───────────────── ADJUSTABLE
  CONVICTION_MIN_GAIN:   50,   // must hit this % gain within time window
  CONVICTION_TIME_MS:    10 * 60 * 1000, // 10min window
  SLIDING_STOP_3MIN:     -15,  // if no +20% by 3min and down this much → cut
  SLIDING_STOP_8MIN:     50,   // if peak hasn't hit this by 8min → cut regardless
  VOL_VELOCITY_DROP:     0.60, // vol must be at least 60% of entry vol at T+5min
  MOMENTUM_DROP:         0.85, // mcap at T+5min must be >= 85% of T+1min mcap
};

// ─────────────────────────────────────────────
//  TOKEN-2022 DETECTION
// ─────────────────────────────────────────────
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
async function getTokenProgramId(mintPk) {
  try {
    var info = await connection.getAccountInfo(mintPk);
    if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  } catch (e) {}
  return TOKEN_PROGRAM_ID;
}

// ─────────────────────────────────────────────
//  SKIP LIST
// ─────────────────────────────────────────────
const SKIP = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bwd",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5zP9QkNEe7z62ZP",
  "CebN5WGQ4jvEPvsVU4EoHEpgznyQHeXF4EZAiMmWUYrX",
  "So11111111111111111111111111111111111111112",
  "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw",
]);

// ─────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────
const connection     = new Connection(CONFIG.RPC_URL, "confirmed");
const positions      = {};
const processedSigs  = new Set();
const processedMints = new Map();
const buying         = new Set();
const selling        = new Set(); // lock — prevents concurrent sells on the same mint
const watchlist      = new Map();
const failedMints    = new Set(); // permanently blocks coins that failed due to insufficient funds
let   lastSig        = null;

// ─────────────────────────────────────────────
//  MINT STATE MACHINE
//  Single source of truth for every mint's lifecycle.
//  All entry points (WS, RPC, Telegram, watchlist) read/write through here.
//
//  States: queued | filtering | buying | bought | selling | sold | blocked
// ─────────────────────────────────────────────
const mintState = new Map();

function setMintState(mint, state, meta) {
  var prev = mintState.get(mint);
  mintState.set(mint, Object.assign({
    state,
    reason:      (meta && meta.reason)  || "",
    source:      (meta && meta.source)  || "unknown",
    score:       (meta && meta.score)   || 0,
    lastUpdated: Date.now(),
  }, meta || {}));
  if (prev && prev.state !== state) {
    console.log("   🗺  [" + mint.slice(0,8) + "] " + prev.state + " → " + state + (meta && meta.reason ? " (" + meta.reason + ")" : ""));
  }
}

function getMintState(mint) {
  return mintState.get(mint) || { state: "unknown" };
}

// Gate: returns true if the mint can proceed to buying
function canBuy(mint) {
  var s = getMintState(mint).state;
  // Allow queued/filtering/unknown — block everything else
  return s === "queued" || s === "filtering" || s === "unknown";
}

// ─────────────────────────────────────────────
//  UNIFIED BUY REQUEST QUEUE
//  All entry points call queueBuyRequest() instead of executeBuy() directly.
//  The queue serialises requests per-mint and enforces the state machine.
// ─────────────────────────────────────────────
const buyQueue = new Map(); // mint → { dex, result, source, overrideSol, bundle }

async function queueBuyRequest(mint, dex, result, source, overrideSol, precomputedBundle) {
  var current = getMintState(mint);

  // Already past the point of no return — don't re-queue
  if (current.state === "buying" || current.state === "bought" ||
      current.state === "selling" || current.state === "sold" ||
      current.state === "blocked") {
    console.log("   ⛔ [" + mint.slice(0,8) + "] queueBuyRequest ignored — state: " + current.state);
    return;
  }

  // Dedup — if already queued from another source, skip
  if (buyQueue.has(mint)) {
    console.log("   ⛔ [" + mint.slice(0,8) + "] Already queued — ignoring duplicate from: " + source);
    return;
  }

  buyQueue.set(mint, { dex, result, source: source || "unknown", overrideSol, bundle: precomputedBundle });
  setMintState(mint, "queued", { source: source || "unknown", score: result && result.score });
  console.log("   📥 [" + mint.slice(0,8) + "] Queued for buy — source: " + (source || "unknown"));

  // Process immediately (queue is per-mint so no global serialisation needed)
  try {
    buyQueue.delete(mint);
    await executeBuy(mint, dex, result, overrideSol, precomputedBundle, source);
  } catch (e) {
    console.error("   ❌ queueBuyRequest error [" + mint.slice(0,8) + "]:", e.message);
    setMintState(mint, "blocked", { reason: "buy queue error: " + e.message.slice(0,60) });
  }
}

let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.WALLET_PRIVATE_KEY));
  console.log("✅ Wallet: " + wallet.publicKey.toBase58());
} catch {
  console.error("❌ Invalid WALLET_PRIVATE_KEY"); process.exit(1);
}

const migrationPk   = new PublicKey(CONFIG.MIGRATION_PROGRAM);
const PUMP_AMM_PK   = new PublicKey(CONFIG.PUMP_AMM_PK);
const PUMP_PROG_PK  = new PublicKey(CONFIG.PUMP_PROGRAM_PK);
const { getAssociatedTokenAddressSync: getATA } = require("@solana/spl-token");

console.log("✅ Jupiter swap ready");

// ─────────────────────────────────────────────
//  PNL TRACKER
//  Tracks every trade for per-trade cards + 3hr summary
// ─────────────────────────────────────────────
var pnlTrades    = [];   // completed trades this session
var sessionStart = Date.now();
var botPaused    = false; // controlled via /pause and /resume Telegram commands

function recordTrade(symbol, mint, solSpent, solReceived, reason, tiers) {
  var pnl     = solReceived - solSpent;
  var pnlPct  = solSpent > 0 ? (pnl / solSpent) * 100 : 0;
  var win     = pnl > 0;
  pnlTrades.push({
    symbol, mint, solSpent, solReceived, pnl, pnlPct, reason, tiers,
    time: Date.now(), win,
  });

  // Feed brain its own persistent copy — survives session report reset
  if (CONFIG.BRAIN_ENABLED) {
    try { brain.recordTrade(symbol, pnl, win, reason, tiers); } catch (e) {}
  }

  // ── Per-trade PnL card ───────────────────────────────────────────
  var emoji   = win ? "🟢" : "🔴";
  var sign    = pnl >= 0 ? "+" : "";
  var tiersHit = tiers.length ? tiers.join(" → ") : "none";
  tg(
    emoji + " *Trade Closed — " + symbol + "*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "📥 Spent:     *" + solSpent.toFixed(4)   + " SOL*\n" +
    "📤 Received:  *" + solReceived.toFixed(4) + " SOL*\n" +
    "💰 PnL:       *" + sign + pnl.toFixed(4) + " SOL*  (" + sign + pnlPct.toFixed(1) + "%)\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "🎯 Tiers hit:  " + tiersHit + "\n" +
    "🚪 Exit:       " + reason + "\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "Mint: `" + mint + "`"
  );
}

function sendSessionSummary() {
  var totalTrades  = pnlTrades.length;
  if (totalTrades === 0) {
    tg("📊 *3hr Summary*\nNo trades completed this period.");
    return;
  }
  var wins         = pnlTrades.filter(function(t) { return t.win; }).length;
  var losses       = totalTrades - wins;
  var totalSpent   = pnlTrades.reduce(function(a, t) { return a + t.solSpent; }, 0);
  var totalRec     = pnlTrades.reduce(function(a, t) { return a + t.solReceived; }, 0);
  var totalPnl     = totalRec - totalSpent;
  var winRate      = ((wins / totalTrades) * 100).toFixed(0);
  var bestTrade    = pnlTrades.reduce(function(a, t) { return t.pnl > a.pnl ? t : a; }, pnlTrades[0]);
  var worstTrade   = pnlTrades.reduce(function(a, t) { return t.pnl < a.pnl ? t : a; }, pnlTrades[0]);
  var sign         = totalPnl >= 0 ? "+" : "";
  var emoji        = totalPnl >= 0 ? "🟢" : "🔴";
  var elapsed      = Math.round((Date.now() - sessionStart) / 3600000 * 10) / 10;

  var tradeLines = pnlTrades.slice(-10).map(function(t) {
    var s = t.pnl >= 0 ? "+" : "";
    return (t.win ? "🟢" : "🔴") + " " + t.symbol + " " + s + t.pnl.toFixed(4) + " SOL (" + s + t.pnlPct.toFixed(0) + "%)";
  }).join("\n");

  tg(
    "📊 *3hr Session Report*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    emoji + " *Net PnL:   " + sign + totalPnl.toFixed(4) + " SOL*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "📈 Trades:    " + totalTrades + "  (" + wins + "W / " + losses + "L)\n" +
    "🎯 Win rate:  " + winRate + "%\n" +
    "📥 Spent:     " + totalSpent.toFixed(4) + " SOL\n" +
    "📤 Received:  " + totalRec.toFixed(4)   + " SOL\n" +
    "⏱ Runtime:   " + elapsed + "hrs\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "🏆 Best:   " + bestTrade.symbol  + "  +" + bestTrade.pnl.toFixed(4)  + " SOL\n" +
    "💀 Worst:  " + worstTrade.symbol + "  "  + worstTrade.pnl.toFixed(4) + " SOL\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "*Recent trades:*\n" + tradeLines
  );

  pnlTrades    = [];
  sessionStart = Date.now();
}



// ─────────────────────────────────────────────
//  TELEGRAM — queue + button support
//  Long-polling with 409 guard (exponential backoff)
// ─────────────────────────────────────────────
let tgQ = [], tgBusy = false, lastTg = 0;
let tgOffset = 0;
let tgPollBackoff = 3000; // starts at 3s, backs off on 409

function tg(msg) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  tgQ.push({ msg });
  if (!tgBusy) nextTg();
}

function tgWithButtons(msg, buttons) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  tgQ.push({ msg, buttons });
  if (!tgBusy) nextTg();
}

function nextTg() {
  if (!tgQ.length) { tgBusy = false; return; }
  tgBusy = true;
  var item = tgQ.shift();
  var wait = Math.max(0, 1000 - (Date.now() - lastTg));
  setTimeout(function() {
    lastTg = Date.now();
    var payload = {
      chat_id:    CONFIG.TELEGRAM_CHAT_ID,
      text:       item.msg,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    };
    if (item.buttons) {
      payload.reply_markup = { inline_keyboard: item.buttons };
    }
    axios.post(
      "https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/sendMessage",
      payload,
      { timeout: 15000 }
    ).catch(function(e) { console.error("TG send:", e.message); })
     .finally(function() { setTimeout(nextTg, 1000); });
  }, wait);
}

function tgAnswerCallback(id, text) {
  axios.post(
    "https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/answerCallbackQuery",
    { callback_query_id: id, text: text || "" },
    { timeout: 8000 }
  ).catch(function() {});
}

// Long-poll for button taps — 409 guard with backoff
async function pollCallbacks() {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    var res = await axios.get(
      "https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN +
      "/getUpdates?offset=" + tgOffset + "&timeout=2&allowed_updates=[%22callback_query%22,%22message%22]",
      { timeout: 12000 }
    );
    tgPollBackoff = 3000;
    var updates = res.data && res.data.result || [];

    for (var i = 0; i < updates.length; i++) {
      var update = updates[i];
      tgOffset = update.update_id + 1;

      // ── Button callbacks ─────────────────────────────────────────
      var cb = update.callback_query;
      if (cb && cb.data) {
        tgAnswerCallback(cb.id, "⏳");
        var data = cb.data;

        if (data.startsWith("refresh:")) {
          var mint = data.replace("refresh:", "");
          console.log("🔄 [TG] Refresh: " + mint.slice(0, 8));
          var dex = await fetchDex(mint, 3);
          if (!dex) {
            tg("⚠️ No data for `" + mint.slice(0, 8) + "...`");
          } else {
            var e2   = processedMints.get(mint);
            var fsa  = e2 && e2.firstSeenAt || Date.now();
            var bestTs2 = (dex.pairCreatedAt && dex.pairCreatedAt > 0)
              ? Math.min(fsa, dex.pairCreatedAt) : fsa;
            dex.ageMin   = (Date.now() - bestTs2) / 60000;
            dex.ageHours = dex.ageMin / 60;
            var result = await runFilters(mint, dex);
            var bar    = "█".repeat(result.score) + "░".repeat(result.total - result.score);
            var astr   = fmtAge(dex.ageMin);
            tgWithButtons(
              "🔄 *Refresh — " + dex.name + " (" + dex.symbol + ")*\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "📊 Score:  *" + result.score + "/" + result.total + "* [" + bar + "]  " +
              (result.pass ? "🟢 PASS" : "🔴 FAIL") + "\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "💰 MCap:   $" + Math.round(dex.mcap).toLocaleString() +
              (e2 && e2.initialMcap ? "  (" + (((dex.mcap - e2.initialMcap) / e2.initialMcap) * 100).toFixed(1) + "%)" : "") + "\n" +
              "💧 Liq:    $" + Math.round(dex.liq).toLocaleString() + "\n" +
              "📈 Vol:    $" + Math.round(dex.vol24h).toLocaleString() + "\n" +
              "⏱ Age:    " + astr + "\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "*Checks:*\n" + fmtChecks(result.checks) + "\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "[📊 Chart](https://dexscreener.com/solana/" + mint + ")  |  " +
              "[🐦 Birdeye](https://birdeye.so/token/" + mint + "?chain=solana)  |  " +
              "[⚡ Swap](https://jup.ag/swap/SOL-" + mint + ")\n" +
              "Mint: `" + mint + "`",
              [[
                { text: "🔄 Refresh again", callback_data: "refresh:" + mint },
                { text: "🟢 Force Buy",     callback_data: "buy:" + mint },
              ]]
            );
          }
        }

        if (data.startsWith("buy:")) {
          var mint = data.replace("buy:", "");
          if (positions[mint] && positions[mint].symbol) {
            tg("⚠️ Already in position for `" + mint.slice(0, 8) + "...`");
          } else {
            console.log("🟢 [TG] Force buy: " + mint.slice(0, 8));
            tg("🟢 *Force buy triggered* — `" + mint.slice(0, 8) + "...`");
            var dex = await fetchDex(mint, 3);
            if (dex) {
              var result = await runFilters(mint, dex);
              await queueBuyRequest(mint, dex, result, "telegram-force");
            } else {
              tg("❌ Force buy failed — no market data");
            }
          }
        }
      }

      // ── Text commands ────────────────────────────────────────────
      var msg = update.message;
      if (msg && msg.text) {
        var cmd = msg.text.trim().toLowerCase();
        console.log("📩 [TG] Command: " + cmd);

        if (cmd === "/pause") {
          botPaused = true;
          var activeCount = Object.keys(positions).filter(function(m) { return positions[m] && positions[m].symbol; }).length;
          tg("⏸ *Bot PAUSED*\nNo new buys will be made.\nCurrent positions: " + activeCount + "\nSells and monitoring still active.\nType /resume to restart buying.");
          console.log("⏸ Bot paused via Telegram");

        } else if (cmd === "/resume") {
          botPaused = false;
          tg("▶️ *Bot RESUMED*\nBuying is active again. Ready to snipe! 🎯");
          console.log("▶️ Bot resumed via Telegram");

        } else if (cmd === "/status") {
          var activeMints = Object.keys(positions).filter(function(m) { return positions[m] && positions[m].symbol; });
          var posLines = activeMints.length === 0 ? "None" : activeMints.map(function(m) {
            var p    = positions[m];
            var gain = p.buyPrice > 0 ? (((p.lastMcap || p.buyPrice) - p.buyPrice) / p.buyPrice * 100).toFixed(1) : "0.0";
            var sign = parseFloat(gain) >= 0 ? "+" : "";
            return "• " + p.symbol + " " + sign + gain + "%";
          }).join("\n");
          tg(
            (botPaused ? "⏸ *Bot Status — PAUSED*" : "▶️ *Bot Status — ACTIVE*") + "\n" +
            "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
            "📊 Positions:   " + activeMints.length + "/" + CONFIG.MAX_POSITIONS + "\n" +
            posLines + "\n" +
            "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
            "👁 Watchlist:   " + watchlist.size + " coins\n" +
            "🚫 Blocked:     " + failedMints.size + " mints\n" +
            "📈 Trades:      " + pnlTrades.length + " this session"
          );
       } else if (cmd === "/paper") {
  var pt = paperTrades;
  if (pt.length === 0) {
    tg("📋 *Paper Summary*\nNo paper trades closed this session yet.");
  } else {
    var pwins   = pt.filter(function(t) { return t.win; }).length;
    var plosses = pt.length - pwins;
    var pwr     = ((pwins / pt.length) * 100).toFixed(0);
    var pavg    = (pt.reduce(function(a, t) { return a + t.gain; }, 0) / pt.length).toFixed(1);
    var pbest   = pt.reduce(function(a, t) { return t.gain > a.gain ? t : a; }, pt[0]);
    var pworst  = pt.reduce(function(a, t) { return t.gain < a.gain ? t : a; }, pt[0]);
    var plines  = pt.slice(-20).map(function(t) {
      var s = t.gain >= 0 ? "+" : "";
      return (t.win ? "🟢" : "🔴") + " " + t.symbol + "  " + s + t.gain.toFixed(1) + "%  (" + t.heldMin + "min)  _" + t.exitReason + "_";
    }).join("\n");
    tg(
      "📋 *Paper Trading Summary*\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "📊 Signals:   *" + pt.length + "* (" + pwins + "W / " + plosses + "L)\n" +
      "🎯 Win rate:  *" + pwr + "%*\n" +
      "📈 Avg gain:  *" + (pavg >= 0 ? "+" : "") + pavg + "%*\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "🏆 Best:   " + pbest.symbol + "  +" + pbest.gain.toFixed(1) + "%\n" +
      "💀 Worst:  " + pworst.symbol + "  " + pworst.gain.toFixed(1) + "%\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "*Last 20 trades:*\n" + plines
    );
  }
        } else if (cmd === "/brain") {
          tg(brain.getBrainReport(pnlTrades));
          console.log("🧠 /brain report sent");

        } else if (cmd === "/state") {
          var stateLines = [];
          mintState.forEach(function(v, m) {
            var age = Math.round((Date.now() - v.lastUpdated) / 1000);
            stateLines.push("• `" + m.slice(0,8) + "` → *" + v.state + "* [" + age + "s ago] " + (v.reason ? v.reason.slice(0,40) : "") + (v.source ? " src:" + v.source : ""));
          });
          var stateMsg = mintState.size === 0
            ? "🗺 *Mint State Machine*\nNo mints tracked yet."
            : "🗺 *Mint State Machine* (" + mintState.size + " mints)\n━━━━━━━━━━━━━━━━━━━━━━━━\n" + stateLines.slice(-20).join("\n");
          tg(stateMsg);
          console.log("🗺 /state report sent");

        } else if (cmd === "/patterns") {
          tg(brain.getPatternsReport());
          console.log("📊 /patterns report sent");

        } else if (cmd === "/trends") {
          tg(brain.getTrendsReport());
          console.log("📈 /trends report sent");

        } else if (cmd === "/summary") {
          if (pnlTrades.length === 0) {
            tg("📊 *Summary*\nNo completed trades this session yet.");
          } else {
            var st      = pnlTrades;
            var wins    = st.filter(function(t) { return t.win; }).length;
            var losses  = st.length - wins;
            var net     = st.reduce(function(a, t) { return a + t.pnl; }, 0);
            var spent   = st.reduce(function(a, t) { return a + t.solSpent; }, 0);
            var recv    = st.reduce(function(a, t) { return a + t.solReceived; }, 0);
            var wr      = ((wins / st.length) * 100).toFixed(0);
            var best    = st.reduce(function(a, t) { return t.pnl > a.pnl ? t : a; }, st[0]);
            var worst   = st.reduce(function(a, t) { return t.pnl < a.pnl ? t : a; }, st[0]);
            var elapsed = Math.round((Date.now() - sessionStart) / 3600000 * 10) / 10;
            var sign    = net >= 0 ? "+" : "";
            var emoji   = net >= 0 ? "🟢" : "🔴";
            tg(
              "📊 *Full Session Summary*\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              emoji + " *Net PnL:    " + sign + net.toFixed(4) + " SOL*\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "📈 Trades:    " + st.length + "  (" + wins + "W / " + losses + "L)\n" +
              "🎯 Win rate:  " + wr + "%\n" +
              "📥 Spent:     " + spent.toFixed(4) + " SOL\n" +
              "📤 Received:  " + recv.toFixed(4) + " SOL\n" +
              "⏱ Runtime:   " + elapsed + "hrs\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "🏆 Best:   " + best.symbol  + "  +" + best.pnl.toFixed(4)  + " SOL\n" +
              "💀 Worst:  " + worst.symbol + "  "  + worst.pnl.toFixed(4) + " SOL\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━"
            );
            var chunkSize = 20;
            for (var ci = 0; ci < st.length; ci += chunkSize) {
              var chunk = st.slice(ci, ci + chunkSize);
              var page  = Math.floor(ci / chunkSize) + 1;
              var total = Math.ceil(st.length / chunkSize);
              var lines = chunk.map(function(t) {
                var s   = t.pnl >= 0 ? "+" : "";
                var pct = t.solSpent > 0 ? ((t.pnl / t.solSpent) * 100).toFixed(0) : "0";
                return (t.win ? "🟢" : "🔴") + " " + t.symbol + "  " + s + t.pnl.toFixed(4) + " SOL (" + s + pct + "%)";
              }).join("\n");
              tg("*Trades " + (ci + 1) + "–" + Math.min(ci + chunkSize, st.length) + (total > 1 ? " (" + page + "/" + total + ")" : "") + ":*\n" + lines);
            }
          }
        }
      }
    }
  } catch (e) {
    var msg = e.message || "";
    if (msg.includes("409")) {
      tgPollBackoff = Math.min(tgPollBackoff * 2, 60000);
      console.log("⚠️ TG 409 — backing off " + (tgPollBackoff/1000) + "s");
      await new Promise(function(r) { setTimeout(r, tgPollBackoff); });
    } else if (!msg.includes("timeout") && !msg.includes("ECONNRESET")) {
      console.error("CB poll error:", msg);
    }
  }
}

// Start callback polling loop
function startCallbackPolling() {
  var loop = async function() {
    await pollCallbacks();
    setTimeout(loop, tgPollBackoff);
  };
  // Clear webhook first then start
  axios.post(
    "https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/deleteWebhook",
    { drop_pending_updates: true },
    { timeout: 10000 }
  ).then(function() {
    console.log("✅ Webhook cleared — buttons active");
    loop();
  }).catch(function(e) {
    console.log("⚠️ Webhook clear failed — starting anyway");
    loop();
  });
}

// ─────────────────────────────────────────────
//  AGE FORMATTER — seconds precision
// ─────────────────────────────────────────────
function fmtAge(ageMin) {
  var s = Math.round(ageMin * 60);
  if (s < 60)   return s + "s";
  if (s < 3600) return Math.floor(s/60) + "m " + (s%60) + "s";
  return (ageMin/60).toFixed(1) + "h";
}

// ─────────────────────────────────────────────
//  GECKOTERMINAL — primary data source (free, no key, rarely 429s)
// ─────────────────────────────────────────────
async function fetchGecko(mint) {
  try {
    var res = await axios.get(
      "https://api.geckoterminal.com/api/v2/networks/solana/tokens/" + mint + "/pools?page=1",
      { timeout: 5000, headers: { "Accept": "application/json;version=20230302" } }
    );
    var pools = res.data && res.data.data;
    if (!pools || pools.length === 0) return null;

    // Pick highest liquidity pool
    var pool = pools.sort(function(a, b) {
      return parseFloat(b.attributes.reserve_in_usd || 0) -
             parseFloat(a.attributes.reserve_in_usd || 0);
    })[0];

    var attr   = pool.attributes;
    var liq    = parseFloat(attr.reserve_in_usd                       || 0);
    var mcap   = parseFloat(attr.fdv_usd || attr.market_cap_usd       || 0);
    var vol24h = parseFloat(attr.volume_usd && attr.volume_usd.h24    || 0);
    var vol5m  = parseFloat(attr.volume_usd && attr.volume_usd.m5     || 0);
    var price  = parseFloat(attr.base_token_price_usd                 || 0);
    var createdAt = attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : Date.now();
    var ageMs  = Date.now() - createdAt;
    var txns   = attr.transactions || {};
    var buys5m  = (txns.m5  && txns.m5.buys)   || 0;
    var sells5m = (txns.m5  && txns.m5.sells)  || 0;
    var buyers24h = (txns.h24 && txns.h24.buys) || 0;

    // Resolve symbol/name from included
    var symbol = mint.slice(0, 6);
    var name   = "Unknown";
    try {
      var incl = res.data.included || [];
      var tok  = incl.find(function(i) { return i.type === "token" && i.attributes && i.attributes.symbol; });
      if (tok) { symbol = tok.attributes.symbol; name = tok.attributes.name || name; }
    } catch (_) {}

    if (mcap > 0 || liq > 0 || vol24h > 0) {
      return { mint, symbol, name, mcap, liq, vol24h, vol5m, price,
               ageHours: ageMs / 3600000, ageMin: ageMs / 60000,
               pairCreatedAt: createdAt, buyers24h, buys5m, sells5m };
    }
    return null;
  } catch (e) {
    return null; // silent — caller falls back to DexScreener
  }
}

// ─────────────────────────────────────────────
//  DEXSCREENER — fallback
// ─────────────────────────────────────────────
var dex429Count = 0;

async function fetchDex(mint, maxRetries) {
  maxRetries = maxRetries || 6;

  // ── PRIMARY: GeckoTerminal ──────────────────
  var geckoResult = await fetchGecko(mint);
  if (geckoResult) {
    return geckoResult;
  }

  // ── FALLBACK: DexScreener ───────────────────
  for (var i = 1; i <= maxRetries; i++) {
    var is429 = false;
    try {
      var res = await axios.get(
        "https://api.dexscreener.com/latest/dex/tokens/" + mint,
        { timeout: 7000 }
      );
      var pairs = res.data && res.data.pairs;
      if (pairs && pairs.length > 0) {
        var pair = pairs.find(function(p) {
          return p.dexId && p.dexId.toLowerCase().indexOf("pump") > -1;
        }) || pairs.sort(function(a, b) {
          return parseFloat(b.liquidity && b.liquidity.usd || 0) -
                 parseFloat(a.liquidity && a.liquidity.usd || 0);
        })[0];

        var liq    = parseFloat(pair.liquidity && pair.liquidity.usd || 0);
        var mcap   = parseFloat(pair.fdv || pair.marketCap || 0);
        var vol24h = parseFloat(pair.volume && pair.volume.h24 || 0);

        if (mcap > 0 || liq > 0 || vol24h > 0) {
          var ageMs = Date.now() - (pair.pairCreatedAt || Date.now());
          return {
           
             mint,
            symbol:        pair.baseToken && pair.baseToken.symbol || mint.slice(0, 6),
            name:          pair.baseToken && pair.baseToken.name   || "Unknown",
            mcap, liq, vol24h,
            vol5m:         parseFloat(pair.volume && pair.volume.m5 || 0),
            price:         parseFloat(pair.priceUsd || 0),
            ageHours:      ageMs / 3600000,
            ageMin:        ageMs / 60000,
            pairCreatedAt: pair.pairCreatedAt || 0,
            buyers24h:     pair.txns && pair.txns.h24 && pair.txns.h24.buys || 0,
            buys5m:        pair.txns && pair.txns.m5  && pair.txns.m5.buys  || 0,
            sells5m:       pair.txns && pair.txns.m5  && pair.txns.m5.sells || 0,
            hasSocials:    !!(pair.info && pair.info.socials && pair.info.socials.length > 0),
            hasTwitter:  !!(pair.info && pair.info.socials && pair.info.socials.some(function(s) {
               return s.type === "twitter" || s.type === "x";
             })),
            socials:       pair.info && pair.info.socials || [],
          };
        }
      }
    } catch (e) {
      is429 = !!(e.response && e.response.status === 429);
      if (is429) dex429Count++; else console.log("   DexScreener attempt " + i + ": " + e.message);
    }
    if (i < maxRetries) {
      var delay = is429 ? 15000 : (i <= 2 ? 1500 : i <= 4 ? 3000 : 6000);
      await new Promise(function(r) { setTimeout(r, delay); });
    }
  }
  return null;
}

// ─────────────────────────────────────────────
//  FETCH HOLDERS — on-chain, pool excluded
//  Always excludes accounts[0] (AMM pool)
//  Returns array of { percentage } (0–100)
// ─────────────────────────────────────────────
function derivePoolTokenAccount(mintPk) {
  try {
    var poolAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from("pool-authority"), mintPk.toBuffer()],
      PUMP_PROG_PK
    )[0];
    var indexBuf = Buffer.alloc(2);
    indexBuf.writeUInt16LE(0, 0);
    var poolPk = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pool"), indexBuf,
        poolAuthority.toBuffer(), mintPk.toBuffer(),
        new PublicKey(CONFIG.WSOL).toBuffer(),
      ],
      PUMP_AMM_PK
    )[0];
    return getATA(mintPk, poolPk, true);
  } catch (e) { return null; }
}

const holderCache = new Map();

async function getCachedHolders(mint) {
  const cached = holderCache.get(mint);
  if (cached && Date.now() - cached.ts < 45000) return cached.data;

  const holders = await fetchHolders(mint);
  if (holders) holderCache.set(mint, { data: holders, ts: Date.now() }); // only cache successes
  return holders;
}

async function fetchHolders(mint) {
  try {
    var mintPk = new PublicKey(mint);
    var poolTokenAccount = derivePoolTokenAccount(mintPk);
    var poolAddress = poolTokenAccount ? poolTokenAccount.toBase58() : null;

    var results = await Promise.all([
      connection.getTokenLargestAccounts(mintPk, "confirmed"),
      connection.getTokenSupply(mintPk, "confirmed"),
    ]);

    var accounts    = results[0] && results[0].value;
    var totalSupply = results[1] && results[1].value && parseFloat(results[1].value.amount);

    if (!accounts || accounts.length === 0 || !totalSupply) return null;

    var poolBal = 0;
    var holders = [];

    for (var i = 0; i < accounts.length; i++) {
      var addr = accounts[i].address;
      var bal  = parseFloat(accounts[i].amount || "0");
      if (bal === 0) continue;

      // Always exclude accounts[0] — it's the AMM pool right after migration
      if (i === 0) { poolBal += bal; continue; }
      // Also exclude by derived pool address
      if (poolAddress && addr === poolAddress) { poolBal += bal; continue; }
      // Belt and suspenders — anything over 60% is a pool/lock account
      if ((bal / totalSupply) * 100 > 60) { poolBal += bal; continue; }

      holders.push({ address: addr, amount: bal });
    }

    var circulatingSupply = totalSupply - poolBal;
    if (circulatingSupply <= 0 || holders.length === 0) return null;

    return holders.map(function(h) {
      return { percentage: (h.amount / circulatingSupply) * 100 };
    });
  } catch (e) {
    console.log("   ⚠️ fetchHolders error:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
//  HELIUS — real total holder count
// ─────────────────────────────────────────────
async function getTotalHolderCount(mint) {
  try {
    var url    = CONFIG.RPC_URL || "";
    var match  = url.match(/api-key=([a-zA-Z0-9\-]+)/);
    var apiKey = match ? match[1] : null;
    if (!apiKey) return null;

    var total = 0;
    var page  = 1;
    var heliusUrl = "https://mainnet.helius-rpc.com/?api-key=" + apiKey;

    while (true) {
      var res = await axios.post(heliusUrl, {
        jsonrpc: "2.0", id: "hc" + page, method: "getTokenAccounts",
        params: { mint, limit: 1000, page, options: { showZeroBalance: false } },
      }, { timeout: 10000 });

      var accounts = res.data && res.data.result && res.data.result.token_accounts;
      if (!accounts || accounts.length === 0) break;
      total += accounts.length;
      if (accounts.length < 1000) break;
      page++;
      if (page > 50) break;
    }

    if (total > 0) { console.log("   🟦 Holders: " + total); return total; }
    return null;
  } catch (e) {
    console.log("   ⚠️ Helius holder count:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
//  MINT EXTRACTION from RPC tx
// ─────────────────────────────────────────────
async function extractMint(signature) {
  try {
    var tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0, commitment: "confirmed",
    });
    if (!tx || !tx.meta) return null;
    for (var b of tx.meta.postTokenBalances || []) {
      if (b.mint && !SKIP.has(b.mint)) return b.mint;
    }
    for (var b of tx.meta.preTokenBalances || []) {
      if (b.mint && !SKIP.has(b.mint)) return b.mint;
    }
    for (var g of tx.meta.innerInstructions || []) {
      for (var ix of g.instructions || []) {
        var m = ix.parsed && ix.parsed.info && ix.parsed.info.mint;
        if (m && !SKIP.has(m)) return m;
      }
    }
    return null;
  } catch { return null; }
}

// ─────────────────────────────────────────────
//  FILTERS — 7 checks, all age-aware
//
//  Vol/MCap thresholds:
//    0s–30s  → 0.05x  (brand new — still need early buyer activity)
//    30s–2m  → 0.15x  (real early snipers must be present)
//    2m–10m  → 0.3x   (momentum must be building hard)
//    10m+    → 0.8x   (serious trading volume required)
//
//  Top10 holder thresholds:
//    0s–30s  → <50%   (pool just created, snipers in)
//    30s–2m  → <45%
//    2m–10m  → <40%
//    10m+    → <20%   (should be distributed by now)
//
//  LP/holder thresholds:
//    flat $40+  (min 30 holders required)
// ─────────────────────────────────────────────
async function runFilters(mint, dex) {
  var score  = 0;
  var checks = {};
  var ageSec = dex.ageMin * 60; // age in seconds — used for all thresholds

  // 1. MCap
  var mcapPass = dex.mcap >= CONFIG.MIN_MCAP_USD;
  if (mcapPass) score++;
  checks.mcap = { pass: mcapPass, label: "MCap",
    val: "$" + Math.round(dex.mcap).toLocaleString() };

  // 2. Liquidity — min AND max
  var liqPass = dex.liq >= CONFIG.MIN_LIQUIDITY_USD && dex.liq <= CONFIG.MAX_LIQUIDITY_USD;
  if (liqPass) score++;
  checks.liq = { pass: liqPass, label: "Liquidity",
    val: "$" + Math.round(dex.liq).toLocaleString() + " (need $" + CONFIG.MIN_LIQUIDITY_USD.toLocaleString() + "–$" + CONFIG.MAX_LIQUIDITY_USD.toLocaleString() + ")" };

  // 3. Volume
  var volPass = dex.vol24h >= CONFIG.MIN_VOLUME_USD;
  if (volPass) score++;
  checks.vol = { pass: volPass, label: "Volume 24h",
    val: "$" + Math.round(dex.vol24h).toLocaleString() };

  // 4. Vol/MCap ratio — age-aware
  var volRatio = dex.mcap > 0 ? dex.vol24h / dex.mcap : 0;
  var minRatio = ageSec <= 30  ? 0.05   // brand new — still need early buyer activity
               : ageSec <= 120 ? 0.15   // 30s-2m — real early snipers must be present
               : ageSec <= 600 ? 0.3    // 2m-10m — momentum must be building hard
               : 0.8;                   // 10m+ — serious trading volume required
  var ratioPass = volRatio >= minRatio;
  if (ratioPass) score++;
  checks.volRatio = { pass: ratioPass, label: "Vol/MCap",
    val: volRatio.toFixed(3) + "x (need " + minRatio + "x @ " + fmtAge(dex.ageMin) + ")" };

  // 5. Age
  var agePass = dex.ageHours <= CONFIG.MAX_AGE_HOURS;
  if (agePass) score++;
  checks.age = { pass: agePass, label: "Age", val: fmtAge(dex.ageMin) };

  // 6 & 7 — Holder checks (flat thresholds from CONFIG)
  var minLpPerHolder = CONFIG.MIN_LP_PER_HOLDER;
  var maxTop10Pct    = ageSec <= 30  ? 50
                     : ageSec <= 120 ? 45
                     : ageSec <= 600 ? 40
                     : 20;

  var holderResults = await Promise.all([
    getCachedHolders(mint),
    getTotalHolderCount(mint),
  ]);
  var holders    = holderResults[0];
  var totalCount = holderResults[1];

  if (holders !== null && holders.length > 0) {
    var hCount = totalCount || holders.length;

    // MIN_HOLDERS guard — skip coins with too few holders
    if (hCount < CONFIG.MIN_HOLDERS) {
      checks.lp    = { pass: false, label: "LP/holder",  val: "n/a — only " + hCount + " holders (need " + CONFIG.MIN_HOLDERS + "+)" };
      checks.top10 = { pass: false, label: "Top10 %",    val: "n/a — holder count too low" };
      return { pass: false, score, total: 7, checks, isCluster: false };
    }
    var top10  = holders.slice(0, 10).reduce(function(s, h) { return s + (h.percentage || 0); }, 0);
    var lpPerH = dex.liq / hCount;
    var lpPass  = lpPerH >= minLpPerHolder;
    var topPass = top10  <  maxTop10Pct;
    if (lpPass)  score++;
    if (topPass) score++;

    checks.lp    = { pass: lpPass,  label: "LP/holder",
      val: "$" + lpPerH.toFixed(2) + " / " + hCount + " holders (need $" + minLpPerHolder + "+)" };
    checks.top10 = { pass: topPass, label: "Top10 %",
      val: top10.toFixed(1) + "% (need <" + maxTop10Pct + "% @ " + fmtAge(dex.ageMin) + ")" };

    // Cluster check
    var isCluster = false;
    if (holders.length >= CONFIG.CLUSTER_WALLETS) {
      var pcts    = holders.map(function(h) { return h.percentage || 0; });
      var avg     = pcts.reduce(function(a, b) { return a + b; }, 0) / pcts.length;
      var uniform = pcts.filter(function(p) { return Math.abs(p - avg) <= CONFIG.CLUSTER_DIFF; });
      if (uniform.length >= CONFIG.CLUSTER_WALLETS) {
        isCluster = true;
        checks.cluster = { pass: true, label: "CLUSTER",
          val: uniform.length + " wallets ~" + avg.toFixed(2) + "% — fast exit" };
      }
    }
    return { pass: score === 7, score, total: 7, checks, isCluster };

 } else {
  // Holder data unavailable — fail both checks, no free pass
  checks.lp    = { pass: false, label: "LP/holder",  val: "n/a — holder data unavailable" };
  checks.top10 = { pass: false, label: "Top10 %",    val: "n/a — holder data unavailable" };
  return { pass: false, score, total: 7, checks, isCluster: false };
}

}

function fmtChecks(checks) {
  return Object.values(checks).map(function(c) {
    return (c.pass ? "✅" : "❌") + " " + c.label + ": " + c.val;
  }).join("\n");
  function fmtChecksCompact(checks) {
  return Object.values(checks).map(function(c) {
    return (c.pass ? "✅" : "❌") + " " + c.label;
  }).join(" ");
}

}

// ─────────────────────────────────────────────
//  PRIORITY QUEUE
//  WS-detected coins get lane 0 (immediate).
//  RPC-polled coins get lane 1 (normal).
//  Migration-wallet-bought coins get lane -1 (jump queue).
//  One worker runs per lane; lanes are processed highest-priority first.
// ─────────────────────────────────────────────
var migrationQueue   = [];   // { mint, source, priority }
var queueWorkerBusy  = false;

function queueMigration(mint, source, priority) {
  // priority: -1 = ultra (migwallet bought), 0 = WS, 1 = RPC
  priority = (priority === undefined) ? (source === "WebSocket" ? 0 : 1) : priority;

  // Don't double-queue the same mint unless it's an upgrade in priority
  var existing = migrationQueue.findIndex(function(q) { return q.mint === mint; });
  if (existing > -1) {
    if (priority < migrationQueue[existing].priority) {
      migrationQueue[existing].priority = priority; // upgrade priority in-place
      migrationQueue.sort(function(a, b) { return a.priority - b.priority; });
    }
    return;
  }

    migrationQueue.push({ mint, source, priority, queuedAt: Date.now() });
  migrationQueue.sort(function(a, b) { return a.priority - b.priority; });
  console.log("📥 Queued [" + source + " P" + priority + "] " + mint.slice(0, 8) + " | queue=" + migrationQueue.length);

  if (!queueWorkerBusy) runQueueWorker();
}

async function runQueueWorker() {
  queueWorkerBusy = true;
  while (migrationQueue.length > 0) {
    var item = migrationQueue.shift();
    var waitedMs = Date.now() - (item.queuedAt || Date.now());
    if (waitedMs > CONFIG.MAX_AGE_HOURS * 60 * 60 * 1000) {
      console.log("   🗑️  [" + item.mint.slice(0, 8) + "] dropped — stale in queue " + Math.round(waitedMs / 1000) + "s");
      continue;
    }
    try {
      await handleMigration(item.mint, item.source);
    } catch (e) {
      console.error("Queue worker error [" + item.mint.slice(0, 8) + "]:", e.message);
    }
  }
  queueWorkerBusy = false;
}


// ─────────────────────────────────────────────
//  BONDING CURVE PRE-FILTER
//  Checks if a coin is still bonding (98-99% progress).
//  Returns true if the coin has FULLY migrated (safe to process).
//  Returns false if still bonding — we skip it early.
// ─────────────────────────────────────────────
async function isFullyMigrated(mint) {
  try {
    // PumpFun bonding curve address = PDA [mint] under PUMP_PROGRAM
    var mintPk = new PublicKey(mint);
    var [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPk.toBuffer()],
      PUMP_PROG_PK
    );
    var info = await connection.getAccountInfo(bondingCurve, "confirmed");
    // If bonding curve account still exists and has data, coin is still bonding
    if (info && info.data && info.data.length > 0) {
      // Parse "complete" flag at byte offset 8+8+8+8+8+8+1 = 49 (bool)
      // Layout: discriminator(8) virtualTokenReserves(8) virtualSolReserves(8)
      //         realTokenReserves(8) realSolReserves(8) tokenTotalSupply(8) complete(1)
      if (info.data.length >= 49) {
        var complete = info.data[48]; // 0 = still bonding, 1 = complete/migrated
        if (complete === 0) {
          console.log("   ⏭  Still bonding — skipping " + mint.slice(0, 8));
          return false;
        }
      }
      // If we can't read the flag, allow through (don't block valid migrations)
      return true;
    }
    // Account doesn't exist = already migrated (curve closed)
    return true;
  } catch (e) {
    // On error, allow through — better to process than to miss
    return true;
  }
}

// ─────────────────────────────────────────────
//  BONDING CURVE HISTORY RUG CHECK  (2 RPC calls)
//  Reads how the coin traded while it was still on the curve.
//  Points:
//    +2  creator dumped >= BONDING_DEV_SOLD_PCT of what they bought
//    +1  one wallet supplied >= BONDING_TOP_BUYER_PCT of buy SOL
//    +1  >= BONDING_EARLY_SLOT_BUYERS wallets bought in the first 2 slots (sniper bundle)
//    +1  fewer than BONDING_MIN_UNIQUE_BUYERS unique buyers (wash / self-trading)
//  Blocks when points >= BONDING_MAX_SCORE.
//  On any RPC error it allows the coin through (same policy as checkBundle).
// ─────────────────────────────────────────────
const bondingCheckCache = new Map();

async function checkBondingHistory(mint) {
  if (!CONFIG.BONDING_RUG_CHECK || CONFIG.BONDING_MAX_SCORE === 0) {
    return { rug: false, score: 0, reason: "disabled" };
  }
  var cached = bondingCheckCache.get(mint);
  if (cached) return cached;

  try {
    var mintPk = new PublicKey(mint);
    var [curvePk] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPk.toBuffer()],
      PUMP_PROG_PK
    );

    // ── CALL 1: full signature history of the bonding curve ──────────
    var sigs = await connection.getSignaturesForAddress(
      curvePk, { limit: CONFIG.BONDING_SIG_LIMIT }, "confirmed"
    );
    if (!sigs || sigs.length === 0) {
      return { rug: false, score: 0, reason: "no curve history — allowed" };
    }

    var truncated = sigs.length >= CONFIG.BONDING_SIG_LIMIT; // oldest txs cut off → creator unknown
    var okSigs    = sigs.filter(function(s) { return !s.err; }).reverse(); // oldest first
    var half      = Math.floor(CONFIG.BONDING_TX_SAMPLE / 2);
    var oldest    = okSigs.slice(0, half);
    var newest    = okSigs.length > half ? okSigs.slice(-half) : [];
    var oldestSet = new Set(oldest.map(function(s) { return s.signature; }));
    var picked    = oldest.concat(newest.filter(function(s) { return !oldestSet.has(s.signature); }));
    // Buyer-count and top-buyer signals are only trustworthy when EVERY successful
    // curve tx was parsed. On busy coins the sample is partial and would false-flag.
    var fullHistory = !truncated && okSigs.length <= CONFIG.BONDING_TX_SAMPLE;

    // ── CALL 2: one batched parse of the sampled txs ─────────────────
    var txs = await connection.getParsedTransactions(
      picked.map(function(s) { return s.signature; }),
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" }
    );

    var events = [];
    for (var i = 0; i < picked.length; i++) {
      var tx = txs && txs[i];
      if (!tx || !tx.meta || tx.meta.err) continue;
      var keys   = tx.transaction.message.accountKeys || [];
      if (!keys[0]) continue;
      var signer = keys[0].pubkey.toBase58(); // fee payer = the trader
      var pre = 0, post = 0;
      (tx.meta.preTokenBalances  || []).forEach(function(b) {
        if (b.mint === mint && b.owner === signer) pre  += parseFloat(b.uiTokenAmount && b.uiTokenAmount.amount || "0");
      });
      (tx.meta.postTokenBalances || []).forEach(function(b) {
        if (b.mint === mint && b.owner === signer) post += parseFloat(b.uiTokenAmount && b.uiTokenAmount.amount || "0");
      });
      var solDelta = ((tx.meta.postBalances[0] || 0) - (tx.meta.preBalances[0] || 0)) / 1e9;
      events.push({
        sig:      picked[i].signature,
        slot:     picked[i].slot,
        signer:   signer,
        tokDelta: post - pre,
        solSpent: -solDelta,
      });
    }
    if (events.length === 0) {
      return { rug: false, score: 0, reason: "no parsable curve txs — allowed" };
    }

    var score   = 0;
    var reasons = [];

    // ── Creator = signer of the oldest curve tx (only trustworthy if history isn't truncated)
    var creator = null;
    if (!truncated && oldest[0]) {
      var first = events.find(function(e) { return e.sig === oldest[0].signature; });
      creator = first ? first.signer : null;
    }

    // ── Signal 1: dev dump ───────────────────────────────────────────
    if (creator) {
      var devBought = 0, devSold = 0;
      events.forEach(function(e) {
        if (e.signer !== creator) return;
        if (e.tokDelta > 0) devBought += e.tokDelta;
        if (e.tokDelta < 0) devSold   += -e.tokDelta;
      });
      if (devBought > 0) {
        var devSoldPct = (devSold / devBought) * 100;
        if (devSoldPct >= CONFIG.BONDING_DEV_SOLD_PCT) {
          score += 2;
          reasons.push("dev sold " + devSoldPct.toFixed(0) + "% of their bag on curve");
        }
      }
    }

    // ── Buyers (token balance went up, real SOL spent) ───────────────
    var buySol = {};   // wallet → SOL spent
    var totalBuySol = 0;
    events.forEach(function(e) {
      if (e.tokDelta > 0 && e.solSpent > 0.001) {
        buySol[e.signer] = (buySol[e.signer] || 0) + e.solSpent;
        totalBuySol += e.solSpent;
      }
    });
    var buyerList = Object.keys(buySol);

    // ── Signal 2: single wallet dominates buy volume ─────────────────
    if (fullHistory && totalBuySol > 0) {
      var topWallet = buyerList.reduce(function(a, b) { return buySol[b] > buySol[a] ? b : a; }, buyerList[0]);
      var topPct = (buySol[topWallet] / totalBuySol) * 100;
      if (topPct >= CONFIG.BONDING_TOP_BUYER_PCT) {
        score++;
        reasons.push("one wallet = " + topPct.toFixed(0) + "% of buy SOL");
      }
    }

    // ── Signal 3: sniper bundle in the first 2 slots ─────────────────
    if (!truncated && oldest[0]) {
      var firstSlot = oldest[0].slot;
      var earlyBuyers = new Set();
      events.forEach(function(e) {
        if (e.slot <= firstSlot + 1 && e.tokDelta > 0 && e.signer !== creator) earlyBuyers.add(e.signer);
      });
      if (earlyBuyers.size >= CONFIG.BONDING_EARLY_SLOT_BUYERS) {
        score++;
        reasons.push(earlyBuyers.size + " wallets sniped in first 2 slots");
      }
    }

    // ── Signal 4: too few unique buyers ──────────────────────────────
    if (fullHistory && buyerList.length < CONFIG.BONDING_MIN_UNIQUE_BUYERS) {
      score++;
      reasons.push("only " + buyerList.length + " unique buyers");
    }

    var rug    = score >= CONFIG.BONDING_MAX_SCORE;
    var reason = reasons.join(" | ") || "clean";
    var out    = { rug: rug, score: score, reason: reason, txs: sigs.length };

    console.log("   🧬 Bonding history: score=" + score + "/" + CONFIG.BONDING_MAX_SCORE +
      " | " + sigs.length + " curve txs | " + reason + (rug ? " — RUG PATTERN" : ""));
    bondingCheckCache.set(mint, out);
    if (bondingCheckCache.size > 500) {
      Array.from(bondingCheckCache.keys()).slice(0, 150).forEach(function(k) { bondingCheckCache.delete(k); });
    }
    return out;

  } catch (e) {
    // RPC hiccup — don't block valid coins
    console.log("   ⚠️ Bonding history check error (allowing through): " + (e.message || "").slice(0, 80));
    return { rug: false, score: 0, reason: "check failed — allowed" };
  }
}

// ─────────────────────────────────────────────
//  MIGRATION WALLET BUY-CHECK
//  After migration, does 39az itself buy the token?
//  If yes → ultra-priority (the wallet is signaling conviction).
//  Checks the last 5 txs on the mint for a 39az buy.
// ─────────────────────────────────────────────
async function migrationWalletBoughtThis(mint) {
  try {
    var mintPk = new PublicKey(mint);
    // Get recent sigs for the migration wallet on this specific mint's token account
    var migATA = getAssociatedTokenAddressSync(mintPk, migrationPk, true);
    var sigs = await connection.getSignaturesForAddress(migATA, { limit: 8 }, "confirmed");
    if (!sigs || sigs.length === 0) return false;

    for (var i = 0; i < Math.min(sigs.length, 5); i++) {
      try {
        var tx = await connection.getParsedTransaction(sigs[i].signature, {
          maxSupportedTransactionVersion: 0, commitment: "confirmed",
        });
        if (!tx || !tx.meta) continue;
        // Look for a token balance increase on the migration wallet's ATA
        var pre  = tx.meta.preTokenBalances  || [];
        var post = tx.meta.postTokenBalances || [];
        var migATAstr = migATA.toBase58();
        var preBal  = 0;
        var postBal = 0;
        pre.forEach(function(b)  { if (b.accountIndex !== undefined) {
          var acct = tx.transaction.message.accountKeys[b.accountIndex];
          if (acct && acct.pubkey && acct.pubkey.toBase58() === migATAstr) preBal  = parseFloat(b.uiTokenAmount.amount || "0");
        }});
        post.forEach(function(b) { if (b.accountIndex !== undefined) {
          var acct = tx.transaction.message.accountKeys[b.accountIndex];
          if (acct && acct.pubkey && acct.pubkey.toBase58() === migATAstr) postBal = parseFloat(b.uiTokenAmount.amount || "0");
        }});
        if (postBal > preBal) {
          console.log("   ⭐ Migration wallet BOUGHT " + mint.slice(0, 8) + " — ultra priority!");
          return true;
        }
      } catch (e) { /* skip individual tx errors — continue to next sig */ }
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ─────────────────────────────────────────────
//  HANDLE MIGRATION
// ─────────────────────────────────────────────
async function handleMigration(mint, source) {
  var entry = processedMints.get(mint);
  if (entry && entry.retries >= CONFIG.RESCAN_MAX) return;
  if (entry && Date.now() - entry.lastTry < 5000) return;

  processedMints.set(mint, {
    retries:     (entry && entry.retries || 0) + 1,
    lastTry:     Date.now(),
    firstSeenAt:  entry && entry.firstSeenAt || Date.now(),
    initialMcap: entry && entry.initialMcap || null,
  });
  if (processedMints.size > 1000) {
    var keys = Array.from(processedMints.keys());
    keys.slice(0, 300).forEach(function(k) { processedMints.delete(k); });
  }

  var isRescan = entry && entry.retries > 0;
  console.log("\n🎓 [" + source + "]" + (isRescan ? " RESCAN #" + entry.retries : "") + " " + mint);

  var walletBought = false; // declared here so it's always in scope

  // ── Bonding curve pre-filter ──────────────────────────────────────
  // Skip coins that are still at 98-99% (not yet fully migrated).
  // Only check on first encounter — rescans already passed this gate.
  if (!isRescan) {
    var fullyMigrated = await isFullyMigrated(mint);
    if (!fullyMigrated) {
  console.log("   ⏭  [" + mint.slice(0, 8) + "] still bonding — retry later");
  return;
}


    // ── Migration wallet buy-check ──────────────────────────────────
    // Run concurrently with the migration delay — no extra time cost.
    // Bonding curve history rug check runs in the same parallel batch (2 RPC calls).
    var [, walletBoughtResult, bondingResult] = await Promise.all([
      new Promise(function(r) { setTimeout(r, CONFIG.POST_MIGRATION_DELAY_MS); }),
      migrationWalletBoughtThis(mint),
      checkBondingHistory(mint),
    ]);
    walletBought = walletBoughtResult;

    if (bondingResult && bondingResult.rug) {
      console.log("   🧬 Bonding rug pattern — skipping " + mint.slice(0, 8) + " | " + bondingResult.reason);
      tg(
        "🧬 *Bonding rug pattern — skipped*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🔎 Score:   " + bondingResult.score + "/" + CONFIG.BONDING_MAX_SCORE + "  (" + bondingResult.txs + " curve txs)\n" +
        "📋 Detail:  " + bondingResult.reason + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "Mint: `" + mint + "`"
      );
      failedMints.add(mint);
      return;
    }

    if (walletBought) {
      tg("⭐ *Migration wallet BOUGHT* — ultra-priority!\nMint: `" + mint + "`");
      // Re-queue at the front with priority -1 if this call was triggered
      // from a lower-priority source (non-blocking — we continue processing here)
    }
  } else {
    // Still apply the normal delay on rescans to avoid hammering RPC
    await new Promise(function(r) { setTimeout(r, 1000); });
  }

  var dex = await fetchDex(mint);
  if (!dex) {
    console.log("   ⚠️ No data — rescanning in 13s");
    setTimeout(function() {
      var e = processedMints.get(mint);
      if (e && e.retries < CONFIG.RESCAN_MAX) queueMigration(mint, "Rescan", 1);
    }, CONFIG.RESCAN_DELAY_MS);
    return;
  }

  // Age correction — use firstSeenAt anchor
  var entry2      = processedMints.get(mint);
  var firstSeenAt = entry2 && entry2.firstSeenAt || Date.now();
  var bestTs      = (dex.pairCreatedAt && dex.pairCreatedAt > 0)
    ? Math.min(firstSeenAt, dex.pairCreatedAt) : firstSeenAt;
  dex.ageMin   = (Date.now() - bestTs) / 60000;
  dex.ageHours = dex.ageMin / 60;

  var ageStr = fmtAge(dex.ageMin);

  console.log("\n   ╔══════════════════════════════════════╗");
  console.log("   ║  " + dex.name + " (" + dex.symbol + ")");
  console.log("   ║  MCap: $" + Math.round(dex.mcap).toLocaleString() +
    "  Liq: $" + Math.round(dex.liq).toLocaleString());
  console.log("   ║  Vol: $" + Math.round(dex.vol24h).toLocaleString() +
    "  Age: " + ageStr);
  console.log("   ╚══════════════════════════════════════╝");

  var result = await runFilters(mint, dex);
  var bar    = "█".repeat(result.score) + "░".repeat(result.total - result.score);
  console.log("   Score: " + result.score + "/7 [" + bar + "] " +
    (result.pass ? "🟢 BUYING" : "🔴 SKIP"));
  Object.values(result.checks).forEach(function(c) {
    console.log("   " + (c.pass ? "✅" : "❌") + " " + c.label + ": " + c.val);
  });

  // ── Brain observes every coin — builds feed trend picture passively ──
  try { brain.observeCoin(dex.symbol, dex.name, result.score, result.total); } catch(e) {}

  // ── Brain advisor — informational only, never blocks a buy ──────────
  var advice = CONFIG.BRAIN_ENABLED
    ? brain.evaluate(dex, pnlTrades)
    : { nudge: 0, mood: "neutral", signals: [], summary: "🧠 Brain: disabled" };
  console.log("🧠 " + advice.summary);
  // Hot flag — brain detected a trending pattern match
  if (advice.hot) console.log("   🌶  Brain: trending pattern match — " + dex.symbol);

    if (!result.pass) {
    var isFreshData = dex.ageMin < 2; // only treat 0-liq/0-mcap as "data not loaded yet" if the token itself is brand new
    var liqZero  = !result.checks.liq.pass  && dex.liq  === 0 && isFreshData;
    var mcapZero = !result.checks.mcap.pass && dex.mcap === 0 && isFreshData;
    var retries  = entry && entry.retries || 0;

    if ((liqZero || mcapZero) && retries < CONFIG.RESCAN_MAX) {

      // Silent rescan — no TG noise for data-incomplete coins
      setTimeout(function() {
        var e = processedMints.get(mint);
        if (e && e.retries < CONFIG.RESCAN_MAX) queueMigration(mint, "Rescan", 1);
      }, CONFIG.RESCAN_DELAY_MS);
      return;
    }

    // Only alert on 5+/7 — below that is just noise
    if (result.score >= 5) {
      tgWithButtons(
"🔴 *#" + dex.symbol + "*  |  MC: *$" + Math.round
