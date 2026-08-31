// Pay a winner whose payout transaction failed after the pot was already
// settled in the database.
//
//   npm run settle:retry -- --list        show every failed settlement
//   npm run settle:retry -- --all         retry all of them
//   npm run settle:retry -- <SETTLEMENT>  retry one
//
// Settlement zeroes the pot and advances the epoch inside a database
// transaction BEFORE the transfer is attempted. lib/pot/settle.ts now refuses
// to enter that transaction unless canPayout() says the treasury can complete
// the transfer, which removes the common cause (an unfunded treasury). But a
// transfer can still fail afterwards for reasons no precheck can rule out: an
// RPC timeout, a blockhash expiring, congestion. When that happens the pot is
// already zero and the winner is owed money with only a `failed` settlement
// row recording it. This script is how they get paid.
//
// It is safe to run repeatedly. Only `failed` rows are touched, the amount
// comes from the settlement record rather than anything recomputed, and the
// status flips to `sent` only after the transfer confirms and only from
// `failed`, so two concurrent runs cannot pay the same winner twice.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

for (const name of ["BIRDEYE_API_KEY", "HELIUS_API_KEY"]) {
  const vaulted = process.env[`PUMPBIRD_${name}`];
  if (vaulted && !process.env[name]) process.env[name] = vaulted;
}

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { settlements } from "@/lib/db/schema";
import { sendPumpBirdPayout, canPayout } from "@/lib/solana/send-payout";
import { getTokenDecimals } from "@/lib/solana/treasury";
import { rawToDisplay } from "@/lib/price/pumpbird";

async function list() {
  const rows = await db.select().from(settlements).where(eq(settlements.status, "failed"));
  if (rows.length === 0) {
    console.log("No failed settlements. Nobody is owed a payout.");
    return rows;
  }
  const decimals = getTokenDecimals();
  console.log(`\n${rows.length} failed settlement(s):\n`);
  for (const s of rows) {
    console.log(
      `  ${s.id}  epoch ${s.epoch}  score ${s.winningScore}  ` +
        `owes ${rawToDisplay(s.payoutTokenAmount, decimals)} $PUMPBIRD to ${s.winnerWallet}`
    );
    console.log(`     failed with: ${s.error ?? "(no reason recorded)"}`);
  }
  console.log("");
  return rows;
}

async function retryOne(id: string): Promise<boolean> {
  const [s] = await db.select().from(settlements).where(eq(settlements.id, id)).limit(1);
  if (!s) {
    console.log(`  ${id}: not found`);
    return false;
  }
  if (s.status !== "failed") {
    console.log(`  ${id}: status is "${s.status}", not "failed". Skipping.`);
    return false;
  }

  const decimals = getTokenDecimals();
  const owed = rawToDisplay(s.payoutTokenAmount, decimals);

  const able = await canPayout({ toWallet: s.winnerWallet, amountRaw: s.payoutTokenAmount });
  if (!able.ok) {
    console.log(`  ${id}: treasury still cannot pay (${able.reason}). Fund it and re-run.`);
    return false;
  }

  console.log(`  ${id}: sending ${owed} $PUMPBIRD to ${s.winnerWallet} ...`);
  const payout = await sendPumpBirdPayout({
    toWallet: s.winnerWallet,
    amountRaw: s.payoutTokenAmount
  });
  if (!payout.ok) {
    await db
      .update(settlements)
      .set({ error: payout.reason })
      .where(and(eq(settlements.id, id), eq(settlements.status, "failed")));
    console.log(`  ${id}: PAYOUT FAILED AGAIN (${payout.reason}). Left as failed.`);
    return false;
  }

  const updated = await db
    .update(settlements)
    .set({
      status: "sent",
      payoutSignature: payout.signature,
      payoutSlot: payout.slot,
      confirmedAt: new Date(),
      error: null
    })
    .where(and(eq(settlements.id, id), eq(settlements.status, "failed")))
    .returning({ id: settlements.id });

  if (updated.length === 0) {
    console.log(
      `  ${id}: WARNING transfer ${payout.signature} confirmed but another run had already ` +
        "changed the status. Check for a double payout."
    );
    return false;
  }

  console.log(`  ${id}: paid, tx ${payout.signature}`);
  return true;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const mode = args.includes("--list") ? "list" : args.includes("--all") ? "all" : "one";

  if (mode === "list") {
    await list();
    process.exit(0);
  }

  if (mode === "all") {
    const rows = await list();
    if (rows.length === 0) process.exit(0);
    let done = 0;
    for (const s of rows) if (await retryOne(s.id)) done++;
    console.log(`\nPaid ${done}/${rows.length}.`);
    process.exit(done === rows.length ? 0 : 1);
  }

  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error(
      "\nUsage:\n" +
        "  npm run settle:retry -- --list\n" +
        "  npm run settle:retry -- --all\n" +
        "  npm run settle:retry -- <SETTLEMENT_ID>\n"
    );
    process.exit(2);
  }
  process.exit((await retryOne(id)) ? 0 : 1);
}

main().catch((e) => {
  console.error("\nretry script crashed:", e);
  process.exit(1);
});
