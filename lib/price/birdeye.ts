// SOL/USD price via Birdeye (BundlerBot key). Cached in Redis to avoid quota.
// Falls back to env-configured constant if Birdeye is unreachable.

import { getRedis, KV } from "@/lib/kv/client";

const SOL_MINT = "So11111111111111111111111111111111111111112";

type CachedPrice = {
  usd: number;
  ts: number; // ms
};

export async function getSolUsd(): Promise<{
  usd: number;
  source: "cache" | "birdeye" | "fallback";
}> {
  const ttl = Number.parseInt(process.env.SOL_USD_CACHE_TTL ?? "30", 10);
  const fallback = Number.parseFloat(process.env.SOL_USD_FALLBACK ?? "150");

  try {
    const redis = getRedis();
    const cached = await redis.get<CachedPrice>(KV.solUsd());
    if (cached && Date.now() - cached.ts < ttl * 1000) {
      return { usd: cached.usd, source: "cache" };
    }
  } catch {
    // Redis unavailable — keep going to Birdeye
  }

  const key = process.env.BIRDEYE_API_KEY;
  if (!key) {
    return { usd: fallback, source: "fallback" };
  }

  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${SOL_MINT}`,
      {
        headers: {
          "x-chain": "solana",
          "X-API-KEY": key,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(3000),
        cache: "no-store"
      }
    );
    if (!r.ok) {
      return { usd: fallback, source: "fallback" };
    }
    const j = (await r.json()) as { data?: { value?: number } };
    const usd = Number(j.data?.value);
    if (!Number.isFinite(usd) || usd <= 0) {
      return { usd: fallback, source: "fallback" };
    }

    try {
      await getRedis().set<CachedPrice>(KV.solUsd(), { usd, ts: Date.now() }, {
        ex: ttl + 5
      });
    } catch {
      // best-effort cache write
    }

    return { usd, source: "birdeye" };
  } catch {
    return { usd: fallback, source: "fallback" };
  }
}

// Retained for any future SOL-only entry mode. PUMPBIRD pricing lives in
// lib/price/pumpbird.ts.
export function usdCentsToLamports(cents: number, solUsd: number): bigint {
  const lamports = Math.ceil((cents / 100 / solUsd) * 1_000_000_000);
  return BigInt(lamports);
}
