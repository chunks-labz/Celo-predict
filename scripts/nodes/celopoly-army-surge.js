const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
    const RPC_URL = "https://forno.celo.org";
    const envPath = path.join(__dirname, "../../../Celopoly/.env");
    const envContent = fs.readFileSync(envPath, 'utf8');
    const decoyMatch = envContent.match(/^DECOY_ADDRESS=(0x[a-fA-F0-9]+)/m);
    const DECOY_ADDRESS = decoyMatch ? decoyMatch[1] : null;
    const keyMatch = envContent.match(/^PRIVATE_KEY=(0x[a-fA-F0-9]+)/m);
    const MASTER_KEY = keyMatch ? keyMatch[1].trim() : null;
    
    const targetCount = 200; // We want 200 DAU!
    const txPerAgent = 1;
    
    if (!DECOY_ADDRESS || !MASTER_KEY) {
        throw new Error("Missing DECOY_ADDRESS or PRIVATE_KEY_CELO_1 in CeloPoly .env");
    }

    const decoyAbi = ["function ping() public"];

    const armyPath = path.join(__dirname, "../../army-wallets.json");
    if (!fs.existsSync(armyPath)) {
        throw new Error("army-wallets.json not found");
    }
    const army = JSON.parse(fs.readFileSync(armyPath, "utf8"));

    console.log(`🚀 Starting CeloPoly multi-wallet surge for ${targetCount} agents...`);

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
        staticNetwork: new ethers.Network("celo", 42220),
        batchMaxCount: 1
    });

    const masterWallet = new ethers.Wallet(MASTER_KEY, provider);

    const feeData = await provider.getFeeData();
    const MAX_GAS_PRICE = ethers.parseUnits("210", "gwei");
    let maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas || 0n) * 11n / 10n;
    let maxFeePerGas = (feeData.maxFeePerGas || 0n) * 12n / 10n;

    if (maxFeePerGas > MAX_GAS_PRICE) {
        maxFeePerGas = MAX_GAS_PRICE;
        maxPriorityFeePerGas = MAX_GAS_PRICE / 2n;
    }

    for (let i = 0; i < Math.min(targetCount, army.length); i++) {
        const soldier = army[i];
        try {
            const wallet = new ethers.Wallet(soldier.privateKey, provider);
            const decoyContract = new ethers.Contract(DECOY_ADDRESS, decoyAbi, wallet);

            // Auto-Refuel Logic
            const balance = await provider.getBalance(soldier.address);
            if (balance < ethers.parseEther("0.02")) {
                console.log(`[Auto-Refuel] Agent ${soldier.id} has low balance. Refueling 0.03 CELO...`);
                let masterNonce = await masterWallet.getNonce("pending");
                const refuelTx = await masterWallet.sendTransaction({
                    to: soldier.address,
                    value: ethers.parseEther("0.03"),
                    nonce: masterNonce
                });
                await refuelTx.wait();
                console.log(`[Auto-Refuel] Agent ${soldier.id} successfully refueled!`);
            }

            let nonce = await wallet.getNonce("pending");
            console.log(`Agent ${soldier.id} (${soldier.address}) pinging CeloPoly...`);

            const promises = [];
            for (let j = 0; j < txPerAgent; j++) {
                const p = decoyContract.ping({ 
                    nonce: nonce++,
                    maxPriorityFeePerGas,
                    maxFeePerGas,
                    gasLimit: 80000n
                })
                .then(tx => console.log(`  Agent ${soldier.id}: sent ${tx.hash}`))
                .catch(err => {
                    if (err.message.includes("already known")) {
                        console.log(`  Agent ${soldier.id}: already in mempool`);
                    } else {
                        console.error(`  Agent ${soldier.id} failed: ${err.message}`);
                    }
                });
                promises.push(p);
            }

            await Promise.all(promises);
            await new Promise(r => setTimeout(r, 200)); // slight delay
        } catch (error) {
            console.error(`Agent ${soldier.id} setup failed:`, error.message);
        }
    }

    console.log("Full CeloPoly daily metric boost broadcasted! DAU target achieved.");
}

main().catch(console.error);
