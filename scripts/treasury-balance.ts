// Inspect live treasury state. Run: npm run treasury:balance

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import {
  getTreasuryAddress,
  getTreasuryAta,
  getTreasuryBalances,
  getTokenDecimals
} from "@/lib/solana/treasury";
import { db } from "@/lib/db/client";
import { pot } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { rawToDisplay } from "@/lib/price/pumpbird";

async function main() {
  const owner = getTreasuryAddress().toBase58();
  const ata = getTreasuryAta().toBase58();
  const balances = await getTreasuryBalances();
  const decimals = getTokenDecimals();

  console.log(`Treasury wallet: ${owner}`);
  console.log(`Treasury ATA:    ${ata}`);
  console.log(`SOL balance:     ${balances.solDisplay} SOL`);
  console.log(
    `PUMPBIRD ATA:    ${balances.tokenAtaExists ? "exists" : "MISSING — will be created on first deposit"}`
  );
  console.log(
    `PUMPBIRD balance: ${rawToDisplay(balances.tokenRawAmount, decimals)} (raw: ${balances.tokenRawAmount})`
  );

  try {
    const [row] = await db.select().from(pot).where(eq(pot.id, 1)).limit(1);
    if (row) {
      console.log("");
      console.log("DB accounting:");
      console.log(`  Epoch:           ${row.epoch}`);
      console.log(`  All-time high:   ${row.allTimeHighScore} (${row.allTimeHighWallet ?? "—"})`);
      console.log(`  Pot:             ${rawToDisplay(row.potTokenAmount, decimals)} PUMPBIRD`);
      console.log(`  Treasury reserve: ${rawToDisplay(row.treasuryTokenAmount, decimals)} PUMPBIRD`);
      console.log(`  Total entries:   ${row.totalEntries}`);

      const expected = row.potTokenAmount + row.treasuryTokenAmount;
      const drift = balances.tokenRawAmount - expected;
      console.log("");
      console.log(`  On-chain:  ${balances.tokenRawAmount} raw`);
      console.log(`  Expected:  ${expected} raw`);
      console.log(`  Drift:     ${drift} raw`);
    } else {
      console.log("(no pot row — hit /api/pot once to seed)");
    }
  } catch (e) {
    console.warn("DB unavailable:", (e as Error).message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
