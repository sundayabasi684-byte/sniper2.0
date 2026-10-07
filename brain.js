/**
 * ================================================================
 *  brain.js — Migration Sniper Advisor
 *
 *  Standalone module. Never imports from bot.js.
 *  Never touches: executeBuy, executeSell, monitor, positions,
 *                 wallet, connection, or any live trading state.
 *
 *  Three layers:
 *    1. Mood       — session PnL → confidence adjustment (day 1)
 *    2. Narrative  — coin name/symbol keyword scan (day 1)
 *    3. Patterns   — win/loss traits from closed trades (100+ trades)
 *
 *  Integration in handleMigration (after runFilters returns result):
 *
 *    const brain = require("./brain");
 *    var advice = brain.evaluate(dex, pnlTrades);
 *    // advice.nudge  : number  — informational only, does NOT change result.pass
 *    // advice.mood   : string  — "confident" | "cautious" | "cooling"
 *    // advice.signals: string[] — human-readable reasons
 *    console.log("🧠 Brain:", advice.summary);
 *    // Optional: append to Telegram skip message
 *
 *  Config flag in bot.js CONFIG:
 *    BRAIN_ENABLED: true,
 *
 *  Telegram command:
 *    /brain  — session mood + pattern stats + recent signal history
 * ================================================================
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const BRAIN_MEMORY_FILE = path.join(__dirname, "brain_memory.json");
const TREND_MEMORY_FILE = path.join(__dirname, "trend_memory.json");

// ─────────────────────────────────────────────
//  PERSISTENT STORAGE — survives Railway redeploys
//  Uses local file as primary + JSONBin as backup
//  JSONBin: free tier, 10k requests/month
//  Set JSONBIN_BIN_ID and JSONBIN_API_KEY in Railway env vars
// ─────────────────────────────────────────────
var JSONBIN_BIN_ID  = process.env.JSONBIN_BIN_ID  || null;
var JSONBIN_API_KEY = process.env.JSONBIN_API_KEY  || null;
var JSONBIN_URL     = JSONBIN_BIN_ID ? "https://api.jsonbin.io/v3/b/" + JSONBIN_BIN_ID : null;

async function loadFromCloud() {
  if (!JSONBIN_URL || !JSONBIN_API_KEY) return null;
  try {
    var axios = require("axios");
    var r = await axios.get(JSONBIN_URL + "/latest", {
      headers: { "X-Master-Key": JSONBIN_API_KEY },
      timeout: 8000
    });
    return r.data && r.data.record || null;
  } catch (e) {
    console.log("🧠 Cloud load failed:", e.message);
    return null;
  }
}

async function saveToCloud(data) {
  if (!JSONBIN_URL || !JSONBIN_API_KEY) return;
  try {
    var axios = require("axios");
    await axios.put(JSONBIN_URL, data, {
      headers: { "X-Master-Key": JSONBIN_API_KEY, "Content-Type": "application/json" },
      timeout: 8000
    });
  } catch (e) {
    console.log("🧠 Cloud save failed:", e.message);
  }
}

// ─────────────────────────────────────────────
//  NARRATIVE KEYWORDS
//  Grouped by expected behaviour pattern.
//  Scores are +/- applied to the nudge.
//  These are observations, not rules — the bot
//  still decides based on its own filter score.
// ─────────────────────────────────────────────
const NARRATIVE = {
  // Historically strong migration magnets
  strong: {
    score: +2,
    words: [
      "ai", "agent", "agents", "gpt", "llm",
      "pepe", "doge", "shib", "wojak", "chad",
      "trump", "maga", "based", "meme",
      "inu", "elon", "pump", "moon",
      "sol", "solana", "jup", "jupiter",
    ],
  },
  // Usually thin liquidity / low conviction
  weak: {
    score: -1,
    words: [
      "test", "safe", "fair", "launch", "v2", "v3",
      "stake", "yield", "apy", "dao", "gov",
      "utility", "nft", "gaming", "p2e",
    ],
  },
  // Rug/honeypot signals — worth flagging
  danger: {
    score: -3,
    words: [
      "rug", "scam", "fake", "honeypot", "exit",
      "100x", "1000x", "guaranteed", "safu",
      "audit", "stealth", "anon", "shadow",
    ],
  },
};

// ─────────────────────────────────────────────
//  MOOD THRESHOLDS
//  Derived from the last N closed trades.
//  If recent sessions are consistently losing,
//  the brain raises caution — not to block buys
//  but to surface the pattern to the operator.
// ─────────────────────────────────────────────
const MOOD = {
  LOOKBACK:         10,   // how many recent trades to evaluate
  CONFIDENT_RATE:   0.60, // ≥60% win rate in last 10 → confident
  CAUTIOUS_RATE:    0.40, // ≤40% win rate in last 10 → cautious
  COOLING_LOSS_SOL: -0.05 // net loss worse than -0.05 SOL → cooling
};

// ─────────────────────────────────────────────
//  PATTERN THRESHOLDS
//  Only meaningful at 100+ closed trades.
//  Below that, getPatternNudge returns 0.
// ─────────────────────────────────────────────
const PATTERN = {
  MIN_TRADES:       100,  // don't trust patterns below this
  MIN_SAMPLE:       8,    // minimum examples of a trait before drawing conclusions
  STRONG_WIN_RATE:  0.65, // trait is a real edge
  WEAK_WIN_RATE:    0.40, // trait is a consistent drag
};

// ─────────────────────────────────────────────
//  SIGNAL HISTORY
//  Ring buffer — last 50 evaluations logged
//  for the /brain Telegram report.
// ─────────────────────────────────────────────
var signalHistory  = [];
var MAX_HISTORY    = 50;

// ─────────────────────────────────────────────
//  PERSISTENT TRADE MEMORY
//  Never wiped by session report reset.
//  Brain keeps its own running history so mood
//  survives the 3hr pnlTrades[] clear in bot.js.
// ─────────────────────────────────────────────
var MAX_BRAIN_MEMORY = 200;

// ── Load from cloud on startup — survives Railway redeploys ────────
var brainTradeMemory = [];
(async function loadBrainMemory() {
  try {
    // Try cloud first
    var cloudData = await loadFromCloud();
    if (cloudData && Array.isArray(cloudData.brainTrades) && cloudData.brainTrades.length > 0) {
      brainTradeMemory = cloudData.brainTrades.slice(-MAX_BRAIN_MEMORY);
      if (cloudData.trendMemory) trendMemory = cloudData.trendMemory;
      console.log("🧠 Brain loaded " + brainTradeMemory.length + " trades from cloud");
      // Also write to local file as backup
      try { fs.writeFileSync(BRAIN_MEMORY_FILE, JSON.stringify(brainTradeMemory), "utf8"); } catch(e) {}
      return;
    }
  } catch (e) {}
  // Fall back to local file
  try {
    if (fs.existsSync(BRAIN_MEMORY_FILE)) {
      var raw = fs.readFileSync(BRAIN_MEMORY_FILE, "utf8");
      var loaded = JSON.parse(raw);
      if (Array.isArray(loaded)) {
        brainTradeMemory = loaded.slice(-MAX_BRAIN_MEMORY);
        console.log("🧠 Brain loaded " + brainTradeMemory.length + " trades from disk");
      }
    }
  } catch (e) {
    console.error("🧠 Brain memory load failed (starting fresh):", e.message);
    brainTradeMemory = [];
  }
})();

function saveBrainMemory() {
  try {
    fs.writeFileSync(BRAIN_MEMORY_FILE, JSON.stringify(brainTradeMemory), "utf8");
  } catch (e) {
    console.error("🧠 Brain memory save failed:", e.message);
  }
  // Save to cloud every 5 trades — non-blocking
  if (brainTradeMemory.length % 5 === 0) {
    saveToCloud({ brainTrades: brainTradeMemory, trendMemory: trendMemory }).catch(function(){});
  }
}

// ─────────────────────────────────────────────
//  TREND MEMORY
//  Tracks name/symbol patterns from winning trades
//  Auto-decays older patterns so stale trends fade
//  Loaded from trend_memory.json on startup
// ─────────────────────────────────────────────
var trendMemory = {}; // { pattern: { score, wins, total, lastSeen } }

try {
  if (fs.existsSync(TREND_MEMORY_FILE)) {
    var rawTrend = fs.readFileSync(TREND_MEMORY_FILE, "utf8");
    trendMemory = JSON.parse(rawTrend) || {};
    console.log("📈 Trend memory loaded: " + Object.keys(trendMemory).length + " patterns");
  }
} catch (e) {
  trendMemory = {};
}

function saveTrendMemory() {
  try {
    fs.writeFileSync(TREND_MEMORY_FILE, JSON.stringify(trendMemory), "utf8");
  } catch (e) {}
}


// ─────────────────────────────────────────────
//  OBSERVE MEMORY
//  Logs every coin evaluated — bought or not.
//  Tracks what words are flooding the migration
//  feed right now, separate from trade outcomes.
//  Decays after 2hrs. Writes every 20 coins.
// ─────────────────────────────────────────────
var OBSERVE_FILE  = path.join(__dirname, "observe_memory.json");
var observeMemory = {};
var observeWrites = 0;

try {
  if (fs.existsSync(OBSERVE_FILE)) {
    observeMemory = JSON.parse(fs.readFileSync(OBSERVE_FILE, "utf8")) || {};
    console.log("👁 Observe memory loaded: " + Object.keys(observeMemory).length + " patterns");
  }
} catch (e) { observeMemory = {}; }

function saveObserveMemory() {
  try { fs.writeFileSync(OBSERVE_FILE, JSON.stringify(observeMemory), "utf8"); } catch (e) {}
}

// Called from handleMigration for every coin — fire and forget, zero latency impact
function observeCoin(symbol, name, filterScore, filterTotal) {
  try {
    var patterns = extractPatterns(symbol, name);
    if (patterns.length === 0) return;
    var now       = Date.now();
    var weight    = filterTotal > 0 ? filterScore / filterTotal : 0;
    var TWO_HOURS = 2 * 60 * 60 * 1000;
    patterns.forEach(function(p) {
      if (!observeMemory[p]) observeMemory[p] = { count: 0, totalWeight: 0, lastSeen: now };
      observeMemory[p].count++;
      observeMemory[p].totalWeight += weight;
      observeMemory[p].lastSeen = now;
    });
    // Decay patterns older than 2hrs
    Object.keys(observeMemory).forEach(function(p) {
      if (now - observeMemory[p].lastSeen > TWO_HOURS) delete observeMemory[p];
    });
    observeWrites++;
    if (observeWrites % 20 === 0) saveObserveMemory();
  } catch (e) {}
}

// Extract name patterns from a symbol/name string
function extractPatterns(symbol, name) {
  var patterns = [];
  var combined = ((symbol || "") + " " + (name || "")).toLowerCase();
  // Extract words 2+ chars, skip common filler
  var skip = new Set(["the", "a", "an", "of", "in", "on", "is", "to", "coin", "token"]);
  combined.split(/[^a-z0-9]+/).forEach(function(w) {
    if (w.length >= 2 && !skip.has(w)) patterns.push(w);
  });
  return patterns;
}

// Called when a trade closes — updates trend memory
function updateTrendMemory(symbol, name, win, pnlPct) {
  try {
    var patterns = extractPatterns(symbol, name);
    var now = Date.now();
    patterns.forEach(function(p) {
      if (!trendMemory[p]) trendMemory[p] = { score: 0, wins: 0, total: 0, lastSeen: now };
      trendMemory[p].total++;
      trendMemory[p].lastSeen = now;
      if (win) {
        trendMemory[p].wins++;
        // Score boost based on how much it won
        var boost = pnlPct >= 200 ? 3 : pnlPct >= 50 ? 2 : 1;
        trendMemory[p].score += boost;
      } else {
        trendMemory[p].score = Math.max(0, trendMemory[p].score - 1);
      }
    });
    // Decay old patterns — halve score if not seen in 6hrs
    var SIX_HOURS = 6 * 60 * 60 * 1000;
    Object.keys(trendMemory).forEach(function(p) {
      if (now - trendMemory[p].lastSeen > SIX_HOURS) {
        trendMemory[p].score = Math.floor(trendMemory[p].score * 0.5);
        if (trendMemory[p].score === 0) delete trendMemory[p];
      }
    });
    saveTrendMemory();
  } catch (e) {}
}

// Check if a coin matches active trends — returns nudge + signals
function getTrendNudge(symbol, name) {
  try {
    var patterns  = extractPatterns(symbol, name);
    var maxScore  = 0;
    var topSignal = null;
    patterns.forEach(function(p) {
      var t = trendMemory[p];
      if (t && t.score > 0 && t.total >= 2) {
        var wr = t.wins / t.total;
        if (t.score > maxScore) {
          maxScore  = t.score;
          topSignal = "📈 Trend match [" + p + "] score:" + t.score + " WR:" + (wr * 100).toFixed(0) + "%";
        }
      }
    });
    if (maxScore >= 4) return { nudge: +2, signal: topSignal, hot: true };
    if (maxScore >= 2) return { nudge: +1, signal: topSignal, hot: false };
    return { nudge: 0, signal: null, hot: false };
  } catch (e) {
    return { nudge: 0, signal: null, hot: false };
  }
}

/**
 * Call this from bot.js recordTrade() to feed brain
 * its own copy of every closed trade.
 * bot.js: brain.recordTrade(symbol, pnl, win, reason, tiers, name, latency);
 */
