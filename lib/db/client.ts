// DB client.
//
// Production: WebSocket-based Neon driver (`neon-serverless`) for real ACID
// transactions. The HTTP-only driver does NOT give real atomicity, which we
// need for pot settlement.
//
// Dev: when DATABASE_URL is missing or looks like a placeholder, we still
// export `db` but lazily — the first query will throw a clear error.
// Routes that need DB call `requireDb()` explicitly so we can surface a
// useful 503 instead of an unhandled crash.

import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

if (typeof globalThis.WebSocket === "undefined") {
  // Lazy require so edge bundlers don't try to bundle it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ws = require("ws");
  neonConfig.webSocketConstructor = ws;
}

const url = process.env.DATABASE_URL;

function looksLikePlaceholder(u: string | undefined): boolean {
  if (!u) return true;
  return (
    u.includes("placeholder") ||
    u.startsWith("postgres://placeholder") ||
    u === ""
  );
}

const placeholderUrl = "postgres://placeholder@localhost/placeholder";

if (looksLikePlaceholder(url)) {
  console.warn(
    "[db] DATABASE_URL not set (or placeholder). DB-backed routes will return 503 in dev."
  );
}

const pool = new Pool({
  connectionString: looksLikePlaceholder(url) ? placeholderUrl : (url as string),
  idleTimeoutMillis: 5_000,
  max: 5
});

export const db = drizzle(pool, { schema });

export type DbClient = typeof db;
export { schema };

export function hasDb(): boolean {
  return !looksLikePlaceholder(url);
}
