// pump.fun bonding curve reader.
//
// Reads the BondingCurve PDA derived from a token mint and returns the live
// constant-product spot price. We use this for sub-second PUMPBIRD/SOL pricing
// while the token is still on the pump.fun bonding curve. Once `complete=true`
// the curve has graduated to Raydium and price should come from Birdeye instead.
//
// Account layout (anchor BondingCurve):
//   0..8   discriminator
//   8..16  virtual_token_reserves : u64
//   16..24 virtual_sol_reserves   : u64
//   24..32 real_token_reserves    : u64
//   32..40 real_sol_reserves      : u64
//   40..48 token_total_supply     : u64
//   48     complete               : u8 (bool)

import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection";

export const PUMPFUN_PROGRAM_ID = new PublicKey(
  process.env.PUMPFUN_PROGRAM_ID ?? "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

export type BondingCurveState = {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
};

export function deriveBondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBytes()],
    PUMPFUN_PROGRAM_ID
  );
  return pda;
}

export async function fetchBondingCurve(
  mint: PublicKey
): Promise<BondingCurveState | null> {
  const conn = getConnection("processed");
  const pda = deriveBondingCurvePda(mint);

  const info = await conn.getAccountInfo(pda, "processed");
  if (!info) return null;

  const data = info.data;
  if (data.length < 49) return null;

  return {
    virtualTokenReserves: readBigU64LE(data, 8),
    virtualSolReserves: readBigU64LE(data, 16),
    realTokenReserves: readBigU64LE(data, 24),
    realSolReserves: readBigU64LE(data, 32),
    tokenTotalSupply: readBigU64LE(data, 40),
    complete: data[48] === 1
  };
}

// Returns SOL per PUMPBIRD (whole token units), as a Number for display.
// For exact math, use computeTokenAmountForUsd() instead.
export function spotPriceSolPerToken(
  curve: BondingCurveState,
  tokenDecimals: number
): number {
  if (curve.virtualTokenReserves === 0n) return 0;
  // sol_per_token = (virtual_sol / 1e9) / (virtual_token / 10^decimals)
  const solReserves = Number(curve.virtualSolReserves) / 1e9;
  const tokenReserves = Number(curve.virtualTokenReserves) / Math.pow(10, tokenDecimals);
  if (tokenReserves === 0) return 0;
  return solReserves / tokenReserves;
}

// Exact integer math: how many raw token units equal `usdCents` at the current
// curve price, given SOL/USD. Quote payload uses this to bind the player to a
// specific lamport-equivalent token amount.
export function computeTokenAmountForUsd(input: {
  curve: BondingCurveState;
  usdCents: number;
  solUsd: number;
}): bigint {
  if (input.solUsd <= 0) throw new Error("solUsd must be > 0");
  if (input.curve.virtualTokenReserves === 0n) throw new Error("empty curve");

  // tokens_per_lamport = virtual_token_reserves / virtual_sol_reserves
  // usd_value = cents / 100; sol_value = usd_value / solUsd; lamports = sol_value * 1e9
  // tokens_raw = lamports * tokens_per_lamport
  //
  // To avoid floating-point loss, multiply everything as bigint after a single
  // float division for cents/solUsd (sub-microdollar precision is fine).

  const usd = input.usdCents / 100;
  const sol = usd / input.solUsd;
  const lamports = BigInt(Math.ceil(sol * 1_000_000_000));

  return (lamports * input.curve.virtualTokenReserves) / input.curve.virtualSolReserves;
}

function readBigU64LE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getBigUint64(offset, true);
}