function recordTrade(symbol, pnl, win, reason, tiers, name, latency) {
  try {
    var pnlPct = 0;
    // estimate pnlPct from last trade in memory for trend scoring
    if (brainTradeMemory.length > 0) {
      var last = brainTradeMemory[brainTradeMemory.length - 1];
      if (last && last.solSpent > 0) pnlPct = (pnl / last.solSpent) * 100;
    }
    brainTradeMemory.push({
      symbol: symbol,
      name:   name   || symbol,
      pnl:    pnl    || 0,
      win:    !!win,
      reason: reason || "",
      tiers:  tiers  || [],
      time:   Date.now(),
      // ── Latency data (null if not available e.g. reentry/force buy) ──
      signalToExecMs: latency && latency.signalToExecMs != null ? latency.signalToExecMs : null,
      txConfirmMs:    latency && latency.txConfirmMs    != null ? latency.txConfirmMs    : null,
      totalLatencyMs: latency && latency.totalLatencyMs != null ? latency.totalLatencyMs : null,
    });
    if (brainTradeMemory.length > MAX_BRAIN_MEMORY) brainTradeMemory.shift();
    saveBrainMemory();
    // Feed trend memory with this result
    updateTrendMemory(symbol, name || symbol, !!win, pnlPct);
  } catch (e) {}
}

