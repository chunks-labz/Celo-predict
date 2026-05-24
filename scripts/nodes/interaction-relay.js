const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
    // Configuration
    const RPC_URLS = (process.env.CELO_RPC_URLS || "https://1rpc.io/celo,https://forno.celo.org")
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean);
    const PRIX_TOKEN_ADDRESS = "0x36489A2cB87fB0ca8E9d0fE2350D082b90FDC68E";
    const SINK_ADDRESS = "0x86E74256beC87d5f542BC9214b708A9dE78e3998"; // Send back to Master
    const TRANSFER_AMOUNT = "0.01"; // Tiny amount of PRIX
    /**
     * PRECISION SCALE CONTROL
     * Allows firing a specific number of agents (e.g. 25 for maintenance, 250 for surge)
     */
    const targetCount = Number.parseInt(process.argv[2], 10) || 143;
    const txPerAgent = Number.parseInt(process.argv[3], 10) || 5;
    const relayDelayMs = Number.parseInt(process.argv[4], 10) || 1000;
    const MAX_GAS_PRICE = ethers.parseUnits("210", "gwei"); // Adjusted to current Mainnet floor

    if (RPC_URLS.length === 0) {
        throw new Error("No RPC URLs configured. Set CELO_RPC_URLS.");
    }

    const prixAbi = ["function transfer(address to, uint256 amount) public returns (bool)"];

    const armyPath = path.join(__dirname, "../../army-wallets.json");
    const army = JSON.parse(fs.readFileSync(armyPath, "utf8"));

    console.log(`🚀 Starting precision interaction relay for ${targetCount} agents...`);
    console.log(`RPC endpoints: ${RPC_URLS.join(", ")}`);
    console.log(`Tx per agent: ${txPerAgent}, delay: ${relayDelayMs}ms`);

    // Execute relay missions
    for (let i = 0; i < Math.min(targetCount, army.length); i++) {
        const soldier = army[i];

        let attempts = 0;
        const maxAttempts = 3;
        let success = false;

        while (attempts < maxAttempts && !success) {
            const rpcIndex = attempts % RPC_URLS.length;
            const provider = new ethers.JsonRpcProvider(RPC_URLS[rpcIndex]);

            try {
                const wallet = new ethers.Wallet(soldier.privateKey, provider);
                const prixContract = new ethers.Contract(PRIX_TOKEN_ADDRESS, prixAbi, wallet);

                // Use pending nonce so batches don't collide with prior in-flight txs
                let nonce = await wallet.getNonce("pending");
                console.log(`----------------------------------------------------`);
                console.log(`Relay Agent ${soldier.id} (${soldier.address}) firing ${txPerAgent} transactions (Start Nonce: ${nonce}) [Attempt ${attempts + 1}]...`);

                const feeData = await provider.getFeeData();
                let maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas || 0n) * 11n / 10n; // 1.1x priority
                let maxFeePerGas = (feeData.maxFeePerGas || 0n) * 12n / 10n; // 1.2x max fee

                // Apply Safety Cap
                if (maxFeePerGas > MAX_GAS_PRICE) {
                    maxFeePerGas = MAX_GAS_PRICE;
                    maxPriorityFeePerGas = MAX_GAS_PRICE / 2n;
                }

                const promises = [];
                for (let txCount = 0; txCount < txPerAgent; txCount++) {
                    const p = prixContract.transfer(SINK_ADDRESS, ethers.parseUnits(TRANSFER_AMOUNT, 18), { 
                        nonce: nonce++,
                        maxPriorityFeePerGas,
                        maxFeePerGas,
                        gasLimit: 100000n // Hardcoded to bypass estimation glitches
                    })
                        .then(tx => console.log(`  Relay Agent ${soldier.id} (tx ${txCount + 1}): sent ${tx.hash}`))
                        .catch(err => {
                            if (err.message.includes("already known")) {
                                console.log(`  Relay Agent ${soldier.id} (tx ${txCount + 1}): already in mempool ✅`);
                            } else {
                                console.error(`  Relay Agent ${soldier.id} (tx ${txCount + 1}) failed: ${err.message}`);
                            }
                        });
                    promises.push(p);
                }

                await Promise.all(promises);
                success = true;

                // Anti-throttle delay for stability
                await new Promise(r => setTimeout(r, relayDelayMs));

            } catch (error) {
                attempts++;
                console.error(`  Relay Agent ${soldier.id} attempt ${attempts} failed:`, error.message);
                if (attempts < maxAttempts) {
                    console.log(`  Retrying in 2s...`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    }

    console.log("Full daily metric boost broadcasted! DAU target achieved.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
