// Typed fetch helpers used by client components.
//
// All requests automatically include the JWT from localStorage (if present).
// Errors are normalized into ApiError so UI can show messages.

const SESSION_KEY = "bp:session:v1";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as { token: string; expiresAt: string };
    if (new Date(j.expiresAt).getTime() <= Date.now()) return null;
    return j.token;
  } catch {
    return null;
  }
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const b = body as { error?: string; message?: string } | null;
    throw new ApiError(
      res.status,
      b?.error ?? `http_${res.status}`,
      b?.message ?? res.statusText,
      body
    );
  }
  return body as T;
}

export async function apiGet<T>(path: string, opts?: { signal?: AbortSignal }): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, {
    method: "GET",
    headers,
    cache: "no-store",
    signal: opts?.signal
  });
  return handle<T>(res);
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  opts?: { signal?: AbortSignal }
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
    signal: opts?.signal
  });
  return handle<T>(res);
}

export async function apiPut<T>(
  path: string,
  body: unknown
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, {
    method: "PUT",
    headers,
    body: JSON.stringify(body ?? {}),
    cache: "no-store"
  });
  return handle<T>(res);
}
