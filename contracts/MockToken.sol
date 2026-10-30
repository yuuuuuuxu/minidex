// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockToken
/// @notice Test-only ERC-20 token for the Sepolia testnet. It has no real value.
///         Supports EIP-2612 `permit` (gasless approvals via an EIP-712 signature)
///         and a rate-limited public faucet so anyone can obtain tokens for demos.
contract MockToken is ERC20, ERC20Permit {
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    /// @notice Last time each address used the faucet
    mapping(address => uint256) public lastFaucetAt;

    error FaucetCooldown(uint256 availableAt);

    event FaucetUsed(address indexed account, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint256 initialSupply)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _mint(msg.sender, initialSupply);
    }

    /// @notice Mint FAUCET_AMOUNT test tokens to the caller, at most once per FAUCET_COOLDOWN
    function faucet() external {
        uint256 last = lastFaucetAt[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCooldown(last + FAUCET_COOLDOWN);
        }
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetUsed(msg.sender, FAUCET_AMOUNT);
    }
}
