// Generate a new Solana keypair for the BirdPump treasury.
//
// Writes the base58 secret to /home/nebryx/birdpump-treasury-secret.txt with
// 0600 perms. Prints ONLY the public address. The secret is NEVER echoed.
//
// You: paste contents of that file into Vercel encrypted env as
// TREASURY_SECRET_KEY (and into .env.local for dev), then `rm` the file.

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const kp = Keypair.generate();
const pub = kp.publicKey.toBase58();
const secret = bs58.encode(kp.secretKey);

const outFile = process.env.OUT_FILE ?? join(homedir(), "birdpump-treasury-secret.txt");

writeFileSync(outFile, secret + "\n", { mode: 0o600 });
chmodSync(outFile, 0o600);

console.log("=== BirdPump treasury keypair generated ===");
console.log("");
console.log("Public address (safe to share — fund this with PUMPBIRD + ~0.05 SOL):");
console.log(`  ${pub}`);
console.log("");
console.log(`Secret written to: ${outFile} (mode 0600)`);
console.log("");
console.log("Next steps:");
console.log(" 1. `cat` that file, copy the secret");
console.log(" 2. Paste into Vercel project env as TREASURY_SECRET_KEY (encrypted)");
console.log(" 3. Paste into local .env.local as TREASURY_SECRET_KEY");
console.log(`    Also set NEXT_PUBLIC_TREASURY_ADDRESS=${pub}`);
console.log(" 4. `rm` the file once it's safely in Vercel + .env.local");
console.log("");
