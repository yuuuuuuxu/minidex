const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { E, MAX, Q112, sqrt, amountOut, deadline, signPermit, rng } = require("./helpers");

describe("MiniSwapPair", function () {
  async function deployFixture() {
    const [owner, alice, bob, attacker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockToken");
    const tokenA = await Token.deploy("Mock USD", "mUSD", E(1_000_000));
    const tokenB = await Token.deploy("Mock ETH", "mETH", E(1_000_000));

    const Pair = await ethers.getContractFactory("MiniSwapPair");
    const pair = await Pair.deploy(await tokenA.getAddress(), await tokenB.getAddress(), owner.address);
    const pairAddr = await pair.getAddress();

    for (const user of [alice, bob, attacker]) {
      await tokenA.transfer(user.address, E(100_000));
      await tokenB.transfer(user.address, E(100_000));
    }
    for (const user of [owner, alice, bob, attacker]) {
      await tokenA.connect(user).approve(pairAddr, MAX);
      await tokenB.connect(user).approve(pairAddr, MAX);
    }
    return { owner, alice, bob, attacker, tokenA, tokenB, pair, pairAddr };
  }

  async function seededFixture() {
    const f = await deployFixture();
    await f.pair
      .connect(f.alice)
      .addLiquidity(E(1000), E(1000), 0, 0, f.alice.address, await deadline());
    return f;
  }

  async function k(pair) {
    const [r0, r1] = await pair.getReserves();
    return r0 * r1;
  }

  // ------------------------------------------------------------------
  describe("Deployment", function () {
    it("stores tokens and owner, LP token metadata", async function () {
      const { pair, tokenA, tokenB, owner } = await loadFixture(deployFixture);
      expect(await pair.token0()).to.equal(await tokenA.getAddress());
      expect(await pair.token1()).to.equal(await tokenB.getAddress());
      expect(await pair.owner()).to.equal(owner.address);
      expect(await pair.symbol()).to.equal("MSLP");
    });

    it("rejects zero address and identical tokens", async function () {
      const { tokenA, owner } = await loadFixture(deployFixture);
      const Pair = await ethers.getContractFactory("MiniSwapPair");
      const a = await tokenA.getAddress();
      await expect(Pair.deploy(ethers.ZeroAddress, a, owner.address)).to.be.revertedWithCustomError(
        Pair,
        "ZeroAddress"
      );
      await expect(Pair.deploy(a, a, owner.address)).to.be.revertedWithCustomError(Pair, "IdenticalTokens");
    });
  });

  // ------------------------------------------------------------------
  describe("Liquidity", function () {
    it("first deposit mints sqrt(x*y) - MINIMUM_LIQUIDITY and locks 1000 shares", async function () {
      const { pair, alice } = await loadFixture(deployFixture);
      const a0 = E(1000);
      const a1 = E(4000);
      await expect(pair.connect(alice).addLiquidity(a0, a1, 0, 0, alice.address, await deadline())).to.emit(
        pair,
        "Mint"
      );
      const expected = sqrt(a0 * a1) - 1000n; // sqrt(1000 * 4000) = 2000
      expect(await pair.balanceOf(alice.address)).to.equal(expected);
      expect(await pair.balanceOf(await pair.DEAD())).to.equal(1000n);
      const [r0, r1] = await pair.getReserves();
      expect(r0).to.equal(a0);
      expect(r1).to.equal(a1);
    });

    it("rejects a first deposit too small to cover MINIMUM_LIQUIDITY", async function () {
      const { pair, alice } = await loadFixture(deployFixture);
      await expect(
        pair.connect(alice).addLiquidity(1000n, 1000n, 0, 0, alice.address, await deadline())
      ).to.be.revertedWithCustomError(pair, "InsufficientLiquidityMinted");
    });

    it("later deposits use the optimal ratio and mint pro rata", async function () {
      const { pair, bob, tokenA, tokenB } = await loadFixture(seededFixture);
      const supplyBefore = await pair.totalSupply();
      const aBefore = await tokenA.balanceOf(bob.address);
      const bBefore = await tokenB.balanceOf(bob.address);

      // Pool is 1:1. Bob offers 100 A and 300 B; only 100 B should be taken.
      await pair.connect(bob).addLiquidity(E(100), E(300), 0, 0, bob.address, await deadline());
      expect(aBefore - (await tokenA.balanceOf(bob.address))).to.equal(E(100));
      expect(bBefore - (await tokenB.balanceOf(bob.address))).to.equal(E(100));
      expect(await pair.balanceOf(bob.address)).to.equal(supplyBefore / 10n); // 10% of pool
    });

    it("takes the other side when token1 is the binding amount", async function () {
      const { pair, bob, tokenA } = await loadFixture(seededFixture);
      const aBefore = await tokenA.balanceOf(bob.address);
      await pair.connect(bob).addLiquidity(E(500), E(50), 0, 0, bob.address, await deadline());
      expect(aBefore - (await tokenA.balanceOf(bob.address))).to.equal(E(50));
    });

    it("enforces amountMin slippage limits and deadline on deposit", async function () {
      const { pair, bob } = await loadFixture(seededFixture);
      await expect(
        pair.connect(bob).addLiquidity(E(100), E(300), 0, E(200), bob.address, await deadline())
      ).to.be.revertedWithCustomError(pair, "InsufficientAmount");
      await expect(
        pair.connect(bob).addLiquidity(E(100), E(100), 0, 0, bob.address, await deadline(-1))
      ).to.be.revertedWithCustomError(pair, "Expired");
      await expect(
        pair.connect(bob).addLiquidity(E(100), E(100), 0, 0, ethers.ZeroAddress, await deadline())
      ).to.be.revertedWithCustomError(pair, "ZeroAddress");
    });

    it("removes liquidity pro rata", async function () {
      const { pair, alice, tokenA, tokenB } = await loadFixture(seededFixture);
      const lp = await pair.balanceOf(alice.address);
      const half = lp / 2n;
      const supply = await pair.totalSupply();
      const [r0, r1] = await pair.getReserves();
      const a0 = await tokenA.balanceOf(alice.address);
      const a1 = await tokenB.balanceOf(alice.address);

      await expect(pair.connect(alice).removeLiquidity(half, 0, 0, alice.address, await deadline())).to.emit(
        pair,
        "Burn"
      );
      expect((await tokenA.balanceOf(alice.address)) - a0).to.equal((half * r0) / supply);
      expect((await tokenB.balanceOf(alice.address)) - a1).to.equal((half * r1) / supply);
    });

    it("withdrawing everything leaves the locked minimum in the pool", async function () {
      const { pair, alice } = await loadFixture(seededFixture);
      const lp = await pair.balanceOf(alice.address);
      await pair.connect(alice).removeLiquidity(lp, 0, 0, alice.address, await deadline());
      expect(await pair.totalSupply()).to.equal(1000n);
      const [r0, r1] = await pair.getReserves();
      expect(r0).to.be.gt(0n);
      expect(r1).to.be.gt(0n);
    });

    it("rejects zero / excessive burns and slippage on withdrawal", async function () {
      const { pair, alice, bob } = await loadFixture(seededFixture);
      await expect(
        pair.connect(alice).removeLiquidity(0, 0, 0, alice.address, await deadline())
      ).to.be.revertedWithCustomError(pair, "InsufficientAmount");
      await expect(
        pair.connect(alice).removeLiquidity(E(1), E(2), 0, alice.address, await deadline())
      ).to.be.revertedWithCustomError(pair, "InsufficientAmount");
      await expect(pair.connect(bob).removeLiquidity(E(1), 0, 0, bob.address, await deadline()))
        .to.be.revertedWithCustomError(pair, "ERC20InsufficientBalance");
    });
  });

  // ------------------------------------------------------------------
  describe("Swaps", function () {
    it("matches the closed-form output dy = y*g*dx / (x + g*dx)", async function () {
      const { pair, bob, tokenA, tokenB } = await loadFixture(seededFixture);
      const [r0, r1] = await pair.getReserves();
      const dx = E(10);
      const expected = amountOut(dx, r0, r1);
      expect(await pair.getAmountOut(dx, r0, r1)).to.equal(expected);

      const before = await tokenB.balanceOf(bob.address);
      await expect(
        pair.connect(bob).swapExactIn(await tokenA.getAddress(), dx, 0, bob.address, await deadline())
      )
        .to.emit(pair, "Swap")
        .withArgs(bob.address, await tokenA.getAddress(), dx, expected, bob.address);
      expect((await tokenB.balanceOf(bob.address)) - before).to.equal(expected);
    });

    it("swaps in the token1 -> token0 direction", async function () {
      const { pair, bob, tokenA, tokenB } = await loadFixture(seededFixture);
      const [r0, r1] = await pair.getReserves();
      const before = await tokenA.balanceOf(bob.address);
      await pair.connect(bob).swapExactIn(await tokenB.getAddress(), E(25), 0, bob.address, await deadline());
      expect((await tokenA.balanceOf(bob.address)) - before).to.equal(amountOut(E(25), r1, r0));
    });

    it("k strictly increases after a swap (fee stays in the pool)", async function () {
      const { pair, bob, tokenA } = await loadFixture(seededFixture);
      const k0 = await k(pair);
      await pair.connect(bob).swapExactIn(await tokenA.getAddress(), E(50), 0, bob.address, await deadline());
      expect(await k(pair)).to.be.gt(k0);
    });

    it("price impact: larger trades get a worse average price", async function () {
      const { pair } = await loadFixture(seededFixture);
      const [r0, r1] = await pair.getReserves();
      const small = await pair.getAmountOut(E(1), r0, r1);
      const large = await pair.getAmountOut(E(500), r0, r1);
      // average price received per unit of input
      expect(small * 500n).to.be.gt(large);
      // output is always strictly less than the reserve, no matter how large the input
      expect(await pair.getAmountOut(E(10_000_000), r0, r1)).to.be.lt(r1);
    });

    it("reverts when output is below amountOutMin (slippage protection)", async function () {
      const { pair, bob, tokenA } = await loadFixture(seededFixture);
      const [r0, r1] = await pair.getReserves();
      const expected = amountOut(E(10), r0, r1);
      await expect(
        pair.connect(bob).swapExactIn(await tokenA.getAddress(), E(10), expected + 1n, bob.address, await deadline())
      )
        .to.be.revertedWithCustomError(pair, "InsufficientOutputAmount")
        .withArgs(expected, expected + 1n);
    });

    it("reverts on expired deadline, unknown token, bad recipient, zero amount", async function () {
      const { pair, bob, tokenA, tokenB } = await loadFixture(seededFixture);
      const a = await tokenA.getAddress();
      await expect(
        pair.connect(bob).swapExactIn(a, E(1), 0, bob.address, await deadline(-1))
      ).to.be.revertedWithCustomError(pair, "Expired");
      await expect(
        pair.connect(bob).swapExactIn(bob.address, E(1), 0, bob.address, await deadline())
      ).to.be.revertedWithCustomError(pair, "InvalidToken");
      await expect(
        pair.connect(bob).swapExactIn(a, E(1), 0, await tokenB.getAddress(), await deadline())
      ).to.be.revertedWithCustomError(pair, "InvalidRecipient");
      await expect(
        pair.connect(bob).swapExactIn(a, E(1), 0, ethers.ZeroAddress, await deadline())
      ).to.be.revertedWithCustomError(pair, "InvalidRecipient");
      await expect(
        pair.connect(bob).swapExactIn(a, 0, 0, bob.address, await deadline())
      ).to.be.revertedWithCustomError(pair, "InsufficientAmount");
    });

    it("reverts when the pool is empty", async function () {
      const { pair, bob, tokenA } = await loadFixture(deployFixture);
      await expect(
        pair.connect(bob).swapExactIn(await tokenA.getAddress(), E(1), 0, bob.address, await deadline())
      ).to.be.revertedWithCustomError(pair, "InsufficientLiquidity");
    });

    it("pure helpers reject zero inputs", async function () {
      const { pair } = await loadFixture(deployFixture);
      await expect(pair.getAmountOut(0, 1, 1)).to.be.revertedWithCustomError(pair, "InsufficientAmount");
      await expect(pair.getAmountOut(1, 0, 1)).to.be.revertedWithCustomError(pair, "InsufficientLiquidity");
      await expect(pair.quote(0, 1, 1)).to.be.revertedWithCustomError(pair, "InsufficientAmount");
      await expect(pair.quote(1, 0, 1)).to.be.revertedWithCustomError(pair, "InsufficientLiquidity");
    });
  });

  // ------------------------------------------------------------------
  describe("Invariants (randomised, reproducible)", function () {
    it("over 60 random swaps: k never decreases and reserves always equal balances", async function () {
      const { pair, pairAddr, bob, tokenA, tokenB } = await loadFixture(seededFixture);
      const rand = rng(528);
      const a = await tokenA.getAddress();
      const b = await tokenB.getAddress();
      let prevK = await k(pair);

      for (let i = 0; i < 60; i++) {
        const zeroForOne = rand() < 0.5;
        const [r0, r1] = await pair.getReserves();
        const reserveIn = zeroForOne ? r0 : r1;
        // trade size between 0.01% and 20% of the input reserve
        const bps = BigInt(1 + Math.floor(rand() * 2000));
        const amountIn = (reserveIn * bps) / 10000n;
        await pair.connect(bob).swapExactIn(zeroForOne ? a : b, amountIn, 0, bob.address, await deadline());

        const newK = await k(pair);
        expect(newK).to.be.gte(prevK);
        prevK = newK;

        const [n0, n1] = await pair.getReserves();
        expect(n0).to.equal(await tokenA.balanceOf(pairAddr));
        expect(n1).to.equal(await tokenB.balanceOf(pairAddr));
      }
    });

    it("LP share value sqrt(k)/totalSupply grows with trading fees", async function () {
      const { pair, bob, tokenA, tokenB } = await loadFixture(seededFixture);
      const valuePerShare = async () => (sqrt(await k(pair)) * 10n ** 18n) / (await pair.totalSupply());
      const before = await valuePerShare();
      const a = await tokenA.getAddress();
      const b = await tokenB.getAddress();
      for (let i = 0; i < 10; i++) {
        await pair.connect(bob).swapExactIn(a, E(100), 0, bob.address, await deadline());
        await pair.connect(bob).swapExactIn(b, E(100), 0, bob.address, await deadline());
      }
      expect(await valuePerShare()).to.be.gt(before);
    });
  });

  // ------------------------------------------------------------------
  describe("EIP-2612 permit (EIP-712 signatures)", function () {
    it("swapExactInWithPermit swaps without a prior approve transaction", async function () {
      const { pair, pairAddr, tokenA, tokenB } = await loadFixture(seededFixture);
      const [, , , , carol] = await ethers.getSigners();
      await tokenA.transfer(carol.address, E(10)); // carol never calls approve
      expect(await tokenA.allowance(carol.address, pairAddr)).to.equal(0n);

      const dl = await deadline();
      const sig = await signPermit(tokenA, carol, pairAddr, E(10), dl);
      const before = await tokenB.balanceOf(carol.address);
      await pair
        .connect(carol)
        .swapExactInWithPermit(await tokenA.getAddress(), E(10), 0, carol.address, dl, sig.v, sig.r, sig.s);
      expect(await tokenB.balanceOf(carol.address)).to.be.gt(before);
      expect(await tokenA.nonces(carol.address)).to.equal(1n);
    });

    it("a replayed signature is useless (nonce already consumed)", async function () {
      const { pair, pairAddr, tokenA } = await loadFixture(seededFixture);
      const [, , , , carol] = await ethers.getSigners();
      await tokenA.transfer(carol.address, E(20));
      const dl = await deadline();
      const sig = await signPermit(tokenA, carol, pairAddr, E(10), dl);
      const a = await tokenA.getAddress();
      await pair.connect(carol).swapExactInWithPermit(a, E(10), 0, carol.address, dl, sig.v, sig.r, sig.s);
      // Replay: permit fails silently inside try/catch, allowance is 0, transferFrom reverts
      await expect(
        pair.connect(carol).swapExactInWithPermit(a, E(10), 0, carol.address, dl, sig.v, sig.r, sig.s)
      ).to.be.revertedWithCustomError(tokenA, "ERC20InsufficientAllowance");
    });

    it("a front-run permit does not block the user's swap", async function () {
      const { pair, pairAddr, tokenA, attacker } = await loadFixture(seededFixture);
      const [, , , , carol] = await ethers.getSigners();
      await tokenA.transfer(carol.address, E(10));
      const dl = await deadline();
      const sig = await signPermit(tokenA, carol, pairAddr, E(10), dl);
      // Attacker copies the signature from the mempool and submits the permit first
      await tokenA.connect(attacker).permit(carol.address, pairAddr, E(10), dl, sig.v, sig.r, sig.s);
      await expect(
        pair
          .connect(carol)
          .swapExactInWithPermit(await tokenA.getAddress(), E(10), 0, carol.address, dl, sig.v, sig.r, sig.s)
      ).to.emit(pair, "Swap");
    });

    it("a signature by the wrong key cannot spend someone else's tokens", async function () {
      const { pair, pairAddr, tokenA, attacker, alice } = await loadFixture(seededFixture);
      const dl = await deadline();
      const sig = await signPermit(tokenA, attacker, pairAddr, E(10), dl); // signed by attacker
      await expect(
        tokenA.connect(attacker).permit(alice.address, pairAddr, E(10), dl, sig.v, sig.r, sig.s)
      ).to.be.revertedWithCustomError(tokenA, "ERC2612InvalidSigner");
    });

    it("the LP token itself supports permit", async function () {
      const { pair, alice, bob } = await loadFixture(seededFixture);
      const dl = await deadline();
      const sig = await signPermit(pair, alice, bob.address, E(5), dl);
      await pair.connect(bob).permit(alice.address, bob.address, E(5), dl, sig.v, sig.r, sig.s);
      expect(await pair.allowance(alice.address, bob.address)).to.equal(E(5));
    });
  });

  // ------------------------------------------------------------------
  describe("Admin: pause / ownership", function () {
    it("only the owner can pause; paused blocks swaps & deposits but not withdrawals", async function () {
      const { pair, owner, alice, bob, tokenA } = await loadFixture(seededFixture);
      await expect(pair.connect(bob).pause()).to.be.revertedWithCustomError(pair, "OwnableUnauthorizedAccount");

      await pair.connect(owner).pause();
      await expect(
        pair.connect(bob).swapExactIn(await tokenA.getAddress(), E(1), 0, bob.address, await deadline())
      ).to.be.revertedWithCustomError(pair, "EnforcedPause");
      await expect(
        pair.connect(bob).addLiquidity(E(1), E(1), 0, 0, bob.address, await deadline())
      ).to.be.revertedWithCustomError(pair, "EnforcedPause");

      const lp = await pair.balanceOf(alice.address);
      await expect(pair.connect(alice).removeLiquidity(lp, 0, 0, alice.address, await deadline())).to.emit(
        pair,
        "Burn"
      );

      await pair.connect(owner).unpause();
      await expect(pair.connect(bob).unpause()).to.be.revertedWithCustomError(pair, "OwnableUnauthorizedAccount");
    });
  });

  // ------------------------------------------------------------------
  describe("Donations and sync", function () {
    it("sync() absorbs tokens sent directly to the pair", async function () {
      const { pair, pairAddr, tokenA, bob } = await loadFixture(seededFixture);
      await tokenA.connect(bob).transfer(pairAddr, E(7));
      const [r0Before] = await pair.getReserves();
      await pair.sync();
      const [r0After] = await pair.getReserves();
      expect(r0After - r0Before).to.equal(E(7));
    });

    it("dust donated + synced before initialisation cannot block the first deposit", async function () {
      const { pair, pairAddr, tokenA, attacker, alice } = await loadFixture(deployFixture);
      await tokenA.connect(attacker).transfer(pairAddr, 1n);
      await pair.sync(); // reserve0 = 1, reserve1 = 0
      await expect(
        pair.connect(alice).addLiquidity(E(1000), E(1000), 0, 0, alice.address, await deadline())
      ).to.emit(pair, "Mint");
    });
  });

  // ------------------------------------------------------------------
  describe("TWAP accumulators", function () {
    it("price0Cumulative grows by price * seconds (UQ112x112)", async function () {
      const { pair, bob } = await loadFixture(deployFixture);
      // price0 = reserve1/reserve0 = 2
      await pair.connect(bob).addLiquidity(E(1000), E(2000), 0, 0, bob.address, await deadline());
      const [, , t0] = await pair.getReserves();
      const c0 = await pair.price0CumulativeLast();
      await time.increase(99);
      await pair.sync(); // next block: t0 + 100
      const [, , t1] = await pair.getReserves();
      const dt = BigInt(t1 - t0);
      expect((await pair.price0CumulativeLast()) - c0).to.equal(2n * Q112 * dt);
      expect((await pair.price1CumulativeLast()) * 2n).to.equal(Q112 * dt);
    });
  });
});
