/**
 * ================================================================
 *  PAPER LOG — virtual trade tracker
 *
 *  Exit rules mirror bot.js monitor() exactly:
 *    #1 Stop loss          — exit at -25% anytime
 *    #2 Sliding stop 3min  — no +20% peak by 3min and down -15%
 *    #3 Sliding stop 8min  — peak never hit +50% by 8min
 *    #4 Conviction exit    — peak never hit +50% by 10min
 *    #5 Trailing floor     — locks profit at each trigger level
 *    #6 Stall exit         — 3min no new high after a big pump
 *    #7 Auto-close         — 2hr hard timeout
 * ================================================================
 */

"use strict";

const axios = require("axios");

// ── Mirror exact values from bot.js CONFIG ─────────────────────────────────
const PAPER_CONFIG = {
  STOP_LOSS_PCT:        -25,
  SLIDING_STOP_3MIN:    -15,
  SLIDING_STOP_8MIN:     50,
  CONVICTION_MIN_GAIN:   50,
  CONVICTION_TIME_MS:    10 * 60 * 1000,
TRAIL_STALL_MS:        180000,   // 3 minutes
  LIQUIDITY_DRAIN_PCT: 0.40,
LIQUIDITY_DRAIN_CONFIRM_MS: 10000,
LIQUIDITY_ABS_FLOOR: 2000,


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

};

// ── In-memory paper position store ────────────────────────────────────────
const paperPositions = {};

// ── Completed paper trades this session ───────────────────────────────────
const paperTrades = [];

// ── Telegram helper ───────────────────────────────────────────────────────
function tgPaper(msg) {
  var token  = process.env.TELEGRAM_BOT_TOKEN;
  var chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  axios.post(
    "https://api.telegram.org/bot" + token + "/sendMessage",
    {
      chat_id:    chatId,
      text:       msg,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    },
    { timeout: 10000 }
  ).catch(function(e) { console.error("[PaperLog] TG error:", e.message); });
}

// ── Entry point called by bot.js ───────────────────────────────────────────
function logPaperTrade(mint, dex, result, source) {
  if (paperPositions[mint]) return;

  paperPositions[mint] = {
    symbol:    dex.symbol  || mint.slice(0, 6),
    name:      dex.name    || "Unknown",
    source:    source      || "unknown",
    entryMcap: dex.mcap    || 0,
    entryLiq:  dex.liq     || 0,
    lastLiq: dex.liq || 0,
    liqDrainSince: null,
    entryVol:  dex.vol24h  || 0,
    entryTime: Date.now(),
    score:     result.score || 0,
    total:     result.total || 7,
    // exit tracking
    peakGain:          0,
    lockedFloor:       null,
    lastPeak:          0,
    lastPeakTime:      null,
    sliding3Checked:   false,
    sliding8Checked:   false,
    convictionChecked: false,
  };

  var srcLabel = source === "migration-snipe" ? "🎯 Migration Snipe" : "👁 Watchlist";
  var bar      = "█".repeat(result.score) + "░".repeat(result.total - result.score);
  var ageStr   = fmtAge(dex.ageMin || 0);

  console.log("[PaperLog] 📝 Logged: " + dex.symbol + " @ $" + Math.round(dex.mcap).toLocaleString() + " [" + source + "]");

  tgPaper(
    "📝 *Paper Trade Logged*\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    srcLabel + "\n" +
    "*" + dex.name + "* (" + dex.symbol + ")\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "📊 Score:  *" + result.score + "/" + result.total + "* [" + bar + "]\n" +
    "💰 MCap:   $" + Math.round(dex.mcap).toLocaleString() + "\n" +
    "💧 Liq:    $" + Math.round(dex.liq).toLocaleString() + "\n" +
    "📈 Vol:    $" + Math.round(dex.vol24h).toLocaleString() + "\n" +
    "⏱ Age:    " + ageStr + "\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "Mint: `" + mint + "`"
  );
}

