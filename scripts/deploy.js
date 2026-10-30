/**
 * Deploys MiniDEX: two MockTokens, the MiniSwapPair, seeds initial liquidity,
 * then deploys the TwapOracle. Writes addresses to deployments/<network>.json and,
 * on Sepolia with ETHERSCAN_API_KEY set, verifies every contract on Etherscan.
 *
 *   npx hardhat run scripts/deploy.js --network sepolia
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers, network } = hre;

const INITIAL_SUPPLY = ethers.parseEther("1000000"); // per token, to the deployer
const SEED_USD = ethers.parseEther("20000"); // initial pool: 20,000 mUSD
const SEED_ETH = ethers.parseEther("10"); //                 10 mETH  -> 1 mETH = 2,000 mUSD
const TWAP_PERIOD = 600; // 10-minute averaging window (short, for demos)

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set PRIVATE_KEY in .env");
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}  (${ethers.formatEther(balance)} ETH)`);
  if (network.name === "sepolia" && balance < ethers.parseEther("0.01")) {
    throw new Error(
      "Deployer has less than 0.01 Sepolia ETH. Get test ETH from a faucet for the address above, then retry."
    );
  }

  const Token = await ethers.getContractFactory("MockToken");
  const usd = await Token.deploy("Mock USD", "mUSD", INITIAL_SUPPLY);
  await usd.waitForDeployment();
  const eth = await Token.deploy("Mock ETH", "mETH", INITIAL_SUPPLY);
  await eth.waitForDeployment();
  console.log(`mUSD:     ${await usd.getAddress()}`);
  console.log(`mETH:     ${await eth.getAddress()}`);

  const Pair = await ethers.getContractFactory("MiniSwapPair");
  const pair = await Pair.deploy(await usd.getAddress(), await eth.getAddress(), deployer.address);
  await pair.waitForDeployment();
  const pairAddr = await pair.getAddress();
  console.log(`Pair:     ${pairAddr}`);

  await (await usd.approve(pairAddr, SEED_USD)).wait();
  await (await eth.approve(pairAddr, SEED_ETH)).wait();
  const block = await ethers.provider.getBlock("latest");
  await (await pair.addLiquidity(SEED_USD, SEED_ETH, 0, 0, deployer.address, block.timestamp + 1200)).wait();
  console.log(`Seeded liquidity: 20,000 mUSD / 10 mETH`);

  const Oracle = await ethers.getContractFactory("TwapOracle");
  const oracle = await Oracle.deploy(pairAddr, TWAP_PERIOD);
  await oracle.waitForDeployment();
  console.log(`Oracle:   ${await oracle.getAddress()}`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      mUSD: await usd.getAddress(),
      mETH: await eth.getAddress(),
      MiniSwapPair: pairAddr,
      TwapOracle: await oracle.getAddress(),
    },
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(`Saved deployments/${network.name}.json`);

  if (network.name === "sepolia") {
    if (!process.env.ETHERSCAN_API_KEY) {
      console.log("ETHERSCAN_API_KEY not set: skipping verification.");
      return;
    }
    console.log("Waiting for confirmations before verifying...");
    await oracle.deploymentTransaction().wait(5);
    const targets = [
      { address: out.contracts.mUSD, args: ["Mock USD", "mUSD", INITIAL_SUPPLY] },
      { address: out.contracts.mETH, args: ["Mock ETH", "mETH", INITIAL_SUPPLY] },
      { address: pairAddr, args: [out.contracts.mUSD, out.contracts.mETH, deployer.address] },
      { address: out.contracts.TwapOracle, args: [pairAddr, TWAP_PERIOD] },
    ];
    for (const t of targets) {
      try {
        await hre.run("verify:verify", { address: t.address, constructorArguments: t.args });
      } catch (e) {
        console.log(`Verify ${t.address}: ${e.message}`);
      }
      console.log(`https://sepolia.etherscan.io/address/${t.address}#code`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
