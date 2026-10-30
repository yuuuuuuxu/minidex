# Slither static analysis — results and triage

Tool: Slither (Feist, Grieco & Groce, 2019), run with `run_slither.cmd`
(config `slither.config.json`: dependencies in `node_modules` excluded).
Raw output: `slither_report.json`.

**Summary: 19 findings in 3 contracts. 0 true vulnerabilities. No code change required.**

| # | Detector | Slither impact | Count | Verdict |
|---|---|---|---|---|
| 1 | `weak-prng` | High | 2 | False positive |
| 2 | `incorrect-equality` | Medium | 6 | False positive |
| 3 | `uninitialized-local` | Medium | 2 | Informational (intended default) |
| 4 | `reentrancy-benign` | Low | 1 | Accepted (guarded) |
| 5 | `timestamp` | Low | 8 | Accepted (by design) |

## 1. `weak-prng` (High) — false positive

*Where:* `MiniSwapPair._update` and `TwapOracle.currentCumulativePrices`:
`uint32(block.timestamp % 2 ** 32)`.

Slither flags any `block.timestamp % n` because that pattern is often used to generate
"random" numbers, which miners/validators can bias. Here the modulo is **not** used for
randomness: it truncates the timestamp to 32 bits so it fits in the same storage slot as
the two `uint112` reserves (112 + 112 + 32 = 256 bits). Accumulator differences are taken
with wrapping arithmetic, so the truncation is harmless until the year 2106 and correct
even after it. This is the same design as Uniswap V2. No value in the contract depends on
the timestamp being unpredictable.

## 2. `incorrect-equality` (Medium) — false positive

*Where:* `amountIn == 0`, `reserveIn == 0 || reserveOut == 0`, `amount0 == 0 || amount1 == 0`,
`amountOut == 0`, `price == 0`.

This detector warns about strict equality on values an attacker can manipulate, e.g.
`balance == 100 ether`, which can be broken by sending 1 wei. All flagged comparisons are
**guards against zero** (empty pool, zero input, zero output, uninitialised oracle). An
attacker cannot use them to block anyone: making a value non-zero only lets the normal
code path run, which is protected by the invariant check and slippage limits.

## 3. `uninitialized-local` (Medium) — informational

*Where:* `bool zeroForOne;` in `MiniSwapPair._swap`; `uint224 price;` in `TwapOracle.consult`.

Solidity initialises locals to zero/false. Both variables are assigned on every valid
path (`zeroForOne` is set to `true` for token0 and stays `false` for token1; any other
token reverts with `InvalidToken`; `price` is set for token0/token1 and any other token
reverts). Behaviour is fully covered by tests ("swaps in the token1 -> token0 direction",
"rejects an unknown token").

## 4. `reentrancy-benign` (Low) — accepted

*Where:* `swapExactInWithPermit` calls `IERC20Permit(tokenIn).permit(...)` and then
updates reserves/accumulators inside `_swap`.

Mitigations already in place:
- `nonReentrant` (OpenZeppelin `ReentrancyGuard`) on every external state-changing
  function, so a malicious token cannot re-enter any of them during `permit`;
- `tokenIn` must equal `token0` or `token1` (otherwise `InvalidToken`), so only the two
  tokens fixed at deployment can ever be called;
- the fee-adjusted invariant `x'y' >= xy` is re-checked on actual balances after every swap.

Slither itself classifies this as *benign* (no state read before the call is reused after it).

## 5. `timestamp` (Low) — accepted, by design

*Where:* deadline checks, TWAP window, faucet cooldown, and functions that call `_update`.

Validators can shift `block.timestamp` by a few seconds. Effects here:
- **Deadlines / faucet cooldown:** a few seconds of drift is irrelevant at minute/day scale.
- **TWAP:** a skew of a few seconds changes a 600 s / 3600 s average by < 1%, and the
  price itself cannot be faked by changing the timestamp.
- Several flagged comparisons (e.g. `reserveIn == 0`) do not involve time at all; Slither
  reports them because the enclosing function also reads `block.timestamp`.

## Detectors that reported nothing

No findings for: `reentrancy-eth` / `reentrancy-no-eth` (fund-stealing re-entrancy),
`arbitrary-send-erc20`, `unchecked-transfer`, `suicidal`, `controlled-delegatecall`,
`tx-origin`, `shadowing-state`, `locked-ether`, `unprotected-upgrade`.
