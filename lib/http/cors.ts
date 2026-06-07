import { NextResponse } from "next/server";

function allowedOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const allowed = allowedOrigins();
  if (allowed.includes("*")) return true;
  return allowed.includes(origin);
}

export function applyCorsHeaders(req: Request, res: NextResponse): NextResponse {
  const origin = req.headers.get("origin");
  if (origin && isOriginAllowed(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
    res.headers.set("Access-Control-Allow-Credentials", "true");
    res.headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Requested-With"
    );
    res.headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    res.headers.set("Access-Control-Max-Age", "86400");
  }
  return res;
}

export function preflight(req: Request): NextResponse | null {
  if (req.method !== "OPTIONS") return null;
  const res = new NextResponse(null, { status: 204 });
  return applyCorsHeaders(req, res);
}
