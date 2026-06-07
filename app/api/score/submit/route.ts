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
import { simulateRun, getVariantConfig, seedForLife } from "@/lib/game/simulator";
import { settleIfNewHigh } from "@/lib/pot/settle";

const Body = z.object({
  ticketId: z.string().min(8).max(32),
  taps: z.array(z.number().int().min(0).max(100_000)).max(20_000),
  // Which life inside the multi-life ticket this submission represents.
  // Must equal ticket.livesUsed (sequential — life 0 first, then 1, etc.).
  // Defaults to 0 for backwards-compatible single-life flows.
  lifeIndex: z.number().int().min(0).max(99).default(0)
});

export const runtime = "nodejs";

export const POST = route(
  {
    auth: true,
    rateLimit: { scope: "score_submit", limit: 60, windowSec: 60 }
  },
  async (req, ctx) => {
    const wallet = ctx.session!.sub;
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("invalid_body", parsed.error.message);
    const { ticketId, taps, lifeIndex } = parsed.data;

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

    // Lives gating — life index must equal current livesUsed (sequential),
    // and must be inside the bundle.
    if (lifeIndex !== ticket.livesUsed) {
      return conflict(
        "life_out_of_order",
        `Expected lifeIndex=${ticket.livesUsed}, got ${lifeIndex}`
      );
    }
    if (lifeIndex >= ticket.livesTotal) {
      return conflict("lives_exhausted", `Ticket has ${ticket.livesTotal} lives`);
    }

    // Min play duration only applies to the FIRST life of a multi-life
    // ticket — subsequent lives don't have a fresh "confirmedAt" anchor
    // and would all fail. We instead rely on the per-life tap-density check.
    if (lifeIndex === 0) {
      const minMs = Number.parseInt(process.env.MIN_PLAY_DURATION_MS ?? "2000", 10);
      if (
        ticket.confirmedAt &&
        Date.now() - ticket.confirmedAt.getTime() < minMs
      ) {
        return bad("too_fast", "Score submitted too quickly after confirmation");
      }
    }

    // Anti-cheat: max taps per second
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

    // Authoritative replay using the LIFE-SPECIFIC seed so each life has its
    // own pipe sequence.
    const lifeSeed = seedForLife(ticket.seed, lifeIndex);
    const result = simulateRun({
      variant: ticket.variant,
      seed: lifeSeed,
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
    let isLastLife = false;
    try {
      await db.transaction(async (tx) => {
        // Lock ticket; re-check life ordering inside the tx to defeat races
        const [t] = await tx
          .select()
          .from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.status, "confirmed")))
          .for("update")
          .limit(1);
        if (!t) {
          throw new Error("ticket_already_played");
        }
        if (t.livesUsed !== lifeIndex) {
          throw new Error("life_race");
        }

        const [potRow] = await tx.select().from(pot).where(eq(pot.id, 1)).limit(1);
        const epoch = potRow?.epoch ?? 1;

        await tx.insert(scores).values({
          id: scoreId,
          ticketId,
          wallet,
          variant: ticket.variant,
          seed: lifeSeed,
          score: result.score,
          ticks: result.ticks,
          tapsCount: result.taps.length,
          checksum: result.checksum,
          taps: result.taps,
          epoch,
          lifeIndex
        });

        const nextUsed = lifeIndex + 1;
        isLastLife = nextUsed >= t.livesTotal;
        await tx
          .update(tickets)
          .set({
            livesUsed: nextUsed,
            status: isLastLife ? "played" : "confirmed",
            playedAt: isLastLife ? new Date() : t.playedAt
          })
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
      if (msg === "ticket_already_played") {
        return conflict("ticket_already_played");
      }
      if (msg === "life_race") {
        return conflict("life_race", "Concurrent submission detected");
      }
      if (msg.includes("scores_ticket_life_uniq")) {
        return conflict("life_already_submitted");
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
      lifeIndex,
      livesRemaining: Math.max(0, ticket.livesTotal - (lifeIndex + 1)),
      lastLife: isLastLife,
      settlement
    });
  }
);
