import { route } from "@/lib/http/middleware";
import { ok } from "@/lib/http/response";
import { getPotSnapshot } from "@/lib/pot/state";
import { hasDb } from "@/lib/db/client";

export const runtime = "nodejs";

export const GET = route(
  { rateLimit: { scope: "pot", limit: 120, windowSec: 60 } },
  async () => {
    if (!hasDb()) {
      // Dev mode with no DB — return empty snapshot so the UI renders
      return ok({
        pot: {
          epoch: 1,
          allTimeHighScore: 0,
          allTimeHighWallet: null,
          potTokenAmount: "0",
          treasuryTokenAmount: "0",
          totalEntries: 0,
          lastSettlementId: null,
          updatedAt: new Date().toISOString()
        }
      });
    }
    const pot = await getPotSnapshot();
    return ok({ pot });
  }
);
