const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { E } = require("./helpers");

describe("MockToken", function () {
  async function fixture() {
    const [owner, user] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockToken");
    const token = await Token.deploy("Mock USD", "mUSD", E(1_000_000));
    return { token, owner, user };
  }

  it("mints the initial supply to the deployer", async function () {
    const { token, owner } = await loadFixture(fixture);
    expect(await token.balanceOf(owner.address)).to.equal(E(1_000_000));
    expect(await token.symbol()).to.equal("mUSD");
  });

  it("faucet gives 1000 tokens once per day", async function () {
    const { token, user } = await loadFixture(fixture);
    await expect(token.connect(user).faucet()).to.emit(token, "FaucetUsed").withArgs(user.address, E(1000));
    expect(await token.balanceOf(user.address)).to.equal(E(1000));

    await expect(token.connect(user).faucet()).to.be.revertedWithCustomError(token, "FaucetCooldown");

    await time.increase(24 * 3600);
    await token.connect(user).faucet();
    expect(await token.balanceOf(user.address)).to.equal(E(2000));
  });
});
