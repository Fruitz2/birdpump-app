// Client-side SPL transfer tx builder used by the paid game flow.
// The wallet (user) is the signer. Phantom fills in recent blockhash on send.

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram
} from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

export function getAtaAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return pda;
}

function createAtaIdempotentIx(input: {
  payer: PublicKey;
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.ata, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: Buffer.from([1]) // create idempotent
  });
}

function createTransferCheckedIx(input: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
}): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // TransferChecked
  data.writeBigUInt64LE(input.amount, 1);
  data.writeUInt8(input.decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.source, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false }
    ],
    data
  });
}

function createMemoIx(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8")
  });
}

export type BuildEntryTxInput = {
  wallet: string;        // base58
  tokenMint: string;     // base58
  treasuryAta: string;   // base58 destination ATA
  amountRaw: bigint;     // raw token units
  decimals: number;
  memo: string;
  priorityFeeMicroLamports?: number;
};

// Build a transaction that:
//  1. (optionally) creates the user's PUMPBIRD ATA if missing
//  2. transfers `amountRaw` from user ATA -> treasury ATA
//  3. attaches the ticket memo
//
// Phantom will set recentBlockhash + send.
export function buildEntryTransaction(input: BuildEntryTxInput): Transaction {
  const wallet = new PublicKey(input.wallet);
  const mint = new PublicKey(input.tokenMint);
  const treasuryAta = new PublicKey(input.treasuryAta);
  const userAta = getAtaAddress(mint, wallet);

  const tx = new Transaction();

  // Priority fee — keeps the tx near the top under congestion
  const priority = input.priorityFeeMicroLamports ?? 25_000;
  if (priority > 0) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority })
    );
  }

  // Always include create-idempotent for the user ATA. It's a no-op if it
  // already exists and ~0.002 SOL cost otherwise.
  tx.add(
    createAtaIdempotentIx({
      payer: wallet,
      ata: userAta,
      owner: wallet,
      mint
    })
  );

  tx.add(
    createTransferCheckedIx({
      source: userAta,
      mint,
      destination: treasuryAta,
      owner: wallet,
      amount: input.amountRaw,
      decimals: input.decimals
    })
  );

  tx.add(createMemoIx(input.memo, wallet));

  tx.feePayer = wallet;
  return tx;
}