function logSignal(entry) {
  signalHistory.push(entry);
  if (signalHistory.length > MAX_HISTORY) signalHistory.shift();
}

// ================================================================
//  1. MOOD DETECTION
//  Reads pnlTrades (array of completed trade objects from bot.js).
//  Returns: { mood, nudge, summary, winRate, netSol }
// ================================================================
function getMood(pnlTrades) {
  // Always use brainTradeMemory — survives session report resets
  // pnlTrades param kept for backwards compat but ignored
  var trades = brainTradeMemory;

  if (!trades || trades.length === 0) {
    return { mood: "neutral", nudge: 0, summary: "😐 No trades yet", winRate: null, netSol: 0 };
  }

  var recent  = trades.slice(-MOOD.LOOKBACK);
  var wins    = recent.filter(function(t) { return t.win; }).length;
  var winRate = wins / recent.length;
  var netSol  = recent.reduce(function(acc, t) { return acc + (t.pnl || 0); }, 0);

  // ── 3 consecutive loss check — highest priority ───────────────────
  // If last 3 trades are all losses, go cooling immediately regardless
  // of overall win rate or net SOL threshold
  var last3     = trades.slice(-3);
  var last3Loss = last3.length === 3 && last3.every(function(t) { return !t.win; });

  var mood, nudge, summary;

  var last3Time  = last3Loss && last3[2] && last3[2].time ? last3[2].time : 0;
  var coolingMins = last3Time ? Math.round((Date.now() - last3Time) / 60000) : 0;
  if (last3Loss && (Date.now() - last3Time) < 3600000) {
  mood    = "cooling";
  nudge   = -2;
  summary = "🥶 Cooling — 3 consecutive losses. Blocking weak entries.";
} else if (last3Loss) {
  mood    = "neutral";
  nudge   = 0;
  summary = "😐 Cooling expired (" + coolingMins + "m) — resuming neutral.";

  } else if (netSol <= MOOD.COOLING_LOSS_SOL && recent.length >= 3) {
    mood    = "cooling";
    nudge   = -1;
    summary = "🥶 Cooling — net " + netSol.toFixed(4) + " SOL last " + recent.length + " trades. Tightening.";
  } else if (winRate >= MOOD.CONFIDENT_RATE && recent.length >= 5) {
    mood    = "confident";
    nudge   = +1;
    summary = "🔥 Confident — " + (winRate * 100).toFixed(0) + "% win rate last " + recent.length + " trades";
  } else if (winRate <= MOOD.CAUTIOUS_RATE && recent.length >= 5) {
    mood    = "cautious";
    nudge   = -1;
    summary = "⚠️ Cautious — " + (winRate * 100).toFixed(0) + "% win rate last " + recent.length + " trades";
  } else {
    mood    = "neutral";
    nudge   = 0;
    summary = "😐 Neutral — " + (winRate * 100).toFixed(0) + "% win rate last " + recent.length + " trades";
  }

  return { mood, nudge, summary, winRate, netSol };
}

