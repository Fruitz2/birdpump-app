// One command to take PumpBird from "token does not exist" to "paid play works".
//
//   npm run launch -- <MINT_ADDRESS>
//   npm run launch -- <MINT_ADDRESS> --check     (read only, creates nothing)
//
// It reads the mint off chain rather than trusting anything you type, proves
// the price oracle can quote a real dollar, creates the treasury token account
// if it is missing, and prints the exact environment variables to paste into
// Vercel. Every check is independent and the script exits non-zero if any
// blocker remains, so it is safe to run repeatedly until it is all green.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

// spectra-vault injects secrets under their vault key names. The vault
// namespaces this project's shared API keys as PUMPBIRD_*, so map them onto
// the names the app actually reads. A value already present in the
// environment always wins, so a real .env.local is never overridden.
for (const name of ["BIRDEYE_API_KEY", "HELIUS_API_KEY"]) {
  const vaulted = process.env[`PUMPBIRD_${name}`];
  if (vaulted && !process.env[name]) process.env[name] = vaulted;
}

import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmRawTransaction
} from "@solana/web3.js";
import { getConnection } from "@/lib/solana/connection";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
} from "@/lib/solana/spl";
import { deriveBondingCurvePda, fetchBondingCurve } from "@/lib/solana/pumpfun";
import { getSolUsd } from "@/lib/price/birdeye";
import { getPumpBirdPrice, rawToDisplay } from "@/lib/price/pumpbird";

type Check = { name: string; ok: boolean; detail: string; blocker: boolean };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string, blocker = true) {
  checks.push({ name, ok, detail, blocker });
  const mark = ok ? "  ok  " : blocker ? " FAIL " : " warn ";
  console.log(`[${mark}] ${name.padEnd(28)} ${detail}`);
}

