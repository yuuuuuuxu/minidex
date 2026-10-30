const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { E, MAX, deadline } = require("./helpers");

describe("TwapOracle", function () {
  const PERIOD = 3600; // 1 hour window

  async function fixture() {
    const [owner, alice, attacker] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockToken");
    const tokenA = await Token.deploy("Mock USD", "mUSD", E(1_000_000));
    const tokenB = await Token.deploy("Mock ETH", "mETH", E(1_000_000));
    const Pair = await ethers.getContractFactory("MiniSwapPair");
    const pair = await Pair.deploy(await tokenA.getAddress(), await tokenB.getAddress(), owner.address);
    const pairAddr = await pair.getAddress();
    for (const u of [alice, attacker]) {
      await tokenA.transfer(u.address, E(100_000));
      await tokenB.transfer(u.address, E(100_000));
      await tokenA.connect(u).approve(pairAddr, MAX);
      await tokenB.connect(u).approve(pairAddr, MAX);
    }
    // Initial price: 1 mETH = 1 mUSD (1:1 pool)
    await pair.connect(alice).addLiquidity(E(1000), E(1000), 0, 0, alice.address, await deadline());

    const Oracle = await ethers.getContractFactory("TwapOracle");
    const oracle = await Oracle.deploy(pairAddr, PERIOD);
    return { pair, oracle, tokenA, tokenB, alice, attacker, Oracle, Pair, owner };
  }

  it("cannot be deployed on an empty pool", async function () {
    const { Pair, Oracle, tokenA, tokenB, owner } = await loadFixture(fixture);
    const empty = await Pair.deploy(await tokenA.getAddress(), await tokenB.getAddress(), owner.address);
    await expect(Oracle.deploy(await empty.getAddress(), PERIOD)).to.be.revertedWithCustomError(
      Oracle,
      "NoReserves"
    );
  });

  it("is not usable before the first update", async function () {
    const { oracle, tokenA } = await loadFixture(fixture);
    await expect(oracle.consult(await tokenA.getAddress(), E(1))).to.be.revertedWithCustomError(
      oracle,
      "NotInitialized"
    );
  });

  it("refuses to update before the period has elapsed", async function () {
    const { oracle } = await loadFixture(fixture);
    await expect(oracle.update()).to.be.revertedWithCustomError(oracle, "PeriodNotElapsed");
  });

  it("reports the average price after one period", async function () {
    const { oracle, tokenA, tokenB } = await loadFixture(fixture);
    await time.increase(PERIOD);
    await expect(oracle.update()).to.emit(oracle, "Updated");
    expect(await oracle.consult(await tokenA.getAddress(), E(1))).to.equal(E(1));
    expect(await oracle.consult(await tokenB.getAddress(), E(1))).to.equal(E(1));
  });

  it("rejects an unknown token", async function () {
    const { oracle, alice } = await loadFixture(fixture);
    await time.increase(PERIOD);
    await oracle.update();
    await expect(oracle.consult(alice.address, E(1))).to.be.revertedWithCustomError(oracle, "InvalidToken");
  });

  it("resists a one-block price manipulation (spot moves ~75%, TWAP moves < 0.1%)", async function () {
    const { pair, oracle, tokenA, attacker } = await loadFixture(fixture);
    await time.increase(PERIOD);

    // Attacker dumps 1000 mUSD into the 1000/1000 pool right before the oracle update
    await pair
      .connect(attacker)
      .swapExactIn(await tokenA.getAddress(), E(1000), 0, attacker.address, await deadline());
    const [r0, r1] = await pair.getReserves();
    const spot = (r1 * 10n ** 18n) / r0; // mETH per mUSD, scaled 1e18
    expect(spot).to.be.lt(E("0.26")); // spot price crashed from 1.00 to ~0.25

    await oracle.update();
    const twap = await oracle.consult(await tokenA.getAddress(), E(1));
    expect(twap).to.be.gt(E("0.999")); // the hour-long average barely moved
    expect(twap).to.be.lte(E(1));
  });

  it("follows a price change that persists for a whole period", async function () {
    const { pair, oracle, tokenA, attacker } = await loadFixture(fixture);
    await pair
      .connect(attacker)
      .swapExactIn(await tokenA.getAddress(), E(1000), 0, attacker.address, await deadline());
    await time.increase(PERIOD);
    await oracle.update(); // window is almost entirely at the new price
    await time.increase(PERIOD);
    await oracle.update(); // window is entirely at the new price
    const [r0, r1] = await pair.getReserves();
    const spot = (r1 * 10n ** 18n) / r0;
    const twap = await oracle.consult(await tokenA.getAddress(), E(1));
    const diff = twap > spot ? twap - spot : spot - twap;
    expect(diff).to.be.lt(E("0.000001"));
  });
});