// ================================================================
//  2. NARRATIVE SNIFFING
//  Scans dex.name and dex.symbol against keyword lists.
//  Returns: { nudge, signals[] }
//  Works from trade 0 — no history needed.
// ================================================================
function getNarrativeNudge(dex) {
  var name    = (dex.name   || "").toLowerCase();
  var symbol  = (dex.symbol || "").toLowerCase();
  var text    = name + " " + symbol;

  var nudge   = 0;
  var signals = [];

  // tokenise: split on spaces, dashes, underscores, digits
  var tokens  = text.split(/[\s\-_0-9]+/).filter(function(t) { return t.length > 1; });

  // Check each group
  Object.keys(NARRATIVE).forEach(function(group) {
    var cfg = NARRATIVE[group];
    cfg.words.forEach(function(kw) {
      // exact token match OR substring match on name (catches "elonmusk", "moonshot")
      var hit = tokens.indexOf(kw) > -1 || name.indexOf(kw) > -1 || symbol.indexOf(kw) > -1;
      if (hit) {
        nudge += cfg.score;
        var label = group === "strong" ? "🟢 narrative hit"
                  : group === "weak"   ? "🟡 weak narrative"
                  : "🔴 danger keyword";
        signals.push(label + " [" + kw + "]");
      }
    });
  });

  // Cap to avoid extreme swings from multiple keyword hits
  nudge = Math.max(-4, Math.min(+3, nudge));

  return { nudge, signals };
}

