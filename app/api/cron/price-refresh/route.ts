// Keeps the Birdeye SOL/USD cache warm so /entry/quote stays fast.

import { cron } from "@/lib/http/middleware";
import { ok } from "@/lib/http/response";
import { getSolUsd } from "@/lib/price/birdeye";

export const runtime = "nodejs";

export const GET = cron(async () => {
  const r = await getSolUsd();
  return ok({ refreshed: true, solUsd: r.usd, source: r.source });
});
