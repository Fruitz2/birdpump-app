import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { route } from "@/lib/http/middleware";
import { ok, bad, conflict, notFound, forbidden } from "@/lib/http/response";
import { db } from "@/lib/db/client";
import { tickets, pot } from "@/lib/db/schema";
import { verifyPumpBirdPayment } from "@/lib/solana/verify-payment";
import { invalidatePotCache } from "@/lib/pot/state";

const Body = z.object({
  ticketId: z.string().min(8).max(32),
  signature: z.string().min(64).max(128)
});

const BURN_CUT_BPS = Number.parseInt(process.env.BURN_CUT_BPS ?? "2500", 10);

function splitEntry(amount: bigint): { pool: bigint; treasury: bigint } {
  const treasury = (amount * BigInt(BURN_CUT_BPS)) / 10_000n;
  const pool = amount - treasury;
  return { pool, treasury };
}

export const runtime = "nodejs";

export const POST = route(
  {
    auth: true,
    rateLimit: { scope: "entry_confirm", limit: 30, windowSec: 60 }
  },
  async (req, ctx) => {
    const wallet = ctx.session!.sub;
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("invalid_body", parsed.error.message);
    const { ticketId, signature } = parsed.data;

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (!ticket) return notFound("ticket_not_found");
    if (ticket.wallet !== wallet) return forbidden("ticket_wallet_mismatch");

    if (ticket.status === "confirmed" || ticket.status === "played") {
      return ok({
        ticket: {
          id: ticket.id,
          status: ticket.status,
          paymentSignature: ticket.paymentSignature
        },
        alreadyConfirmed: true
      });
    }
    if (ticket.status === "expired" || ticket.status === "refunded" || ticket.status === "mispaid") {
      return conflict("ticket_unusable", `Ticket is ${ticket.status}`);
    }
    if (ticket.expiresAt.getTime() < Date.now()) {
      await db.update(tickets).set({ status: "expired" }).where(eq(tickets.id, ticketId));
      return conflict("ticket_expired");
    }

    const result = await verifyPumpBirdPayment({
      signature,
      walletAddress: wallet,
      expectedMemo: ticket.memo,
      minAmount: ticket.minTokenAmount,
      maxAmount: ticket.maxTokenAmount,
      maxAgeSeconds: 30 * 60
    });

    if (!result.ok) {
      // If the amount is OUTSIDE the band, mark as mispaid so it shows up in
      // the operator reconciliation queue.
      if (
        result.reason.startsWith("amount_too_low:") ||
        result.reason.startsWith("amount_too_high:")
      ) {
        await db
          .update(tickets)
          .set({ status: "mispaid", paymentSignature: signature })
          .where(eq(tickets.id, ticketId));
        return conflict("payment_outside_slippage", result.reason);
      }
      return bad("payment_invalid", result.reason);
    }

    try {
      await db.transaction(async (tx) => {
        const [t] = await tx
          .select()
          .from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.status, "pending")))
          .for("update")
          .limit(1);
        if (!t) throw new Error("ticket_status_changed");

        await tx
          .update(tickets)
          .set({
            status: "confirmed",
            paymentSignature: signature,
            paymentSlot: result.slot,
            paidTokenAmount: result.amountRaw,
            confirmedAt: new Date()
          })
          .where(eq(tickets.id, ticketId));

        const { pool, treasury } = splitEntry(result.amountRaw);

        const [potRow] = await tx
          .select()
          .from(pot)
          .where(eq(pot.id, 1))
          .for("update")
          .limit(1);
        if (!potRow) {
          await tx.insert(pot).values({ id: 1 });
        }

        await tx
          .update(pot)
          .set({
            potTokenAmount: sql`${pot.potTokenAmount} + ${pool}`,
            treasuryTokenAmount: sql`${pot.treasuryTokenAmount} + ${treasury}`,
            totalEntries: sql`${pot.totalEntries} + 1`,
            updatedAt: new Date()
          })
          .where(eq(pot.id, 1));
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "ticket_status_changed") {
        return conflict("ticket_status_changed", "Ticket was already processed");
      }
      if (msg.includes("tickets_payment_sig_uniq")) {
        return conflict("signature_already_used");
      }
      throw e;
    }

    await invalidatePotCache();

    return ok({
      ticket: {
        id: ticketId,
        status: "confirmed",
        paymentSignature: signature,
        paymentSlot: result.slot.toString(),
        paidTokenAmount: result.amountRaw.toString()
      }
    });
  }
);
