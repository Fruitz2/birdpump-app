import { Ratelimit } from "@upstash/ratelimit";
import { getRedis, isDevMemoryMode } from "@/lib/kv/client";

const limiters = new Map<string, Ratelimit>();

function getLimiter(scope: string, limit: number, windowSec: number): Ratelimit {
  const key = `${scope}:${limit}:${windowSec}`;
  const existing = limiters.get(key);
  if (existing) return existing;

  const r = new Ratelimit({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redis: getRedis() as any,
    limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
    analytics: false,
    prefix: `bp:rl:${scope}`
  });
  limiters.set(key, r);
  return r;
}

export async function rateLimit(input: {
  scope: string;
  id: string;
  limit: number;
  windowSec: number;
}): Promise<{ ok: boolean; remaining: number }> {
  // In-memory dev KV doesn't support the Lua scripts @upstash/ratelimit needs.
  // Skip rate limiting in dev so local sign-in works freely. Production
  // (real Upstash) is unaffected.
  if (isDevMemoryMode()) {
    return { ok: true, remaining: -1 };
  }
  const limiter = getLimiter(input.scope, input.limit, input.windowSec);
  const r = await limiter.limit(input.id);
  return { ok: r.success, remaining: r.remaining };
}
