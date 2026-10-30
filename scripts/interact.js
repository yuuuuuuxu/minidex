/**
 * Demo script for the presentation: reads the deployed pool, does a small swap,
 * and prints spot price, k, and the TWAP (if the oracle has been updated).
 *
 *   npx hardhat run scripts/interact.js --network sepolia
 */
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const fmt = (x) => Number(ethers.formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 6 });

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Run scripts/deploy.js on ${network.name} first`);
  const { contracts } = JSON.parse(fs.readFileSync(file, "utf8"));
  const [me] = await ethers.getSigners();

  const usd = await ethers.getContractAt("MockToken", contracts.mUSD);
  const pair = await ethers.getContractAt("MiniSwapPair", contracts.MiniSwapPair);
  const oracle = await ethers.getContractAt("TwapOracle", contracts.TwapOracle);

  const show = async (label) => {
    const [r0, r1] = await pair.getReserves();
    console.log(`\n[${label}]`);
    console.log(`  reserves: ${fmt(r0)} mUSD / ${fmt(r1)} mETH`);
    console.log(`  spot:     1 mETH = ${fmt((r0 * 10n ** 18n) / r1)} mUSD`);
    console.log(`  sqrt(k):  ${fmt(sqrt(r0 * r1))}`);
  };

  await show("before");

  const amountIn = ethers.parseEther("100");
  if ((await usd.balanceOf(me.address)) < amountIn) await (await usd.faucet()).wait();
  await (await usd.approve(contracts.MiniSwapPair, amountIn)).wait();
  const [r0, r1] = await pair.getReserves();
  const expected = await pair.getAmountOut(amountIn, r0, r1);
  const minOut = (expected * 995n) / 1000n; // accept at most 0.5% slippage
  const dl = (await ethers.provider.getBlock("latest")).timestamp + 600;
  const tx = await pair.swapExactIn(contracts.mUSD, amountIn, minOut, me.address, dl);
  const rc = await tx.wait();
  console.log(`\nSwapped 100 mUSD -> ${fmt(expected)} mETH   tx: ${rc.hash}`);

  await show("after");

  try {
    await (await oracle.update()).wait();
    console.log("\nOracle updated.");
  } catch {
    console.log("\nOracle period not elapsed yet; showing the last stored average.");
  }
  try {
    console.log(`TWAP: 1 mETH = ${fmt(await oracle.consult(contracts.mETH, ethers.parseEther("1")))} mUSD`);
  } catch {
    console.log("TWAP not initialised yet (call update() after the period).");
  }
}

function sqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
