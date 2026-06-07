import { z } from "zod";
import { nanoid } from "nanoid";
import { route } from "@/lib/http/middleware";
import { ok, bad, err } from "@/lib/http/response";
import { db } from "@/lib/db/client";
import { tickets, users } from "@/lib/db/schema";
import { getPumpBirdPrice, rawToDisplay } from "@/lib/price/pumpbird";
import {
  getTokenMint,
  getTokenDecimals,
  getTreasuryAddress,
  getTreasuryAta
} from "@/lib/solana/treasury";

const MAX_LIVES = Number.parseInt(process.env.MAX_LIVES_PER_TICKET ?? "100", 10);

const Body = z.object({
  variant: z.enum(["forked", "custom"]).default("custom"),
  // Number of plays included in this single payment. 1..100.
  // Total payment = lives × per-life $1 worth of PUMPBIRD.
  lives: z.number().int().min(1).max(MAX_LIVES).default(1)
});

const TICKET_TTL_MIN = 15;
const SLIPPAGE_BPS = Number.parseInt(process.env.SLIPPAGE_BPS ?? "300", 10);
const QUOTE_TTL_MS = Number.parseInt(process.env.QUOTE_TTL_MS ?? "10000", 10);

export const runtime = "nodejs";

export const POST = route(
  {
    auth: true,
    rateLimit: { scope: "entry_create", limit: 12, windowSec: 60 }
  },
  async (req, ctx) => {
    const wallet = ctx.session!.sub;
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("invalid_body", parsed.error.message);
    const { variant, lives } = parsed.data;

    let treasury: string;
    let treasuryAta: string;
    let mint: string;
    let decimals: number;
    try {
      treasury = getTreasuryAddress().toBase58();
      treasuryAta = getTreasuryAta().toBase58();
      mint = getTokenMint().toBase58();
      decimals = getTokenDecimals();
    } catch (e) {
      return err(503, "treasury_unavailable", (e as Error).message);
    }

    const price = await getPumpBirdPrice();
    if (!price.available) {
      return err(503, "price_unavailable", price.reason);
    }

    const perLifeCents = Number.parseInt(process.env.ENTRY_USD_CENTS ?? "100", 10);
    const totalCents = perLifeCents * lives;
    const targetRaw = price.rawForUsdCents(totalCents);
    const slippage = (targetRaw * BigInt(SLIPPAGE_BPS)) / 10_000n;
    const minRaw = targetRaw - slippage;
    const maxRaw = targetRaw + slippage;

    const id = nanoid(24);
    const memo = `bp:${nanoid(12)}`;
    const seed = `${variant}:${wallet.slice(0, 8)}:${id}:${Date.now()}`;
    const now = new Date();
    const quoteExpiresAt = new Date(now.getTime() + QUOTE_TTL_MS);
    const ticketExpiresAt = new Date(now.getTime() + TICKET_TTL_MIN * 60 * 1000);

    await db
      .insert(users)
      .values({ wallet, createdAt: now, lastSeenAt: now })
      .onConflictDoNothing();

    await db.insert(tickets).values({
      id,
      wallet,
      variant,
      seed,
      memo,
      entryUsdCents: totalCents,
      entryTokenAmount: targetRaw,
      minTokenAmount: minRaw,
      maxTokenAmount: maxRaw,
      tokenUsdMicros: BigInt(Math.round(price.tokenUsd * 1_000_000)),
      quoteExpiresAt,
      status: "pending",
      expiresAt: ticketExpiresAt,
      livesTotal: lives,
      livesUsed: 0,
      createdAt: now
    });

    return ok({
      ticket: {
        id,
        variant,
        seed,
        memo,
        status: "pending",
        entryUsdCents: totalCents,
        perLifeUsdCents: perLifeCents,
        lives,
        tokenUsd: price.tokenUsd,
        quoteExpiresAt: quoteExpiresAt.toISOString(),
        ticketExpiresAt: ticketExpiresAt.toISOString()
      },
      payment: {
        tokenMint: mint,
        tokenDecimals: decimals,
        treasury,
        treasuryAta,
        amount: {
          target: targetRaw.toString(),
          min: minRaw.toString(),
          max: maxRaw.toString(),
          display: rawToDisplay(targetRaw, decimals)
        },
        memo,
        cluster: process.env.SOLANA_CLUSTER ?? "mainnet-beta"
      }
    });
  }
);
