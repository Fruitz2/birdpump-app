// Verify an SPL token transfer of PUMPBIRD from a player to the treasury ATA.
//
// We use the parsed transaction's tokenBalances to compute the exact delta to
// the treasury ATA — this catches any combination of SPL ix variants (Transfer,
// TransferChecked, multi-hop, even routed through a separate signer if the
// player was the only signer). Then we check the wallet signed the tx and the
// memo matches.

import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./connection";
import { getTokenMint, getTreasuryAta } from "./treasury";

const MEMO_PROGRAM_IDS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"
]);

export type SplVerifyResult =
  | {
      ok: true;
      amountRaw: bigint;
      slot: bigint;
      memo: string;
    }
  | { ok: false; reason: string };

export async function verifyPumpBirdPayment(input: {
  signature: string;
  walletAddress: string;
  expectedMemo: string;
  minAmount: bigint;
  maxAmount: bigint;
  maxAgeSeconds?: number;
}): Promise<SplVerifyResult> {
  const conn = getConnection("confirmed");

  let mint: PublicKey;
  let treasuryAta: PublicKey;
  try {
    mint = getTokenMint();
    treasuryAta = getTreasuryAta();
  } catch (e) {
    return { ok: false, reason: `config:${(e as Error).message}` };
  }

  let wallet: PublicKey;
  try {
    wallet = new PublicKey(input.walletAddress);
  } catch {
    return { ok: false, reason: "invalid_wallet_address" };
  }

  let tx;
  try {
    tx = await conn.getParsedTransaction(input.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });
  } catch (e) {
    return { ok: false, reason: `rpc_error:${(e as Error).message}` };
  }

  if (!tx) return { ok: false, reason: "transaction_not_found" };
  if (tx.meta?.err) return { ok: false, reason: "transaction_failed" };

  if (input.maxAgeSeconds && tx.blockTime) {
    const ageSec = Date.now() / 1000 - tx.blockTime;
    if (ageSec > input.maxAgeSeconds) {
      return { ok: false, reason: "transaction_too_old" };
    }
  }

  // Confirm wallet signed (fee payer = wallet, by convention)
  const signers = tx.transaction.message.accountKeys
    .filter((k) => k.signer)
    .map((k) => k.pubkey.toBase58());
  if (!signers.includes(wallet.toBase58())) {
    return { ok: false, reason: "wallet_not_signer" };
  }

  // Find treasury ATA balance delta for the PUMPBIRD mint
  const treasuryStr = treasuryAta.toBase58();
  const mintStr = mint.toBase58();

  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  // The account index is over tx.transaction.message.accountKeys
  const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const treasuryIdx = accountKeys.indexOf(treasuryStr);
  if (treasuryIdx === -1) {
    return { ok: false, reason: "treasury_ata_not_in_tx" };
  }

  const preEntry = pre.find(
    (b) => b.accountIndex === treasuryIdx && b.mint === mintStr
  );
  const postEntry = post.find(
    (b) => b.accountIndex === treasuryIdx && b.mint === mintStr
  );

  if (!postEntry) {
    return { ok: false, reason: "treasury_post_balance_missing" };
  }

  const preRaw = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
  const postRaw = BigInt(postEntry.uiTokenAmount.amount);
  const delta = postRaw - preRaw;

  if (delta < input.minAmount) {
    return { ok: false, reason: `amount_too_low:got=${delta}` };
  }
  if (delta > input.maxAmount) {
    return { ok: false, reason: `amount_too_high:got=${delta}` };
  }

  // Find memo
  let memoFound = false;
  let observedMemo = "";
  for (const ix of tx.transaction.message.instructions ?? []) {
    const programId =
      "programId" in ix && ix.programId ? ix.programId.toBase58() : undefined;
    if (programId && MEMO_PROGRAM_IDS.has(programId)) {
      if ("parsed" in ix && typeof ix.parsed === "string") {
        observedMemo = ix.parsed;
      } else if ("data" in ix && typeof ix.data === "string") {
        observedMemo = ix.data;
      }
      if (observedMemo === input.expectedMemo) {
        memoFound = true;
        break;
      }
    }
  }
  if (!memoFound) {
    return { ok: false, reason: `memo_mismatch:got=${observedMemo}` };
  }

  return {
    ok: true,
    amountRaw: delta,
    slot: BigInt(tx.slot ?? 0),
    memo: observedMemo
  };
}
