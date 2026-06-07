// Register a Helius webhook that streams transactions hitting the treasury wallet
// to our /api/webhooks/helius endpoint.
//
// One-time setup script. Run after deploying to Vercel so you have a public URL.
//
// Required env:
//   HELIUS_API_KEY                  - Helius account key
//   NEXT_PUBLIC_TREASURY_ADDRESS    - treasury wallet to watch
//   PUBLIC_API_BASE                 - https://<your-vercel-domain>
//   HELIUS_WEBHOOK_SECRET           - Bearer token webhook will send
//
// Usage:
//   tsx scripts/setup-helius-webhook.ts

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const apiKey = required("HELIUS_API_KEY");
  const treasury = required("NEXT_PUBLIC_TREASURY_ADDRESS");
  const base = required("PUBLIC_API_BASE");
  const secret = required("HELIUS_WEBHOOK_SECRET");

  const webhookURL = `${base.replace(/\/+$/u, "")}/api/webhooks/helius`;

  const body = {
    webhookURL,
    transactionTypes: ["TRANSFER"],
    accountAddresses: [treasury],
    webhookType: "enhanced",
    authHeader: `Bearer ${secret}`
  };

  const r = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const text = await r.text();
  console.log(`HTTP ${r.status}`);
  console.log(text);

  if (!r.ok) {
    process.exit(1);
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} not set`);
    process.exit(1);
  }
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
