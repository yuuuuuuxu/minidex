# MiniDEX — a constant-product AMM with signed approvals and a TWAP oracle

CDS528 Group Project · Solidity 0.8.28 (EVM: Cancun, via-IR) · Hardhat · OpenZeppelin v5 · Sepolia testnet

MiniDEX is a minimal decentralized exchange for one token pair. There is no order book:
traders swap directly against a pool of two tokens, and the price comes from the
invariant **x · y = k**. Anyone can become a liquidity provider (LP) and earn the 0.30%
trading fee. The project re-implements the core of Uniswap V2 from first principles,
with emphasis on the mathematics (swap formula, √k shares, TWAP) and on cryptographic
authorization (EIP-712 / EIP-2612 signatures verified with `ecrecover`).

> ⚠️ Testnet only. All tokens are mock tokens with no value. Never use a wallet that holds real funds.

---

## 1. Deployed contracts (Sepolia)

| Contract | Address | Etherscan |
|---|---|---|
| MockToken `mUSD` | `0xb2D240Ab2f0C4B7fdFD0C94C6A5c2be9a25E7Ba4` | [verified source](https://sepolia.etherscan.io/address/0xb2D240Ab2f0C4B7fdFD0C94C6A5c2be9a25E7Ba4#code) |
| MockToken `mETH` | `0x67A668d5cbA1c16F8abDF235dC08945e481BA0DC` | [verified source](https://sepolia.etherscan.io/address/0x67A668d5cbA1c16F8abDF235dC08945e481BA0DC#code) |
| MiniSwapPair (LP token `MSLP`) | `0xce74ee4eeDA92E8e3da08d2Df3E3238A043263bB` | [verified source](https://sepolia.etherscan.io/address/0xce74ee4eeDA92E8e3da08d2Df3E3238A043263bB#code) |
| TwapOracle | `0x7d0e462B0a5B64663343E23D0B613746416a011b` | [verified source](https://sepolia.etherscan.io/address/0x7d0e462B0a5B64663343E23D0B613746416a011b#code) |

Deployed on 1 October 2026 by `0xEbC50726708773d35e9c6a3e43Dddc383b7CF217`, seeded with 20,000 mUSD / 10 mETH (1 mETH = 2,000 mUSD). Addresses are also saved in `deployments/sepolia.json`.

---

## 2. Architecture

```
            ┌──────────────┐  approve / permit   ┌──────────────────────────────┐
  Trader ──►│ MockToken    │────────────────────►│ MiniSwapPair (is ERC-20 MSLP) │
            │ mUSD / mETH  │◄── transferFrom ────│  reserves x, y   (uint112)    │
            └──────────────┘                     │  swapExactIn / WithPermit     │
  LP ───── addLiquidity / removeLiquidity ──────►│  add / removeLiquidity        │
                                                 │  price0/1CumulativeLast (TWAP)│
                                                 │  pause() — owner only         │
                                                 └──────────────┬───────────────┘
                                                                │ reads cumulative prices
                                                 ┌──────────────▼───────────────┐
  Any contract / user ── consult(token, amt) ───►│ TwapOracle (fixed window)     │
                                                 └──────────────────────────────┘
```

| File | Purpose |
|---|---|
| `contracts/MiniSwapPair.sol` | The AMM: swaps, liquidity, LP token (ERC-20 + permit), TWAP accumulators, pause |
| `contracts/TwapOracle.sol` | Time-weighted average price over a fixed window, manipulation-resistant |
| `contracts/MockToken.sol` | Test ERC-20 with EIP-2612 permit and a rate-limited faucet |
| `contracts/libraries/UQ112x112.sol` | Fixed-point (112.112) helpers for prices |
| `scripts/deploy.js` | Deploy all contracts, seed liquidity, verify on Etherscan |
| `scripts/interact.js` | Demo: swap on Sepolia and print price, √k and TWAP |
| `test/*.test.js` | Unit, property and attack-scenario tests (38 tests) |
| `analysis/amm_math.py` | Plots and numeric checks for the report |

---

## 3. The mathematics

**Swap.** With reserves *x*, *y* and fee factor γ = 0.997, selling Δx returns

  Δy = y · γΔx / (x + γΔx)

so Δy < y always (the pool cannot be drained) and the average price worsens as Δx/x grows
(price impact). The 0.3% stays in the pool, so *k* strictly increases with every swap.
After the transfer, the contract independently re-checks the fee-adjusted invariant on
actual balances: (x′·10⁴ − 30·Δx)(y′·10⁴ − 30·Δy_in) ≥ x·y·10⁸.

**LP shares.** The first deposit mints √(x·y) − 1000 shares (geometric mean: independent of
the unit of account); 1000 shares are locked forever at `0x…dEaD` to make share-price
inflation attacks uneconomic. Later deposits mint min(Δx/x, Δy/y) · totalSupply.

**Impermanent loss.** If the price moves by factor *r*, an LP's position is worth
2√r / (1 + r) of simply holding — ≤ 1 by AM–GM, equal only at *r* = 1.

**TWAP.** On the first transaction of each block the pair adds `price × secondsElapsed`
to an accumulator (UQ112x112 fixed point). The oracle computes
TWAP = (C(t₂) − C(t₁)) / (t₂ − t₁). Distorting a 1-hour TWAP by one block moves it by
~1/3600 of the distortion, while the attacker loses to arbitrage the whole time.

---

## 4. Security design

| Threat | Mitigation |
|---|---|
| Re-entrancy (malicious token callbacks) | `nonReentrant` on every state-changing entry point; burn-before-transfer; reserves updated from balances |
| Front-running / sandwich attacks | `amountOutMin` / `amount0Min` / `amount1Min` slippage limits and a `deadline` on every user action |
| Oracle / price manipulation (flash loans) | TWAP oracle instead of spot price; tested: a 75% one-block spot move shifts a 1-hour TWAP by < 0.1% |
| Signature replay / forgery | EIP-712 domain separator (chainId + contract), per-owner nonce, expiry; `ecrecover` must equal `owner` |
| Permit front-running (griefing) | `permit` wrapped in `try/catch`, so a copied signature cannot block the user's swap |
| LP share inflation / rounding | 1000 shares permanently locked; all divisions round in the pool's favour |
| Integer overflow | Solidity 0.8 checked math; reserves capped at 2¹¹²; accumulator wrap is intentional and confined to `unchecked` |
| Admin abuse | Owner can only pause swaps/deposits; **withdrawals can never be paused**; no upgradeability, no fee switch, no way for the owner to move user funds |

**Pausable / upgradeable?** Pausable (emergency stop) — yes. Upgradeable — no, deliberately:
an immutable core means users do not have to trust the deployer not to swap the logic.

---

## 5. Setup

Requirements: [Node.js](https://nodejs.org) 20 or later (tested on 24 LTS), Git. Optional: Python 3 (for Slither and the analysis script).

> **Windows one-click scripts:** `run_tests.cmd` (install + compile + test), `deploy_sepolia.cmd` (deploy + verify), `run_slither.cmd` (static analysis). On PowerShell, use `npm.cmd` / `npx.cmd` if script execution is disabled.

```bash
git clone <this-repo-url>
cd minidex
npm install
```

## 6. Compile & test

```bash
npx hardhat compile
npx hardhat test
npx hardhat coverage            # line/branch coverage report
REPORT_GAS=true npx hardhat test   # gas usage table (PowerShell: $env:REPORT_GAS="true"; npx hardhat test)
```

## 7. Deploy to Sepolia

1. Copy `.env.example` to `.env` and fill in `SEPOLIA_RPC_URL`, `PRIVATE_KEY` (a **test** wallet) and `ETHERSCAN_API_KEY`.
2. Get Sepolia test ETH from a faucet (e.g. Google Cloud Web3 faucet or Alchemy faucet).
3. Deploy (also seeds 20,000 mUSD / 10 mETH of liquidity and verifies on Etherscan):

```bash
npx hardhat run scripts/deploy.js --network sepolia
npx hardhat run scripts/interact.js --network sepolia   # demo swap + prices
```

Manual verification, if needed:

```bash
npx hardhat verify --network sepolia <PAIR_ADDRESS> <mUSD_ADDRESS> <mETH_ADDRESS> <OWNER_ADDRESS>
```

## 8. Static analysis (Slither)

```bash
pip install slither-analyzer
npx hardhat compile
slither . --config-file slither.config.json
```

**Result: 19 findings, 0 true vulnerabilities** (2 `weak-prng` and 6 `incorrect-equality` false positives,
2 informational `uninitialized-local`, 1 guarded `reentrancy-benign`, 8 by-design `timestamp`).
No findings for fund-stealing re-entrancy, arbitrary `transferFrom`, unchecked transfers or self-destruct.
Full triage: [`security/SLITHER_TRIAGE.md`](security/SLITHER_TRIAGE.md) · raw output: `slither_report.json`.

## 9. Math analysis

```bash
python analysis/amm_math.py     # writes figures to analysis/figures/
```

---

## 10. AI-use disclosure

Generative AI (Anthropic Claude) was used to assist with drafting contract code, tests,
scripts and this README. All code was reviewed, run and tested by the author, who is
responsible for its correctness.

## 11. References (APA 7)

Adams, H., Zinsmeister, N., & Robinson, D. (2020). *Uniswap v2 core* [White paper]. Uniswap. https://uniswap.org/whitepaper.pdf

Ethereum.org. (n.d.). *Uniswap-v2 contract walk-through*. Retrieved October 1, 2026, from https://ethereum.org/developers/tutorials/uniswap-v2-annotated-code/

Lundfall, M. (2020). *EIP-2612: Permit extension for EIP-20 signed approvals* (Ethereum Improvement Proposal No. 2612). https://eips.ethereum.org/EIPS/eip-2612

Bloemen, R., Logvinov, L., & Evans, J. (2017). *EIP-712: Typed structured data hashing and signing* (Ethereum Improvement Proposal No. 712). https://eips.ethereum.org/EIPS/eip-712

OpenZeppelin. (2024). *OpenZeppelin Contracts* (Version 5) [Computer software]. https://github.com/OpenZeppelin/openzeppelin-contracts

Feist, J., Grieco, G., & Groce, A. (2019). Slither: A static analysis framework for smart contracts. In *2019 IEEE/ACM 2nd International Workshop on Emerging Trends in Software Engineering for Blockchain (WETSEB)* (pp. 8–15). IEEE. https://doi.org/10.1109/WETSEB.2019.00008

## License

MIT. `UQ112x112` and the TWAP oracle pattern are re-implementations of ideas from Uniswap V2 (GPL-3.0 original), credited above.
