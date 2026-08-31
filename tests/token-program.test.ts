import { describe, it, expect, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getTokenProgramId,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
} from "@/lib/solana/spl";
import { getAtaAddress, tokenProgramFromName } from "@/lib/client/entry-tx";
import { deriveBondingCurvePda } from "@/lib/solana/pumpfun";

// Ground truth, read off mainnet on 2026-08-31.
//
// 4U4U…pump is a real pump.fun mint. Its account is owned by the Token-2022
// program, so its associated token accounts derive with TOKEN_2022_PROGRAM_ID
// in the seeds. The bonding curve PDA's ATA below was fetched with
// getParsedAccountInfo and came back owned by the Token-2022 program, with
// `owner` equal to the curve PDA and `mint` equal to the mint.
//
// The legacy-derived address is included deliberately: it does NOT exist on
// chain. Before the Token-2022 fix, every player payment was built against
// that address, which is why this test exists at all. A transfer to a
// non-existent account does not warn, it just fails, and the money never
// arrives where the confirm route is looking for it.
const MINT = new PublicKey("4U4U8oXwDyVXGeTffMXds4NAgBgLFwq3wNvTCRTSpump");
const CURVE_PDA = "87QyZiHAmVNe3Q2dKK7RqYfg4N5NoGzQM6Bq19y1X8QC";
const ATA_TOKEN2022 = "DXEdBCjqoMozfbPUV1huD1Gzf7MyUUY8miCGCbNnGExP"; // exists on chain
const ATA_LEGACY = "3U1EKuvs348FDA2Uq5G9JRpZLXAFyALYWdZ62cbhshGi"; // does not exist

const ORIGINAL = process.env.PUMPBIRD_TOKEN_PROGRAM;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PUMPBIRD_TOKEN_PROGRAM;
  else process.env.PUMPBIRD_TOKEN_PROGRAM = ORIGINAL;
});

describe("bonding curve PDA", () => {
  it("derives the curve address mainnet actually uses", () => {
    expect(deriveBondingCurvePda(MINT).toBase58()).toBe(CURVE_PDA);
  });
});

describe("associated token address derivation", () => {
  const curve = new PublicKey(CURVE_PDA);

  it("matches the real on-chain Token-2022 ATA", () => {
    expect(getAssociatedTokenAddress(MINT, curve, TOKEN_2022_PROGRAM_ID).toBase58()).toBe(
      ATA_TOKEN2022
    );
  });

  it("defaults to Token-2022, because that is what pump.fun mints", () => {
    delete process.env.PUMPBIRD_TOKEN_PROGRAM;
    expect(getAssociatedTokenAddress(MINT, curve).toBase58()).toBe(ATA_TOKEN2022);
  });

  it("still derives the classic address when explicitly asked", () => {
    expect(getAssociatedTokenAddress(MINT, curve, TOKEN_PROGRAM_ID).toBase58()).toBe(ATA_LEGACY);
  });

  it("the two programs derive genuinely different addresses", () => {
    expect(ATA_TOKEN2022).not.toBe(ATA_LEGACY);
  });

  it("the browser builder derives the same address as the server", () => {
    expect(getAtaAddress(MINT, curve).toBase58()).toBe(
      getAssociatedTokenAddress(MINT, curve, TOKEN_2022_PROGRAM_ID).toBase58()
    );
    expect(getAtaAddress(MINT, curve, tokenProgramFromName("legacy")).toBase58()).toBe(
      getAssociatedTokenAddress(MINT, curve, TOKEN_PROGRAM_ID).toBase58()
    );
  });
});