// ================================================================
//  3. PATTERN MEMORY
//  Learns which traits correlate with wins/losses from closed trades.
//  Returns: { nudge, signals[], ready }
//  ready = false until MIN_TRADES threshold is met.
//
//  Traits extracted per trade:
//    - ageGroup   : "instant" | "early" | "mid" | "late"
//    - mcapBucket : "micro" | "small" | "mid"
//    - tiersHit   : "t1+" | "none"
// ================================================================
function getPatternNudge(dex, pnlTrades) {
  // Always use brainTradeMemory — survives session resets
  var trades = brainTradeMemory;
  if (!trades || trades.length < PATTERN.MIN_TRADES) {
    return { nudge: 0, signals: ["📊 Pattern memory inactive (" + trades.length + "/" + PATTERN.MIN_TRADES + " trades)"], ready: false };
  }

  // Build trait index from closed trades
  var traitMap = {};

  trades.forEach(function(trade) {
    var traits = extractTraits(trade);
    traits.forEach(function(trait) {
      if (!traitMap[trait]) traitMap[trait] = { wins: 0, total: 0 };
      traitMap[trait].total++;
      if (trade.win) traitMap[trait].wins++;
    });
  });

  // Now score the current coin by its traits
  var currentTraits = extractDexTraits(dex);
  var nudge   = 0;
  var signals = [];

  currentTraits.forEach(function(trait) {
    var stat = traitMap[trait];
    if (!stat || stat.total < PATTERN.MIN_SAMPLE) return; // not enough data for this trait
    var winRate = stat.wins / stat.total;
    if (winRate >= PATTERN.STRONG_WIN_RATE) {
      nudge += 1;
      signals.push("📈 Pattern edge: " + trait + " (" + (winRate * 100).toFixed(0) + "% WR, n=" + stat.total + ")");
    } else if (winRate <= PATTERN.WEAK_WIN_RATE) {
      nudge -= 1;
      signals.push("📉 Pattern drag: " + trait + " (" + (winRate * 100).toFixed(0) + "% WR, n=" + stat.total + ")");
    }
  });

  nudge = Math.max(-2, Math.min(+2, nudge));
  return { nudge, signals, ready: true };
}