function usage(): never {
  console.error(
    "\nUsage: npm run launch -- <MINT_ADDRESS> [--check]\n\n" +
      "  <MINT_ADDRESS>  the pump.fun contract address (CA) of $PUMPBIRD\n" +
      "  --check         read only. Runs every check, creates nothing.\n"
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const checkOnly = args.includes("--check");
  const mintArg = args.find((a) => !a.startsWith("--"));
  if (!mintArg) usage();

  console.log("\nPUMPBIRD LAUNCH PREFLIGHT");
  console.log("=".repeat(72));

  // ---- 1. the mint is a real, initialised SPL mint --------------------------
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintArg);
  } catch {
    record("mint address", false, `${mintArg} is not a valid base58 pubkey`);
    return finish();
  }

  const conn = getConnection("confirmed");
  const mintInfo = await conn.getAccountInfo(mint, "confirmed").catch(() => null);
  if (!mintInfo) {
    record("mint account", false, `${mint.toBase58()} does not exist on chain`);
    return finish();
  }

  // The token program id is one of the ATA derivation seeds, so reading it off
  // chain rather than assuming is the difference between payments landing and
  // payments going to an address nobody owns. pump.fun issues Token-2022.
  const owner = mintInfo.owner.toBase58();
  let tokenProgramName: "token2022" | "legacy";
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
    tokenProgramName = "token2022";
    record("token program", true, "Token-2022 (standard for pump.fun)");
  } else if (owner === TOKEN_PROGRAM_ID.toBase58()) {
    tokenProgramName = "legacy";
    record("token program", true, "classic SPL Token");
  } else {
    record("token program", false, `mint is owned by ${owner}, which is not a token program`);
    return finish();
  }
  process.env.PUMPBIRD_TOKEN_PROGRAM = tokenProgramName;

  // Token-2022 can carry a transfer fee or a transfer hook. Either would break
  // the payment band (the treasury would receive less than the player sent) or
  // the transfer itself (a hook needs extra accounts this builder does not
  // pass). pump.fun mints carry only MetadataPointer + TokenMetadata, so this
  // check exists to catch the day that changes.
  if (tokenProgramName === "token2022") {
    const exts = readToken2022Extensions(mintInfo.data);
    const hostile = exts.filter((e) => [1, 2, 15, 16, 13, 10].includes(e));
    record(
      "token extensions",
      hostile.length === 0,
      hostile.length === 0
        ? `${exts.length} extension(s), none affect transfers`
        : `mint carries extension type(s) ${hostile.join(", ")} (transfer fee / hook / permanent delegate). ` +
            "The payment band and the transfer builder do not support these."
    );
  }

  // SPL mint layout: supply u64 @36, decimals u8 @44, isInitialized u8 @45
  const data = mintInfo.data;
  if (data.length < 82) {
    record("mint account", false, `unexpected mint account size ${data.length}`);
    return finish();
  }
  const decimals = data[44];
  const initialized = data[45] === 1;
  const supplyRaw = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
    36,
    true
  );
  if (!initialized) {
    record("mint account", false, "mint exists but is not initialised");
    return finish();
  }
  record(
    "mint account",
    true,
    `decimals=${decimals} supply=${(Number(supplyRaw) / 10 ** decimals).toLocaleString("en-US")}`
  );

  // Everything below reads config through the same helpers the API uses, so
  // set the env exactly as production will see it.
  process.env.PUMPBIRD_TOKEN_MINT = mint.toBase58();
  process.env.PUMPBIRD_TOKEN_DECIMALS = String(decimals);

  // ---- 2. the bonding curve is readable ------------------------------------
  const curvePda = deriveBondingCurvePda(mint);
  const curve = await fetchBondingCurve(mint).catch(() => null);
  if (!curve) {
    record(
      "bonding curve",
      false,
      `no curve at ${curvePda.toBase58()} — is this actually a pump.fun mint?`,
      false
    );
  } else if (curve.complete) {
    record(
      "bonding curve",
      true,
      "curve COMPLETE (graduated). Pricing falls back to Birdeye, which needs BIRDEYE_API_KEY."
    );
  } else {
    const solInCurve = Number(curve.realSolReserves) / LAMPORTS_PER_SOL;
    record("bonding curve", true, `live, ${solInCurve.toFixed(3)} SOL in the curve`);
  }

  // ---- 3. SOL/USD -----------------------------------------------------------
  const sol = await getSolUsd();
  record(
    "SOL/USD",
    sol.source !== "fallback",
    `$${sol.usd.toFixed(2)} (source: ${sol.source})`,
    false
  );
  if (sol.source === "fallback") {
    console.log(
      "         ^ BIRDEYE_API_KEY is missing or failing, so every quote uses the " +
        `SOL_USD_FALLBACK constant of $${sol.usd.toFixed(2)}. Fix this before launch.`
    );
  }

  // ---- 4. the oracle can actually quote a dollar ----------------------------
  const price = await getPumpBirdPrice();
  if (!price.available) {
    record("price oracle", false, `cannot quote: ${price.reason}`);
  } else {
    const perLifeCents = Number.parseInt(process.env.ENTRY_USD_CENTS ?? "100", 10);
    const raw = price.rawForUsdCents(perLifeCents);
    const display = rawToDisplay(raw, decimals);
    if (raw <= 0n) {
      record("price oracle", false, "quote returned zero tokens for $1");
    } else {
      record(
        "price oracle",
        true,
        `$${(perLifeCents / 100).toFixed(2)} = ${display.toLocaleString("en-US", {
          maximumFractionDigits: 2
        })} $PUMPBIRD (source: ${price.source})`
      );
      console.log(
        `         1 $PUMPBIRD = $${price.tokenUsd.toPrecision(4)} / ${price.tokenSol.toPrecision(4)} SOL`
      );
    }
  }

  // ---- 5. treasury keypair and SOL gas -------------------------------------
  const secret = process.env.TREASURY_SECRET_KEY;
  if (!secret) {
    record("treasury key", false, "TREASURY_SECRET_KEY not set in this environment");
    return finish();
  }
  const { getTreasuryKeypair } = await import("@/lib/solana/treasury");
  let treasury: Keypair;
  try {
    treasury = getTreasuryKeypair();
  } catch (e) {
    record("treasury key", false, (e as Error).message);
    return finish();
  }
  record("treasury key", true, treasury.publicKey.toBase58());

  const lamports = BigInt(await conn.getBalance(treasury.publicKey, "confirmed"));
  const minGas = Number.parseFloat(process.env.MIN_GAS_SOL ?? "0.05");
  // ATA rent is ~0.00204 SOL per winner payout, plus the fee for each transfer.
  const needed = BigInt(Math.floor((minGas + 0.01) * LAMPORTS_PER_SOL));
  record(
    "treasury SOL",
    lamports >= needed,
    `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
      `(need >= ${(Number(needed) / LAMPORTS_PER_SOL).toFixed(4)} for payout fees and winner ATA rent)`
  );

  // ---- 6. treasury ATA ------------------------------------------------------
  const ata = getAssociatedTokenAddress(mint, treasury.publicKey);
  let ataInfo = await conn.getAccountInfo(ata, "confirmed").catch(() => null);

  if (!ataInfo && checkOnly) {
    record("treasury ATA", false, `${ata.toBase58()} missing (run without --check to create it)`);
  } else if (!ataInfo) {
    if (lamports < BigInt(Math.floor(0.005 * LAMPORTS_PER_SOL))) {
      record(
        "treasury ATA",
        false,
        "missing, and the treasury has too little SOL to create it. Fund the treasury first."
      );
    } else {
      console.log(`[ .... ] treasury ATA                creating ${ata.toBase58()} ...`);
      try {
        const sig = await createAta(mint, treasury, ata);
        ataInfo = await conn.getAccountInfo(ata, "confirmed").catch(() => null);
        record("treasury ATA", ataInfo !== null, `created, tx ${sig}`);
      } catch (e) {
        record("treasury ATA", false, `creation failed: ${(e as Error).message}`);
      }
    }
  } else {
    const bal = await conn.getTokenAccountBalance(ata, "confirmed").catch(() => null);
    record(
      "treasury ATA",
      true,
      `${ata.toBase58()} exists, holding ${bal?.value.uiAmountString ?? "0"} $PUMPBIRD`
    );
  }

  // ---- 7. supporting services ----------------------------------------------
  // These are consumed by the DEPLOYED app, not by this script. Their real
  // proof is `npm run launch:verify`, which hits production and fails if the
  // database, cache or auth are not wired. Missing here only means they are
  // absent from THIS machine, which is normal and not a launch blocker.
  record("DATABASE_URL", Boolean(process.env.DATABASE_URL), process.env.DATABASE_URL ? "set" : "not on this machine (checked by launch:verify)", false);
  record(
    "Upstash Redis",
    Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
    process.env.KV_REST_API_URL ? "set" : "not on this machine (checked by launch:verify)",
    false
  );
  record("JWT_SECRET", Boolean(process.env.JWT_SECRET), process.env.JWT_SECRET ? "set" : "not on this machine (checked by launch:verify)", false);
  record("HELIUS_API_KEY", Boolean(process.env.HELIUS_API_KEY), process.env.HELIUS_API_KEY ? "set" : "missing (falls back to the public RPC, which rate limits)", false);
  // This one does block: without it every quote prices SOL from a hardcoded
  // constant, and a graduated token cannot be priced at all.
  record("BIRDEYE_API_KEY", Boolean(process.env.BIRDEYE_API_KEY), process.env.BIRDEYE_API_KEY ? "set" : "missing");

  // ---- 8. what to paste into Vercel ----------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log("SET THESE IN THE HOSTING ENV (Production), then redeploy:\n");
  console.log(`  PUMPBIRD_TOKEN_MINT=${mint.toBase58()}`);
  console.log(`  PUMPBIRD_TOKEN_DECIMALS=${decimals}`);
  console.log(`  PUMPBIRD_TOKEN_PROGRAM=${tokenProgramName}`);
  console.log(`  NEXT_PUBLIC_TREASURY_ADDRESS=${treasury.publicKey.toBase58()}`);
  console.log(`  SLIPPAGE_BPS=1000`);
  console.log("\nThen verify the deployed site is quoting for real:\n");
  console.log("  npm run launch:verify\n");

  finish();
}

// Token-2022 mints store a TLV extension list after the 165 byte base + 1
// byte account type. Returns the extension type ids present.
function readToken2022Extensions(data: Uint8Array): number[] {
  const out: number[] = [];
  if (data.length <= 166) return out;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 166;
  while (off + 4 <= data.length) {
    const type = view.getUint16(off, true);
    const len = view.getUint16(off + 2, true);
    if (type === 0 && len === 0) break;
    out.push(type);
    off += 4 + len;
  }
  return out;
}

async function createAta(mint: PublicKey, treasury: Keypair, ata: PublicKey): Promise<string> {
  const conn = getConnection("confirmed");
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx.add(
    createAssociatedTokenAccountInstruction({
      payer: treasury.publicKey,
      ata,
      owner: treasury.publicKey,
      mint
    })
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = treasury.publicKey;
  tx.sign(treasury);
  return sendAndConfirmRawTransaction(conn, tx.serialize(), {
    commitment: "confirmed",
    maxRetries: 3
  });
}

function finish(): never {
  const blockers = checks.filter((c) => !c.ok && c.blocker);
  const warnings = checks.filter((c) => !c.ok && !c.blocker);
  console.log("=".repeat(72));
  if (blockers.length === 0) {
    console.log(
      warnings.length
        ? `READY, with ${warnings.length} warning(s) above. Paid play will work.`
        : "ALL GREEN. Paid play will work."
    );
    process.exit(0);
  }
  console.log(`${blockers.length} BLOCKER(S). Paid play will NOT work until these are fixed:`);
  for (const b of blockers) console.log(`  - ${b.name}: ${b.detail}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("\nlaunch script crashed:", e);
  process.exit(1);
});
