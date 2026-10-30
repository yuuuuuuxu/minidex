// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MiniSwapPair} from "./MiniSwapPair.sol";
import {UQ112x112} from "./libraries/UQ112x112.sol";

/// @title TwapOracle
/// @notice Fixed-window time-weighted average price (TWAP) oracle on top of a MiniSwapPair.
///
///         TWAP over [t1, t2] = (C(t2) - C(t1)) / (t2 - t1)
///         where C(t) is the pair's cumulative price (sum of price * seconds).
///
///         Why this resists manipulation: moving the spot price for one block shifts the
///         average by only (distortion * 1 block) / window, while the attacker is exposed to
///         arbitrage for every second the distorted price is held.
///
/// @dev Pattern adapted from Uniswap V2's ExampleOracleSimple (Adams et al., 2020).
contract TwapOracle {
    using UQ112x112 for uint224;

    MiniSwapPair public immutable pair;
    address public immutable token0;
    address public immutable token1;
    /// @notice Minimum averaging window in seconds
    uint32 public immutable period;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint32 public blockTimestampLast;

    /// @notice Average price of token0 in token1 over the last window (UQ112x112)
    uint224 public price0Average;
    /// @notice Average price of token1 in token0 over the last window (UQ112x112)
    uint224 public price1Average;

    error NoReserves();
    error PeriodNotElapsed(uint32 elapsed, uint32 period);
    error InvalidToken();
    error NotInitialized();

    event Updated(uint224 price0Average, uint224 price1Average, uint32 timestamp);

    constructor(MiniSwapPair _pair, uint32 _period) {
        pair = _pair;
        token0 = address(_pair.token0());
        token1 = address(_pair.token1());
        period = _period;
        price0CumulativeLast = _pair.price0CumulativeLast();
        price1CumulativeLast = _pair.price1CumulativeLast();
        uint112 reserve0;
        uint112 reserve1;
        (reserve0, reserve1, blockTimestampLast) = _pair.getReserves();
        if (reserve0 == 0 || reserve1 == 0) revert NoReserves();
    }

    /// @notice Cumulative prices as of now, including the time since the pair's last update
    ///         (computed counterfactually, so no transaction on the pair is needed).
    function currentCumulativePrices() public view returns (uint256 price0Cumulative, uint256 price1Cumulative, uint32 timestamp) {
        timestamp = uint32(block.timestamp % 2 ** 32);
        price0Cumulative = pair.price0CumulativeLast();
        price1Cumulative = pair.price1CumulativeLast();
        (uint112 reserve0, uint112 reserve1, uint32 pairTimestamp) = pair.getReserves();
        if (pairTimestamp != timestamp) {
            unchecked {
                uint32 timeElapsed = timestamp - pairTimestamp;
                price0Cumulative += uint256(UQ112x112.encode(reserve1).uqdiv(reserve0)) * timeElapsed;
                price1Cumulative += uint256(UQ112x112.encode(reserve0).uqdiv(reserve1)) * timeElapsed;
            }
        }
    }

    /// @notice Recompute the average prices. Callable by anyone, at most once per period.
    function update() external {
        (uint256 price0Cumulative, uint256 price1Cumulative, uint32 timestamp) = currentCumulativePrices();
        uint32 timeElapsed;
        unchecked {
            timeElapsed = timestamp - blockTimestampLast;
        }
        if (timeElapsed < period) revert PeriodNotElapsed(timeElapsed, period);

        unchecked {
            // Accumulator overflow is fine: modular subtraction still gives the right difference
            price0Average = uint224((price0Cumulative - price0CumulativeLast) / timeElapsed);
            price1Average = uint224((price1Cumulative - price1CumulativeLast) / timeElapsed);
        }
        price0CumulativeLast = price0Cumulative;
        price1CumulativeLast = price1Cumulative;
        blockTimestampLast = timestamp;
        emit Updated(price0Average, price1Average, timestamp);
    }

    /// @notice Convert amountIn of `token` into the other token at the TWAP
    function consult(address token, uint256 amountIn) external view returns (uint256 amountOut) {
        uint224 price;
        if (token == token0) price = price0Average;
        else if (token == token1) price = price1Average;
        else revert InvalidToken();
        if (price == 0) revert NotInitialized();
        amountOut = Math.mulDiv(uint256(price), amountIn, 2 ** 112);
    }
}