// ─────────────────────────────────────────────
//  Trait extraction — from closed trade object
//  (bot.js recordTrade stores symbol, pnl, tiers, time)
// ─────────────────────────────────────────────
function extractTraits(trade) {
  var traits = [];

  // Tier outcome
  if (trade.tiers && trade.tiers.length > 0) {
    traits.push("tiers:hit");
  } else {
    traits.push("tiers:none");
  }

  // Time of day bucket (UTC hours)
  if (trade.time) {
    var hour = new Date(trade.time).getUTCHours();
    var session = hour >= 13 && hour < 21 ? "session:us"
                : hour >= 7  && hour < 13 ? "session:eu"
                : "session:asia";
    traits.push(session);
  }

  // Exit reason group
  if (trade.reason) {
    var r = trade.reason.toLowerCase();
    if (r.indexOf("stop") > -1)     traits.push("exit:stoploss");
    if (r.indexOf("stall") > -1)    traits.push("exit:stall");
    if (r.indexOf("cluster") > -1)  traits.push("exit:cluster");
    if (r.indexOf("t1") > -1)       traits.push("exit:tier");
    if (r.indexOf("volume") > -1)   traits.push("exit:volccrash");
    if (r.indexOf("break") > -1)    traits.push("exit:breakeven");
  }

  return traits;
}

// ─────────────────────────────────────────────
//  Trait extraction — from live dex object
//  Maps current coin to the same trait keys so
//  pattern stats are comparable.
// ─────────────────────────────────────────────
function extractDexTraits(dex) {
  var traits = [];

  // MCap bucket
  if (dex.mcap < 30000)       traits.push("mcap:micro");
  else if (dex.mcap < 100000) traits.push("mcap:small");
  else                        traits.push("mcap:mid");

  // Age group
  var ageSec = (dex.ageMin || 0) * 60;
  if (ageSec <= 30)       traits.push("age:instant");
  else if (ageSec <= 120) traits.push("age:early");
  else if (ageSec <= 600) traits.push("age:mid");
  else                    traits.push("age:late");

  // Time of day (UTC)
  var hour    = new Date().getUTCHours();
  var session = hour >= 13 && hour < 21 ? "session:us"
              : hour >= 7  && hour < 13 ? "session:eu"
              : "session:asia";
  traits.push(session);

  // Vol/MCap bucket
  var ratio = dex.mcap > 0 ? dex.vol24h / dex.mcap : 0;
  if (ratio >= 0.5)       traits.push("ratio:high");
  else if (ratio >= 0.1)  traits.push("ratio:mid");
  else                    traits.push("ratio:low");

  return traits;
}

// ================================================================
//  MAIN EXPORT — evaluate()
//  Call this after runFilters() in handleMigration.
//
//  Returns:
//    nudge    : number  — composite score delta (informational)
//    mood     : string  — session mood label
//    signals  : string[] — human-readable explanations
//    summary  : string  — one-liner for Telegram
//    moodData : object  — raw mood stats for /brain report
// ================================================================
function evaluate(dex, pnlTrades) {
  try {
    var moodResult      = getMood(pnlTrades);
    var narrativeResult = getNarrativeNudge(dex);
    var patternResult   = getPatternNudge(dex, pnlTrades);
    var trendResult     = getTrendNudge(dex.symbol, dex.name);

    var totalNudge = moodResult.nudge + narrativeResult.nudge + patternResult.nudge + trendResult.nudge;
    totalNudge     = Math.max(-5, Math.min(+5, totalNudge)); // hard cap

    var signals = []
      .concat(narrativeResult.signals)
      .concat(patternResult.ready ? patternResult.signals : [])
      .concat(trendResult.signal ? [trendResult.signal] : [])
      .concat([moodResult.summary]);

    var moodEmoji = moodResult.mood === "confident" ? "🔥"
                  : moodResult.mood === "cautious"  ? "⚠️"
                  : moodResult.mood === "cooling"   ? "🥶"
                  : "😐";

    var nudgeStr  = totalNudge > 0 ? "+" + totalNudge : String(totalNudge);
    var summary   = moodEmoji + " Brain: " + nudgeStr + " | " + moodResult.summary;
    if (narrativeResult.signals.length > 0) {
      summary += "\n" + narrativeResult.signals.slice(0, 2).join(", ");
    }

    // Log to history ring buffer
    logSignal({
      ts:      Date.now(),
      symbol:  dex.symbol,
      name:    dex.name,
      nudge:   totalNudge,
      mood:    moodResult.mood,
      signals: signals,
    });

    return {
      nudge:    totalNudge,
      mood:     moodResult.mood,
      signals:  signals,
      summary:  summary,
      moodData: moodResult,
      hot:      trendResult.hot || false, // ⭐ true when a known trending pattern matches
    };
  } catch (err) {
    // Brain never crashes the bot — always returns a safe default
    console.error("🧠 Brain error (safe default):", err.message);
    return { nudge: 0, mood: "neutral", signals: [], summary: "🧠 Brain: offline", moodData: {} };
  }
}

