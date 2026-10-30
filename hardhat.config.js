require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
// Accept the key with or without the 0x prefix (MetaMask exports it without one)
const RAW_KEY = (process.env.PRIVATE_KEY || "").trim();
const PRIVATE_KEY = RAW_KEY && !RAW_KEY.startsWith("0x") ? `0x${RAW_KEY}` : RAW_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      // OpenZeppelin >= 5.2 uses the MCOPY opcode, introduced in the Cancun upgrade.
      // Sepolia and mainnet both support Cancun.
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      // IR pipeline: moves locals to memory when needed, avoiding "stack too deep"
      viaIR: true,
    },
  },
  networks: {
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  sourcify: { enabled: false },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
  },
};
