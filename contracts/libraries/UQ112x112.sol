// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title UQ112x112 fixed-point helpers
/// @notice Unsigned fixed-point numbers with 112 integer bits and 112 fractional bits,
///         stored in a uint224. Used to represent prices (reserve ratios) without floats.
/// @dev Adapted from Uniswap V2 (Adams, Zinsmeister & Robinson, 2020), GPL-3.0 original;
///      re-implemented here for Solidity ^0.8.
library UQ112x112 {
    uint224 internal constant Q112 = 2 ** 112;

    /// @notice Encode an integer y as the fixed-point number y.0
    function encode(uint112 y) internal pure returns (uint224 z) {
        z = uint224(y) * Q112; // never overflows: (2^112 - 1) * 2^112 < 2^224
    }

    /// @notice Divide a UQ112x112 by a uint112, returning a UQ112x112
    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / uint224(y);
    }
}