// ================================================================
//  TELEGRAM REPORT — /brain command
//  Call this from pollCallbacks when cmd === "/brain"
//
//  Returns a formatted string ready to pass to tg()
// ================================================================
function getBrainReport(pnlTrades) {
  try {
    var mood     = getMood(brainTradeMemory);
    var total    = brainTradeMemory.length;
    var wins     = brainTradeMemory.filter(function(t) { return t.win; }).length;
    var losses   = total - wins;
    var netSol   = mood.netSol || 0;
    var sign     = netSol >= 0 ? "+" : "";

    // Recent signal history — last 8 evaluations
    var recent   = signalHistory.slice(-8).reverse();
    var histLines = recent.length === 0
      ? "No coins evaluated yet."
      : recent.map(function(h) {
          var age  = Math.round((Date.now() - h.ts) / 60000);
          var nudge = h.nudge >= 0 ? "+" + h.nudge : String(h.nudge);
          return (h.nudge > 0 ? "🟢" : h.nudge < 0 ? "🔴" : "⚫") +
            " *" + h.symbol + "* nudge:" + nudge +
            " [" + age + "m ago]";
        }).join("\n");

    // Pattern readiness
    var patternLine = total >= PATTERN.MIN_TRADES
      ? "✅ Pattern memory active (" + total + " trades)"
      : "⏳ Pattern memory: " + total + "/" + PATTERN.MIN_TRADES + " trades needed";

    return (
      "🧠 *Brain Report*\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "*Session mood:* " + mood.mood.toUpperCase() + "\n" +
      "*Win rate (last 10):* " + (mood.winRate !== null ? (mood.winRate * 100).toFixed(0) + "%" : "n/a") + "\n" +
      "*Net SOL (last 10):* " + sign + netSol.toFixed(4) + " SOL\n" +
      "*All-time trades:* " + total + " (" + wins + "W / " + losses + "L)\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      patternLine + "\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "*Recent signals:*\n" + histLines
    );
  } catch (err) {
    return "🧠 Brain report error: " + err.message;
  }
}

// ================================================================
//  PATTERNS REPORT — /patterns command
// ================================================================
function getPatternsReport() {
  try {
    var trades = brainTradeMemory;
    var total  = trades.length;
    if (total < 5) {
      return "📊 *Patterns Report*\n⏳ Need at least 5 trades — currently " + total + "\nKeep running the bot and check back soon.";
    }

    // Win rate overall
    var wins    = trades.filter(function(t) { return t.win; }).length;
    var winRate = (wins / total * 100).toFixed(0);

    // Best exit reasons
    var reasonMap = {};
    trades.forEach(function(t) {
      var r = t.reason || "unknown";
      if (!reasonMap[r]) reasonMap[r] = { wins: 0, total: 0, pnl: 0 };
      reasonMap[r].total++;
      if (t.win) reasonMap[r].wins++;
      reasonMap[r].pnl += t.pnl || 0;
    });
    var reasonLines = Object.keys(reasonMap)
      .sort(function(a, b) { return reasonMap[b].pnl - reasonMap[a].pnl; })
      .slice(0, 5)
      .map(function(r) {
        var d = reasonMap[r];
        var wr = (d.wins / d.total * 100).toFixed(0);
        var sign = d.pnl >= 0 ? "+" : "";
        return "• " + r.slice(0, 25) + " — " + wr + "% WR | " + sign + d.pnl.toFixed(4) + " SOL";
      }).join("\n");

    // Best performing symbols
    var symMap = {};
    trades.forEach(function(t) {
      var s = t.symbol || "?";
      if (!symMap[s]) symMap[s] = { wins: 0, total: 0, pnl: 0 };
      symMap[s].total++;
      if (t.win) symMap[s].wins++;
      symMap[s].pnl += t.pnl || 0;
    });
    var symLines = Object.keys(symMap)
      .sort(function(a, b) { return symMap[b].pnl - symMap[a].pnl; })
      .slice(0, 5)
      .map(function(s) {
        var d = symMap[s];
        var sign = d.pnl >= 0 ? "+" : "";
        return "• " + s + " (" + d.total + " trades) — " + sign + d.pnl.toFixed(4) + " SOL";
      }).join("\n");

    // Net SOL all time
    var netSol = trades.reduce(function(a, t) { return a + (t.pnl || 0); }, 0);
    var netSign = netSol >= 0 ? "+" : "";

    return (
      "📊 *Patterns Report*\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "Total trades: *" + total + "* | Win rate: *" + winRate + "%*\n" +
      "Net all-time: *" + netSign + netSol.toFixed(4) + " SOL*\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "*Top exit reasons:*\n" + reasonLines + "\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "*Top symbols:*\n" + symLines
    );
  } catch (err) {
    return "📊 Patterns error: " + err.message;
  }
}

