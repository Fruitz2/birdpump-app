// Treasury monitor cron.
// - Snapshots SOL gas balance + PUMPBIRD token balance + accounting state
// - Warns when SOL is too low to pay tx fees
// - Warns when on-chain token balance drifts from DB accounting (pot + treasury)
// - Polls pending settlements and refreshes their on-chain status

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { cron } from "@/lib/http/middleware";
import { ok } from "@/lib/http/response";
import { db } from "@/lib/db/client";
import { pot, settlements, treasurySnapshots } from "@/lib/db/schema";
import { getTreasuryBalances, gasSolCapLamports } from "@/lib/solana/treasury";
import { getConnection } from "@/lib/solana/connection";

const PENDING_POLL_LIMIT = 20;
// Drift tolerance — small drift is normal (rounding, in-flight tx).
const DRIFT_TOLERANCE_RAW = 1_000_000n; // ~1 token at 6 decimals

export const runtime = "nodejs";

export const GET = cron(async () => {
  let balances;
  try {
    balances = await getTreasuryBalances();
  } catch (e) {
    return ok({ error: `treasury_unavailable: ${(e as Error).message}` });
  }

  const [potRow] = await db.select().from(pot).where(eq(pot.id, 1)).limit(1);
  const minGas = gasSolCapLamports();
  const gasLow = balances.solLamports < minGas;

  const expected =
    (potRow?.potTokenAmount ?? 0n) + (potRow?.treasuryTokenAmount ?? 0n);
  const drift = balances.tokenRawAmount - expected;
  const absDrift = drift < 0n ? -drift : drift;
  const driftFlag = absDrift > DRIFT_TOLERANCE_RAW;

  await db.insert(treasurySnapshots).values({
    id: nanoid(24),
    solLamports: balances.solLamports,
    tokenAmount: balances.tokenRawAmount,
    potTokenAmount: potRow?.potTokenAmount ?? 0n,
    treasuryTokenAmount: potRow?.treasuryTokenAmount ?? 0n,
    gasLow,
    tokenAccountingDrift: driftFlag
  });

  if (gasLow) {
    console.warn(
      `[treasury-monitor] LOW GAS — treasury has ${balances.solDisplay} SOL, need >= ${
        Number(minGas) / 1_000_000_000
      } SOL. Top up wallet before payouts fail.`
    );
  }
  if (driftFlag) {
    console.warn(
      `[treasury-monitor] ACCOUNTING DRIFT — on-chain token balance ${balances.tokenRawAmount} ≠ expected ${expected} (delta ${drift})`
    );
  }

  // Refresh pending settlement statuses
  const pending = await db
    .select()
    .from(settlements)
    .where(eq(settlements.status, "sent"))
    .limit(PENDING_POLL_LIMIT);

  const conn = getConnection("confirmed");
  let confirmed = 0;
  for (const s of pending) {
    if (!s.payoutSignature) continue;
    try {
      const status = await conn.getSignatureStatus(s.payoutSignature, {
        searchTransactionHistory: true
      });
      const v = status.value;
      if (
        v?.confirmationStatus === "finalized" ||
        v?.confirmationStatus === "confirmed"
      ) {
        await db
          .update(settlements)
          .set({ status: "confirmed", confirmedAt: new Date() })
          .where(eq(settlements.id, s.id));
        confirmed += 1;
      } else if (v?.err) {
        await db
          .update(settlements)
          .set({ status: "failed", error: JSON.stringify(v.err) })
          .where(eq(settlements.id, s.id));
      }
    } catch (e) {
      console.warn(`[treasury-monitor] poll error ${s.id}: ${(e as Error).message}`);
    }
  }

  return ok({
    solLamports: balances.solLamports.toString(),
    solDisplay: balances.solDisplay,
    tokenRawAmount: balances.tokenRawAmount.toString(),
    tokenAtaExists: balances.tokenAtaExists,
    gasLow,
    drift: drift.toString(),
    accountingDrift: driftFlag,
    pendingSettlements: pending.length,
    confirmedSettlements: confirmed
  });
});
