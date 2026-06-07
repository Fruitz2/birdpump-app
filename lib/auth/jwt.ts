import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { nanoid } from "nanoid";

const ALG = "HS256";

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 chars");
  }
  return new TextEncoder().encode(s);
}

function ttl(): number {
  return Number.parseInt(process.env.JWT_TTL_SECONDS ?? "86400", 10);
}

export type SessionClaims = JWTPayload & {
  sub: string; // wallet address
  jti: string;
  iat: number;
  exp: number;
};

export async function signSession(wallet: string): Promise<{
  token: string;
  jti: string;
  expiresAt: number;
}> {
  const jti = nanoid(24);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl();

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(wallet)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secret());

  return { token, jti, expiresAt: exp };
}

export async function verifySession(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] });

  if (typeof payload.sub !== "string" || typeof payload.jti !== "string") {
    throw new Error("invalid_session_claims");
  }
  return payload as SessionClaims;
}
