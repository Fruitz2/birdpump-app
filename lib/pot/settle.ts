// Atomic pot settlement (PUMPBIRD edition).

import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { pot, scores, settlements, users } from "@/lib/db/schema";
import { sendPumpBirdPayout } from "@/lib/solana/send-payout";
import { getRedis, KV } from "@/lib/kv/client";
import { invalidatePotCache } from "./state";

export type SettleResult =
  | {
      kind: "settled";
      settlementId: string;
      payoutTokenAmount: string;
      payoutSignature: string | null;
      payoutStatus: "sent" | "failed" | "confirmed";
    }
  | { kind: "skipped"; reason: string };

const SETTLE_LOCK_TTL = 90;

export async function settleIfNewHigh(scoreId: string): Promise<SettleResult> {
  const redis = getRedis();
  const acquired = await redis.set(KV.settlementLock(), scoreId, {
    nx: true,
    ex: SETTLE_LOCK_TTL
  });
  if (!acquired) {
    return { kind: "skipped", reason: "concurrent_settlement_in_progress" };
  }

  try {
    const phase1 = await db.transaction(async (tx) => {
      const [scoreRow] = await tx
        .select()
        .from(scores)
        .where(eq(scores.id, scoreId))
        .limit(1);
      if (!scoreRow) return { ok: false, reason: "score_not_found" } as const;

      const [potRow] = await tx
        .select()
        .from(pot)
        .where(eq(pot.id, 1))
        .for("update")
        .limit(1);
      if (!potRow) return { ok: false, reason: "pot_row_missing" } as const;

      if (scoreRow.score <= potRow.allTimeHighScore) {
        return { ok: false, reason: "not_new_high" } as const;
      }

      const payoutTokenAmount = potRow.potTokenAmount;
      const settlementId = nanoid(24);

      await tx.insert(settlements).values({
        id: settlementId,
        epoch: potRow.epoch,
        winnerWallet: scoreRow.wallet,
        winningScore: scoreRow.score,
        previousHigh: potRow.allTimeHighScore,
        payoutTokenAmount,
        status: "pending",
        triggerScoreId: scoreRow.id
      });

      await tx
        .update(pot)
        .set({
          allTimeHighScore: scoreRow.score,
          allTimeHighWallet: scoreRow.wallet,
          potTokenAmount: 0n,
          epoch: potRow.epoch + 1,
          lastSettlementId: settlementId,
          updatedAt: new Date()
        })
        .where(eq(pot.id, 1));

      await tx
        .update(scores)
        .set({ winSettlementId: settlementId })
        .where(eq(scores.id, scoreRow.id));

      await tx
        .update(users)
        .set({
          bestScore: sql`GREATEST(${users.bestScore}, ${scoreRow.score})`,
          totalWonTokens: sql`${users.totalWonTokens} + ${payoutTokenAmount}`
        })
        .where(eq(users.wallet, scoreRow.wallet));

      return {
        ok: true,
        settlementId,
        winnerWallet: scoreRow.wallet,
        payoutTokenAmount
      } as const;
    });

    if (!phase1.ok) {
      return { kind: "skipped", reason: phase1.reason };
    }

    await invalidatePotCache();

    if (phase1.payoutTokenAmount <= 0n) {
      await db
        .update(settlements)
        .set({ status: "confirmed", confirmedAt: new Date() })
        .where(eq(settlements.id, phase1.settlementId));
      return {
        kind: "settled",
        settlementId: phase1.settlementId,
        payoutTokenAmount: phase1.payoutTokenAmount.toString(),
        payoutSignature: null,
        payoutStatus: "confirmed"
      };
    }

    const payout = await sendPumpBirdPayout({
      toWallet: phase1.winnerWallet,
      amountRaw: phase1.payoutTokenAmount
    });

    if (payout.ok) {
      await db
        .update(settlements)
        .set({
          status: "sent",
          payoutSignature: payout.signature,
          payoutSlot: payout.slot,
          confirmedAt: new Date()
        })
        .where(eq(settlements.id, phase1.settlementId));

      return {
        kind: "settled",
        settlementId: phase1.settlementId,
        payoutTokenAmount: phase1.payoutTokenAmount.toString(),
        payoutSignature: payout.signature,
        payoutStatus: "sent"
      };
    } else {
      await db
        .update(settlements)
        .set({ status: "failed", error: payout.reason })
        .where(eq(settlements.id, phase1.settlementId));

      console.error(
        `[settle] payout FAILED for ${phase1.settlementId}: ${payout.reason}. Manual reconciliation needed.`
      );

      return {
        kind: "settled",
        settlementId: phase1.settlementId,
        payoutTokenAmount: phase1.payoutTokenAmount.toString(),
        payoutSignature: null,
        payoutStatus: "failed"
      };
    }
  } finally {
    try {
      await redis.del(KV.settlementLock());
    } catch {
      // best-effort
    }
  }
}
