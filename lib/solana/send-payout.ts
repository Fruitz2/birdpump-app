// SPL token payout from treasury ATA → winner ATA.
// Creates the winner's ATA if it doesn't exist (treasury pays the ~0.002 SOL rent).

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  sendAndConfirmRawTransaction
} from "@solana/web3.js";
import { getConnection } from "./connection";
import {
  getTokenDecimals,
  getTokenMint,
  getTreasuryAddress,
  getTreasuryAta,
  getTreasuryKeypair
} from "./treasury";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress
} from "./spl";

const PRIORITY_FEE_MICROLAMPORTS = 50_000;
const COMPUTE_UNIT_LIMIT = 200_000;

export type SplPayoutResult =
  | { ok: true; signature: string; slot: bigint; createdAta: boolean }
  | { ok: false; reason: string };

/**
 * Can the treasury actually complete a payout of `amountRaw` right now?
 *
 * This exists because settlement zeroes the pot and advances the epoch inside
 * a database transaction BEFORE the transfer is attempted. If the transfer
 * then fails, the pot is gone from the ledger and the winner has nothing. The
 * cheapest failure to cause is an empty treasury: signing costs SOL, and
 * creating the winner's token account costs about 0.002 SOL of rent on top.
 *
 * So the settlement path calls this first and refuses to settle at all when it
 * returns false. Nothing is lost, the record stands, and the payout can be
 * completed once the treasury is funded.
 */
export async function canPayout(input: {
  toWallet: string;
  amountRaw: bigint;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const conn = getConnection("confirmed");

  let recipient: PublicKey;
  try {
    recipient = new PublicKey(input.toWallet);
  } catch {
    return { ok: false, reason: "invalid_recipient" };
  }

  const treasuryOwner = getTreasuryAddress();
  const mint = getTokenMint();
  const recipientAta = getAssociatedTokenAddress(mint, recipient);

  const [lamports, treasuryAtaBal, recipientAtaInfo] = await Promise.all([
    conn.getBalance(treasuryOwner, "confirmed").catch(() => null),
    conn.getTokenAccountBalance(getTreasuryAta(), "confirmed").catch(() => null),
    conn.getAccountInfo(recipientAta, "confirmed").catch(() => null)
  ]);

  if (lamports === null) return { ok: false, reason: "rpc_unavailable" };
  if (!treasuryAtaBal) return { ok: false, reason: "treasury_ata_missing" };

  const held = BigInt(treasuryAtaBal.value.amount);
  if (held < input.amountRaw) {
    return { ok: false, reason: `insufficient_treasury_tokens:${held}<${input.amountRaw}` };
  }

  // Signature plus priority fee, and the winner's token account rent when it
  // does not exist yet. Rounded up generously: refusing a payout we could just
  // afford is recoverable, attempting one we cannot is not.
  const RENT_LAMPORTS = 2_100_000;
  const FEE_LAMPORTS = 200_000;
  const needed = FEE_LAMPORTS + (recipientAtaInfo ? 0 : RENT_LAMPORTS);
  if (lamports < needed) {
    return {
      ok: false,
      reason: `insufficient_treasury_sol:${lamports}<${needed}`
    };
  }

  return { ok: true };
}

export async function sendPumpBirdPayout(input: {
  toWallet: string;
  amountRaw: bigint;
}): Promise<SplPayoutResult> {
  if (input.amountRaw <= 0n) {
    return { ok: false, reason: "zero_amount" };
  }

  let recipient: PublicKey;
  try {
    recipient = new PublicKey(input.toWallet);
  } catch {
    return { ok: false, reason: "invalid_recipient" };
  }

  const conn = getConnection("confirmed");
  const treasury = getTreasuryKeypair();
  const mint = getTokenMint();
  const decimals = getTokenDecimals();
  const treasuryAta = getTreasuryAta();
  const recipientAta = getAssociatedTokenAddress(mint, recipient);

  // Check treasury ATA has enough
  let treasuryBalance: bigint;
  try {
    const r = await conn.getTokenAccountBalance(treasuryAta, "confirmed");
    treasuryBalance = BigInt(r.value.amount);
  } catch {
    return { ok: false, reason: "treasury_ata_missing" };
  }
  if (treasuryBalance < input.amountRaw) {
    return {
      ok: false,
      reason: `insufficient_treasury_tokens:${treasuryBalance}`
    };
  }

  // Build tx
  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICROLAMPORTS
    })
  );

  // Create recipient ATA if missing
  const recipientAtaInfo = await conn.getAccountInfo(recipientAta, "confirmed");
  let createdAta = false;
  if (!recipientAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction({
        payer: getTreasuryAddress(),
        ata: recipientAta,
        owner: recipient,
        mint
      })
    );
    createdAta = true;
  }

  tx.add(
    createTransferCheckedInstruction({
      source: treasuryAta,
      mint,
      destination: recipientAta,
      owner: getTreasuryAddress(),
      amount: input.amountRaw,
      decimals
    })
  );

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = getTreasuryAddress();
  tx.sign(treasury);

  const raw = tx.serialize();
  try {
    const sig = await sendAndConfirmRawTransaction(
      conn,
      raw,
      {
        commitment: "confirmed",
        skipPreflight: false,
        maxRetries: 3,
        blockhash,
        lastValidBlockHeight
      } as Parameters<typeof sendAndConfirmRawTransaction>[2]
    );

    const status = await conn.getSignatureStatus(sig, {
      searchTransactionHistory: false
    });
    const slot = status.value?.slot ?? 0;

    return { ok: true, signature: sig, slot: BigInt(slot), createdAta };
  } catch (e) {
    return { ok: false, reason: `send_failed:${(e as Error).message}` };
  }
}
