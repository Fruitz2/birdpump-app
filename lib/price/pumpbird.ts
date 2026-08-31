// PUMPBIRD/USD price aggregator.
//
// Strategy:
//   1. If PUMPBIRD_TOKEN_MINT set AND bonding curve PDA exists:
//      - Read curve reserves via Helius RPC (sub-second)
//      - Combine with SOL/USD from Birdeye for PUMPBIRD/USD
//   2. If curve is `complete` (graduated to Raydium), fall back to Birdeye
//      direct token price.
//   3. If everything fails, return { available: false } and the route refuses
//      to quote.

import { PublicKey } from "@solana/web3.js";
import { getRedis } from "@/lib/kv/client";
import { tokenMintAddress, tokenDecimals } from "@/lib/config/token";
import { getSolUsd } from "./birdeye";
import {
  fetchBondingCurve,
  computeTokenAmountForUsd,
  spotPriceSolPerToken,
  type BondingCurveState
} from "@/lib/solana/pumpfun";

const CACHE_KEY = "bp:pumpbird:price:v1";
const CACHE_TTL = 5; // seconds — pump.fun is fast

export type PumpBirdQuote = {
  available: true;
  source: "bonding_curve" | "birdeye" | "cache";
  tokenMint: string;
  tokenDecimals: number;
  // USD price of 1 whole PUMPBIRD
  tokenUsd: number;
  // SOL price of 1 whole PUMPBIRD
  tokenSol: number;
  // 1 SOL in USD
  solUsd: number;
  // Curve state (only when source = bonding_curve)
  curve?: {
    virtualTokenReserves: string;
    virtualSolReserves: string;
    realTokenReserves: string;
    realSolReserves: string;
    tokenTotalSupply: string;
    complete: boolean;
  };
  // For quote computation
  rawForUsdCents: (cents: number) => bigint;
  ts: number;
};

export type PumpBirdQuoteResult =
  | PumpBirdQuote
  | { available: false; reason: string };

type CachedPrice = Omit<PumpBirdQuote, "rawForUsdCents" | "available"> & {
  // we re-derive rawForUsdCents on read using the cached curve
};

export async function getPumpBirdPrice(): Promise<PumpBirdQuoteResult> {
  const mintAddr = tokenMintAddress();
  const decimals = tokenDecimals();

  if (!mintAddr) {
    return { available: false, reason: "token mint not configured yet" };
  }

  let mint: PublicKey;
  try {
    mint = new PublicKey(mintAddr);
  } catch {
    return { available: false, reason: "configured token mint is not a valid pubkey" };
  }

  // Try cache first
  try {
    const cached = await getRedis().get<CachedPrice>(CACHE_KEY);
    if (cached && Date.now() - cached.ts < CACHE_TTL * 1000) {
      return materialize(cached, decimals);
    }
  } catch {
    // ignore
  }

  // Read SOL/USD in parallel with bonding curve fetch
  const [solUsdRes, curve] = await Promise.all([
    getSolUsd(),
    fetchBondingCurve(mint).catch(() => null)
  ]);
  const solUsd = solUsdRes.usd;

  if (curve && !curve.complete) {
    const tokenSol = spotPriceSolPerToken(curve, decimals);
    if (tokenSol <= 0) {
      return { available: false, reason: "curve_empty" };
    }
    const tokenUsd = tokenSol * solUsd;

    const quote: CachedPrice = {
      source: "bonding_curve",
      tokenMint: mintAddr,
      tokenDecimals: decimals,
      tokenUsd,
      tokenSol,
      solUsd,
      curve: {
        virtualTokenReserves: curve.virtualTokenReserves.toString(),
        virtualSolReserves: curve.virtualSolReserves.toString(),
        realTokenReserves: curve.realTokenReserves.toString(),
        realSolReserves: curve.realSolReserves.toString(),
        tokenTotalSupply: curve.tokenTotalSupply.toString(),
        complete: curve.complete
      },
      ts: Date.now()
    };
    try {
      await getRedis().set(CACHE_KEY, quote, { ex: CACHE_TTL + 2 });
    } catch {
      // best-effort
    }
    return materialize(quote, decimals);
  }

  // Curve graduated or missing → Birdeye token price
  const tokenUsd = await fetchBirdeyeTokenPriceUsd(mintAddr).catch(() => null);
  if (tokenUsd && tokenUsd > 0) {
    const quote: CachedPrice = {
      source: "birdeye",
      tokenMint: mintAddr,
      tokenDecimals: decimals,
      tokenUsd,
      tokenSol: tokenUsd / solUsd,
      solUsd,
      ts: Date.now()
    };
    try {
      await getRedis().set(CACHE_KEY, quote, { ex: CACHE_TTL + 2 });
    } catch {
      // best-effort
    }
    return materialize(quote, decimals);
  }

  return { available: false, reason: "no_price_source_available" };
}

function materialize(c: CachedPrice, decimals: number): PumpBirdQuote {
  const rawForUsdCents = (cents: number): bigint => {
    if (c.curve) {
      return computeTokenAmountForUsd({
        curve: {
          virtualTokenReserves: BigInt(c.curve.virtualTokenReserves),
          virtualSolReserves: BigInt(c.curve.virtualSolReserves),
          realTokenReserves: BigInt(c.curve.realTokenReserves),
          realSolReserves: BigInt(c.curve.realSolReserves),
          tokenTotalSupply: BigInt(c.curve.tokenTotalSupply),
          complete: c.curve.complete
        } as BondingCurveState,
        usdCents: cents,
        solUsd: c.solUsd
      });
    }
    // Birdeye direct: tokens = (cents / 100) / tokenUsd
    const whole = cents / 100 / c.tokenUsd;
    const raw = BigInt(Math.ceil(whole * Math.pow(10, decimals)));
    return raw;
  };

  return {
    available: true,
    source: c.source,
    tokenMint: c.tokenMint,
    tokenDecimals: c.tokenDecimals,
    tokenUsd: c.tokenUsd,
    tokenSol: c.tokenSol,
    solUsd: c.solUsd,
    curve: c.curve,
    rawForUsdCents,
    ts: c.ts
  };
}

async function fetchBirdeyeTokenPriceUsd(mint: string): Promise<number | null> {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${mint}`,
      {
        headers: {
          "x-chain": "solana",
          "X-API-KEY": key,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(2500),
        cache: "no-store"
      }
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { value?: number } };
    const v = Number(j.data?.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

// formatted display helpers (used in API responses)
export function rawToDisplay(raw: bigint, decimals: number): number {
  // For very large amounts we lose precision in Number — only use for display
  const div = BigInt(10) ** BigInt(decimals);
  const whole = raw / div;
  const frac = raw - whole * div;
  return Number(whole) + Number(frac) / Math.pow(10, decimals);
}
