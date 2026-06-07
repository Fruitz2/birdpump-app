import { NextResponse } from "next/server";
import { verifySession, type SessionClaims } from "@/lib/auth/jwt";
import { applyCorsHeaders, preflight } from "@/lib/http/cors";
import { unauthorized, internal, tooMany, err as apiErr } from "@/lib/http/response";
import { rateLimit } from "@/lib/ratelimit";

export type Handler<C extends RouteCtx = RouteCtx> = (
  req: Request,
  ctx: C
) => Promise<NextResponse> | NextResponse;

export type RouteCtx = {
  params?: Record<string, string | string[]>;
  session?: SessionClaims;
};

type RouteOpts = {
  auth?: boolean;
  rateLimit?: { scope: string; limit: number; windowSec: number };
};

export function route<C extends RouteCtx>(
  opts: RouteOpts,
  handler: Handler<C>
): Handler<C> {
  return async (req, ctx) => {
    const pre = preflight(req);
    if (pre) return pre;

    try {
      // Rate limit (best-effort — never block on KV failure)
      if (opts.rateLimit) {
        const id =
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          req.headers.get("x-real-ip") ||
          "anon";
        const rl = await rateLimit({
          scope: opts.rateLimit.scope,
          id,
          limit: opts.rateLimit.limit,
          windowSec: opts.rateLimit.windowSec
        }).catch(() => ({ ok: true, remaining: -1 }));
        if (!rl.ok) {
          return applyCorsHeaders(req, tooMany("Too many requests"));
        }
      }

      // Auth
      if (opts.auth) {
        const header = req.headers.get("authorization") ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token) {
          return applyCorsHeaders(req, unauthorized("Missing bearer token"));
        }
        try {
          ctx.session = await verifySession(token);
        } catch {
          return applyCorsHeaders(req, unauthorized("Invalid or expired token"));
        }
      }

      const res = await handler(req, ctx);
      return applyCorsHeaders(req, res);
    } catch (e) {
      console.error("[route]", e);
      return applyCorsHeaders(
        req,
        internal((e as Error)?.message ?? "Unknown error")
      );
    }
  };
}

export function cron(handler: Handler): Handler {
  return async (req, ctx) => {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.get("authorization");
    if (secret && auth !== `Bearer ${secret}`) {
      return apiErr(401, "unauthorized", "Invalid cron secret");
    }
    try {
      return await handler(req, ctx);
    } catch (e) {
      console.error("[cron]", e);
      return internal((e as Error)?.message ?? "cron failure");
    }
  };
}
