// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {UQ112x112} from "./libraries/UQ112x112.sol";

/// @title MiniSwapPair
/// @notice A single-pair constant-product automated market maker (AMM).
///
///         Invariant:   x * y >= k        (x, y = pool reserves)
///         Swap output: dy = y * g*dx / (x + g*dx),   g = 1 - fee = 0.997
///         LP shares:   first deposit mints sqrt(x*y) - MINIMUM_LIQUIDITY,
///                      later deposits mint pro rata to the existing supply.
///
///         The pair itself is the ERC-20 LP token ("MSLP") and supports EIP-2612 permit.
///         It also accumulates time-weighted prices (TWAP) that an external oracle can read.
///
/// @dev    Design follows Uniswap V2 (Adams, Zinsmeister & Robinson, 2020), simplified:
///         the Router logic (slippage limits, deadlines, optimal deposit amounts) is merged
///         into the pair, and tokens are pulled with transferFrom instead of the
///         "transfer first, then call" pattern. All arithmetic is integer-only.
contract MiniSwapPair is ERC20, ERC20Permit, ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;
    using UQ112x112 for uint224;

    // ------------------------------------------------------------------
    // Constants & storage
    // ------------------------------------------------------------------

    /// @notice LP shares permanently locked on the first deposit (anti share-inflation)
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    /// @notice Swap fee in basis points (30 bps = 0.30%), paid to liquidity providers
    uint256 public constant FEE_BPS = 30;
    uint256 private constant BPS = 10_000;
    /// @dev OpenZeppelin v5 forbids minting to address(0), so locked shares go here
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    // Packed into a single storage slot (112 + 112 + 32 = 256 bits)
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    /// @notice Sum over time of price0 (token1 per token0) * seconds, in UQ112x112
    uint256 public price0CumulativeLast;
    /// @notice Sum over time of price1 (token0 per token1) * seconds, in UQ112x112
    uint256 public price1CumulativeLast;

    // ------------------------------------------------------------------
    // Events & errors
    // ------------------------------------------------------------------

    event Mint(address indexed sender, address indexed to, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Burn(address indexed sender, address indexed to, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swap(
        address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    error ZeroAddress();
    error IdenticalTokens();
    error Expired();
    error InvalidToken();
    error InvalidRecipient();
    error InsufficientAmount();
    error InsufficientLiquidity();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMin);
    error KInvariantViolated();
    error ReserveOverflow();

    modifier ensure(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    constructor(IERC20 _token0, IERC20 _token1, address initialOwner)
        ERC20("MiniSwap LP", "MSLP")
        ERC20Permit("MiniSwap LP")
        Ownable(initialOwner)
    {
        if (address(_token0) == address(0) || address(_token1) == address(0)) revert ZeroAddress();
        if (address(_token0) == address(_token1)) revert IdenticalTokens();
        token0 = _token0;
        token1 = _token1;
    }

    // ------------------------------------------------------------------
    // Views & pure math
    // ------------------------------------------------------------------

    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    /// @notice Output amount for an exact input, after the 0.30% fee.
    ///         dy = (dx * 9970 * y) / (x * 10000 + dx * 9970)
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * (BPS - FEE_BPS);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * BPS + amountInWithFee);
    }

    /// @notice Amount of B that has the same value as amountA at the current pool ratio
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) public pure returns (uint256 amountB) {
        if (amountA == 0) revert InsufficientAmount();
        if (reserveA == 0 || reserveB == 0) revert InsufficientLiquidity();
        amountB = (amountA * reserveB) / reserveA;
    }

    // ------------------------------------------------------------------
    // Liquidity
    // ------------------------------------------------------------------

    /// @notice Deposit both tokens and receive LP shares.
    /// @dev Amounts are adjusted to the current pool ratio so the price is not moved.
    ///      The caller must have approved this contract for both tokens.
    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address to,
        uint256 deadline
    ) external nonReentrant whenNotPaused ensure(deadline) returns (uint256 amount0, uint256 amount1, uint256 liquidity) {
        if (to == address(0)) revert ZeroAddress();

        (amount0, amount1) = _depositAmounts(amount0Desired, amount1Desired);
        if (amount0 == 0 || amount1 == 0) revert InsufficientAmount();
        if (amount0 < amount0Min || amount1 < amount1Min) revert InsufficientAmount();

        liquidity = _mintLiquidity(amount0, amount1); // computed against pre-deposit reserves

        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);
        _mint(to, liquidity);

        _updateFromBalances();
        emit Mint(msg.sender, to, amount0, amount1, liquidity);
    }

    /// @dev The first LP sets the initial price. Keyed on totalSupply (not reserves) so that
    ///      dust donated + sync()'d before initialisation cannot block the first deposit.
    function _depositAmounts(uint256 amount0Desired, uint256 amount1Desired)
        private
        view
        returns (uint256 amount0, uint256 amount1)
    {
        if (totalSupply() == 0) return (amount0Desired, amount1Desired);
        return _optimalAmounts(amount0Desired, amount1Desired, reserve0, reserve1);
    }

    /// @dev LP shares for a deposit. First deposit: sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY
    ///      (geometric mean = sqrt(k), independent of the price unit), with MINIMUM_LIQUIDITY
    ///      locked forever. Later deposits: pro rata to the existing supply.
    function _mintLiquidity(uint256 amount0, uint256 amount1) private returns (uint256 liquidity) {
        uint256 _totalSupply = totalSupply();
        if (_totalSupply == 0) {
            uint256 root = Math.sqrt(amount0 * amount1);
            if (root <= MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();
            liquidity = root - MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min((amount0 * _totalSupply) / reserve0, (amount1 * _totalSupply) / reserve1);
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
    }

    /// @notice Burn LP shares and receive the pro-rata share of both reserves.
    /// @dev Intentionally NOT blocked by pause: users can always withdraw their funds.
    function removeLiquidity(uint256 liquidity, uint256 amount0Min, uint256 amount1Min, address to, uint256 deadline)
        external
        nonReentrant
        ensure(deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        if (to == address(0)) revert ZeroAddress();
        if (liquidity == 0) revert InsufficientAmount();

        (amount0, amount1) = _withdrawAmounts(liquidity);
        if (amount0 < amount0Min || amount1 < amount1Min) revert InsufficientAmount();

        _burn(msg.sender, liquidity); // effects before interactions
        token0.safeTransfer(to, amount0);
        token1.safeTransfer(to, amount1);

        _updateFromBalances();
        emit Burn(msg.sender, to, amount0, amount1, liquidity);
    }

    /// @dev Pro-rata share of the actual balances (includes any donated tokens)
    function _withdrawAmounts(uint256 liquidity) private view returns (uint256 amount0, uint256 amount1) {
        uint256 _totalSupply = totalSupply();
        amount0 = (liquidity * token0.balanceOf(address(this))) / _totalSupply;
        amount1 = (liquidity * token1.balanceOf(address(this))) / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
    }

    // ------------------------------------------------------------------
    // Swaps
    // ------------------------------------------------------------------

    /// @notice Swap an exact amount of tokenIn for as much of the other token as possible.
    /// @param amountOutMin Slippage protection: revert if output would be smaller
    /// @param deadline     Revert if mined after this timestamp (stale-transaction protection)
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 amountOutMin, address to, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        ensure(deadline)
        returns (uint256 amountOut)
    {
        amountOut = _swap(tokenIn, amountIn, amountOutMin, to);
    }

    /// @notice Same as swapExactIn, but approves tokenIn with an EIP-2612 signature in the
    ///         same transaction (no separate `approve` transaction needed).
    /// @dev The permit is wrapped in try/catch: if someone front-runs and submits the same
    ///      signature first, the allowance already exists and the swap still succeeds.
    ///      A replayed or forged signature leaves no allowance, so transferFrom reverts.
    function swapExactInWithPermit(
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused ensure(deadline) returns (uint256 amountOut) {
        try IERC20Permit(tokenIn).permit(msg.sender, address(this), amountIn, deadline, v, r, s) {} catch {}
        amountOut = _swap(tokenIn, amountIn, amountOutMin, to);
    }

    function _swap(address tokenIn, uint256 amountIn, uint256 amountOutMin, address to)
        private
        returns (uint256 amountOut)
    {
        bool zeroForOne;
        if (tokenIn == address(token0)) zeroForOne = true;
        else if (tokenIn != address(token1)) revert InvalidToken();
        if (to == address(0) || to == address(token0) || to == address(token1)) revert InvalidRecipient();

        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        if (_reserve0 == 0 || _reserve1 == 0) revert InsufficientLiquidity();

        // Measure what actually arrived (robust to fee-on-transfer tokens)
        uint256 received = _pull(zeroForOne ? token0 : token1, amountIn);

        amountOut = zeroForOne
            ? getAmountOut(received, _reserve0, _reserve1)
            : getAmountOut(received, _reserve1, _reserve0);
        if (amountOut == 0 || amountOut < amountOutMin) revert InsufficientOutputAmount(amountOut, amountOutMin);

        (zeroForOne ? token1 : token0).safeTransfer(to, amountOut);

        _checkInvariantAndUpdate(_reserve0, _reserve1, zeroForOne ? 0 : amountOut, zeroForOne ? amountOut : 0);
        emit Swap(msg.sender, tokenIn, received, amountOut, to);
    }

    function _pull(IERC20 token, uint256 amount) private returns (uint256 received) {
        if (amount == 0) revert InsufficientAmount();
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        received = token.balanceOf(address(this)) - balanceBefore;
    }

    /// @dev Defense in depth: independently of getAmountOut, verify the fee-adjusted
    ///      constant-product invariant  (x' - f*dx)(y' - f*dy) >= x*y  on actual balances.
    function _checkInvariantAndUpdate(uint112 _reserve0, uint112 _reserve1, uint256 amount0Out, uint256 amount1Out)
        private
    {
        uint256 balance0 = token0.balanceOf(address(this));
        uint256 balance1 = token1.balanceOf(address(this));
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;

        uint256 balance0Adjusted = balance0 * BPS - amount0In * FEE_BPS;
        uint256 balance1Adjusted = balance1 * BPS - amount1In * FEE_BPS;
        if (balance0Adjusted * balance1Adjusted < uint256(_reserve0) * uint256(_reserve1) * BPS * BPS) {
            revert KInvariantViolated();
        }
        _update(balance0, balance1, _reserve0, _reserve1);
    }

    // ------------------------------------------------------------------
    // Maintenance & admin
    // ------------------------------------------------------------------

    /// @notice Force reserves to match balances (absorbs tokens sent directly to the pair)
    function sync() external nonReentrant {
        _updateFromBalances();
    }

    /// @notice Emergency stop for swaps and deposits. Withdrawals stay available.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _optimalAmounts(uint256 amount0Desired, uint256 amount1Desired, uint112 _reserve0, uint112 _reserve1)
        private
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 amount1Optimal = quote(amount0Desired, _reserve0, _reserve1);
        if (amount1Optimal <= amount1Desired) {
            return (amount0Desired, amount1Optimal);
        }
        uint256 amount0Optimal = quote(amount1Desired, _reserve1, _reserve0);
        return (amount0Optimal, amount1Desired);
    }

    /// @dev Set reserves to the current token balances (old reserves price the elapsed time)
    function _updateFromBalances() private {
        _update(token0.balanceOf(address(this)), token1.balanceOf(address(this)), reserve0, reserve1);
    }

    /// @dev Updates reserves and, on the first call in each block, the price accumulators.
    ///      priceCumulative += price_before_this_block * secondsElapsed
    ///      Overflow of the accumulators is intended (only differences are used).
    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert ReserveOverflow();
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        unchecked {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast; // wraps intentionally
            if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                price0CumulativeLast += uint256(UQ112x112.encode(_reserve1).uqdiv(_reserve0)) * timeElapsed;
                price1CumulativeLast += uint256(UQ112x112.encode(_reserve0).uqdiv(_reserve1)) * timeElapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }
}
