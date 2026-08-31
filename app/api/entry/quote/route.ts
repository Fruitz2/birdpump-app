import { route } from "@/lib/http/middleware";
import { ok } from "@/lib/http/response";
import { getPumpBirdPrice, rawToDisplay } from "@/lib/price/pumpbird";
import { getTreasuryAddress, getTreasuryAta } from "@/lib/solana/treasury";

const SLIPPAGE_BPS = Number.parseInt(process.env.SLIPPAGE_BPS ?? "1000", 10); // 10% — a fresh pump.fun curve moves several % between quote and signature; a tight band strands funds in `mispaid`
const QUOTE_TTL_MS = Number.parseInt(process.env.QUOTE_TTL_MS ?? "10000", 10);
const MAX_LIVES = Number.parseInt(process.env.MAX_LIVES_PER_TICKET ?? "100", 10);

export const runtime = "nodejs";

export const GET = route(
  { rateLimit: { scope: "quote", limit: 120, windowSec: 60 } },
  async (req) => {
    const url = new URL(req.url);
    const livesParam = url.searchParams.get("lives");
    const lives = Math.max(1, Math.min(MAX_LIVES, Number.parseInt(livesParam ?? "1", 10) || 1));

    const perLifeCents = Number.parseInt(process.env.ENTRY_USD_CENTS ?? "100", 10);
    const totalCents = perLifeCents * lives;

    const price = await getPumpBirdPrice();
    if (!price.available) {
      return ok({
        available: false,
        reason: price.reason,
        cluster: process.env.SOLANA_CLUSTER ?? "mainnet-beta"
      });
    }

    const targetRaw = price.rawForUsdCents(totalCents);
    const slippage = (targetRaw * BigInt(SLIPPAGE_BPS)) / 10_000n;
    const minRaw = targetRaw - slippage;
    const maxRaw = targetRaw + slippage;

    let treasury: string | null = null;
    let treasuryAta: string | null = null;
    try {
      treasury = getTreasuryAddress().toBase58();
      treasuryAta = getTreasuryAta().toBase58();
    } catch {
      // Treasury config missing — keep nulls so frontend can show config warning
    }

    return ok({
      available: true,
      lives,
      perLifeUsdCents: perLifeCents,
      entryUsdCents: totalCents,
      tokenMint: price.tokenMint,
      tokenDecimals: price.tokenDecimals,
      tokenProgram: process.env.PUMPBIRD_TOKEN_PROGRAM === "legacy" ? "legacy" : "token2022",
      tokenUsd: price.tokenUsd,
      tokenSol: price.tokenSol,
      solUsd: price.solUsd,
      priceSource: price.source,
      amount: {
        target: targetRaw.toString(),
        min: minRaw.toString(),
        max: maxRaw.toString(),
        display: {
          target: rawToDisplay(targetRaw, price.tokenDecimals),
          min: rawToDisplay(minRaw, price.tokenDecimals),
          max: rawToDisplay(maxRaw, price.tokenDecimals)
        }
      },
      slippageBps: SLIPPAGE_BPS,
      ttlMs: QUOTE_TTL_MS,
      treasury,
      treasuryAta,
      cluster: process.env.SOLANA_CLUSTER ?? "mainnet-beta"
    });
  }
);
