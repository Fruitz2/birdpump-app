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

const Body = z.object({
  variant: z.enum(["forked", "custom"]).default("custom")
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

    const entryCents = Number.parseInt(process.env.ENTRY_USD_CENTS ?? "100", 10);
    const targetRaw = price.rawForUsdCents(entryCents);
    const slippage = (targetRaw * BigInt(SLIPPAGE_BPS)) / 10_000n;
    const minRaw = targetRaw - slippage;
    const maxRaw = targetRaw + slippage;

    const id = nanoid(24);
    const memo = `bp:${nanoid(12)}`;
    const seed = `${parsed.data.variant}:${wallet.slice(0, 8)}:${id}:${Date.now()}`;
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
      variant: parsed.data.variant,
      seed,
      memo,
      entryUsdCents: entryCents,
      entryTokenAmount: targetRaw,
      minTokenAmount: minRaw,
      maxTokenAmount: maxRaw,
      tokenUsdMicros: BigInt(Math.round(price.tokenUsd * 1_000_000)),
      quoteExpiresAt,
      status: "pending",
      expiresAt: ticketExpiresAt,
      createdAt: now
    });

    return ok({
      ticket: {
        id,
        variant: parsed.data.variant,
        seed,
        memo,
        status: "pending",
        entryUsdCents: entryCents,
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
