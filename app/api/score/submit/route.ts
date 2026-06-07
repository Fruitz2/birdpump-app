import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { route } from "@/lib/http/middleware";
import {
  ok,
  bad,
  conflict,
  notFound,
  forbidden
} from "@/lib/http/response";
import { db } from "@/lib/db/client";
import { scores, tickets, users, pot } from "@/lib/db/schema";
import { simulateRun, getVariantConfig } from "@/lib/game/simulator";
import { settleIfNewHigh } from "@/lib/pot/settle";

const Body = z.object({
  ticketId: z.string().min(8).max(32),
  taps: z.array(z.number().int().min(0).max(100_000)).max(20_000)
});

export const runtime = "nodejs";

export const POST = route(
  {
    auth: true,
    rateLimit: { scope: "score_submit", limit: 30, windowSec: 60 }
  },
  async (req, ctx) => {
    const wallet = ctx.session!.sub;
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("invalid_body", parsed.error.message);
    const { ticketId, taps } = parsed.data;

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (!ticket) return notFound("ticket_not_found");
    if (ticket.wallet !== wallet) return forbidden("ticket_wallet_mismatch");
    if (ticket.status !== "confirmed") {
      return conflict("ticket_not_confirmed", `Ticket is ${ticket.status}`);
    }

    // Min play duration — block instant-submit cheats
    const minMs = Number.parseInt(process.env.MIN_PLAY_DURATION_MS ?? "2000", 10);
    if (
      ticket.confirmedAt &&
      Date.now() - ticket.confirmedAt.getTime() < minMs
    ) {
      return bad("too_fast", "Score submitted too quickly after confirmation");
    }

    // Anti-cheat: max taps per second across the run
    const variantConfig = getVariantConfig(ticket.variant);
    const maxTps = Number.parseInt(process.env.MAX_TAPS_PER_SECOND ?? "40", 10);
    if (taps.length > 0) {
      const sortedTaps = [...taps].sort((a, b) => a - b);
      let densestTps = 0;
      const ticksPerSec = Math.round(1000 / variantConfig.tickMs);
      for (let i = 0; i < sortedTaps.length; i += 1) {
        const windowEnd = sortedTaps[i] + ticksPerSec;
        let j = i;
        while (j < sortedTaps.length && sortedTaps[j] <= windowEnd) j += 1;
        const tps = j - i;
        if (tps > densestTps) densestTps = tps;
      }
      if (densestTps > maxTps) {
        return bad("tap_density_exceeded", `peak ${densestTps} taps/sec`);
      }
    }

    // Authoritative replay
    const result = simulateRun({
      variant: ticket.variant,
      seed: ticket.seed,
      taps
    });

    const maxScore = Number.parseInt(
      process.env.MAX_PLAUSIBLE_SCORE ?? "500",
      10
    );
    if (result.score > maxScore) {
      return bad("score_implausible", `${result.score} > ${maxScore}`);
    }

    const scoreId = nanoid(24);

    let inserted = false;
    try {
      await db.transaction(async (tx) => {
        // Lock ticket — must still be confirmed
        const [t] = await tx
          .select()
          .from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.status, "confirmed")))
          .for("update")
          .limit(1);
        if (!t) {
          throw new Error("ticket_already_played");
        }

        const [potRow] = await tx.select().from(pot).where(eq(pot.id, 1)).limit(1);
        const epoch = potRow?.epoch ?? 1;

        await tx.insert(scores).values({
          id: scoreId,
          ticketId,
          wallet,
          variant: ticket.variant,
          seed: ticket.seed,
          score: result.score,
          ticks: result.ticks,
          tapsCount: result.taps.length,
          checksum: result.checksum,
          taps: result.taps,
          epoch
        });

        await tx
          .update(tickets)
          .set({ status: "played", playedAt: new Date() })
          .where(eq(tickets.id, ticketId));

        await tx
          .update(users)
          .set({
            bestScore: sql`GREATEST(${users.bestScore}, ${result.score})`,
            totalPlays: sql`${users.totalPlays} + 1`,
            lastSeenAt: new Date()
          })
          .where(eq(users.wallet, wallet));
        inserted = true;
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "ticket_already_played" || msg.includes("scores_ticket_uniq")) {
        return conflict("ticket_already_played");
      }
      throw e;
    }

    let settlement: Awaited<ReturnType<typeof settleIfNewHigh>> | null = null;
    if (inserted) {
      settlement = await settleIfNewHigh(scoreId);
    }

    return ok({
      scoreId,
      score: result.score,
      ticks: result.ticks,
      tapsCount: result.taps.length,
      checksum: result.checksum,
      settlement
    });
  }
);