// ── Called every 5s by bot.js ──────────────────────────────────────────────
async function checkPaperPositions(fetchDex, fetchOnChainPoolSol) {
 var mints = Object.keys(paperPositions);
  if (mints.length === 0) return;

  for (var i = 0; i < mints.length; i++) {
    var mint = mints[i];
    var pos  = paperPositions[mint];
    if (!pos) continue;

    var heldMs   = Date.now() - pos.entryTime;
    var heldMin  = Math.round(heldMs / 60000);
    var autoClose = heldMs >= 2 * 60 * 60 * 1000;

    var dex = null;
    try {
      dex = await fetchDex(mint, 2);
    } catch (e) {
      console.error("[PaperLog] fetchDex error:", e.message);
    }

    if (!dex && !autoClose) continue;

        var exitMcap = dex ? dex.mcap : pos.entryMcap;

    if ((pos.buyPoolSol === undefined || pos.buyPoolSol === null) && heldMs < 420000) {
      try {
        var initPoolSol = await fetchOnChainPoolSol(mint);
        if (initPoolSol !== null) pos.buyPoolSol = initPoolSol;
      } catch (e) {}
    }
    pos.onChainTick = (pos.onChainTick || 0) + 1;
    if (heldMs < 420000 && pos.buyPoolSol && pos.onChainTick % 3 === 0) {
      try {
        var onChainSol = await fetchOnChainPoolSol(mint);
        if (onChainSol !== null) {
          var onChainGain = ((onChainSol - pos.buyPoolSol) / pos.buyPoolSol) * 100;
          exitMcap = pos.entryMcap * (1 + onChainGain / 100);
        }
      } catch (e) {}
    }

    var gain     = pos.entryMcap > 0
      ? ((exitMcap - pos.entryMcap) / pos.entryMcap) * 100
      : 0;
    var gainStr  = (gain >= 0 ? "+" : "") + gain.toFixed(1) + "%";


    // Update peak
    if (gain > pos.peakGain) {
      pos.peakGain = gain;
    }
    var peak = pos.peakGain;

 
    var exitReason = null;

    if (!exitReason && pos.lastLiq && dex && dex.liq !== undefined && dex.liq !== null && dex.liq < pos.lastLiq) {
  var suddenDropPct = (pos.lastLiq - dex.liq) / pos.lastLiq;
  if (suddenDropPct >= 0.40) {
    exitReason = "Sudden liquidity pull — dropped " + (suddenDropPct * 100).toFixed(0) + "% in one check, now " + gainStr;
  }
}
if (dex && dex.liq !== undefined && dex.liq !== null) pos.lastLiq = dex.liq;

    
// ── #0 LIQUIDITY DRAIN — floor + hard backstop, 10s confirm delay ──
    if (!exitReason && pos.entryLiq > 0 && dex && dex.liq !== undefined && dex.liq !== null) {
      var liqPct      = dex.liq / pos.entryLiq;
      var liqDraining = liqPct < PAPER_CONFIG.LIQUIDITY_DRAIN_PCT || dex.liq < PAPER_CONFIG.LIQUIDITY_ABS_FLOOR;
      if (liqDraining) {
        if (!pos.liqDrainSince) pos.liqDrainSince = Date.now();
        if (Date.now() - pos.liqDrainSince >= PAPER_CONFIG.LIQUIDITY_DRAIN_CONFIRM_MS) {
          exitReason = dex.liq < PAPER_CONFIG.LIQUIDITY_ABS_FLOOR
            ? "Liquidity drain — liq $" + Math.round(dex.liq).toLocaleString() + " below hard floor, now " + gainStr
            : "Liquidity drain — liq fell to " + (liqPct * 100).toFixed(0) + "% of entry, now " + gainStr;
        }
      } else {
        pos.liqDrainSince = null;
      }
    }

    // #1 STOP LOSS
    if (gain <= PAPER_CONFIG.STOP_LOSS_PCT) {
      exitReason = "Stop loss " + gainStr;
    }

    // #2 SLIDING STOP 3MIN
    if (!exitReason && heldMs >= 3 * 60 * 1000 && !pos.sliding3Checked) {
      pos.sliding3Checked = true;
      if (peak < 20 && gain <= PAPER_CONFIG.SLIDING_STOP_3MIN) {
        exitReason = "Sliding stop 3min — peak +" + peak.toFixed(1) + "%, now " + gainStr;
      }
    }

    // #3 SLIDING STOP 8MIN
    if (!exitReason && heldMs >= 8 * 60 * 1000 && !pos.sliding8Checked) {
      pos.sliding8Checked = true;
      if (peak < PAPER_CONFIG.SLIDING_STOP_8MIN) {
        exitReason = "Sliding stop 8min — peak only +" + peak.toFixed(1) + "%";
      }
    }

    // #4 CONVICTION EXIT
    if (!exitReason && heldMs >= PAPER_CONFIG.CONVICTION_TIME_MS && !pos.convictionChecked) {
      pos.convictionChecked = true;
      if (peak < PAPER_CONFIG.CONVICTION_MIN_GAIN) {
        exitReason = "Conviction exit — 10min, peak only +" + peak.toFixed(1) + "%";
      }
    }

    // #5 TRAILING FLOOR
    if (!exitReason) {
      var triggers = PAPER_CONFIG.PROFIT_LOCK_TRIGGERS;
      var hitTrigger = null;
      for (var t = triggers.length - 1; t >= 0; t--) {
        if (peak >= triggers[t].gain) { hitTrigger = triggers[t]; break; }
      }
      if (hitTrigger) {
        if (!pos.lockedFloor || hitTrigger.floor > pos.lockedFloor) {
          pos.lockedFloor = hitTrigger.floor;
        }
        if (gain <= pos.lockedFloor) {
          exitReason = "Floor hit — locked +" + pos.lockedFloor + "%, now " + gainStr;
        }
      }
    }

    // #6 STALL EXIT — 3min no new high after a big pump
    if (!exitReason && pos.lockedFloor !== null) {
      if (!pos.lastPeak || peak > pos.lastPeak) {
        pos.lastPeak     = peak;
        pos.lastPeakTime = Date.now();
      }
      if (pos.lastPeakTime && (Date.now() - pos.lastPeakTime) >= PAPER_CONFIG.TRAIL_STALL_MS) {
        exitReason = "Stall exit — peak +" + peak.toFixed(1) + "% no new high for 3min";
      }
    }

    // #7 AUTO-CLOSE 2HR
    if (!exitReason && autoClose) {
      exitReason = "Auto-close 2hr";
    }

    if (!exitReason) continue;

    // ── Close position ──────────────────────────────────────────────────
    var emoji    = gain >= 0 ? "🟢" : "🔴";
    var srcLabel = pos.source === "migration-snipe" ? "🎯 Migration" : "👁 Watchlist";

    var trade = {
      symbol:    pos.symbol,
      mint,
      source:    pos.source,
      entryMcap: pos.entryMcap,
      exitMcap,
      gain,
      peakGain:  peak,
      heldMin,
      score:     pos.score,
      total:     pos.total,
      exitReason,
      time:      Date.now(),
      win:       gain > 0,
    };
    paperTrades.push(trade);
    delete paperPositions[mint];

    console.log("[PaperLog] " + (gain >= 0 ? "📈" : "📉") + " Closed: " + pos.symbol + " " + gainStr + " | peak +" + peak.toFixed(1) + "% | " + exitReason);

    tgPaper(
      emoji + " *Paper Trade Closed — " + pos.symbol + "*\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      srcLabel + "  |  Score: *" + pos.score + "/" + pos.total + "*\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "📥 Entry MCap:  $" + Math.round(pos.entryMcap).toLocaleString() + "\n" +
      "📤 Exit MCap:   $" + Math.round(exitMcap).toLocaleString() + "\n" +
      "📈 Peak Gain:   +" + peak.toFixed(1) + "%\n" +
      "💰 Paper PnL:   *" + gainStr + "*\n" +
      "⏱ Held:        " + heldMin + "min\n" +
      "📋 Exit reason: " + exitReason + "\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "Mint: `" + mint + "`"
    );

    if (paperTrades.length > 0 && paperTrades.length % 5 === 0) {
      sendPaperSummary();
    }
  }
}

