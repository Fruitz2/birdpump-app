import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { getConnection } from "./connection";
import { getAssociatedTokenAddress } from "./spl";
import { tokenMintAddress, tokenDecimals } from "@/lib/config/token";

let _treasury: Keypair | null = null;

export function getTreasuryKeypair(): Keypair {
  if (_treasury) return _treasury;

  const secret = process.env.TREASURY_SECRET_KEY;
  if (!secret) throw new Error("TREASURY_SECRET_KEY not set");

  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(secret);
  } catch {
    throw new Error("TREASURY_SECRET_KEY must be base58");
  }
  if (bytes.length !== 64) {
    throw new Error("TREASURY_SECRET_KEY must decode to 64 bytes");
  }

  _treasury = Keypair.fromSecretKey(bytes);

  const expected = process.env.NEXT_PUBLIC_TREASURY_ADDRESS;
  if (expected && expected !== _treasury.publicKey.toBase58()) {
    throw new Error(
      `TREASURY_SECRET_KEY pubkey (${_treasury.publicKey.toBase58()}) does not match NEXT_PUBLIC_TREASURY_ADDRESS (${expected})`
    );
  }

  return _treasury;
}

export function getTreasuryAddress(): PublicKey {
  return getTreasuryKeypair().publicKey;
}

export function getTokenMint(): PublicKey {
  const m = tokenMintAddress();
  if (!m) throw new Error("token mint not configured (token.config.json / PUMPBIRD_TOKEN_MINT)");
  return new PublicKey(m);
}

export function getTokenDecimals(): number {
  return tokenDecimals();
}

export function getTreasuryAta(): PublicKey {
  return getAssociatedTokenAddress(getTokenMint(), getTreasuryAddress());
}

export type TreasuryBalances = {
  solLamports: bigint;
  solDisplay: number;
  tokenRawAmount: bigint;
  tokenAtaExists: boolean;
};

export async function getTreasuryBalances(): Promise<TreasuryBalances> {
  const conn = getConnection("confirmed");
  const owner = getTreasuryAddress();
  const ata = getTreasuryAta();

  const [solLamports, ataInfo] = await Promise.all([
    conn.getBalance(owner, "confirmed"),
    conn.getTokenAccountBalance(ata, "confirmed").catch(() => null)
  ]);

  return {
    solLamports: BigInt(solLamports),
    solDisplay: solLamports / LAMPORTS_PER_SOL,
    tokenRawAmount: ataInfo ? BigInt(ataInfo.value.amount) : 0n,
    tokenAtaExists: ataInfo !== null
  };
}

export function hotWalletCapTokens(): bigint {
  const v = process.env.HOT_WALLET_CAP_TOKENS;
  if (!v) return 0n; // 0 = unset, no cap
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

export function gasSolCapLamports(): bigint {
  // Minimum SOL balance to keep available for tx fees.
  // Default ~0.05 SOL — covers thousands of transfers.
  const sol = Number.parseFloat(process.env.MIN_GAS_SOL ?? "0.05");
  return BigInt(Math.floor(sol * LAMPORTS_PER_SOL));
}

// --- Treasury ATA existence latch -------------------------------------------
//
// The client entry transaction transfers straight into the treasury ATA and
// does NOT create it (lib/client/entry-tx.ts). If that account does not exist,
// the player's transfer fails AFTER they have signed and paid a network fee.
//
// `scripts/launch.ts` creates the ATA at launch time. This latch is the belt
// to that braces: /api/entry/create refuses to issue a ticket until the ATA is
// confirmed on chain, so nobody can ever sign a doomed payment.
//
// An ATA, once created, is never closed by this system, so a single `true` is
// cached forever. A `false` is never cached — we re-check every call until it
// exists.
let _ataConfirmed = false;

export async function treasuryAtaExists(): Promise<boolean> {
  if (_ataConfirmed) return true;
  const conn = getConnection("confirmed");
  const info = await conn.getAccountInfo(getTreasuryAta(), "confirmed");
  if (info) {
    _ataConfirmed = true;
    return true;
  }
  return false;
}
