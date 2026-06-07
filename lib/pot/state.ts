import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { pot } from "@/lib/db/schema";
import { getRedis, KV } from "@/lib/kv/client";

export type PotSnapshot = {
  epoch: number;
  allTimeHighScore: number;
  allTimeHighWallet: string | null;
  // Pot tokens that winners can take
  potTokenAmount: string;
  // Treasury reserve (your buyback/burn fund)
  treasuryTokenAmount: string;
  totalEntries: number;
  lastSettlementId: string | null;
  updatedAt: string;
};

export async function ensurePotRow(): Promise<void> {
  const rows = await db.select().from(pot).where(eq(pot.id, 1)).limit(1);
  if (rows.length === 0) {
    await db.insert(pot).values({ id: 1 });
  }
}

export async function getPotSnapshot(): Promise<PotSnapshot> {
  try {
    const cached = await getRedis().get<PotSnapshot>(KV.potSnapshot());
    if (cached) return cached;
  } catch {
    // ignore
  }

  await ensurePotRow();
  const [row] = await db.select().from(pot).where(eq(pot.id, 1)).limit(1);
  if (!row) throw new Error("pot_row_missing");

  const snap: PotSnapshot = {
    epoch: row.epoch,
    allTimeHighScore: row.allTimeHighScore,
    allTimeHighWallet: row.allTimeHighWallet,
    potTokenAmount: row.potTokenAmount.toString(),
    treasuryTokenAmount: row.treasuryTokenAmount.toString(),
    totalEntries: row.totalEntries,
    lastSettlementId: row.lastSettlementId,
    updatedAt: row.updatedAt.toISOString()
  };

  try {
    await getRedis().set(KV.potSnapshot(), snap, { ex: 5 });
  } catch {
    // ignore
  }

  return snap;
}

export async function invalidatePotCache(): Promise<void> {
  try {
    await getRedis().del(KV.potSnapshot());
  } catch {
    // ignore
  }
}
