const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const MAX = ethers.MaxUint256;
const Q112 = 2n ** 112n;

/** Integer square root (floor) for BigInt, Newton's method */
function sqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Reference implementation of the contract's swap formula (0.30% fee) */
function amountOut(amountIn, reserveIn, reserveOut) {
  const inWithFee = amountIn * 9970n;
  return (inWithFee * reserveOut) / (reserveIn * 10000n + inWithFee);
}

async function deadline(secondsFromNow = 3600) {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp + secondsFromNow);
}

/** Sign an EIP-2612 permit (EIP-712 typed data) */
async function signPermit(token, owner, spender, value, dl) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = {
    name: await token.name(),
    version: "1",
    chainId,
    verifyingContract: await token.getAddress(),
  };
  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const message = {
    owner: owner.address,
    spender,
    value,
    nonce: await token.nonces(owner.address),
    deadline: dl,
  };
  return ethers.Signature.from(await owner.signTypedData(domain, types, message));
}

/** Deterministic pseudo-random generator (mulberry32) for reproducible fuzz-style tests */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { E, MAX, Q112, sqrt, amountOut, deadline, signPermit, rng };
