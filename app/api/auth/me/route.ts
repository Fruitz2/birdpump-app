import { eq } from "drizzle-orm";
import { route } from "@/lib/http/middleware";
import { ok } from "@/lib/http/response";
import { db, hasDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

export const runtime = "nodejs";

export const GET = route({ auth: true }, async (_req, ctx) => {
  const wallet = ctx.session!.sub;

  if (!hasDb()) {
    // Dev mode without DB — return a stub profile from the JWT claim
    return ok({
      wallet,
      displayName: null,
      avatarId: null,
      bestScore: 0,
      totalPlays: 0,
      totalWonTokens: "0",
      createdAt: new Date(0).toISOString(),
      lastSeenAt: new Date().toISOString(),
      devStub: true
    });
  }

  const [row] = await db.select().from(users).where(eq(users.wallet, wallet)).limit(1);
  if (!row) {
    return ok({
      wallet,
      displayName: null,
      avatarId: null,
      bestScore: 0,
      totalPlays: 0,
      totalWonTokens: "0",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    });
  }

  return ok({
    wallet: row.wallet,
    displayName: row.displayName,
    avatarId: row.avatarId,
    bestScore: row.bestScore,
    totalPlays: row.totalPlays,
    totalWonTokens: row.totalWonTokens.toString(),
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString()
  });
});
