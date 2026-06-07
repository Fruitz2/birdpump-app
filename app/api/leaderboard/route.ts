import { route } from "@/lib/http/middleware";
import { ok } from "@/lib/http/response";
import { db, hasDb } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { desc, sql } from "drizzle-orm";
import { getRedis, KV } from "@/lib/kv/client";

const CACHE_TTL = 10; // seconds

type LeaderEntry = {
  rank: number;
  wallet: string;
  displayName: string | null;
  avatarId: string | null;
  bestScore: number;
  totalPlays: number;
  totalWonTokens: string;
};

export const runtime = "nodejs";

export const GET = route(
  { rateLimit: { scope: "leaderboard", limit: 60, windowSec: 60 } },
  async (req) => {
    const url = new URL(req.url);
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
    const limit = Math.min(Math.max(limitParam, 1), 100);

    if (!hasDb()) {
      // Dev mode: return empty leaderboard so the UI renders
      return ok({ leaderboard: [], cached: false, devEmpty: true });
    }

    const cacheKey = `${KV.leaderboard()}:${limit}`;
    try {
      const cached = await getRedis().get<LeaderEntry[]>(cacheKey);
      if (cached) return ok({ leaderboard: cached, cached: true });
    } catch {
      // ignore
    }

    const rows = await db
      .select({
        wallet: users.wallet,
        displayName: users.displayName,
        avatarId: users.avatarId,
        bestScore: users.bestScore,
        totalPlays: users.totalPlays,
        totalWonTokens: users.totalWonTokens
      })
      .from(users)
      .where(sql`${users.bestScore} > 0`)
      .orderBy(desc(users.bestScore))
      .limit(limit);

    const leaderboard: LeaderEntry[] = rows.map((r, i) => ({
      rank: i + 1,
      wallet: r.wallet,
      displayName: r.displayName,
      avatarId: r.avatarId,
      bestScore: r.bestScore,
      totalPlays: r.totalPlays,
      totalWonTokens: r.totalWonTokens.toString()
    }));

    try {
      await getRedis().set(cacheKey, leaderboard, { ex: CACHE_TTL });
    } catch {
      // ignore
    }

    return ok({ leaderboard, cached: false });
  }
);
