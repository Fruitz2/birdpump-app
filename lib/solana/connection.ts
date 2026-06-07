import { Connection, Commitment } from "@solana/web3.js";

let _conn: Connection | null = null;

function rpcUrl(): string {
  const explicit = process.env.SOLANA_RPC_URL;
  if (explicit) return explicit;

  const heliusKey = process.env.HELIUS_API_KEY;
  const cluster = process.env.SOLANA_CLUSTER ?? "mainnet-beta";
  if (heliusKey) {
    const host = cluster === "devnet"
      ? "devnet.helius-rpc.com"
      : "mainnet.helius-rpc.com";
    return `https://${host}/?api-key=${heliusKey}`;
  }
  return process.env.SOLANA_RPC_FALLBACK ?? "https://api.mainnet-beta.solana.com";
}

export function getConnection(commitment: Commitment = "confirmed"): Connection {
  if (_conn) return _conn;
  _conn = new Connection(rpcUrl(), {
    commitment,
    disableRetryOnRateLimit: false,
    httpHeaders: {
      "User-Agent": "birdpump-backend/0.1"
    }
  });
  return _conn;
}

export function isMainnet(): boolean {
  return (process.env.SOLANA_CLUSTER ?? "mainnet-beta") === "mainnet-beta";
}
