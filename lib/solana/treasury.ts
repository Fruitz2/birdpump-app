import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { getConnection } from "./connection";
import { getAssociatedTokenAddress } from "./spl";

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
  const m = process.env.PUMPBIRD_TOKEN_MINT;
  if (!m) throw new Error("PUMPBIRD_TOKEN_MINT not set");
  return new PublicKey(m);
}

export function getTokenDecimals(): number {
  return Number.parseInt(process.env.PUMPBIRD_TOKEN_DECIMALS ?? "6", 10);
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
