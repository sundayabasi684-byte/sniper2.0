// ─────────────────────────────────────────────
//  MONITOR — position tracking
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

      // Ghost detection
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
                  if (!ghostSigs[gs].err) {
                    ghostSellSig = ghostSigs[gs].signature;
                    break;
                  }
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

      if (mcap !== pos.lastMcap) {
        pos.lastMcap = mcap;
        pos.lastMcapTime = Date.now();
      }

      if (gain > (pos.peakGain || 0)) pos.peakGain = gain;

      // Sudden liquidity pull
      if (pos.lastLiq && dex.liq !== undefined && dex.liq !== null && dex.liq < pos.lastLiq) {
        var suddenDropPct = (pos.lastLiq - dex.liq) / pos.lastLiq;
        if (suddenDropPct >= 0.40) {
          await executeSell(mint, 100, "Sudden liquidity pull — dropped " + (suddenDropPct * 100).toFixed(0) + "% in one check, now " + gainStr);
          delete positions[mint];
          continue;
        }
      }

      if (dex.liq !== undefined && dex.liq !== null) pos.lastLiq = dex.liq;

      // Liquidity drain
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
      }

      // Periodic sell-route + wash-trading recheck
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

      // Track mcap snapshots every 60s
      if (!pos.mcapSnapshots) pos.mcapSnapshots = [];
      var lastSnap = pos.mcapSnapshots[pos.mcapSnapshots.length - 1];
      if (!lastSnap || Date.now() - lastSnap.ts >= 60000) {
        pos.mcapSnapshots.push({ mcap, ts: Date.now() });
      }

      // Conviction exit
      if (holdMs >= CONFIG.CONVICTION_TIME_MS && (pos.peakGain || 0) < CONFIG.CONVICTION_MIN_GAIN && !pos.convictionExited) {
        pos.convictionExited = true;
        console.log("   ⏱ [Conviction] " + pos.symbol + " 10min no +50% — exiting");
        await executeSell(mint, 100, "Conviction exit — 10min and no +50% gain");
        delete positions[mint];
        continue;
      }

      // Others...
    }
  } finally {
    monitorRunning = false;
  }
}
