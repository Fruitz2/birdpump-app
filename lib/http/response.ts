import { NextResponse } from "next/server";

export type ApiError = {
  error: string;
  message?: string;
  details?: unknown;
};

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function err(
  status: number,
  error: string,
  message?: string,
  details?: unknown
): NextResponse {
  const body: ApiError = { error };
  if (message) body.message = message;
  if (details !== undefined) body.details = details;
  return NextResponse.json(body, { status });
}

export const bad = (e: string, m?: string) => err(400, e, m);
export const unauthorized = (m?: string) => err(401, "unauthorized", m);
export const forbidden = (m?: string) => err(403, "forbidden", m);
export const notFound = (m?: string) => err(404, "not_found", m);
export const conflict = (e: string, m?: string) => err(409, e, m);
export const tooMany = (m?: string) => err(429, "rate_limited", m);
export const internal = (m?: string) => err(500, "internal_error", m);
