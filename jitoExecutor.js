async function executeJitoBuyAndLog(mint, buyAmountSol, wallet) {
    try {
        console.log("⚡ Dispatching via Jito Bundle Engine...");

        // Execute atomically via Jito with a 0.0001 SOL tip
        const jitoResult = await executeJitoBuy(mint, buyAmountSol, wallet, 0.0001);

        if (jitoResult.error) {
            throw new Error(`Jito Engine Error: ${jitoResult.error.message || JSON.stringify(jitoResult.error)}`);
        }

        var sig = jitoResult.result; // Jito bundle UUID / signature hash
        var link = "https://solscan.io/tx/" + sig;
        console.log("  ✅ JITO BUNDLE LANDED: " + link);

        return { success: true, sig, link };
    } catch (err) {
        console.error("Jito Execution Failed:", err.message);
        return { success: false, error: err.message };
    }
}

module.exports = { executeJitoBuyAndLog };