// ── Paper session summary ──────────────────────────────────────────────────
function sendPaperSummary() {
  var total   = paperTrades.length;
  if (total === 0) return;
  var wins    = paperTrades.filter(function(t) { return t.win; }).length;
  var losses  = total - wins;
  var winRate = ((wins / total) * 100).toFixed(0);
  var avgGain = (paperTrades.reduce(function(a, t) { return a + t.gain; }, 0) / total).toFixed(1);
  var best    = paperTrades.reduce(function(a, t) { return t.gain > a.gain ? t : a; }, paperTrades[0]);
  var worst   = paperTrades.reduce(function(a, t) { return t.gain < a.gain ? t : a; }, paperTrades[0]);

  var lines = paperTrades.slice(-8).map(function(t) {
    var s = t.gain >= 0 ? "+" : "";
    return (t.win ? "🟢" : "🔴") + " " + t.symbol + "  " + s + t.gain.toFixed(1) + "%  (" + t.heldMin + "min)";
  }).join("\n");

  tgPaper(
    "📋 *Paper Trading Summary*\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "📊 Signals:   *" + total + "* (" + wins + "W / " + losses + "L)\n" +
    "🎯 Win rate:  *" + winRate + "%*\n" +
    "📈 Avg gain:  *" + (avgGain >= 0 ? "+" : "") + avgGain + "%*\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "🏆 Best:   " + best.symbol + "  +" + best.gain.toFixed(1) + "%\n" +
    "💀 Worst:  " + worst.symbol + "  " + worst.gain.toFixed(1) + "%\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "*Recent:*\n" + lines
  );
}

// ── Age formatter ──────────────────────────────────────────────────────────
function fmtAge(ageMin) {
  var s = Math.round(ageMin * 60);
  if (s < 60)   return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return (ageMin / 60).toFixed(1) + "h";
}

module.exports = { logPaperTrade, checkPaperPositions, paperTrades };


