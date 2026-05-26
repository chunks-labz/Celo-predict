const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
    // Configuration
    const RPC_URL = "https://forno.celo.org";
    const PRIVATE_KEY = process.env.PRIVATE_KEY;
    const FUND_AMOUNT = "0.2"; // Adjusted to fit 50 CELO budget for 250 wallets
    const PRIX_TOKEN_ADDRESS = "0x36489A2cB87fB0ca8E9d0fE2350D082b90FDC68E";
    const PRIX_AMOUNT = "100.0"; // PRIX per wallet
    const MAX_GAS_PRICE = ethers.parseUnits("250", "gwei");
    
    // Surgical Limit (e.g., only fund the first 10)
    const FUND_LIMIT = parseInt(process.argv[2]) || 10;

    if (!PRIVATE_KEY) {
        throw new Error("PRIVATE_KEY environment variable is not set.");
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { 
        staticNetwork: new ethers.Network("celo", 42220),
        batchMaxCount: 1 
    });
    const masterWallet = new ethers.Wallet(PRIVATE_KEY, provider);

    // PRIX Token Contract
    const prixAbi = ["function transfer(address to, uint256 amount) public returns (bool)", "function balanceOf(address account) public view returns (uint256)"];
    const prixContract = new ethers.Contract(PRIX_TOKEN_ADDRESS, prixAbi, masterWallet);

    // Helper for robust retries
    async function retry(fn, maxRetries = 5, delay = 3000) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn();
            } catch (error) {
                console.warn(`    [Retry ${i + 1}/${maxRetries}] failed: ${error.message}. Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw new Error(`Failed after ${maxRetries} attempts`);
    }

    // Fixed High-Priority Fees for Mainnet Push
    const maxFeePerGas = MAX_GAS_PRICE;
    const maxPriorityFeePerGas = ethers.parseUnits("2", "gwei");

    const armyPath = path.join(__dirname, "../../army-wallets.json");
    const army = JSON.parse(fs.readFileSync(armyPath, "utf8"));

    console.log(`Starting surgical funding for top ${FUND_LIMIT} agents...`);

    let nonce = await retry(() => masterWallet.getNonce());
    let fundedCount = 0;

    for (const soldier of army) {
        if (fundedCount >= FUND_LIMIT) break;

        // Simple skip if already funded (check CELO balance)
        const soldierBalance = await retry(() => provider.getBalance(soldier.address));
        if (soldierBalance >= ethers.parseEther(FUND_AMOUNT)) {
            console.log(`Relay Agent ${soldier.id} already has high-capacity fuel. Skipping.`);
            fundedCount++;
            continue;
        }

        console.log(`----------------------------------------------------`);
        console.log(`Funding soldier ${soldier.id}: ${soldier.address} (Nonce: ${nonce})...`);

        try {
            // 1. Send CELO
            const celoTx = await retry(() => masterWallet.sendTransaction({
                to: soldier.address,
                value: ethers.parseEther(FUND_AMOUNT),
                nonce: nonce++,
                maxFeePerGas,
                maxPriorityFeePerGas,
                gasLimit: 21000n
            }));
            console.log(`  CELO Transaction sent: ${celoTx.hash}`);

            // 2. Send PRIX (only if needed)
            const prixBalance = await retry(() => prixContract.balanceOf(soldier.address));
            let prixTx = null;
            if (prixBalance < ethers.parseUnits("1.0", 18)) {
                prixTx = await retry(() => prixContract.transfer(soldier.address, ethers.parseUnits(PRIX_AMOUNT, 18), {
                    nonce: nonce++,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                    gasLimit: 100000n
                }));
                console.log(`  PRIX Transaction sent: ${prixTx.hash}`);
            } else {
                console.log(`  PRIX balance sufficient (${ethers.formatUnits(prixBalance, 18)} PRIX). Skipping PRIX send.`);
            }
            
            fundedCount++;

            // Wait occasionally to avoid RPC rate limits
            if (fundedCount % 20 === 0) {
                console.log("  Waiting for batch confirmation...");
                if (prixTx) {
                    await retry(() => prixTx.wait());
                } else {
                    await retry(() => celoTx.wait());
                }
            }

            // Throttle delay to avoid Cloudflare rate limiting
            await new Promise(r => setTimeout(r, 400));
        } catch (error) {
            console.error(`  Failed to fund ${soldier.address}:`, error.message);
            // Refresh nonce if there's an error
            nonce = await retry(() => masterWallet.getNonce());
        }
    }

    console.log("Optimized funding distribution complete!");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