// ================================================================
//  TRENDS REPORT — /trends command
//  Section 1: Feed trends  — words flooding the migration feed now
//  Section 2: Trade trends — words from your winning closed trades
// ================================================================
function getTrendsReport() {
  try {
    var now = Date.now();

    // ── Feed trends (observe memory) ─────────────────────────────
    var obsKeys = Object.keys(observeMemory)
      .filter(function(p) { return observeMemory[p].count >= 3; })
      .sort(function(a, b) { return observeMemory[b].count - observeMemory[a].count; })
      .slice(0, 8);

    var feedLines = obsKeys.length === 0
      ? "⏳ Scanning... check back in a few minutes"
      : obsKeys.map(function(p) {
          var o    = observeMemory[p];
          var avg  = (o.totalWeight / o.count * 7).toFixed(1);
          var age  = Math.round((now - o.lastSeen) / 60000);
          var icon = o.count >= 10 ? "🔥" : o.count >= 6 ? "📈" : "👀";
          return icon + " *" + p + "*  " + o.count + "x · avg " + avg + "/7 · " + age + "m ago";
        }).join("\n");

    // ── Trade trends (trend memory) ──────────────────────────────
    var tradeKeys = Object.keys(trendMemory)
      .filter(function(p) { return trendMemory[p].total >= 2; })
      .sort(function(a, b) { return trendMemory[b].score - trendMemory[a].score; })
      .slice(0, 8);

    var tradeLines = tradeKeys.length === 0
      ? "⏳ No data yet — builds up as trades close"
      : tradeKeys.map(function(p) {
          var t    = trendMemory[p];
          var wr   = (t.wins / t.total * 100).toFixed(0);
          var age  = Math.round((now - t.lastSeen) / 60000);
          var icon = t.score >= 4 ? "🔥" : t.score >= 2 ? "📈" : "⚫";
          return icon + " *" + p + "*  " + wr + "% WR · " + t.total + " trades · score " + t.score + " · " + age + "m ago";
        }).join("\n");

    return (
      "📈 *Trend Report*\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "👁 *Feed Trends* _(all coins seen)_\n" +
      feedLines + "\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "💰 *Trade Trends* _(your winning patterns)_\n" +
      tradeLines
    );
  } catch (err) {
    return "📈 Trends error: " + err.message;
  }
}

// ================================================================
//  EXPORTS
// ================================================================
module.exports = {
  evaluate,          // main entry point — call after runFilters()
  getMood,           // call standalone if you only want mood
  getBrainReport,    // Telegram /brain command handler
  getPatternsReport, // Telegram /patterns command handler
  getTrendsReport,   // Telegram /trends command handler
  recordTrade,       // call from bot.js recordTrade() — feeds persistent memory
  getTrendNudge,     // check active trends for a coin
  updateTrendMemory, // update trend memory after a trade
  observeCoin,       // call from handleMigration for every evaluated coin
  trendMemory,       // legacy reference
};
