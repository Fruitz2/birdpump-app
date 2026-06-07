import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  buildSiwsMessage,
  generateNonce,
  isValidSolanaAddress,
  verifySiwsSignature
} from "@/lib/auth/siws";

describe("SIWS", () => {
  it("validates Solana addresses", () => {
    const kp = Keypair.generate();
    expect(isValidSolanaAddress(kp.publicKey.toBase58())).toBe(true);
    expect(isValidSolanaAddress("not-an-address")).toBe(false);
  });

  it("generates a base58 nonce of expected length", () => {
    const n = generateNonce();
    expect(n.length).toBeGreaterThanOrEqual(40);
    expect(n.length).toBeLessThanOrEqual(48);
  });

  it("builds a deterministic message", () => {
    const m = buildSiwsMessage({
      domain: "birdpump.fun",
      wallet: "abc",
      nonce: "xyz",
      issuedAt: "2026-06-06T00:00:00.000Z"
    });
    expect(m).toContain("birdpump.fun");
    expect(m).toContain("Wallet: abc");
    expect(m).toContain("Nonce: xyz");
  });

  it("accepts a valid ed25519 signature and rejects a tampered one", () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const message = buildSiwsMessage({
      domain: "birdpump.fun",
      wallet,
      nonce: generateNonce(),
      issuedAt: new Date().toISOString()
    });
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    const sig58 = bs58.encode(sig);

    const ok = verifySiwsSignature({ message, signatureBase58: sig58, wallet });
    expect(ok.ok).toBe(true);

    const tamperedMsg = message + "x";
    const fail = verifySiwsSignature({
      message: tamperedMsg,
      signatureBase58: sig58,
      wallet
    });
    expect(fail.ok).toBe(false);
  });

  it("rejects a signature signed by a different wallet", () => {
    const wallet = Keypair.generate();
    const other = Keypair.generate();
    const message = "msg";
    const sig = nacl.sign.detached(new TextEncoder().encode(message), other.secretKey);
    const r = verifySiwsSignature({
      message,
      signatureBase58: bs58.encode(sig),
      wallet: wallet.publicKey.toBase58()
    });
    expect(r.ok).toBe(false);
  });
});
