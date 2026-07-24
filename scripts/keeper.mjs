#!/usr/bin/env node
/**
 * DemoDex keeper — fires events periodically for Warden demo traffic.
 *
 * Usage:
 *   node scripts/keeper.mjs
 *
 * Env:
 *   RHC_HTTP_URL=https://...
 *   DEMODEX_ADDRESS=0x...
 *   KEEPER_PRIVATE_KEY=0x...    (needs a tiny ETH for gas)
 *   KEEPER_INTERVAL_SEC=900      (default: 15 minutes)
 */

import { ethers } from "ethers";

const RPC = process.env.RHC_HTTP_URL ?? "https://rhc-testnet.example-rpc.com";
const DEMODEX = process.env.DEMODEX_ADDRESS ?? "";
const KEY = process.env.KEEPER_PRIVATE_KEY ?? "";
const INTERVAL = parseInt(process.env.KEEPER_INTERVAL_SEC ?? "900") * 1000; // 15 min default

const TOKENS = {
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
};

const abi = [
  "function demoAll(address tokenIn, address tokenOut, uint256 swapAmount, uint256 debtAmount, uint256 depositAmount)",
];

const pairs = [
  { in: TOKENS.TSLA, out: TOKENS.AAPL },
  { in: TOKENS.NVDA, out: TOKENS.TSLA },
  { in: TOKENS.AAPL, out: TOKENS.NVDA },
];

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randPair() {
  return pairs[Math.floor(Math.random() * pairs.length)];
}

async function fire() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(KEY, provider);
  const dex = new ethers.Contract(DEMODEX, abi, wallet);

  const pair = randPair();
  const swapAmount = ethers.parseEther(String(rand(10, 500)));
  const debtAmount = ethers.parseEther(String(rand(50, 1000)));
  const depositAmount = ethers.parseEther(String(rand(100, 5000)));

  try {
    const tx = await dex.demoAll(pair.in, pair.out, swapAmount, debtAmount, depositAmount);
    console.log(`[${new Date().toISOString()}] fired · tx ${tx.hash.slice(0, 10)}… · swap=${ethers.formatEther(swapAmount)} ${pair.in.slice(2, 6)}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] failed · ${e.message}`);
  }
}

console.log(`[keeper] starting · interval=${INTERVAL / 1000}s · contract=${DEMODEX}`);
fire();
setInterval(fire, INTERVAL);
