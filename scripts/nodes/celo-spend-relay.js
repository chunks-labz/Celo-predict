const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
    const RPC_URLS = (process.env.CELO_RPC_URLS || "https://forno.celo.org")
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean);

    const SINK_ADDRESS = process.env.SINK_ADDRESS || "0x86E74256beC87d5f542BC9214b708A9dE78e3998";
    const targetCount = Number.parseInt(process.argv[2], 10) || 250;
    const celoPerWallet = process.argv[3] || "10";
    const relayDelayMs = Number.parseInt(process.argv[4], 10) || 1200;
    const reserveForGas = process.argv[5] || "0.003";
    const maxGasPriceGwei = process.argv[6] || "210";
    const totalBudgetCelo = process.argv[7] ? process.argv[7] : null;
    const dryRun = process.env.DRY_RUN === "1";

    if (RPC_URLS.length === 0) {
        throw new Error("No RPC URLs configured. Set CELO_RPC_URLS.");
    }

    const transferValue = ethers.parseEther(celoPerWallet);
    let budgetRemaining = totalBudgetCelo ? ethers.parseEther(totalBudgetCelo) : null;
    const gasReserve = ethers.parseEther(reserveForGas);
    const maxFeeCap = ethers.parseUnits(maxGasPriceGwei, "gwei");

    const armyPath = path.join(__dirname, "../../army-wallets.json");
    const army = JSON.parse(fs.readFileSync(armyPath, "utf8"));
    const runCount = Math.min(targetCount, army.length);

    console.log(`Starting CELO spend relay for ${runCount} sub-wallets`);
    console.log(`Recipient: ${SINK_ADDRESS}`);
    console.log(`Amount per wallet: ${celoPerWallet} CELO`);
    if (budgetRemaining !== null) {
        console.log(`Total budget mode: ${totalBudgetCelo} CELO`);
    }
    console.log(`Dry run: ${dryRun ? "ON" : "OFF"}`);

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < runCount; i++) {
        const soldier = army[i];
        const provider = new ethers.JsonRpcProvider(RPC_URLS[i % RPC_URLS.length]);

        try {
            const wallet = new ethers.Wallet(soldier.privateKey, provider);
            const balance = await provider.getBalance(wallet.address);
            const feeData = await provider.getFeeData();
            let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei");
            let maxFeePerGas = feeData.maxFeePerGas || maxPriorityFeePerGas * 2n;

            if (maxFeePerGas > maxFeeCap) {
                maxFeePerGas = maxFeeCap;
                maxPriorityFeePerGas = maxFeeCap / 2n;
            }

            const estimatedGasCost = 21000n * maxFeePerGas;
            const maxSpendable = balance - gasReserve - estimatedGasCost;
            if (maxSpendable <= 0n) {
                skipped++;
                console.log(`SKIP ${soldier.id} ${wallet.address} balance=${ethers.formatEther(balance)} CELO (no spendable after gas reserve)`);
                continue;
            }

            let sendValue = transferValue;
            if (budgetRemaining !== null) {
                if (budgetRemaining <= 0n) {
                    break;
                }
                sendValue = budgetRemaining < transferValue ? budgetRemaining : transferValue;
            }

            if (sendValue > maxSpendable) {
                skipped++;
                console.log(`SKIP ${soldier.id} ${wallet.address} balance=${ethers.formatEther(balance)} CELO (max spendable ${ethers.formatEther(maxSpendable)})`);
                continue;
            }

            if (dryRun) {
                sent++;
                if (budgetRemaining !== null) {
                    budgetRemaining -= sendValue;
                }
                console.log(`DRY  ${soldier.id} ${wallet.address} -> ${SINK_ADDRESS} value=${ethers.formatEther(sendValue)} CELO`);
                continue;
            }

            const nonce = await wallet.getNonce("pending");
            const tx = await wallet.sendTransaction({
                to: SINK_ADDRESS,
                value: sendValue,
                nonce,
                gasLimit: 21000n,
                maxPriorityFeePerGas,
                maxFeePerGas
            });

            sent++;
            if (budgetRemaining !== null) {
                budgetRemaining -= sendValue;
            }
            console.log(`SENT ${soldier.id} ${wallet.address} value=${ethers.formatEther(sendValue)} tx=${tx.hash}`);
            await new Promise((resolve) => setTimeout(resolve, relayDelayMs));
        } catch (error) {
            failed++;
            console.error(`FAIL ${soldier.id} ${soldier.address}: ${error.message}`);
        }
    }

    console.log("----------------------------------------------------");
    console.log(`Completed. Sent=${sent}, Skipped=${skipped}, Failed=${failed}`);
    if (budgetRemaining !== null) {
        console.log(`Budget remaining CELO=${ethers.formatEther(budgetRemaining)}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
