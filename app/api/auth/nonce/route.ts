import { z } from "zod";
import { route } from "@/lib/http/middleware";
import { ok, bad } from "@/lib/http/response";
import {
  buildSiwsMessage,
  generateNonce,
  isValidSolanaAddress
} from "@/lib/auth/siws";
import { getRedis, KV } from "@/lib/kv/client";
import { db, hasDb } from "@/lib/db/client";
import { authNonces } from "@/lib/db/schema";

const Body = z.object({
  wallet: z.string().min(32).max(44)
});

export const runtime = "nodejs";

export const POST = route(
  { rateLimit: { scope: "auth_nonce", limit: 20, windowSec: 60 } },
  async (req) => {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("invalid_body", parsed.error.message);
    const { wallet } = parsed.data;

    if (!isValidSolanaAddress(wallet)) {
      return bad("invalid_wallet", "Not a valid base58 Solana address");
    }

    const ttl = Number.parseInt(process.env.SIWS_NONCE_TTL ?? "300", 10);
    const domain = process.env.SIWS_DOMAIN ?? "birdpump.fun";
    const nonce = generateNonce();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const message = buildSiwsMessage({ domain, wallet, nonce, issuedAt });

    await getRedis().set(
      KV.nonce(nonce),
      { wallet, issuedAt, expiresAt },
      { ex: ttl }
    );

    // Best-effort audit log to Postgres — never block auth on a DB error
    if (hasDb()) {
      try {
        await db
          .insert(authNonces)
          .values({
            nonce,
            wallet,
            issuedAt: new Date(issuedAt),
            expiresAt: new Date(expiresAt)
          })
          .onConflictDoNothing();
      } catch (e) {
        console.warn("[auth/nonce] DB audit write failed:", (e as Error).message);
      }
    }

    return ok({ nonce, message, expiresAt });
  }
);

export const OPTIONS = route({}, async () => ok({}));
