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

if (!process.env.RPC_URL) { console.error("❌ Missing RPC_URL"); process.exit(1); }
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
const { executeJitoBuy } = require("./jitoExecutor");
const { logPaperTrade, checkPaperPositions, paperTrades } = require("./paperLog");

const JUP_HEADERS = process.env.JUPITER_API_KEY
  ? { "x-api-key": process.env.JUPITER_API_KEY }
  : {};

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

  BUY_AMOUNT_SOL:             0.0025,
  PRIORITY_FEE_MICROLAMPORTS: 250000,

  MIN_LIQUIDITY_USD: 10000,
  MAX_LIQUIDITY_USD: 20000,
  LIQUIDITY_DRAIN_PCT: 0.40, LIQUIDITY_DRAIN_CONFIRM_MS: 20000, LIQUIDITY_ABS_FLOOR: 2000,
  MIN_VOLUME_USD:    30000,
  MIN_MCAP_USD:      10000,
  MAX_AGE_HOURS:     0.25,
  MIN_HOLDERS:       60,
  MIN_LP_PER_HOLDER: 65,

  STOP_LOSS_PCT:   -25,
  VOLUME_DROP_PCT: 0.65,

  CLUSTER_WALLETS:   20,
  CLUSTER_DIFF:      0.5,
  CLUSTER_EXIT_GAIN: 20,

  PROFIT_LOCK_TRIGGERS: [
    { gain: 30,    floor: 15    },
    { gain: 50,    floor: 30    },
    { gain: 60,    floor: 40    },
    { gain: 80,    floor: 60    },
    { gain: 100,   floor: 75    },
    { gain: 150,   floor: 120   },
    { gain: 220,   floor: 180   },
    { gain: 300,   floor: 250   },
    { gain: 500,   floor: 425   },
    { gain: 700,   floor: 600   },
    { gain: 1000,  floor: 870   },
    { gain: 1500,  floor: 1320  },
    { gain: 2000,  floor: 1780  },
    { gain: 3000,  floor: 2700  },
    { gain: 5000,  floor: 4550  },
    { gain: 7000,  floor: 6440  },
    { gain: 10000, floor: 9300  },
  ],

  TRAIL_STALL_MS: 180000,

  MAX_POSITIONS:         2,
  BREAKEVEN_EXIT:        true,
  PRE_BUY_STALL_MS:      45000,

  POST_MIGRATION_DELAY_MS: 200,
  RESCAN_DELAY_MS:         13000,
  RESCAN_MAX:              5,
  MONITOR_INTERVAL_MS:     2000,
  POLL_INTERVAL_MS:        1500,

  SLOPE_MIN_READINGS:      3,
  SLOPE_MIN:               800,
  SLOPE_RECHECK_MS:        1200,

  WATCH_SCAN_MS:           6000,
  WATCH_FAST_WINDOW_MS:    3 * 60 * 1000,
  WATCH_SLOW_MS:           8000,

  WASH_VOL_THRESHOLD:      1000,
  WASH_MIN_UNIQUE_BUYS:    3,

  HONEYPOT_MAX_IMPACT_PCT: 8,

  REENTRY_WINDOW_MS:       0,
  REENTRY_SIZE_PCT:        0,

  BRAIN_ENABLED:           true,

  DEAD_HOLD_MS:          10 * 60 * 1000,
  DEAD_MAX_PEAK_PCT:     5,
  DEAD_EXIT_THRESHOLD:   -25,

  BUNDLE_TX_LIMIT:       15,
  BUNDLE_SAME_SLOT:      3,
  BUNDLE_SIZE_DIFF_PCT:  15,
  BUNDLE_MAX_SCORE:      2,

  BONDING_RUG_CHECK:         false,
  BONDING_SIG_LIMIT:         1000,
  BONDING_TX_SAMPLE:         50,
  BONDING_DEV_SOLD_PCT:      50,
  BONDING_TOP_BUYER_PCT:     35,
  BONDING_EARLY_SLOT_BUYERS: 4,
  BONDING_MIN_UNIQUE_BUYERS: 8,
  BONDING_MAX_SCORE:         2,

  CONVICTION_MIN_GAIN:   50,
  CONVICTION_TIME_MS:    10 * 60 * 1000,
  SLIDING_STOP_3MIN:     -15,
  SLIDING_STOP_8MIN:     50,
  VOL_VELOCITY_DROP:     0.60,
  MOMENTUM_DROP:         0.85,
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
const selling        = new Set();
const watchlist      = new Map();
const failedMints    = new Set();
let   lastSig        = null;

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
// ─────────────────────────────────────────────
var pnlTrades    = [];
var sessionStart = Date.now();
var botPaused    = false;

function recordTrade(symbol, mint, solSpent, solReceived, reason, tiers) {
  var pnl     = solReceived - solSpent;
  var pnlPct  = solSpent > 0 ? (pnl / solSpent) * 100 : 0;
  var win     = pnl > 0;
  pnlTrades.push({
    symbol, mint, solSpent, solReceived, pnl, pnlPct, reason, tiers,
    time: Date.now(), win,
  });

  if (CONFIG.BRAIN_ENABLED) {
    try { brain.recordTrade(symbol, pnl, win, reason, tiers); } catch (e) {}
  }

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
  var totalTrades = pnlTrades.length;
  if (totalTrades === 0) {
    tg("📊 *3hr Summary*\nNo trades completed this period.");
    return;
  }

  var wins       = pnlTrades.filter(function(t) { return t.win; }).length;
  var losses     = totalTrades - wins;
  var totalSpent = pnlTrades.reduce(function(a, t) { return a + t.solSpent; }, 0);
  var totalRec   = pnlTrades.reduce(function(a, t) { return a + t.solReceived; }, 0);
  var totalPnl   = totalRec - totalSpent;
  var winRate    = ((wins / totalTrades) * 100).toFixed(0);
  var bestTrade  = pnlTrades.reduce(function(a, t) { return t.pnl > a.pnl ? t : a; }, pnlTrades[0]);
  var worstTrade = pnlTrades.reduce(function(a, t) { return t.pnl < a.pnl ? t : a; }, pnlTrades[0]);
  var sign       = totalPnl >= 0 ? "+" : "";
  var emoji      = totalPnl >= 0 ? "🟢" : "🔴";
  var elapsed    = Math.round((Date.now() - sessionStart) / 3600000 * 10) / 10;

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
//  TELEGRAM
// ─────────────────────────────────────────────
let tgQ = [], tgBusy = false, lastTg = 0;
let tgOffset = 0;
let tgPollBackoff = 3000;

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
            var e2 = processedMints.get(mint);
            var fsa = e2 && e2.firstSeenAt || Date.now();
            var bestTs2 = (dex.pairCreatedAt && dex.pairCreatedAt > 0)
              ? Math.min(fsa, dex.pairCreatedAt) : fsa;
            dex.ageMin = (Date.now() - bestTs2) / 60000;
            dex.ageHours = dex.ageMin / 60;
            var result = await runFilters(mint, dex);
            var bar = "█".repeat(result.score) + "░".repeat(result.total - result.score);
            var astr = fmtAge(dex.ageMin);
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
              queueDecision(mint, "Telegram", {
                dex,
                result,
                reason: "manual buy"
              });
            } else {
              tg("❌ Force buy failed — no market data");
            }
          }
        }
      }

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
            var p = positions[m];
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

