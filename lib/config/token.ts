// Where the $PUMPBIRD token identity comes from.
//
// A contract address is public information. It is printed on the site, posted
// on X, and pasted into every trading bot on the chain. It is not a secret and
// it has no business being a hosting-dashboard environment variable.
//
// Keeping it in a committed file means launching is a commit, which is
// something anyone with repo access can do and which deploys itself. Keeping
// it in the dashboard means launching requires someone logged into the
// hosting provider at the exact moment the token goes live. Only one of those
// is operable at 3am.
//
// Resolution order:
//   1. process.env  — still wins, so the dashboard can override without a
//      deploy and so tests can set whatever they like
//   2. token.config.json at the repo root, written by `npm run launch`
//   3. not configured, and every caller says so plainly rather than guessing
//
// Secrets stay where secrets belong. This file only ever holds the mint, its
// decimals, and which token program it lives under.

import config from "../../token.config.json";

export type TokenProgramName = "token2022" | "legacy";

type TokenConfig = {
  mint: string | null;
  decimals: number;
  program: string;
  launchedAt?: string | null;
  note?: string;
};

const file = config as TokenConfig;

/** The mint address, or null when the token has not been launched yet. */
export function tokenMintAddress(): string | null {
  const fromEnv = process.env.PUMPBIRD_TOKEN_MINT?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = file.mint?.trim();
  return fromFile ? fromFile : null;
}

export function tokenDecimals(): number {
  const fromEnv = process.env.PUMPBIRD_TOKEN_DECIMALS?.trim();
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 18) return n;
  }
  return Number.isFinite(file.decimals) ? file.decimals : 6;
}

/**
 * pump.fun issues Token-2022, so that is the default. Only the exact string
 * "legacy" selects the classic program, in either source.
 */
export function tokenProgramName(): TokenProgramName {
  const fromEnv = process.env.PUMPBIRD_TOKEN_PROGRAM?.trim();
  if (fromEnv) return fromEnv === "legacy" ? "legacy" : "token2022";
  return file.program === "legacy" ? "legacy" : "token2022";
}

/** True once a mint is configured from either source. */
export function isTokenConfigured(): boolean {
  return tokenMintAddress() !== null;
}

/** Where the current value came from, for diagnostics. */
export function tokenConfigSource(): "env" | "file" | "none" {
  if (process.env.PUMPBIRD_TOKEN_MINT?.trim()) return "env";
  if (file.mint?.trim()) return "file";
  return "none";
}
