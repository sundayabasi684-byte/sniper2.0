try {
    console.log("   ⚡ Dispatching via Jito Bundle Engine...");
    
    // Execute atomically via Jito with a 0.0001 SOL tip
    const jitoResult = await executeJitoBuy(mint, buyAmountSol, wallet, 0.0001);
    
    if (jitoResult.error) {
      throw new Error(`Jito Engine Error: ${jitoResult.error.message || JSON.stringify(jitoResult.error)}`);
    }

    var sig = jitoResult.result; // Jito bundle UUID / signature hash
    var link = "https://solscan.io/tx/" + sig;
    console.log("   ✅ JITO BUNDLE LANDED: " + link);

    positions[mint] = {
      symbol: dex.symbol, name: dex.name, mint,
      buyPrice: dex.mcap, isCluster: result.isCluster,
      tier1: false, tier2: false, tier3: false,
      prevVol: dex.vol5m || 0,
      entryVol: dex.vol5m || 0,
      entryHolders: null,
      lastMcap: dex.mcap, lastMcapTime: Date.now(), entryTime: Date.now(),
      peakGain: 0,
      mcapSnapshots: [{ mcap: dex.mcap, ts: Date.now() }],
      solSpent: buySol,
      entryLiq: dex.liq || 0, lastLiq: dex.liq || 0, liqDrainSince: null,
    };

    // Keep your baseline pool SOL & holder tracking timers intact...
    setTimeout(async function() {
      try {
        var initPoolSol = await fetchOnChainPoolSol(mint);
        if (initPoolSol !== null && positions[mint]) {
          positions[mint].buyPoolSol = initPoolSol;
        }
      } catch (e) {}
    }, 1000);

    tg(
      "🚀 *Jito Bundle Landed — " + dex.name + " (" + dex.symbol + ")*\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "💰 Entry MCap:  $" + Math.round(dex.mcap).toLocaleString() + "\n" +
      "💸 Spent:       " + buySol + " SOL (Protected)\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
      "Mint: `" + mint + "`\n" +
      "[View Bundle](" + link + ")"
    );

  } catch (err) {
    console.error("   ❌ Jito Buy FAILED:", err.message);
    tg("❌ *Jito Buy FAILED*\n*" + dex.name + "*\nError: `" + err.message.slice(0, 200) + "`");
    var errMsg = err.message.toLowerCase();
    if (errMsg.includes("insufficient") || errMsg.includes("not enough")) {
      failedMints.add(mint);
    }
    delete positions[mint];
  } finally {
    buying.delete(mint);
  }