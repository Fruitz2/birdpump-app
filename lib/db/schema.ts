import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar
} from "drizzle-orm/pg-core";

// =============================================================================
// Enums
// =============================================================================
export const ticketStatus = pgEnum("ticket_status", [
  "pending",
  "confirmed",
  "played",
  "expired",
  "mispaid",
  "refunded"
]);

export const settlementStatus = pgEnum("settlement_status", [
  "pending",
  "sent",
  "confirmed",
  "failed"
]);

export const variantEnum = pgEnum("variant", ["forked", "custom"]);

// =============================================================================
// Users — one row per wallet
// =============================================================================
export const users = pgTable(
  "users",
  {
    wallet: varchar("wallet", { length: 44 }).primaryKey(),
    displayName: varchar("display_name", { length: 24 }),
    avatarId: varchar("avatar_id", { length: 64 }),
    bestScore: integer("best_score").default(0).notNull(),
    totalPlays: integer("total_plays").default(0).notNull(),
    totalWonTokens: bigint("total_won_tokens", { mode: "bigint" })
      .default(0n)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (t) => ({
    bestScoreIdx: index("users_best_score_idx").on(t.bestScore)
  })
);

// =============================================================================
// Entry tickets — one row per game play
// Quote is bound: entry_token_amount is the target, plus min/max for slippage.
// =============================================================================
export const tickets = pgTable(
  "tickets",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    wallet: varchar("wallet", { length: 44 })
      .notNull()
      .references(() => users.wallet, { onDelete: "cascade" }),
    variant: variantEnum("variant").notNull(),
    seed: varchar("seed", { length: 128 }).notNull(),
    memo: varchar("memo", { length: 32 }).notNull(),
    entryUsdCents: integer("entry_usd_cents").notNull(),
    entryTokenAmount: bigint("entry_token_amount", { mode: "bigint" }).notNull(),
    minTokenAmount: bigint("min_token_amount", { mode: "bigint" }).notNull(),
    maxTokenAmount: bigint("max_token_amount", { mode: "bigint" }).notNull(),
    tokenUsdMicros: bigint("token_usd_micros", { mode: "bigint" }).notNull(),
    quoteExpiresAt: timestamp("quote_expires_at", { withTimezone: true }).notNull(),
    status: ticketStatus("status").default("pending").notNull(),
    paymentSignature: varchar("payment_signature", { length: 128 }),
    paymentSlot: bigint("payment_slot", { mode: "bigint" }),
    paidTokenAmount: bigint("paid_token_amount", { mode: "bigint" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    playedAt: timestamp("played_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Multi-life pack: a single payment unlocks `livesTotal` games. Each
    // game uses a deterministic seed derived from ticket.seed + the
    // life's index. livesUsed increments on every score submit.
    livesTotal: integer("lives_total").default(1).notNull(),
    livesUsed: integer("lives_used").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (t) => ({
    walletIdx: index("tickets_wallet_idx").on(t.wallet),
    statusIdx: index("tickets_status_idx").on(t.status),
    memoUniq: uniqueIndex("tickets_memo_uniq").on(t.memo),
    sigUniq: uniqueIndex("tickets_payment_sig_uniq").on(t.paymentSignature)
  })
);

// =============================================================================
// Score submissions
// =============================================================================
export const scores = pgTable(
  "scores",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    ticketId: varchar("ticket_id", { length: 32 })
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    wallet: varchar("wallet", { length: 44 })
      .notNull()
      .references(() => users.wallet, { onDelete: "cascade" }),
    variant: variantEnum("variant").notNull(),
    seed: varchar("seed", { length: 128 }).notNull(),
    score: integer("score").notNull(),
    ticks: integer("ticks").notNull(),
    tapsCount: integer("taps_count").notNull(),
    checksum: varchar("checksum", { length: 16 }).notNull(),
    taps: jsonb("taps").$type<number[]>().notNull(),
    epoch: integer("epoch").notNull(),
    winSettlementId: varchar("win_settlement_id", { length: 32 }),
    // Index of this life within its multi-life ticket (0 for single-life).
    lifeIndex: integer("life_index").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (t) => ({
    walletIdx: index("scores_wallet_idx").on(t.wallet),
    epochScoreIdx: index("scores_epoch_score_idx").on(t.epoch, t.score),
    leaderboardIdx: index("scores_leaderboard_idx").on(t.score, t.ticks),
    // One score per (ticket, life) — a multi-life ticket can have many
    // scores but each life can only be submitted once.
    ticketLifeUniq: uniqueIndex("scores_ticket_life_uniq").on(t.ticketId, t.lifeIndex)
  })
);

// =============================================================================
// Pot — single-row table tracking current pot state
// =============================================================================
export const pot = pgTable("pot", {
  id: integer("id").primaryKey().default(1),
  epoch: integer("epoch").default(1).notNull(),
  allTimeHighScore: integer("all_time_high_score").default(0).notNull(),
  allTimeHighWallet: varchar("all_time_high_wallet", { length: 44 }),
  // Game pot — what winners take. 75% of every entry accumulates here.
  potTokenAmount: bigint("pot_token_amount", { mode: "bigint" }).default(0n).notNull(),
  // Buyback/burn reserve — what stays in treasury. 25% of every entry.
  treasuryTokenAmount: bigint("treasury_token_amount", { mode: "bigint" })
    .default(0n)
    .notNull(),
  totalEntries: integer("total_entries").default(0).notNull(),
  lastSettlementId: varchar("last_settlement_id", { length: 32 }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
});

// =============================================================================
// Settlements
// =============================================================================
export const settlements = pgTable(
  "settlements",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    epoch: integer("epoch").notNull(),
    winnerWallet: varchar("winner_wallet", { length: 44 }).notNull(),
    winningScore: integer("winning_score").notNull(),
    previousHigh: integer("previous_high").notNull(),
    payoutTokenAmount: bigint("payout_token_amount", { mode: "bigint" }).notNull(),
    payoutSignature: varchar("payout_signature", { length: 128 }),
    payoutSlot: bigint("payout_slot", { mode: "bigint" }),
    status: settlementStatus("status").default("pending").notNull(),
    error: text("error"),
    triggerScoreId: varchar("trigger_score_id", { length: 32 })
      .notNull()
      .references(() => scores.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true })
  },
  (t) => ({
    winnerIdx: index("settlements_winner_idx").on(t.winnerWallet),
    statusIdx: index("settlements_status_idx").on(t.status),
    epochIdx: index("settlements_epoch_idx").on(t.epoch)
  })
);

// =============================================================================
// SIWS nonces
// =============================================================================
export const authNonces = pgTable(
  "auth_nonces",
  {
    nonce: varchar("nonce", { length: 64 }).primaryKey(),
    wallet: varchar("wallet", { length: 44 }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true })
  },
  (t) => ({
    walletIdx: index("auth_nonces_wallet_idx").on(t.wallet)
  })
);

// =============================================================================
// Treasury snapshots — periodic monitoring
// =============================================================================
export const treasurySnapshots = pgTable("treasury_snapshots", {
  id: varchar("id", { length: 32 }).primaryKey(),
  solLamports: bigint("sol_lamports", { mode: "bigint" }).notNull(),
  tokenAmount: bigint("token_amount", { mode: "bigint" }).notNull(),
  potTokenAmount: bigint("pot_token_amount", { mode: "bigint" }).notNull(),
  treasuryTokenAmount: bigint("treasury_token_amount", { mode: "bigint" }).notNull(),
  gasLow: boolean("gas_low").default(false).notNull(),
  tokenAccountingDrift: boolean("token_accounting_drift")
    .default(false)
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull()
});

export const POT_INIT_SQL = sql`
INSERT INTO pot (id, epoch, all_time_high_score, pot_token_amount, treasury_token_amount, total_entries)
VALUES (1, 1, 0, 0, 0, 0)
ON CONFLICT (id) DO NOTHING;
`;
