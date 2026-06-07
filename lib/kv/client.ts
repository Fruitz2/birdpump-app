import { Redis } from "@upstash/redis";

// ─────────────────────────────────────────────────────────────────────────────
// KV client with a dev-mode in-memory fallback.
//
// When KV_REST_API_URL / KV_REST_API_TOKEN are missing or look like placeholders,
// we use an in-process Map that mimics the small subset of Upstash methods we
// rely on (get / set with ex / del). This lets `npm run dev` work end-to-end
// without provisioning Upstash, so wallet sign-in can be tested locally.
//
// In production (real Upstash URL), behavior is unchanged — full Redis is used.
// ─────────────────────────────────────────────────────────────────────────────

type Stored = { value: unknown; expiresAt: number | null };

class MemoryKv {
  private store = new Map<string, Stored>();

  private isExpired(s: Stored): boolean {
    return s.expiresAt !== null && s.expiresAt <= Date.now();
  }

  async get<T>(key: string): Promise<T | null> {
    const s = this.store.get(key);
    if (!s) return null;
    if (this.isExpired(s)) {
      this.store.delete(key);
      return null;
    }
    return s.value as T;
  }

  async set<T>(
    key: string,
    value: T,
    opts?: { ex?: number; nx?: boolean }
  ): Promise<"OK" | null> {
    if (opts?.nx && this.store.has(key)) {
      const existing = this.store.get(key)!;
      if (!this.isExpired(existing)) return null;
    }
    const expiresAt =
      typeof opts?.ex === "number" ? Date.now() + opts.ex * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.store.delete(k)) n += 1;
    }
    return n;
  }

  // Subset of Pipeline / multi we don't need locally — stubbed minimally
  pipeline() {
    return this;
  }

  async exec() {
    return [];
  }

  // Compatibility: @upstash/ratelimit constructs queries via these methods.
  // We provide the minimum it needs to function (sorted-set ops are skipped;
  // the rate limit is effectively a no-op in dev, which is fine for local
  // development — production uses real Upstash).
  async eval(): Promise<unknown> {
    return [1, 1, Date.now()];
  }

  async evalsha(): Promise<unknown> {
    return [1, 1, Date.now()];
  }

  async script(): Promise<string> {
    return "stub";
  }
}

let _redis: Redis | MemoryKv | null = null;
let _isMemory = false;

function looksLikePlaceholder(url: string): boolean {
  return url.includes("placeholder") || url.startsWith("http://localhost");
}

export function isDevMemoryMode(): boolean {
  if (_redis === null) getRedis();
  return _isMemory;
}

export function getRedis(): Redis | MemoryKv {
  if (_redis) return _redis;

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token || looksLikePlaceholder(url)) {
    console.warn(
      "[kv] Using in-memory dev store (no real Upstash configured). NOT for production."
    );
    _redis = new MemoryKv();
    _isMemory = true;
    return _redis;
  }

  _redis = new Redis({ url, token });
  _isMemory = false;
  return _redis;
}

// Common keyspace
export const KV = {
  nonce: (n: string) => `bp:nonce:${n}`,
  session: (jti: string) => `bp:session:${jti}`,
  rate: (scope: string, id: string) => `bp:rl:${scope}:${id}`,
  solUsd: () => `bp:price:solusd`,
  leaderboard: () => `bp:leaderboard:v1`,
  potSnapshot: () => `bp:pot:v1`,
  ticketLock: (id: string) => `bp:ticket-lock:${id}`,
  settlementLock: () => `bp:settlement-lock`
} as const;