function startCallbackPolling() {
  var loop = async function() {
    await pollCallbacks();
    setTimeout(loop, tgPollBackoff);
  };
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
//  AGE FORMATTER
// ─────────────────────────────────────────────
function fmtAge(ageMin) {
  var s = Math.round(ageMin * 60);
  if (s < 60)   return s + "s";
  if (s < 3600) return Math.floor(s/60) + "m " + (s%60) + "s";
  return (ageMin/60).toFixed(1) + "h";
}

// ─────────────────────────────────────────────
//  GECKOTERMINAL
// ─────────────────────────────────────────────
async function fetchGecko(mint) {
  try {
    var res = await axios.get(
      "https://api.geckoterminal.com/api/v2/networks/solana/tokens/" + mint + "/pools?page=1",
      { timeout: 5000, headers: { "Accept": "application/json;version=20230302" } }
    );
    var pools = res.data && res.data.data;
    if (!pools || pools.length === 0) return null;

    var pool = pools.sort(function(a, b) {
      return parseFloat(b.attributes.reserve_in_usd || 0) -
             parseFloat(a.attributes.reserve_in_usd || 0);
    })[0];

    var attr   = pool.attributes;
    var liq    = parseFloat(attr.reserve_in_usd || 0);
    var mcap   = parseFloat(attr.fdv_usd || attr.market_cap_usd || 0);
    var vol24h = parseFloat(attr.volume_usd && attr.volume_usd.h24 || 0);
    var vol5m  = parseFloat(attr.volume_usd && attr.volume_usd.m5 || 0);
    var price  = parseFloat(attr.base_token_price_usd || 0);
    var createdAt = attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : Date.now();
    var ageMs  = Date.now() - createdAt;
    var txns   = attr.transactions || {};
    var buys5m  = (txns.m5  && txns.m5.buys)   || 0;
    var sells5m = (txns.m5  && txns.m5.sells)  || 0;
    var buyers24h = (txns.h24 && txns.h24.buys) || 0;

    var symbol = mint.slice(0, 6);
    var name = "Unknown";
    try {
      var incl = res.data.included || [];
      var tok  = incl.find(function(i) { return i.type === "token" && i.attributes && i.attributes.symbol; });
      if (tok) { symbol = tok.attributes.symbol; name = tok.attributes.name || name; }
    } catch (_) {}

    if (mcap > 0 || liq > 0 || vol24h > 0) {
      return {
        mint, symbol, name, mcap, liq, vol24h, vol5m, price,
        ageHours: ageMs / 3600000, ageMin: ageMs / 60000,
        pairCreatedAt: createdAt, buyers24h, buys5m, sells5m
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────
//  DEXSCREENER fallback
// ─────────────────────────────────────────────
var dex429Count = 0;

async function fetchDex(mint, maxRetries) {
  maxRetries = maxRetries || 6;

  var geckoResult = await fetchGecko(mint);
  if (geckoResult) return geckoResult;

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

        var liq = parseFloat(pair.liquidity && pair.liquidity.usd || 0);
        var mcap = parseFloat(pair.fdv || pair.marketCap || 0);
        var vol24h = parseFloat(pair.volume && pair.volume.h24 || 0);

        if (mcap > 0 || liq > 0 || vol24h > 0) {
          var ageMs = Date.now() - (pair.pairCreatedAt || Date.now());
          return {
            mint,
            symbol: pair.baseToken && pair.baseToken.symbol || mint.slice(0, 6),
            name: pair.baseToken && pair.baseToken.name || "Unknown",
            mcap, liq, vol24h,
            vol5m: parseFloat(pair.volume && pair.volume.m5 || 0),
            price: parseFloat(pair.priceUsd || 0),
            ageHours: ageMs / 3600000,
            ageMin: ageMs / 60000,
            pairCreatedAt: pair.pairCreatedAt || 0,
            buyers24h: pair.txns && pair.txns.h24 && pair.txns.h24.buys || 0,
            buys5m: pair.txns && pair.txns.m5 && pair.txns.m5.buys || 0,
            sells5m: pair.txns && pair.txns.m5 && pair.txns.m5.sells || 0,
            hasSocials: !!(pair.info && pair.info.socials && pair.info.socials.length > 0),
            hasTwitter: !!(pair.info && pair.info.socials && pair.info.socials.some(function(s) {
              return s.type === "twitter" || s.type === "x";
            })),
            socials: pair.info && pair.info.socials || [],
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
//  HOLDERS
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
  if (holders) holderCache.set(mint, { data: holders, ts: Date.now() });
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

    var accounts = results[0] && results[0].value;
    var totalSupply = results[1] && results[1].value && parseFloat(results[1].value.amount);

    if (!accounts || accounts.length === 0 || !totalSupply) return null;

    var poolBal = 0;
    var holders = [];

    for (var i = 0; i < accounts.length; i++) {
      var addr = accounts[i].address;
      var bal = parseFloat(accounts[i].amount || "0");
      if (bal === 0) continue;

      if (i === 0) { poolBal += bal; continue; }
      if (poolAddress && addr === poolAddress) { poolBal += bal; continue; }
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

async function getTotalHolderCount(mint) {
  try {
    var url = CONFIG.RPC_URL || "";
    var match = url.match(/api-key=([a-zA-Z0-9\-]+)/);
    var apiKey = match ? match[1] : null;
    if (!apiKey) return null;

    var total = 0;
    var page = 1;
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
//  EXTRACT MINT from RPC tx
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
//  FILTERS
// ─────────────────────────────────────────────
async function runFilters(mint, dex) {
  var score = 0;
  var checks = {};
  var ageSec = dex.ageMin * 60;

  var mcapPass = dex.mcap >= CONFIG.MIN_MCAP_USD;
  if (mcapPass) score++;
  checks.mcap = { pass: mcapPass, label: "MCap", val: "$" + Math.round(dex.mcap).toLocaleString() };

  var liqPass = dex.liq >= CONFIG.MIN_LIQUIDITY_USD && dex.liq <= CONFIG.MAX_LIQUIDITY_USD;
  if (liqPass) score++;
  checks.liq = { pass: liqPass, label: "Liquidity", val: "$" + Math.round(dex.liq).toLocaleString() + " (need $" + CONFIG.MIN_LIQUIDITY_USD.toLocaleString() + "–$" + CONFIG.MAX_LIQUIDITY_USD.toLocaleString() + ")" };

  var volPass = dex.vol24h >= CONFIG.MIN_VOLUME_USD;
  if (volPass) score++;
  checks.vol = { pass: volPass, label: "Volume 24h", val: "$" + Math.round(dex.vol24h).toLocaleString() };

  var volRatio = dex.mcap > 0 ? dex.vol24h / dex.mcap : 0;
  var minRatio = ageSec <= 30 ? 0.05 : ageSec <= 120 ? 0.15 : ageSec <= 600 ? 0.3 : 0.8;
  var ratioPass = volRatio >= minRatio;
  if (ratioPass) score++;
  checks.volRatio = { pass: ratioPass, label: "Vol/MCap", val: volRatio.toFixed(3) + "x (need " + minRatio + "x @ " + fmtAge(dex.ageMin) + ")" };

  var agePass = dex.ageHours <= CONFIG.MAX_AGE_HOURS;
  if (agePass) score++;
  checks.age = { pass: agePass, label: "Age", val: fmtAge(dex.ageMin) };

  var minLpPerHolder = CONFIG.MIN_LP_PER_HOLDER;
  var maxTop10Pct = ageSec <= 30 ? 50 : ageSec <= 120 ? 45 : ageSec <= 600 ? 40 : 20;

  var holderResults = await Promise.all([
    getCachedHolders(mint),
    getTotalHolderCount(mint),
  ]);
  var holders = holderResults[0];
  var totalCount = holderResults[1];

  if (holders !== null && holders.length > 0) {
    var hCount = totalCount || holders.length;

    if (hCount < CONFIG.MIN_HOLDERS) {
      checks.lp = { pass: false, label: "LP/holder", val: "n/a — only " + hCount + " holders (need " + CONFIG.MIN_HOLDERS + "+)" };
      checks.top10 = { pass: false, label: "Top10 %", val: "n/a — holder count too low" };
      return { pass: false, score, total: 7, checks, isCluster: false };
    }

    var top10 = holders.slice(0, 10).reduce(function(s, h) { return s + (h.percentage || 0); }, 0);
    var lpPerH = dex.liq / hCount;
    var lpPass = lpPerH >= minLpPerHolder;
    var topPass = top10 < maxTop10Pct;
    if (lpPass) score++;
    if (topPass) score++;

    checks.lp = { pass: lpPass, label: "LP/holder", val: "$" + lpPerH.toFixed(2) + " / " + hCount + " holders (need $" + minLpPerHolder + "+)" };
    checks.top10 = { pass: topPass, label: "Top10 %", val: top10.toFixed(1) + "% (need <" + maxTop10Pct + "% @ " + fmtAge(dex.ageMin) + ")" };

    var isCluster = false;
    if (holders.length >= CONFIG.CLUSTER_WALLETS) {
      var pcts = holders.map(function(h) { return h.percentage || 0; });
      var avg = pcts.reduce(function(a, b) { return a + b; }, 0) / pcts.length;
      var uniform = pcts.filter(function(p) { return Math.abs(p - avg) <= CONFIG.CLUSTER_DIFF; });
      if (uniform.length >= CONFIG.CLUSTER_WALLETS) {
        isCluster = true;
        checks.cluster = { pass: true, label: "CLUSTER", val: uniform.length + " wallets ~" + avg.toFixed(2) + "% — fast exit" };
      }
    }
    return { pass: score === 7, score, total: 7, checks, isCluster };
  } else {
    checks.lp = { pass: false, label: "LP/holder", val: "n/a — holder data unavailable" };
    checks.top10 = { pass: false, label: "Top10 %", val: "n/a — holder data unavailable" };
    return { pass: false, score, total: 7, checks, isCluster: false };
  }
}

function fmtChecks(checks) {
  return Object.values(checks).map(function(c) {
    return (c.pass ? "✅" : "❌") + " " + c.label + ": " + c.val;
  }).join("\n");
}

// ─────────────────────────────────────────────
//  MINT STATE + DECISION QUEUE
// ─────────────────────────────────────────────
const mintState = new Map();
const decisionQueue = [];
let decisionWorkerBusy = false;

function ensureMintState(mint) {
  if (!mintState.has(mint)) {
    mintState.set(mint, {
      state: "idle",
      source: null,
      score: 0,
      lastUpdated: Date.now(),
      reason: null,
    });
  }
  return mintState.get(mint);
}

function setMintState(mint, state, source, reason, score) {
  const s = ensureMintState(mint);
  s.state = state;
  s.source = source;
  s.reason = reason;
  s.score = score;
  s.lastUpdated = Date.now();
  return s;
}

function isMintBusy(mint) {
  const s = mintState.get(mint);
  return !!s && ["queued", "processing", "buying", "selling"].includes(s.state);
}

function queueDecision(mint, source, payload = {}) {
  const s = ensureMintState(mint);
  if (s.state === "buying" || s.state === "selling") return;

  const existing = decisionQueue.find((q) => q.mint === mint);
  if (existing) {
    existing.source = source;
    existing.payload = payload;
    existing.queuedAt = Date.now();
    return;
  }

  decisionQueue.push({
    mint,
    source,
    payload,
    queuedAt: Date.now(),
  });

  setMintState(mint, "queued", source, payload.reason || "queued", payload.score || 0);

  if (!decisionWorkerBusy) {
    processDecisionQueue();
  }
}

async function processDecisionQueue() {
  decisionWorkerBusy = true;

  while (decisionQueue.length) {
    const item = decisionQueue.shift();
    const mint = item.mint;
    const state = ensureMintState(mint);

    if (state.state === "buying" || state.state === "selling") continue;

    try {
      setMintState(mint, "processing", item.source, "processing decision", item.payload.score || 0);
      await handleDecision(mint, item.source, item.payload);
    } catch (e) {
      console.error("Decision queue error [" + mint.slice(0, 8) + "]:", e.message);
      setMintState(mint, "idle", item.source, "decision error", 0);
    }
  }

  decisionWorkerBusy = false;
}

async function handleDecision(mint, source, payload) {
  const state = ensureMintState(mint);

  if (positions[mint] && positions[mint].symbol) {
    setMintState(mint, "bought", source, "already in position", state.score || 0);
    return;
  }

  if (failedMints.has(mint)) {
    setMintState(mint, "blocked", source, "failedMints", state.score || 0);
    return;
  }

  const dex = payload.dex || await fetchDex(mint, 2);
  if (!dex) {
    setMintState(mint, "idle", source, "market data unavailable", 0);
    return;
  }

  const result = payload.result || await runFilters(mint, dex);

  if (!result.pass) {
    setMintState(mint, "filtered", source, "filters failed", result.score || 0);
    return;
  }

  setMintState(mint, "buying", source, "eligible for buy", result.score || 0);
  await executeBuy(mint, dex, result, payload.overrideSol, payload.precomputedBundle);

  if (positions[mint] && positions[mint].symbol) {
    setMintState(mint, "bought", source, "buy executed", result.score || 0);
  } else {
    setMintState(mint, "idle", source, "buy not opened", result.score || 0);
  }
}

// ─────────────────────────────────────────────
//  PRIORITY QUEUE
// ─────────────────────────────────────────────
var migrationQueue = [];
var queueWorkerBusy = false;

function queueMigration(mint, source, priority) {
  priority = (priority === undefined) ? (source === "WebSocket" ? 0 : 1) : priority;

  var existing = migrationQueue.findIndex(function(q) { return q.mint === mint; });
  if (existing > -1) {
    if (priority < migrationQueue[existing].priority) {
      migrationQueue[existing].priority = priority;
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
// ─────────────────────────────────────────────
async function isFullyMigrated(mint) {
  try {
    var mintPk = new PublicKey(mint);
    var [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPk.toBuffer()],
      PUMP_PROG_PK
    );
    var info = await connection.getAccountInfo(bondingCurve, "confirmed");
    if (info && info.data && info.data.length > 0) {
      if (info.data.length >= 49) {
        var complete = info.data[48];
        if (complete === 0) {
          console.log("   ⏭  Still bonding — skipping " + mint.slice(0, 8));
          return false;
        }
      }
      return true;
    }
    return true;
  } catch (e) {
    return true;
  }
}

// ─────────────────────────────────────────────
//  BONDING CURVE HISTORY RUG CHECK
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

    var sigs = await connection.getSignaturesForAddress(curvePk, { limit: CONFIG.BONDING_SIG_LIMIT }, "confirmed");
    if (!sigs || sigs.length === 0) {
      return { rug: false, score: 0, reason: "no curve history — allowed" };
    }

    var truncated = sigs.length >= CONFIG.BONDING_SIG_LIMIT;
    var okSigs = sigs.filter(function(s) { return !s.err; }).reverse();
    var half = Math.floor(CONFIG.BONDING_TX_SAMPLE / 2);
    var oldest = okSigs.slice(0, half);
    var newest = okSigs.length > half ? okSigs.slice(-half) : [];
    var oldestSet = new Set(oldest.map(function(s) { return s.signature; }));
    var picked = oldest.concat(newest.filter(function(s) { return !oldestSet.has(s.signature); }));
    var fullHistory = !truncated && okSigs.length <= CONFIG.BONDING_TX_SAMPLE;

    var txs = await connection.getParsedTransactions(
      picked.map(function(s) { return s.signature; }),
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" }
    );

    var events = [];
    for (var i = 0; i < picked.length; i++) {
      var tx = txs && txs[i];
      if (!tx || !tx.meta || tx.meta.err) continue;
      var keys = tx.transaction.message.accountKeys || [];
      if (!keys[0]) continue;

      var signer = keys[0].pubkey.toBase58();
      var pre = 0, post = 0;

      (tx.meta.preTokenBalances || []).forEach(function(b) {
        if (b.mint === mint && b.owner === signer) pre += parseFloat(b.uiTokenAmount && b.uiTokenAmount.amount || "0");
      });
      (tx.meta.postTokenBalances || []).forEach(function(b) {
        if (b.mint === mint && b.owner === signer) post += parseFloat(b.uiTokenAmount && b.uiTokenAmount.amount || "0");
      });

      var solDelta = ((tx.meta.postBalances[0] || 0) - (tx.meta.preBalances[0] || 0)) / 1e9;
      events.push({
        sig: picked[i].signature,
        slot: picked[i].slot,
        signer: signer,
        tokDelta: post - pre,
        solSpent: -solDelta,
      });
    }

    if (events.length === 0) {
      return { rug: false, score: 0, reason: "no parsable curve txs — allowed" };
    }

    var score = 0;
    var reasons = [];

    var creator = null;
    if (!truncated && oldest[0]) {
      var first = events.find(function(e) { return e.sig === oldest[0].signature; });
      creator = first ? first.signer : null;
    }

    if (creator) {
      var devBought = 0, devSold = 0;
      events.forEach(function(e) {
        if (e.signer !== creator) return;
        if (e.tokDelta > 0) devBought += e.tokDelta;
        if (e.tokDelta < 0) devSold += -e.tokDelta;
      });
      if (devBought > 0) {
        var devSoldPct = (devSold / devBought) * 100;
        if (devSoldPct >= CONFIG.BONDING_DEV_SOLD_PCT) {
          score += 2;
          reasons.push("dev sold " + devSoldPct.toFixed(0) + "% of their bag on curve");
        }
      }
    }

    var buySol = {};
    var totalBuySol = 0;
    events.forEach(function(e) {
      if (e.tokDelta > 0 && e.solSpent > 0.001) {
        buySol[e.signer] = (buySol[e.signer] || 0) + e.solSpent;
        totalBuySol += e.solSpent;
      }
    });
    var buyerList = Object.keys(buySol);

    if (fullHistory && totalBuySol > 0) {
      var topWallet = buyerList.reduce(function(a, b) { return buySol[b] > buySol[a] ? b : a; }, buyerList[0]);
      var topPct = (buySol[topWallet] / totalBuySol) * 100;
      if (topPct >= CONFIG.BONDING_TOP_BUYER_PCT) {
        score++;
        reasons.push("one wallet = " + topPct.toFixed(0) + "% of buy SOL");
      }
    }

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

    if (fullHistory && buyerList.length < CONFIG.BONDING_MIN_UNIQUE_BUYERS) {
      score++;
      reasons.push("only " + buyerList.length + " unique buyers");
    }

    var rug = score >= CONFIG.BONDING_MAX_SCORE;
    var reason = reasons.join(" | ") || "clean";
    var out = { rug: rug, score: score, reason: reason, txs: sigs.length };

    console.log("   🧬 Bonding history: score=" + score + "/" + CONFIG.BONDING_MAX_SCORE +
      " | " + sigs.length + " curve txs | " + reason + (rug ? " — RUG PATTERN" : ""));
    bondingCheckCache.set(mint, out);
    if (bondingCheckCache.size > 500) {
      Array.from(bondingCheckCache.keys()).slice(0, 150).forEach(function(k) { bondingCheckCache.delete(k); });
    }
    return out;

  } catch (e) {
    console.log("   ⚠️ Bonding history check error (allowing through): " + (e.message || "").slice(0, 80));
    return { rug: false, score: 0, reason: "check failed — allowed" };
  }
}

// ─────────────────────────────────────────────
//  MIGRATION WALLET BUY-CHECK
// ─────────────────────────────────────────────
async function migrationWalletBoughtThis(mint) {
  try {
    var mintPk = new PublicKey(mint);
    var migATA = getAssociatedTokenAddressSync(mintPk, migrationPk, true);
    var sigs = await connection.getSignaturesForAddress(migATA, { limit: 8 }, "confirmed");
    if (!sigs || sigs.length === 0) return false;

    for (var i = 0; i < Math.min(sigs.length, 5); i++) {
      try {
        var tx = await connection.getParsedTransaction(sigs[i].signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });

        if (!tx || !tx.meta) continue;

        var pre = tx.meta.preTokenBalances || [];
        var post = tx.meta.postTokenBalances || [];
        var migATAstr = migATA.toBase58();
        var preBal = 0;
        var postBal = 0;

        pre.forEach(function(b) {
          if (b.accountIndex !== undefined) {
            var acct = tx.transaction.message.accountKeys[b.accountIndex];
            if (acct && acct.pubkey && acct.pubkey.toBase58() === migATAstr) {
              preBal = parseFloat(b.uiTokenAmount.amount || "0");
            }
          }
        });

        post.forEach(function(b) {
          if (b.accountIndex !== undefined) {
            var acct = tx.transaction.message.accountKeys[b.accountIndex];
            if (acct && acct.pubkey && acct.pubkey.toBase58() === migATAstr) {
              postBal = parseFloat(b.uiTokenAmount.amount || "0");
            }
          }
        });

        if (postBal > preBal) {
          console.log("   ⭐ Migration wallet BOUGHT " + mint.slice(0, 8) + " — ultra priority!");
          return true;
        }
      } catch (e) {
        // ignore single tx parse failure
      }
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
    retries: (entry && entry.retries || 0) + 1,
    lastTry: Date.now(),
    firstSeenAt: entry && entry.firstSeenAt || Date.now(),
    initialMcap: entry && entry.initialMcap || null,
  });

  if (processedMints.size > 1000) {
    var keys = Array.from(processedMints.keys());
    keys.slice(0, 300).forEach(function(k) { processedMints.delete(k); });
  }

  var isRescan = entry && entry.retries > 0;
  console.log("\n🎓 [" + source + "]" + (isRescan ? " RESCAN #" + entry.retries : "") + " " + mint);

  var walletBought = false;

  if (!isRescan) {
    var fullyMigrated = await isFullyMigrated(mint);
    if (!fullyMigrated) {
      console.log("   ⏭  [" + mint.slice(0, 8) + "] still bonding — retry later");
      return;
    }

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
    }
  } else {
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

  var entry2 = processedMints.get(mint);
  var firstSeenAt = entry2 && entry2.firstSeenAt || Date.now();
  var bestTs = (dex.pairCreatedAt && dex.pairCreatedAt > 0)
    ? Math.min(firstSeenAt, dex.pairCreatedAt) : firstSeenAt;

  dex.ageMin = (Date.now() - bestTs) / 60000;
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
  var bar = "█".repeat(result.score) + "░".repeat(result.total - result.score);
  console.log("   Score: " + result.score + "/7 [" + bar + "] " + (result.pass ? "🟢 BUYING" : "🔴 SKIP"));
  Object.values(result.checks).forEach(function(c) {
    console.log("   " + (c.pass ? "✅" : "❌") + " " + c.label + ": " + c.val);
  });

  try { brain.observeCoin(dex.symbol, dex.name, result.score, result.total); } catch (e) {}

  var advice = CONFIG.BRAIN_ENABLED
    ? brain.evaluate(dex, pnlTrades)
    : { nudge: 0, mood: "neutral", signals: [], summary: "🧠 Brain: disabled" };
  console.log("🧠 " + advice.summary);
  if (advice.hot) console.log("   🌶  Brain: trending pattern match — " + dex.symbol);

  if (!result.pass) {
    var isFreshData = dex.ageMin < 2;
    var liqZero = !result.checks.liq.pass && dex.liq === 0 && isFreshData;
    var mcapZero = !result.checks.mcap.pass && dex.mcap === 0 && isFreshData;
    var retries = entry && entry.retries || 0;

    if ((liqZero || mcapZero) && retries < CONFIG.RESCAN_MAX) {
      setTimeout(function() {
        var e = processedMints.get(mint);
        if (e && e.retries < CONFIG.RESCAN_MAX) queueMigration(mint, "Rescan", 1);
      }, CONFIG.RESCAN_DELAY_MS);
      return;
    }

    if (result.score >= 5) {
      tgWithButtons(
        "🔴 *#" + dex.symbol + "*  |  MC: *$" + Math.round(dex.mcap).toLocaleString() + "*  |  Score: *" + result.score + "/7*\n" +
        "Liq: $" + Math.round(dex.liq).toLocaleString() + " | Vol: $" + Math.round(dex.vol24h).toLocaleString() + " | " + (dex.hasTwitter ? "🐦X" : "🚫NoX") + "\n" +
        "[📊 Chart](https://dexscreener.com/solana/" + mint + ") | [🐦 Birdeye](https://birdeye.so/token/" + mint + "?chain=solana) | [⚡ Swap](https://jup.ag/swap/SOL-" + mint + ")\n" +
        mint,
        [[
          { text: "🔄 Refresh", callback_data: "refresh:" + mint },
          { text: "🟢 Force Buy", callback_data: "buy:" + mint },
        ]]
      );
    }

    if (result.score >= 5 && !positions[mint] && !watchlist.has(mint)) {
      if (watchlist.size >= 5) {
        var oldestMint = watchlist.keys().next().value;
        var oldestEntry = watchlist.get(oldestMint);
        console.log("   👁  Watchlist full (5) — dropping oldest: " + (oldestEntry ? oldestEntry.symbol : oldestMint.slice(0, 6)));
        watchlist.delete(oldestMint);
      }
      watchlist.set(mint, {
        score: result.score,
        symbol: dex.symbol,
        name: dex.name,
        addedAt: Date.now(),
        firstSeenAt: firstSeenAt,
        phase: "fast",
        lastSlowScan: null,
        mcapHistory: [{ mcap: dex.mcap, ts: Date.now() }],
      });
      console.log("   👁  Watchlist: " + dex.symbol + " (" + result.score + "/7)");
      tg(
        "👁 *Watchlist Added — " + dex.name + " (" + dex.symbol + ")*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "📊 Score:  *" + result.score + "/7* — checking every 8s\n" +
        "💰 MCap:   $" + Math.round(dex.mcap).toLocaleString() + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "Mint: `" + mint + "`"
      );
    }
    return;
  }

  if (CONFIG.BRAIN_ENABLED && advice.mood === "cooling" && advice.nudge <= 0) {
    console.log("   🧠 Brain blocked — cooling mood, nudge " + advice.nudge + " [" + dex.symbol + "]");
    tg("🧠 *Brain blocked* — cooling session\n*" + dex.name + " (" + dex.symbol + ")*\n" +
      advice.summary + "\nMint: `" + mint + "`");
    return;
  }

  if (walletBought) {
    var washCheck = checkWashTrading(dex);
    var bundleCheck = await checkBundle(mint);
    if (!washCheck.wash && !bundleCheck.bundled) {
      logPaperTrade(mint, dex, result, "migration-snipe");
    } else {
      console.log("   📝 Paper log skipped — " + (washCheck.wash ? "wash trading" : "bundle") + " detected");
    }
    console.log("   ⭐ 7/7 + wallet bought — AUTO-BUY: " + dex.symbol);
    tg(
      "⭐ *Auto-Buy Triggered — " + dex.name + " (" + dex.symbol + ")*\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "📊 Score:  *7/7*  |  Migration wallet bought ✅\n" +
      "💰 MCap:   $" + Math.round(dex.mcap).toLocaleString() + "\n" +
      "💧 Liq:    $" + Math.round(dex.liq).toLocaleString() + "\n" +
      "⏱ Age:    " + ageStr + "\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Mint: `" + mint + "`"
    );

    queueDecision(mint, "Migration", {
      dex,
      result,
      reason: "wallet bought => autostart",
      precomputedBundle: bundleCheck,
    });
    return;
  }

  console.log("   🔍 7/7 — wallet didn't buy, scanning slope...");
  try {
    await new Promise(function(r) { setTimeout(r, CONFIG.SLOPE_RECHECK_MS); });
    var dex2 = await fetchDex(mint, 2);
    if (dex2) {
      dex2.ageMin = (Date.now() - bestTs) / 60000;
      dex2.ageHours = dex2.ageMin / 60;

      var result2 = await runFilters(mint, dex2);
      var slopeOk = (dex2.mcap - dex.mcap) > CONFIG.SLOPE_MIN;
      var stillPass = result2.pass;

      console.log("   🔍 Re-score: " + result2.score + "/7 | slope " + (slopeOk ? "✅" : "❌") + " | mcap " + Math.round(dex.mcap) + " → " + Math.round(dex2.mcap));

      if (stillPass && slopeOk) {
        var washCheck2 = checkWashTrading(dex2);
        var bundleCheck2 = await checkBundle(mint);
        if (!washCheck2.wash && !bundleCheck2.bundled) {
          logPaperTrade(mint, dex2, result2, "migration-snipe");
        } else {
          console.log("   📝 Paper log skipped — " + (washCheck2.wash ? "wash trading" : "bundle") + " detected");
        }
        console.log("   ✅ 7/7 + slope confirmed — AUTO-BUY: " + dex2.symbol);
        tg(
          "🪨 *Auto-Buy — " + dex2.name + " (" + dex2.symbol + ")*\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "📊 Score:  *7/7*  |  Slope confirmed ✅\n" +
          "💰 MCap:   $" + Math.round(dex2.mcap).toLocaleString() + "\n" +
          "💧 Liq:    $" + Math.round(dex2.liq).toLocaleString() + "\n" +
          "📈 Vol:    $" + Math.round(dex2.vol24h).toLocaleString() + "\n" +
          "⏱ Age:    " + ageStr + "\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "Mint: `" + mint + "`"
        );

        queueDecision(mint, "SlopeCheck", {
          dex: dex2,
          result: result2,
          reason: "7/7 slope confirmed",
          precomputedBundle: bundleCheck2,
        });
        return;
      }

      var bar2 = "█".repeat(result2.score) + "░".repeat(result2.total - result2.score);
      tgWithButtons(
        "⚠️ *7/7 but slope weak — " + dex2.name + " (" + dex2.symbol + ")*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "📊 Score:  *" + result2.score + "/7* [" + bar2 + "]\n" +
        "📉 MCap drift: $" + Math.round(dex.mcap).toLocaleString() + " → $" + Math.round(dex2.mcap).toLocaleString() + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "💰 MCap:   $" + Math.round(dex2.mcap).toLocaleString() + "\n" +
        "💧 Liq:    $" + Math.round(dex2.liq).toLocaleString() + "\n" +
        "⏱ Age:    " + ageStr + "\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "Mint: `" + mint + "`",
        [[
          { text: "🔄 Refresh", callback_data: "refresh:" + mint },
          { text: "🚀 Force Buy", callback_data: "buy:" + mint },
        ]]
      );
      return;
    }
  } catch (e) {
    console.error("   Slope scan error:", e.message);
  }

  tgWithButtons(
    "🪨 *7/7 — " + dex.name + " (" + dex.symbol + ")*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "📊 Score:  *" + result.score + "/7* [" + bar + "]  🟢 All green\n" +
    "💰 MCap:   $" + Math.round(dex.mcap).toLocaleString() + "\n" +
    "💧 Liq:    $" + Math.round(dex.liq).toLocaleString() + "\n" +
    "⏱ Age:    " + ageStr + "\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "⚠️ Could not verify slope\n" +
    "Mint: `" + mint + "`",
    [[
      { text: "🔄 Refresh", callback_data: "refresh:" + mint },
      { text: "🚀 Force Buy", callback_data: "buy:" + mint },
    ]]
  );
}

// ─────────────────────────────────────────────
//  BUY — JUPITER
// ─────────────────────────────────────────────
async function executeBuy(mint, dex, result, overrideSol, precomputedBundle) {
  if (buying.has(mint)) {
    console.log("   ⚠️ Buy in progress: " + mint.slice(0, 8));
    return;
  }
  buying.add(mint);

  var buySol = overrideSol || CONFIG.BUY_AMOUNT_SOL;

  if (failedMints.has(mint)) {
    buying.delete(mint);
    return;
  }
  if (positions[mint] && positions[mint].symbol) {
    buying.delete(mint);
    return;
  }

  var activeMints = Object.keys(positions).filter(function(m) {
    return positions[m] && positions[m].symbol;
  });

  if (activeMints.length >= CONFIG.MAX_POSITIONS) {
    console.log("   ⏸  Max positions (" + CONFIG.MAX_POSITIONS + ") reached — checking health before skipping");

    for (var i = 0; i < activeMints.length; i++) {
      var pm = activeMints[i];
      var pos = positions[pm];
      if (!pos || !pos.entryTime) continue;
      var age = Date.now() - pos.entryTime;
      if (!pos.tier1 && age >= CONFIG.PRE_BUY_STALL_MS) {
        console.log("   🔄 Selling stalled position " + pos.symbol + " to make room");
        tg("🔄 *Selling stalled position* — *" + pos.symbol + "*\nHeld " + Math.round(age/1000) + "s, no T1 yet — freeing slot");
        await executeSell(pm, 100, "Stalled — freeing slot");
        delete positions[pm];
        break;
      }
    }

    var stillActive = Object.keys(positions).filter(function(m) {
      return positions[m] && positions[m].symbol;
    });
    if (stillActive.length >= CONFIG.MAX_POSITIONS) {
      console.log("   ⏸  Still at max positions — skipping " + mint.slice(0, 8));
      buying.delete(mint);
      return;
    }
  }

  if (botPaused) {
    console.log("   ⏸  Bot is paused — skipping buy for " + mint.slice(0, 8));
    buying.delete(mint);
    delete positions[mint];
    return;
  }

  var washResult = checkWashTrading(dex);
  if (washResult.wash) {
    console.log("   🚿 Wash trading detected — " + washResult.reason);
    tg("🚿 *Wash trading — skipped*\n*" + dex.name + " (" + dex.symbol + ")*\n" + washResult.reason + "\nMint: `" + mint + "`");
    buying.delete(mint);
    return;
  }

  var authority = await checkMintAuthority(mint);
  if (!authority.safe) {
    console.log("   🔒 Authority blocked — " + authority.reason);
    tg("🔒 *Authority check — skipped*\n*" + dex.name + " (" + dex.symbol + ")*\n" + authority.reason + "\nMint: `" + mint + "`");
    if (!authority.transient) failedMints.add(mint);
    buying.delete(mint);
    return;
  }

  var honeypot = await checkHoneypot(mint, dex);
  if (!honeypot.safe) {
    console.log("   🍯 Honeypot blocked — " + honeypot.reason);
    tg("🍯 *Honeypot detected — skipped*\n*" + dex.name + " (" + dex.symbol + ")*\n" + honeypot.reason + "\nMint: `" + mint + "`");
    if (!honeypot.transient) failedMints.add(mint);
    buying.delete(mint);
    return;
  }

  var bundle = precomputedBundle || await checkBundle(mint);
  if (bundle.bundled) {
    console.log("   🎯 Bundle blocked — " + bundle.reason);
    tg(
      "🎯 *Bundle detected — skipped*\n" +
      "*" + dex.name + " (" + dex.symbol + ")*\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "🔎 Score:   " + bundle.score + "/" + CONFIG.BUNDLE_MAX_SCORE + "\n" +
      "📋 Detail:  " + bundle.reason + "\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Mint: `" + mint + "`"
    );
    failedMints.add(mint);
    buying.delete(mint);
    return;
  }

  positions[mint] = true;

  var ageStr = fmtAge(dex.ageMin);
  console.log("\n🚀 BUYING: " + dex.name + " (" + dex.symbol + ") age:" + ageStr);

  tgWithButtons(
    "🟡 *#" + dex.symbol + "*  |  MC: *$" + Math.round(dex.mcap).toLocaleString() + "*  |  Score: *" + result.score + "/7*\n" +
    "Liq: $" + Math.round(dex.liq).toLocaleString() + " | Vol: $" + Math.round(dex.vol24h).toLocaleString() + " | " + (dex.hasTwitter ? "🐦X" : "🚫NoX") + "\n" +
    (result.isCluster ? "⚡ CLUSTER — fast exit armed\n" : "") +
    "⏳ Executing via Jupiter...\n" +
    "[📊 Chart](https://dexscreener.com/solana/" + mint + ") | [🐦 Birdeye](https://birdeye.so/token/" + mint + "?chain=solana)\n" +
    mint,
    [[{ text: "🔄 Refresh", callback_data: "refresh:" + mint }]]
  );

  try {
    var solLam = Math.floor(buySol * LAMPORTS_PER_SOL);
    var tx = await jupiterSwap(CONFIG.WSOL, mint, solLam, 800);

    var { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    var sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

    var link = "https://solscan.io/tx/" + sig;
    console.log("   ✅ BUY CONFIRMED: " + link);

    positions[mint] = {
      symbol: dex.symbol,
      name: dex.name,
      mint,
      buyPrice: dex.mcap,
      isCluster: result.isCluster,
      tier1: false,
      tier2: false,
      tier3: false,
      prevVol: dex.vol5m || 0,
      entryVol: dex.vol5m || 0,
      entryHolders: null,
      lastMcap: dex.mcap,
      lastMcapTime: Date.now(),
      entryTime: Date.now(),
      peakGain: 0,
      mcapSnapshots: [{ mcap: dex.mcap, ts: Date.now() }],
      solSpent: buySol,
      entryLiq: dex.liq || 0,
      lastLiq: dex.liq || 0,
      liqDrainSince: null,
    };

    setTimeout(async function() {
      try {
        var initPoolSol = await fetchOnChainPoolSol(mint);
        if (initPoolSol !== null && positions[mint]) {
          positions[mint].buyPoolSol = initPoolSol;
          console.log("   🔗 buyPoolSol baseline: " + initPoolSol.toFixed(4) + " SOL");
        }
      } catch (e) {}
    }, 1000);

    setTimeout(async function() {
      try {
        if (!positions[mint]) return;
        var hCount = await getTotalHolderCount(mint);
        if (hCount && positions[mint]) {
          positions[mint].entryHolders = hCount;
          console.log("   👥 [T+5min] " + (positions[mint].symbol || mint.slice(0,8)) + " holders: " + hCount);

          setTimeout(async function() {
            try {
              if (!positions[mint]) return;
              var hCount2 = await getTotalHolderCount(mint);
              if (hCount2 && positions[mint] && positions[mint].entryHolders) {
                var growth = hCount2 - positions[mint].entryHolders;
                console.log("   👥 [T+7min] " + (positions[mint].symbol || mint.slice(0,8)) + " holder growth: +" + growth);
                if (growth <= 0 && (positions[mint].peakGain || 0) < 20) {
                  console.log("   👥 [HolderGrowth] No new holders + no pump — closing");
                  tg("👥 *No holder growth — closing*\n*" + (positions[mint].symbol || mint.slice(0,8)) + "*\nHolders flat at " + hCount2 + " | peak +" + (positions[mint].peakGain||0).toFixed(1) + "%");
                  await executeSell(mint, 100, "No holder growth at T+7min — " + hCount2 + " holders, peak +" + (positions[mint].peakGain||0).toFixed(1) + "%");
                  delete positions[mint];
                }
              }
            } catch (e) { console.log("   ⚠️ Holder growth check error:", e.message.slice(0,60)); }
          }, 2 * 60 * 1000);
        }
      } catch (e) { console.log("   ⚠️ T+5min holder fetch error:", e.message.slice(0,60)); }
    }, 5 * 60 * 1000);

    tg(
      "✅ *Buy Confirmed — " + dex.name + " (" + dex.symbol + ")*\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "💰 Entry MCap:  $" + Math.round(dex.mcap).toLocaleString() + "\n" +
      "💸 Spent:       " + buySol + " SOL\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Mint: `" + mint + "`\n" +
      "[View TX](" + link + ")"
    );
  } catch (err) {
    console.error("   ❌ Buy FAILED:", err.message);
    tg("❌ *Buy FAILED*\n*" + dex.name + "*\nError: `" + err.message.slice(0, 200) + "`");
    var errMsg = err.message.toLowerCase();
    if (errMsg.includes("insufficient") || errMsg.includes("not enough")) {
      failedMints.add(mint);
      console.log("   🚫 Added to failedMints — will not retry: " + err.message.slice(0, 80));
    }
    delete positions[mint];
  } finally {
    buying.delete(mint);
  }
}

// ─────────────────────────────────────────────
//  SELL
// ─────────────────────────────────────────────
async function executeSell(mint, pct, reason) {
  if (selling.has(mint)) { console.log("   ⚠️ Sell already in progress: " + mint.slice(0, 8)); return; }
  selling.add(mint);

  var pos = positions[mint];
  if (!pos) { selling.delete(mint); return; }
  console.log("📤 SELL " + pct + "% " + pos.symbol + " | " + reason);

  try {
    var mintPk = new PublicKey(mint);
    var tokenProgId = await getTokenProgramId(mintPk);
    var userATA = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, tokenProgId);
    var info = await connection.getTokenAccountBalance(userATA);
    var balance = parseInt(info && info.value && info.value.amount || "0");
    var tokens = Math.floor(balance * (pct / 100));
    if (tokens <= 0) { console.log("   ⚠️ No balance"); delete positions[mint]; selling.delete(mint); return; }

    checkSellViable(mint, tokens).then(function(v) {
      if (!v.viable) console.log("   ⚠️ [PreSell] " + pos.symbol + " — " + v.reason + " (selling anyway)");
    }).catch(function() {});

    var solBefore = 0;
    try {
      solBefore = await connection.getBalance(wallet.publicKey, "confirmed") / LAMPORTS_PER_SOL;
    } catch (e) { console.log("   ⚠️ Could not read pre-sell balance:", e.message); }

    var tx = await jupiterSwap(mint, CONFIG.WSOL, tokens, 500);
    var { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    var sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

    var link = "https://solscan.io/tx/" + sig;
    console.log("   ✅ SELL confirmed: " + link);

    var solReceived = 0;
    try {
      var solAfter = await connection.getBalance(wallet.publicKey, "confirmed") / LAMPORTS_PER_SOL;
      solReceived = solAfter - solBefore;
    } catch (e) { console.log("   ⚠️ Could not read post-sell balance:", e.message); }

    pos.totalReceived = (pos.totalReceived || 0) + solReceived;

    if (pct >= 100) {
      recordTrade(
        pos.symbol, mint,
        pos.solSpent || CONFIG.BUY_AMOUNT_SOL,
        pos.totalReceived,
        reason,
        []
      );
      delete positions[mint];
      setTimeout(async function() {
        try {
          var mintPk2 = new PublicKey(mint);
          var userATA2 = getAssociatedTokenAddressSync(mintPk2, wallet.publicKey);
          var ix = createCloseAccountInstruction(userATA2, wallet.publicKey, wallet.publicKey);
          var { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
          var txClose = new Transaction().add(ix);
          txClose.recentBlockhash = blockhash;
          txClose.feePayer = wallet.publicKey;
          txClose.sign(wallet);
          var sigClose = await connection.sendRawTransaction(txClose.serialize(), { skipPreflight: true });
          await connection.confirmTransaction({ signature: sigClose, blockhash, lastValidBlockHeight }, "confirmed");
          tg("♻️ Rent reclaimed — " + pos.symbol + " +0.0020 SOL");
        } catch (e) { console.log("⚠️ Rent reclaim failed: " + e.message.slice(0,60)); }
      }, 3000);
    }

    tg("📤 *SELL — " + pos.symbol + "*\nMint: `" + mint + "`\n" +
      pct + "% | " + reason + "\n[TX](" + link + ")");
  } catch (err) {
    console.error("   ❌ Sell failed:", err.message);
    tg("❌ *Sell FAILED — " + (pos && pos.symbol || mint.slice(0, 8)) + "*\nError: `" + err.message.slice(0, 200) + "`");
  } finally {
    selling.delete(mint);
  }
}

// ─────────────────────────────────────────────
//  AUTH + SELL VIABLE + HONEYPOT
// ─────────────────────────────────────────────
const mintAuthCache = new Map();

async function checkMintAuthority(mint) {
  var cached = mintAuthCache.get(mint);
  if (cached) return cached;
  try {
    var acct = await connection.getParsedAccountInfo(new PublicKey(mint));
    var parsed = acct && acct.value && acct.value.data && acct.value.data.parsed && acct.value.data.parsed.info;
    if (!parsed) return { safe: false, transient: true, reason: "mint account not readable" };
    if (parsed.mintAuthority) return cacheAuth(mint, { safe: false, reason: "mint authority still active" });
    if (parsed.freezeAuthority) return cacheAuth(mint, { safe: false, reason: "freeze authority still active" });
    return cacheAuth(mint, { safe: true });
  } catch (e) {
    return { safe: false, transient: true, reason: "authority check failed — " + e.message.slice(0, 60) };
  }
}

function cacheAuth(mint, result) {
  mintAuthCache.set(mint, result);
  return result;
}

async function checkSellViable(mint, tokenAmount) {
  try {
    var sellQuote = await axios.get(
      "https://api.jup.ag/swap/v1/quote" +
      "?inputMint=" + mint +
      "&outputMint=" + CONFIG.WSOL +
      "&amount=" + tokenAmount +
      "&slippageBps=500",
      { headers: JUP_HEADERS, timeout: 3000 }
    );

    if (!sellQuote.data || !sellQuote.data.outAmount) {
      return { viable: false, reason: "No sell route found" };
    }

    var impact = parseFloat(sellQuote.data.priceImpactPct || 0);
    if (impact > CONFIG.HONEYPOT_MAX_IMPACT_PCT) {
      return { viable: false, reason: "Sell impact " + impact.toFixed(1) + "% too high" };
    }

    return { viable: true, impact };
  } catch (e) {
    return { viable: true, reason: "check timed out — proceeding" };
  }
}

async function checkHoneypot(mint, dex) {
  try {
    var testLam = Math.floor(CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL * 0.1);

    var buyQuote = await axios.get(
      "https://api.jup.ag/swap/v1/quote" +
      "?inputMint=" + CONFIG.WSOL +
      "&outputMint=" + mint +
      "&amount=" + testLam +
      "&slippageBps=500",
      { headers: JUP_HEADERS, timeout: 8000 }
    );

    if (!buyQuote.data || !buyQuote.data.outAmount) {
      console.log("   🍯 Honeypot: no buy quote — skipping");
      return { safe: false, reason: "No buy route found" };
    }

    var tokenAmount = buyQuote.data.outAmount;

    var sellQuote = await axios.get(
      "https://api.jup.ag/swap/v1/quote" +
      "?inputMint=" + mint +
      "&outputMint=" + CONFIG.WSOL +
      "&amount=" + tokenAmount +
      "&slippageBps=500",
      { headers: JUP_HEADERS, timeout: 8000 }
    );

    if (!sellQuote.data || !sellQuote.data.outAmount) {
      console.log("   🍯 Honeypot: no sell route — BLOCKED");
      return { safe: false, reason: "No sell route — likely honeypot" };
    }

    var impact = parseFloat(sellQuote.data.priceImpactPct || 0);
    if (impact > CONFIG.HONEYPOT_MAX_IMPACT_PCT) {
      console.log("   🍯 Honeypot: sell impact " + impact.toFixed(1) + "% > " + CONFIG.HONEYPOT_MAX_IMPACT_PCT + "% — BLOCKED");
      return { safe: false, reason: "Sell impact " + impact.toFixed(1) + "% — no exit liquidity" };
    }

    console.log("   ✅ Honeypot check passed — sell impact " + impact.toFixed(1) + "%");
    return { safe: true, impact };
  } catch (e) {
    console.log("   ⚠️ Honeypot check failed (blocking):", e.message.slice(0, 80));
    return { safe: false, transient: true, reason: "honeypot check failed — blocked for safety" };
  }
}

// ─────────────────────────────────────────────
//  WASH TRADING CHECK
// ─────────────────────────────────────────────
function checkWashTrading(dex) {
  if (!dex.vol5m || dex.vol5m < CONFIG.WASH_VOL_THRESHOLD) return { wash: false };
  var buys5m = dex.buys5m || 0;
  if (buys5m === 0) {
    return { wash: true, reason: "$" + Math.round(dex.vol5m) + " vol5m but 0 buy txns — wash trading" };
  }
  if (buys5m < CONFIG.WASH_MIN_UNIQUE_BUYS) {
    return {
      wash: true,
      reason: "$" + Math.round(dex.vol5m) + " vol5m but only " + buys5m + " buy txns — likely wash"
    };
  }
  return { wash: false };
}

// ─────────────────────────────────────────────
//  BUNDLE DETECTION
// ─────────────────────────────────────────────
async function checkBundle(mint) {
  if (CONFIG.BUNDLE_MAX_SCORE === 0) return { bundled: false, score: 0, reason: "disabled" };
  try {
    var mintPk = new PublicKey(mint);
    var sigs = await connection.getSignaturesForAddress(mintPk, { limit: CONFIG.BUNDLE_TX_LIMIT }, "confirmed");
    if (!sigs || sigs.length === 0) return { bundled: false, score: 0, reason: "no txs" };

    var migPkStr = migrationPk.toBase58();
    var walletBuys = {};

    for (var i = 0; i < sigs.length; i++) {
      try {
        var tx = await connection.getParsedTransaction(sigs[i].signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (!tx || !tx.meta) continue;

        var slot = sigs[i].slot;
        var keys = tx.transaction.message.accountKeys || [];
        var signers = keys.filter(function(k) { return k.signer; }).map(function(k) { return k.pubkey.toBase58(); });
        if (signers.includes(migPkStr)) continue;

        var preBalances = tx.meta.preBalances || [];
        var postBalances = tx.meta.postBalances || [];

        for (var ki = 0; ki < keys.length; ki++) {
          var key = keys[ki];
          if (!key.signer || !key.writable) continue;
          var walletStr = key.pubkey.toBase58();
          if (walletStr === migPkStr) continue;

          var solSpent = (preBalances[ki] - postBalances[ki]) / 1e9;
          if (solSpent < 0.001) continue;

          var gotTokens = (tx.meta.postTokenBalances || []).some(function(b) {
            var bKey = keys[b.accountIndex];
            return bKey && bKey.pubkey.toBase58() !== walletStr &&
              (tx.meta.preTokenBalances || []).every(function(pre) {
                return pre.accountIndex !== b.accountIndex ||
                  parseFloat(b.uiTokenAmount.amount) > parseFloat(pre.uiTokenAmount.amount || "0");
              });
          });

          if (!walletBuys[walletStr]) {
            walletBuys[walletStr] = { slot, solSpent };
          }
        }
      } catch (e) {}
    }

    var buyers = Object.keys(walletBuys);
    if (buyers.length < 2) return { bundled: false, score: 0, reason: "not enough buyers" };

    var bundleScore = 0;
    var bundleReasons = [];

    var slotGroups = {};
    buyers.forEach(function(w) {
      var s = walletBuys[w].slot;
      if (!slotGroups[s]) slotGroups[s] = [];
      slotGroups[s].push(w);
    });
    var maxSlotGroup = Object.values(slotGroups).reduce(function(a, b) {
      return b.length > a.length ? b : a;
    }, []);

    if (maxSlotGroup.length >= CONFIG.BUNDLE_SAME_SLOT) {
      bundleScore++;
      bundleReasons.push(maxSlotGroup.length + " wallets in same slot");

      var sizes = maxSlotGroup.map(function(w) { return walletBuys[w].solSpent; });
      var avgSize = sizes.reduce(function(a, b) { return a + b; }, 0) / sizes.length;
      var allClose = sizes.every(function(s) {
        return Math.abs(s - avgSize) / avgSize * 100 <= CONFIG.BUNDLE_SIZE_DIFF_PCT;
      });
      if (allClose && sizes.length >= 3) {
        bundleScore++;
        bundleReasons.push("coordinated sizes ~" + avgSize.toFixed(3) + " SOL each");
      }
    }

    var preBals = buyers.map(function(w) {
      return Math.round(walletBuys[w].solSpent * 10) / 10;
    });
    var balFreq = {};
    preBals.forEach(function(b) {
      balFreq[b] = (balFreq[b] || 0) + 1;
    });
    var maxFreq = Math.max.apply(null, Object.values(balFreq));
    if (maxFreq >= 3) {
      bundleScore++;
      bundleReasons.push(maxFreq + " wallets with identical spend amounts");
    }

    var bundled = bundleScore >= CONFIG.BUNDLE_MAX_SCORE;
    var reason = bundleReasons.join(" | ") || "clean";
    console.log("   🔎 Bundle check: score=" + bundleScore + " | " + reason);
    return { bundled, score: bundleScore, reason };

  } catch (e) {
    console.log("   ⚠️ Bundle check error (allowing through):", e.message.slice(0, 80));
    return { bundled: false, score: 0, reason: "check failed — allowed" };
  }
}

// ─────────────────────────────────────────────
//  ON-CHAIN POOL SOL
// ─────────────────────────────────────────────
var poolSolCache = new Map();
var missCache = new Map();
var pdaMissCount = 0;

async function fetchOnChainPoolSol(mint) {
  try {
    var cached = poolSolCache.get(mint);
    if (cached && Date.now() - cached.ts < 600) return cached.sol;

    var missed = missCache.get(mint);
    if (missed && Date.now() - missed < 60000) return null;

    var mintPk = new PublicKey(mint);
    var poolAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from("pool-authority"), mintPk.toBuffer()],
      PUMP_AMM_PK
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
    var wsolAta = getAssociatedTokenAddressSync(new PublicKey(CONFIG.WSOL), poolPk, true);
    var info = await connection.getTokenAccountBalance(wsolAta, "confirmed");
    var sol = info && info.value ? parseInt(info.value.amount) / LAMPORTS_PER_SOL : null;
    if (sol !== null) poolSolCache.set(mint, { sol, ts: Date.now() });
    return sol;
  } catch (e) {
    missCache.set(mint, Date.now());
    pdaMissCount++;
    return null;
  }
}

// ─────────────────────────────────────────────
//  MONITOR
// ─────────────────────────────────────────────
var monitorRunning = false;
async function monitor() {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    var mints = Object.keys(positions);

    for (var i = 0; i < mints.length; i++) {
      var mint = mints[i];
      if (!positions[mint]) continue;
      var pos = positions[mint];

      try {
        if (!pos.ghostDetecting) {
          var ghostAgeMs = pos.entryTime ? Date.now() - pos.entryTime : 0;
          if (ghostAgeMs > 60000 && pos.solSpent > 0) {
            var ghostMintPk = new PublicKey(mint);
            var ghostProgId = await getTokenProgramId(ghostMintPk);
            var ghostAta = getAssociatedTokenAddressSync(ghostMintPk, wallet.publicKey, false, ghostProgId);
            var ghostBal = await connection.getTokenAccountBalance(ghostAta).catch(function() { return null; });
            var ghostRawBal = parseInt(ghostBal && ghostBal.value && ghostBal.value.amount || "0");
            if (ghostRawBal === 0 && pos.state !== "BUYING") {
              pos.ghostDetecting = true;
              console.log("   👻 Ghost position detected — " + pos.symbol + " — reading sell tx for PnL...");
              try {
                var ghostSigs = await connection.getSignaturesForAddress(ghostAta, { limit: 5 }).catch(function() { return []; });
                var ghostSellSig = null;
                for (var gs = 0; gs < ghostSigs.length; gs++) {
                  if (!ghostSigs[gs].err) { ghostSellSig = ghostSigs[gs].signature; break; }
                }
                if (ghostSellSig) {
                  console.log("   👻 Sell tx found: https://solscan.io/tx/" + ghostSellSig);
                  tg("👻 *Manual Sell Detected — " + pos.symbol + "*\nSell tx: `" + ghostSellSig + "`");
                } else {
                  console.log("   👻 Sell tx not found — closing silently (no PnL recorded)");
                }
              } catch (ghostInner) {}
              delete positions[mint];
              continue;
            }
          }
        }
      } catch (ghostErr) {}

      var dex = await fetchDex(mint, 2);
      if (!dex) continue;

      var mcap = dex.mcap;
      var curVol = dex.vol5m || 0;

      var holdMs = pos.entryTime ? Date.now() - pos.entryTime : 0;
      pos.onChainTick = (pos.onChainTick || 0) + 1;
      if (holdMs < 420000 && pos.buyPoolSol && pos.onChainTick % 3 === 0) {
        var onChainSol = await fetchOnChainPoolSol(mint);
        if (onChainSol !== null) {
          var onChainGain = ((onChainSol - pos.buyPoolSol) / pos.buyPoolSol) * 100;
          mcap = pos.buyPrice * (1 + onChainGain / 100);
        }
      }

      var gain = pos.buyPrice > 0 ? ((mcap - pos.buyPrice) / pos.buyPrice) * 100 : 0;
      var gainStr = (gain >= 0 ? "+" : "") + gain.toFixed(1) + "%";
      console.log(pos.symbol + " | " + gainStr + " | MCap $" + Math.round(mcap).toLocaleString() + (holdMs < 420000 ? " [onchain]" : ""));

      if (mcap !== pos.lastMcap) { pos.lastMcap = mcap; pos.lastMcapTime = Date.now(); }

      if (gain > (pos.peakGain || 0)) pos.peakGain = gain;

      if (pos.lastLiq && dex.liq !== undefined && dex.liq !== null && dex.liq < pos.lastLiq) {
        var suddenDropPct = (pos.lastLiq - dex.liq) / pos.lastLiq;
        if (suddenDropPct >= 0.40) {
          await executeSell(mint, 100, "Sudden liquidity pull — dropped " + (suddenDropPct * 100).toFixed(0) + "% in one check, now " + gainStr);
          delete positions[mint];
          continue;
        }
      }
      if (dex.liq !== undefined && dex.liq !== null) pos.lastLiq = dex.liq;

      if (pos.entryLiq > 0 && dex.liq !== undefined && dex.liq !== null) {
        var liqPct = dex.liq / pos.entryLiq;
        var liqDraining = liqPct < CONFIG.LIQUIDITY_DRAIN_PCT || dex.liq < CONFIG.LIQUIDITY_ABS_FLOOR;
        if (liqDraining) {
          if (!pos.liqDrainSince) pos.liqDrainSince = Date.now();
          if (Date.now() - pos.liqDrainSince >= CONFIG.LIQUIDITY_DRAIN_CONFIRM_MS) {
            var liqReason = dex.liq < CONFIG.LIQUIDITY_ABS_FLOOR
              ? "Liquidity drain — liq $" + Math.round(dex.liq).toLocaleString() + " below hard floor, now " + gainStr
              : "Liquidity drain — liq fell to " + (liqPct * 100).toFixed(0) + "% of entry, now " + gainStr;
            await executeSell(mint, 100, liqReason);
            delete positions[mint];
            continue;
          }
        } else {
          pos.liqDrainSince = null;
        }

        if (!pos.lastSellCheck || Date.now() - pos.lastSellCheck > 60000) {
          pos.lastSellCheck = Date.now();
          var washNow = checkWashTrading(dex);
          if (washNow.wash) {
            console.log("   ⚠️ [WashRecheck] " + pos.symbol + " now showing wash trading — exiting");
            await executeSell(mint, 100, "Wash trading detected while holding: " + washNow.reason);
            delete positions[mint];
            continue;
          }

          try {
            var mintPkChk = new PublicKey(mint);
            var tokProgChk = await getTokenProgramId(mintPkChk);
            var ataChk = getAssociatedTokenAddressSync(mintPkChk, wallet.publicKey, false, tokProgChk);
            var balChk = await connection.getTokenAccountBalance(ataChk);
            var heldTokens = parseInt(balChk && balChk.value && balChk.value.amount || "0");
            if (heldTokens > 0) {
              var sellCheck = await checkSellViable(mint, heldTokens);
              if (!sellCheck.viable) {
                console.log("   ⚠️ [SellRouteRecheck] " + pos.symbol + " — " + sellCheck.reason + " — exiting now");
                await executeSell(mint, 100, "Sell route degraded: " + sellCheck.reason);
                delete positions[mint];
                continue;
              }
            }
          } catch (e) {}
        }
      }

      if (!pos.mcapSnapshots) pos.mcapSnapshots = [];
      var lastSnap = pos.mcapSnapshots[pos.mcapSnapshots.length - 1];
      if (!lastSnap || Date.now() - lastSnap.ts >= 60000) {
        pos.mcapSnapshots.push({ mcap, ts: Date.now() });
      }

      if (holdMs >= CONFIG.CONVICTION_TIME_MS && (pos.peakGain || 0) < CONFIG.CONVICTION_MIN_GAIN && !pos.convictionExited) {
        pos.convictionExited = true;
        console.log("   ⏱ [Conviction] " + pos.symbol + " 10min no +" + CONFIG.CONVICTION_MIN_GAIN + "% — closing | peak +" + (pos.peakGain||0).toFixed(1) + "% now " + gainStr);
        await executeSell(mint, 100, "Conviction exit — 10min, peak +" + (pos.peakGain||0).toFixed(1) + "%, now " + gainStr);
        delete positions[mint];
        continue;
      }

      if (!pos.lockedFloor) {
        if (holdMs >= 8 * 60 * 1000 && (pos.peakGain || 0) < CONFIG.SLIDING_STOP_8MIN) {
          console.log("   ⏱ [Sliding] " + pos.symbol + " 8min no +" + CONFIG.SLIDING_STOP_8MIN + "% — closing | " + gainStr);
          await executeSell(mint, 100, "Sliding exit — 8min, peak +" + (pos.peakGain||0).toFixed(1) + "%");
          delete positions[mint];
          continue;
        }
        if (holdMs >= 3 * 60 * 1000 && (pos.peakGain || 0) < 20 && gain <= CONFIG.SLIDING_STOP_3MIN) {
          console.log("   ⏱ [Sliding] " + pos.symbol + " 3min no +20%, now " + gainStr + " — tightened stop");
          await executeSell(mint, 100, "Sliding stop — 3min, peak +" + (pos.peakGain||0).toFixed(1) + "%, now " + gainStr);
          delete positions[mint];
          continue;
        }
      }

      if (holdMs >= 5 * 60 * 1000 && !pos.volVelocityChecked) {
        pos.volVelocityChecked = true;
        if (pos.entryVol && curVol < pos.entryVol * CONFIG.VOL_VELOCITY_DROP) {
          console.log("   📉 [VolVelocity] " + pos.symbol + " vol dropped >40% from entry — exiting");
          await executeSell(mint, 100, "Volume velocity — 5min vol fell 40%+ from entry");
          delete positions[mint];
          continue;
        }
      }

      if (holdMs >= 5 * 60 * 1000 && !pos.buySellChecked) {
        pos.buySellChecked = true;
        var buys5m = dex.buys5m || 0;
        var sells5m = dex.sells5m || 0;
        if (sells5m > 0 && buys5m > 0 && sells5m > buys5m * 1.5) {
          console.log("   📉 [BuySell] " + pos.symbol + " sells dominating " + sells5m + ">" + buys5m + " — exiting");
          await executeSell(mint, 100, "Buy/sell ratio — sells " + sells5m + " vs buys " + buys5m + " at 5min");
          delete positions[mint];
          continue;
        }
      }

      if (holdMs >= 5 * 60 * 1000 && !pos.momentumChecked && pos.mcapSnapshots.length >= 2) {
        pos.momentumChecked = true;
        var snap1 = pos.mcapSnapshots[0];
        var snap5 = pos.mcapSnapshots[pos.mcapSnapshots.length - 1];
        if (snap5.mcap < snap1.mcap * CONFIG.MOMENTUM_DROP) {
          console.log("   📉 [Momentum] " + pos.symbol + " mcap fell 15%+ from T+1min — rug pattern | " + gainStr);
          await executeSell(mint, 100, "MCap momentum — peaked at T+1min, now -" + ((1 - snap5.mcap/snap1.mcap) * 100).toFixed(0) + "% from that");
          delete positions[mint];
          continue;
        }
      }

      if (gain < 0 && holdMs < 45000) continue;

      if (CONFIG.BREAKEVEN_EXIT && !pos.tier1) {
        var peak = pos.peakGain || 0;
        var floor = peak >= 60 ? null
          : peak >= 20 ? 15
          : peak >= 15 ? 10
          : peak >= 10 ? 5
          : peak >= 4 ? 3
          : null;

        if (floor !== null && gain <= floor) {
          var floorStr = floor > 0 ? "+" + floor + "%" : "0%";
          await executeSell(mint, 100, "Break-even exit — peak +" + peak.toFixed(1) + "% → floor " + floorStr);
          delete positions[mint];
          continue;
        }
      }

      if (gain <= CONFIG.STOP_LOSS_PCT) {
        await executeSell(mint, 100, "Stop loss " + gainStr);
        delete positions[mint];
        continue;
      }

      if (pos.prevVol > 0 && curVol < pos.prevVol * (1 - CONFIG.VOLUME_DROP_PCT)) {
        await executeSell(mint, 100, "Volume crash -50%");
        delete positions[mint];
        continue;
      }
      pos.prevVol = curVol;

      var peak = pos.peakGain || 0;
      var triggers = CONFIG.PROFIT_LOCK_TRIGGERS;
      var hitTrigger = null;
      for (var t = triggers.length - 1; t >= 0; t--) {
        if (peak >= triggers[t].gain) { hitTrigger = triggers[t]; break; }
      }

      if (hitTrigger) {
        if (!pos.lockedFloor || hitTrigger.floor > pos.lockedFloor) {
          pos.lockedFloor = hitTrigger.floor;
          console.log("🔒 [Floor Lock] " + pos.symbol + " peak +" + peak.toFixed(1) + "% → floor locked at +" + pos.lockedFloor + "%");
        }
        if (gain <= pos.lockedFloor) {
          await executeSell(mint, 100, "Floor hit +" + pos.lockedFloor + "% → now " + gainStr);
          delete positions[mint];
          continue;
        }
        if (!pos.lastPeak || peak > pos.lastPeak) {
          pos.lastPeak = peak;
          pos.lastPeakTime = Date.now();
        }
        if (pos.lastPeakTime && (Date.now() - pos.lastPeakTime) >= CONFIG.TRAIL_STALL_MS) {
          await executeSell(mint, 100, "Trail stall — peak +" + peak.toFixed(1) + "% for 30s");
          delete positions[mint];
          continue;
        }
      }
    }
  } finally {
    monitorRunning = false;
  }
}

// ─────────────────────────────────────────────
//  DEAD POSITION CLEANER
// ─────────────────────────────────────────────
var cleanerRunning = false;
async function cleanDeadPositions() {
  if (cleanerRunning) return;
  cleanerRunning = true;
  try {
    var mints = Object.keys(positions);
    if (mints.length === 0) return;

    for (var i = 0; i < mints.length; i++) {
      var mint = mints[i];
      var pos = positions[mint];
      if (!pos || !pos.symbol || !pos.entryTime) continue;

      var heldMs = Date.now() - pos.entryTime;
      var peakGain = pos.peakGain || 0;

      if (heldMs < CONFIG.DEAD_HOLD_MS) continue;
      if (peakGain > CONFIG.DEAD_MAX_PEAK_PCT) continue;
      if (pos.lockedFloor) continue;

      var dex = await fetchDex(mint, 2);
      if (!dex) {
        console.log("   🧹 [Cleaner] No data for " + pos.symbol + " after " + Math.round(heldMs/60000) + "min — force cleaning");
        tg(
          "🧹 *Dead Position Cleaned — " + pos.symbol + "*\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "⏱ Held:      " + Math.round(heldMs / 60000) + "min\n" +
          "📉 Reason:   No market data — coin likely dead\n" +
          "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
          "Mint: `" + mint + "`"
        );
        await executeSell(mint, 100, "Cleaner — no data after " + Math.round(heldMs/60000) + "min");
        delete positions[mint];
        continue;
      }

      var gain = pos.buyPrice > 0 ? ((dex.mcap - pos.buyPrice) / pos.buyPrice) * 100 : 0;
      var gainStr = (gain >= 0 ? "+" : "") + gain.toFixed(1) + "%";

      if (gain > CONFIG.DEAD_EXIT_THRESHOLD) continue;

      console.log("   🧹 [Cleaner] " + pos.symbol + " held " + Math.round(heldMs/60000) + "min | peak +" + peakGain.toFixed(1) + "% | now " + gainStr + " — cleaning");

      tg(
        "🧹 *Dead Position Cleaned — " + pos.symbol + "*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "⏱ Held:      " + Math.round(heldMs / 60000) + "min\n" +
        "📈 Peak:      +" + peakGain.toFixed(1) + "%\n" +
        "💰 Exit:      " + gainStr + "\n" +
        "📉 Reason:   Down " + gainStr + " after 10min with no momentum\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "Mint: `" + mint + "`"
      );

      await executeSell(mint, 100, "Cleaner — held " + Math.round(heldMs/60000) + "min, peak +" + peakGain.toFixed(1) + "%, now " + gainStr);
      delete positions[mint];
    }
  } catch (e) {
    console.error("[Cleaner] Error:", e.message);
  } finally {
    cleanerRunning = false;
  }
}

// ─────────────────────────────────────────────
//  WATCHLIST
// ─────────────────────────────────────────────
async function scanWatchlist() {
  if (watchlist.size === 0) return;

  var now = Date.now();
  for (var [mint, w] of watchlist) {
    if (positions[mint]) { watchlist.delete(mint); continue; }

    var elapsed = now - w.addedAt;

    if (elapsed > 5 * 60 * 1000) {
      console.log("   👁  [" + w.symbol + "] 5min expired — dropped from watchlist");
      watchlist.delete(mint);
      continue;
    }

    if (elapsed > CONFIG.WATCH_FAST_WINDOW_MS && w.lastScanAt && now - w.lastScanAt < CONFIG.WATCH_SLOW_MS) {
      continue;
    }
    w.lastScanAt = now;

    try {
      var dex = await fetchDex(mint, 2);
      if (!dex) continue;

      if (w.firstSeenAt) {
        var bestTs = (dex.pairCreatedAt && dex.pairCreatedAt > 0)
          ? Math.min(w.firstSeenAt, dex.pairCreatedAt) : w.firstSeenAt;
        dex.ageMin = (Date.now() - bestTs) / 60000;
        dex.ageHours = dex.ageMin / 60;
      }

      if (!w.mcapHistory) w.mcapHistory = [];
      w.mcapHistory.push({ mcap: dex.mcap, ts: Date.now() });
      if (w.mcapHistory.length > 10) w.mcapHistory.shift();

      var result = await runFilters(mint, dex);
      var bar = "█".repeat(result.score) + "░".repeat(result.total - result.score);

      if (w.lastLoggedScore !== result.score) {
        w.lastLoggedScore = result.score;
        console.log("   👁  [" + w.symbol + "] " + result.score + "/7 [" + bar + "] " + Math.round(elapsed/1000) + "s");
      }

      if (result.pass) {
        var slopeOk = true;
        if (w.mcapHistory.length >= CONFIG.SLOPE_MIN_READINGS) {
          var oldest = w.mcapHistory[0].mcap;
          var newest = w.mcapHistory[w.mcapHistory.length - 1].mcap;
          slopeOk = (newest - oldest) > CONFIG.SLOPE_MIN;
          if (!slopeOk) {
            console.log("   📉 [" + w.symbol + "] Slope declining — holding off");
          }
        }
        if (slopeOk) {
          if (!positions[mint] && !buying.has(mint) && !w.alerted) {
            w.alerted = true;

            queueDecision(mint, "Watchlist", {
              dex,
              result,
              reason: "watchlist hit"
            });

            logPaperTrade(mint, dex, result, "watchlist");
            tgWithButtons(
              "🪨 *Watchlist 7/7 — " + dex.name + " (" + dex.symbol + ")*\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "📊 Score:  *7/7*  |  MCap trending up ✅  |  ⚠️ Wallet didn't buy\n" +
              "💰 MCap:   $" + Math.round(dex.mcap).toLocaleString() + "\n" +
              "💧 Liq:    $" + Math.round(dex.liq).toLocaleString() + "\n" +
              "📈 Vol:    $" + Math.round(dex.vol24h).toLocaleString() + "\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "Mint: `" + mint + "`",
              [[
                { text: "🔄 Refresh", callback_data: "refresh:" + mint },
                { text: "🚀 Force Buy", callback_data: "buy:" + mint },
              ]]
            );
          }
        }
      } else if (result.score <= 5) {
        console.log("   👁  [" + w.symbol + "] Score dropped to " + result.score + "/7 — removed");
        watchlist.delete(mint);
      }
    } catch (e) {
      console.error("Watchlist error [" + w.symbol + "]:", e.message);
    }
  }
}

// ─────────────────────────────────────────────
//  WEBSOCKET
// ─────────────────────────────────────────────
function connectWS() {
  console.log("🔌 Connecting WebSocket...");
  var PP_KEY = process.env.PUMPPORTAL_API_KEY;
  var wsUrl = "wss://pumpportal.fun/api/data" + (PP_KEY ? "?api-key=" + PP_KEY : "");
  var ws = new WebSocket(wsUrl);
  var rawLogged = 0;

  ws.on("open", function() {
    console.log("✅ WebSocket connected — subscribing to migrations (subscribeMigration)");
    ws.send(JSON.stringify({ method: "subscribeMigration" }));
  });

  ws.on("message", async function(raw) {
    try {
      if (rawLogged < 3) { rawLogged++; console.log("🧪 [WS raw] " + raw.toString().slice(0, 400)); }
      var e = JSON.parse(raw.toString());
      if (!e.mint) return;
      var entry = processedMints.get(e.mint);
      if (entry && entry.retries >= CONFIG.RESCAN_MAX) return;
      if (entry && Date.now() - entry.lastTry < 2000) return;
      console.log("⚡ [WS] Migration: " + e.mint.slice(0, 8) + "...");
      queueMigration(e.mint, "WebSocket", 0);
      queueDecision(e.mint, "WebSocket", { reason: "migration detected" });
    } catch (err) { console.error("WS parse:", err.message); }
  });

  ws.on("error", function(e) { console.error("WS error:", e.message); });
  ws.on("close", function() {
    console.log("⚠️ WS closed — reconnecting 3s...");
    setTimeout(connectWS, 3000);
  });
}

// ─────────────────────────────────────────────
//  RPC POLLING
// ─────────────────────────────────────────────
async function poll() {
  try {
    var sigs = await connection.getSignaturesForAddress(migrationPk, { limit: 50, until: lastSig || undefined });
    if (!sigs || !sigs.length) return;

    lastSig = sigs[0].signature;
    var newSigs = sigs.filter(function(s) { return !processedSigs.has(s.signature); });
    if (!newSigs.length) return;

    for (var i = 0; i < newSigs.length; i++) {
      var s = newSigs[i];
      processedSigs.add(s.signature);
      var mint = await extractMint(s.signature);
      if (!mint) continue;

      var entry = processedMints.get(mint);
      if (entry && entry.retries >= CONFIG.RESCAN_MAX) continue;
      if (entry && Date.now() - entry.lastTry < 5000) continue;

      console.log("🔍 [RPC] Migration: " + mint.slice(0, 8) + "...");
      queueMigration(mint, "RPC Poll", 1);
      queueDecision(mint, "RPC Poll", { reason: "migration detected" });
    }

    if (processedSigs.size > 500) {
      var arr = Array.from(processedSigs);
      arr.slice(0, 200).forEach(function(s) { processedSigs.delete(s); });
    }
  } catch (e) {
    var msg = e.message || "";
    if (msg.indexOf("429") > -1) {
      console.log("⏳ RPC rate limited — pausing 30s");
      await new Promise(function(r) { setTimeout(r, 30000); });
    } else {
      console.error("Poll error:", msg);
    }
  }
}

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
console.log("╔══════════════════════════════════════════════╗");
console.log("║   PUMP.FUN MIGRATION SNIPER — JUPITER BUILD  ║");
console.log("╚══════════════════════════════════════════════╝");
console.log("Wallet  : " + wallet.publicKey.toBase58());
console.log("Watching: " + CONFIG.MIGRATION_PROGRAM);
console.log("Buy     : " + CONFIG.BUY_AMOUNT_SOL + " SOL via Jupiter");
console.log("Filters : age-aware Vol/MCap + Top10% + LP/holder");
console.log("Watchlist: 5+/7 → 8s scans → drops at 3/7, buys at 7/7");

process.on("uncaughtException", function(e) { console.error("💥 Uncaught:", e.message); });
process.on("unhandledRejection", function(e) { console.error("💥 Unhandled:", e && e.message || e); });

tg(
  "🤖 *Migration Sniper LIVE*\n" +
  "Wallet: `" + wallet.publicKey.toBase58() + "`\n\n" +
  "*Filters:*\n" +
  "• MCap > $" + CONFIG.MIN_MCAP_USD.toLocaleString() + "\n" +
  "• Liq  $" + CONFIG.MIN_LIQUIDITY_USD.toLocaleString() + "–$" + CONFIG.MAX_LIQUIDITY_USD.toLocaleString() + "\n" +
  "• Vol  > $" + CONFIG.MIN_VOLUME_USD.toLocaleString() + "\n" +
  "• Age  < " + (CONFIG.MAX_AGE_HOURS * 60).toFixed(0) + "min\n" +
  "• Holders ≥ " + CONFIG.MIN_HOLDERS + " | LP/holder ≥ $" + CONFIG.MIN_LP_PER_HOLDER + "\n" +
  "• Vol/MCap: 0s=0.05x | 30s=0.15x | 2m=0.3x | 10m=0.8x\n" +
  "• Top10%:  0s<50% | 30s<45% | 2m<40% | 10m<20%\n\n" +
  "*Protection:*\n" +
  "• Stop " + CONFIG.STOP_LOSS_PCT + "% | Vol crash -50% | Break-even exit ON\n\n" +
  "*Sells:* trailing floor — +" + CONFIG.PROFIT_LOCK_TRIGGERS[0].gain + "% → floor +" + CONFIG.PROFIT_LOCK_TRIGGERS[0].floor + "% | +" + CONFIG.PROFIT_LOCK_TRIGGERS[1].gain + "% → floor +" + CONFIG.PROFIT_LOCK_TRIGGERS[1].floor + "%\n\n" +
  "*Max positions:* " + CONFIG.MAX_POSITIONS + "\n" +
  "*Watchlist:* 5+/7 → 8s | drops at 3/7"
);

setInterval(function() {
  if (dex429Count > 0) console.log("📊 [1min] DexScreener 429s: " + dex429Count);
  dex429Count = 0;
}, 60000);

setInterval(function() {
  console.log("📊 [1hr] PDA misses: " + pdaMissCount);
  pdaMissCount = 0;
}, 60 * 60 * 1000);

connectWS();

startCallbackPolling();

setTimeout(function() {
  console.log("🔍 RPC poll started (backup)...");
  setInterval(function() {
    poll().catch(function(e) { console.error("Poll:", e.message); });
  }, CONFIG.POLL_INTERVAL_MS);
}, 5000);

setInterval(function() {
  monitor().catch
