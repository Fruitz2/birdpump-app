// Sign-In With Solana (SIWS) — ed25519 signature verification.
//
// Flow:
//   1. Client POST /api/auth/nonce {wallet}
//      -> server issues random nonce + the canonical message string
//   2. Client uses Phantom signMessage to sign the message
//   3. Client POST /api/auth/verify {wallet, signature, nonce}
//      -> server re-derives the message, verifies signature, issues JWT
//
// Why the message must be deterministic on the server: we never trust the
// client-sent message. We always reconstruct it from {wallet, nonce, issuedAt}
// and verify the signature against THAT string. Otherwise a malicious client
// could swap in a different message for the same signature.

import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

const ENC = new TextEncoder();

export type NonceRecord = {
  nonce: string;
  wallet: string;
  issuedAt: string;
  expiresAt: string;
};

export function buildSiwsMessage(input: {
  domain: string;
  wallet: string;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${input.domain} wants you to sign in to BirdPump with your Solana wallet.`,
    ``,
    `Wallet: ${input.wallet}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    ``,
    `By signing you confirm wallet ownership. This signature is free and is`,
    `NOT a transaction — no SOL is moved.`
  ].join("\n");
}

export function verifySiwsSignature(input: {
  message: string;
  signatureBase58: string;
  wallet: string;
}): { ok: true } | { ok: false; reason: string } {
  let pubkey: Uint8Array;
  try {
    pubkey = new PublicKey(input.wallet).toBytes();
  } catch {
    return { ok: false, reason: "invalid_wallet_address" };
  }

  let signature: Uint8Array;
  try {
    signature = bs58.decode(input.signatureBase58);
  } catch {
    return { ok: false, reason: "invalid_signature_encoding" };
  }

  if (signature.length !== 64) {
    return { ok: false, reason: "invalid_signature_length" };
  }

  const messageBytes = ENC.encode(input.message);
  const valid = nacl.sign.detached.verify(messageBytes, signature, pubkey);

  if (!valid) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}

export function isValidSolanaAddress(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

export function generateNonce(): string {
  // 32 bytes -> base58 ~ 44 chars
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bs58.encode(bytes);
}
