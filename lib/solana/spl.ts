// SPL Token helpers — manual instruction builders so we don't pull in
// @solana/spl-token (heavy + version churn). Only the small subset we need.

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction
} from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
// pump.fun mints tokens under Token-2022, NOT the classic token program.
// Verified 2026-08-31 against three live pump.fun mints: all owned by
// TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb. Their only extensions are
// MetadataPointer and TokenMetadata, so there is no transfer fee and no
// transfer hook: TransferChecked behaves exactly as it does on the classic
// program, and the amount the treasury receives equals the amount sent.
//
// The program id is part of the ATA derivation seeds, so getting this wrong
// does not fail loudly, it silently derives a DIFFERENT address and every
// payment lands nowhere. That is why `npm run launch` reads the mint owner
// off chain and refuses to proceed when it disagrees with this setting.
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

/**
 * Which token program the PUMPBIRD mint lives under.
 * `PUMPBIRD_TOKEN_PROGRAM=legacy` selects the classic program; anything else
 * (including unset) selects Token-2022, because that is what pump.fun issues.
 */
export function getTokenProgramId(): PublicKey {
  return process.env.PUMPBIRD_TOKEN_PROGRAM === "legacy"
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;
}
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

// Anchor-style discriminator-less SPL instruction codes
const IX_TRANSFER = 3;
const IX_TRANSFER_CHECKED = 12;

export function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId: PublicKey = getTokenProgramId()
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgramId.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return pda;
}

export function createAssociatedTokenAccountInstruction(input: {
  payer: PublicKey;
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgramId?: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.ata, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      {
        pubkey: input.tokenProgramId ?? getTokenProgramId(),
        isSigner: false,
        isWritable: false
      }
    ],
    // discriminator 1 = CreateIdempotent, so running this twice is harmless
    data: Buffer.from([1])
  });
}

export function createTransferCheckedInstruction(input: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
  tokenProgramId?: PublicKey;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 8 + 1);
  data.writeUInt8(IX_TRANSFER_CHECKED, 0);
  data.writeBigUInt64LE(input.amount, 1);
  data.writeUInt8(input.decimals, 9);

  return new TransactionInstruction({
    programId: input.tokenProgramId ?? getTokenProgramId(),
    keys: [
      { pubkey: input.source, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false }
    ],
    data
  });
}

export function createMemoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8")
  });
}

export { IX_TRANSFER, IX_TRANSFER_CHECKED };
