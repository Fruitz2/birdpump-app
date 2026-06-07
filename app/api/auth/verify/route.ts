import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { route } from "@/lib/http/middleware";
import { ok, bad, unauthorized } from "@/lib/http/response";
import {
  buildSiwsMessage,
  isValidSolanaAddress,
  verifySiwsSignature
} from "@/lib/auth/siws";
import { signSession } from "@/lib/auth/jwt";
import { getRedis, KV } from "@/lib/kv/client";
import { db, hasDb } from "@/lib/db/client";
import { authNonces, users } from "@/lib/db/schema";

const Body = z.object({
  wallet: z.string().min(32).max(44),
  nonce: z.string().min(32).max(64),
  signature: z.string().min(64).max(128) // base58 of 64-byte sig
});

type NonceRecord = { wallet: string; issuedAt: string; expiresAt: string };

export const runtime = "nodejs";

export const POST = route(
  { rateLimit: { scope: "auth_verify", limit: 20, windowSec: 60 } },
  async (req) => {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("invalid_body", parsed.error.message);
    const { wallet, nonce, signature } = parsed.data;

    if (!isValidSolanaAddress(wallet)) {
      return bad("invalid_wallet", "Not a valid base58 Solana address");
    }

    const redis = getRedis();
    const record = (await redis.get(KV.nonce(nonce))) as NonceRecord | null;
    if (!record) {
      return unauthorized("Nonce not found or expired");
    }
    if (record.wallet !== wallet) {
      return unauthorized("Nonce was not issued for this wallet");
    }

    const domain = process.env.SIWS_DOMAIN ?? "birdpump.fun";
    const message = buildSiwsMessage({
      domain,
      wallet,
      nonce,
      issuedAt: record.issuedAt
    });

    const result = verifySiwsSignature({
      message,
      signatureBase58: signature,
      wallet
    });
    if (!result.ok) {
      return unauthorized(`Signature verification failed: ${result.reason}`);
    }

    // Consume nonce — single use
    await redis.del(KV.nonce(nonce));

    // Best-effort DB updates (auth still succeeds without DB in dev)
    if (hasDb()) {
      try {
        await db
          .update(authNonces)
          .set({ consumedAt: new Date() })
          .where(and(eq(authNonces.nonce, nonce), isNull(authNonces.consumedAt)));

        const now = new Date();
        await db
          .insert(users)
          .values({ wallet, createdAt: now, lastSeenAt: now })
          .onConflictDoUpdate({
            target: users.wallet,
            set: { lastSeenAt: now }
          });
      } catch (e) {
        console.warn("[auth/verify] DB upsert failed:", (e as Error).message);
      }
    }

    const session = await signSession(wallet);
    return ok({
      token: session.token,
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
      wallet
    });
  }
);