describe("token program selection", () => {
  it("defaults to Token-2022 when unset", () => {
    delete process.env.PUMPBIRD_TOKEN_PROGRAM;
    expect(getTokenProgramId().toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it("selects the classic program only for the exact string 'legacy'", () => {
    process.env.PUMPBIRD_TOKEN_PROGRAM = "legacy";
    expect(getTokenProgramId().toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    process.env.PUMPBIRD_TOKEN_PROGRAM = "token2022";
    expect(getTokenProgramId().toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    process.env.PUMPBIRD_TOKEN_PROGRAM = "";
    expect(getTokenProgramId().toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it("client name mapping agrees with the server", () => {
    expect(tokenProgramFromName(undefined).toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(tokenProgramFromName(null).toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(tokenProgramFromName("token2022").toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(tokenProgramFromName("legacy").toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});

describe("instructions target the right program", () => {
  const owner = new PublicKey(CURVE_PDA);

  it("transferChecked is built against Token-2022 by default", () => {
    delete process.env.PUMPBIRD_TOKEN_PROGRAM;
    const ix = createTransferCheckedInstruction({
      source: new PublicKey(ATA_TOKEN2022),
      mint: MINT,
      destination: new PublicKey(ATA_TOKEN2022),
      owner,
      amount: 1_000_000n,
      decimals: 6
    });
    expect(ix.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    // discriminator 12 = TransferChecked, then u64 amount, then u8 decimals
    expect(ix.data[0]).toBe(12);
    expect(ix.data.readBigUInt64LE(1)).toBe(1_000_000n);
    expect(ix.data[9]).toBe(6);
  });

  it("ATA creation passes the token program in the account list and is idempotent", () => {
    delete process.env.PUMPBIRD_TOKEN_PROGRAM;
    const ix = createAssociatedTokenAccountInstruction({
      payer: owner,
      ata: new PublicKey(ATA_TOKEN2022),
      owner,
      mint: MINT
    });
    // discriminator 1 = CreateIdempotent, so re-running the launch script is safe
    expect(ix.data[0]).toBe(1);
    expect(ix.keys[5].pubkey.toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it("an explicit override wins over the environment", () => {
    process.env.PUMPBIRD_TOKEN_PROGRAM = "token2022";
    const ix = createTransferCheckedInstruction({
      source: new PublicKey(ATA_LEGACY),
      mint: MINT,
      destination: new PublicKey(ATA_LEGACY),
      owner,
      amount: 1n,
      decimals: 6,
      tokenProgramId: TOKEN_PROGRAM_ID
    });
    expect(ix.programId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});

describe("treasury account self-healing", () => {
  const wallet = new PublicKey("AMnaq33vDkV4A9se8Xzuz9c4EP3cj9KcWJWfg7WeXu77");
  const treasuryOwner = new PublicKey(CURVE_PDA);
  const treasuryAta = getAssociatedTokenAddress(MINT, treasuryOwner, TOKEN_2022_PROGRAM_ID);

  const base = {
    wallet: wallet.toBase58(),
    tokenMint: MINT.toBase58(),
    treasuryAta: treasuryAta.toBase58(),
    treasuryOwner: treasuryOwner.toBase58(),
    amountRaw: 1_000_000n,
    decimals: 6,
    memo: "bp:testtesttes"
  };

  it("omits the treasury creation instruction when the account already exists", async () => {
    const { buildEntryTransaction } = await import("@/lib/client/entry-tx");
    const tx = buildEntryTransaction({ ...base, createTreasuryAta: false });
    const ataIxs = tx.instructions.filter(
      (ix) => ix.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    );
    // just the player's own account
    expect(ataIxs).toHaveLength(1);
    expect(ataIxs[0].keys[1].pubkey.toBase58()).toBe(
      getAssociatedTokenAddress(MINT, wallet, TOKEN_2022_PROGRAM_ID).toBase58()
    );
  });

  it("adds a create-idempotent for the treasury account when the server asks", async () => {
    const { buildEntryTransaction } = await import("@/lib/client/entry-tx");
    const tx = buildEntryTransaction({ ...base, createTreasuryAta: true });
    const ataIxs = tx.instructions.filter(
      (ix) => ix.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    );
    expect(ataIxs).toHaveLength(2);
    const created = ataIxs.map((ix) => ix.keys[1].pubkey.toBase58());
    expect(created).toContain(treasuryAta.toBase58());
    // every one is CreateIdempotent, so a race between two players is harmless
    for (const ix of ataIxs) expect(ix.data[0]).toBe(1);
    // the player pays the rent, and the treasury wallet is the owner
    const treasuryIx = ataIxs.find((ix) => ix.keys[1].pubkey.equals(treasuryAta))!;
    expect(treasuryIx.keys[0].pubkey.toBase58()).toBe(wallet.toBase58());
    expect(treasuryIx.keys[2].pubkey.toBase58()).toBe(treasuryOwner.toBase58());
  });

  it("does nothing unsafe if the server asks but sends no treasury owner", async () => {
    const { buildEntryTransaction } = await import("@/lib/client/entry-tx");
    const tx = buildEntryTransaction({ ...base, treasuryOwner: undefined, createTreasuryAta: true });
    const ataIxs = tx.instructions.filter(
      (ix) => ix.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    );
    expect(ataIxs).toHaveLength(1);
  });
});
