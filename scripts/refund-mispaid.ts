// Refund tickets that paid outside the slippage band.
//
//   npm run refund:list                 show every mispaid ticket
//   npm run refund:mispaid -- <TICKET>  refund one ticket
//   npm run refund:mispaid -- --all     refund every mispaid ticket
//
// Why this exists: /api/entry/confirm marks a payment `mispaid` when the amount
// lands outside the ticket's band. The tokens are already in the treasury and
// the player got nothing. Before this script the `refunded` status existed in
// the schema and no code path ever set it, so every one of those was a manual
// job and an angry Telegram message.
//
// The amount refunded is read back OFF CHAIN from the payment signature, not
// from anything the client claimed, using the same verification helper the
// confirm route uses. A mispaid ticket is never refunded twice: the status
// flips to `refunded` inside the same run, and the script skips anything that
// is not currently `mispaid`.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { tickets } from "@/lib/db/schema";
import { verifyPumpBirdPayment } from "@/lib/solana/verify-payment";
import { sendPumpBirdPayout } from "@/lib/solana/send-payout";
import { getTokenDecimals } from "@/lib/solana/treasury";
import { rawToDisplay } from "@/lib/price/pumpbird";

const NO_BAND_MIN = 0n;
const NO_BAND_MAX = (1n << 63n) - 1n;

async function list() {
  const rows = await db.select().from(tickets).where(eq(tickets.status, "mispaid"));
  if (rows.length === 0) {
    console.log("No mispaid tickets. Nothing to refund.");
    return rows;
  }
  const decimals = getTokenDecimals();
  console.log(`\n${rows.length} mispaid ticket(s):\n`);
  for (const t of rows) {
    console.log(
      `  ${t.id}  ${t.wallet}  quoted ${rawToDisplay(t.entryTokenAmount, decimals)} ` +
        `band [${rawToDisplay(t.minTokenAmount, decimals)} .. ${rawToDisplay(t.maxTokenAmount, decimals)}]`
    );
    console.log(`     sig ${t.paymentSignature ?? "(none recorded)"}`);
  }
  console.log("");
  return rows;
}

async function refundOne(ticketId: string): Promise<boolean> {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!t) {
    console.log(`  ${ticketId}: not found`);
    return false;
  }
  if (t.status !== "mispaid") {
    console.log(`  ${ticketId}: status is "${t.status}", not "mispaid". Skipping.`);
    return false;
  }
  if (!t.paymentSignature) {
    console.log(`  ${ticketId}: no payment signature recorded, cannot verify. Refund by hand.`);
    return false;
  }

  // Read the true amount off chain. Wide band so the verifier returns the
  // delta instead of rejecting it, every other check still applies.
  const v = await verifyPumpBirdPayment({
    signature: t.paymentSignature,
    walletAddress: t.wallet,
    expectedMemo: t.memo,
    minAmount: NO_BAND_MIN,
    maxAmount: NO_BAND_MAX
  });
  if (!v.ok) {
    console.log(`  ${ticketId}: on chain verification failed (${v.reason}). Refund by hand.`);
    return false;
  }

  const decimals = getTokenDecimals();
  console.log(
    `  ${ticketId}: sending ${rawToDisplay(v.amountRaw, decimals)} $PUMPBIRD back to ${t.wallet} ...`
  );

  const payout = await sendPumpBirdPayout({ toWallet: t.wallet, amountRaw: v.amountRaw });
  if (!payout.ok) {
    console.log(`  ${ticketId}: PAYOUT FAILED (${payout.reason}). Ticket left as mispaid.`);
    return false;
  }

  // Only flip the status once the transfer confirmed, and only from `mispaid`,
  // so a concurrent run cannot double refund.
  const updated = await db
    .update(tickets)
    .set({ status: "refunded" })
    .where(and(eq(tickets.id, ticketId), eq(tickets.status, "mispaid")))
    .returning({ id: tickets.id });

  if (updated.length === 0) {
    console.log(
      `  ${ticketId}: WARNING refund tx ${payout.signature} sent but the status was already ` +
        "changed by another run. Check for a double refund."
    );
    return false;
  }

  console.log(`  ${ticketId}: refunded, tx ${payout.signature}`);
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
    for (const t of rows) if (await refundOne(t.id)) done++;
    console.log(`\nRefunded ${done}/${rows.length}.`);
    process.exit(done === rows.length ? 0 : 1);
  }

  const ticketId = args.find((a) => !a.startsWith("--"));
  if (!ticketId) {
    console.error(
      "\nUsage:\n" +
        "  npm run refund:list\n" +
        "  npm run refund:mispaid -- <TICKET_ID>\n" +
        "  npm run refund:mispaid -- --all\n"
    );
    process.exit(2);
  }
  const ok = await refundOne(ticketId);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("\nrefund script crashed:", e);
  process.exit(1);
});
