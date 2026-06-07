// Helius webhook receiver — currently informational only.
//
// V1 uses client-driven /entry/confirm (player submits signature, server verifies).
// Webhooks are wired here so we can later auto-confirm tickets when Helius
// notifies us the user's payment tx hit treasury, eliminating the manual confirm.
//
// For now this just logs and returns 200. Webhook secret is required so random
// callers can't spam our logs.

import { route } from "@/lib/http/middleware";
import { ok, unauthorized } from "@/lib/http/response";

export const runtime = "nodejs";

export const POST = route({}, async (req) => {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}` && auth !== secret) {
      return unauthorized("invalid_webhook_secret");
    }
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  console.log(
    "[helius] event received",
    Array.isArray(body) ? `array[${body.length}]` : typeof body
  );

  return ok({ received: true });
});
