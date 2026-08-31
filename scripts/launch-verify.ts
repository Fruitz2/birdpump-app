// Prove the DEPLOYED site can quote a real dollar. Run after setting the env
// vars in Vercel and redeploying.
//
//   npm run launch:verify
//   npm run launch:verify -- https://staging.example.com
//
// This talks to production over HTTP exactly the way a player's browser does,
// so it catches the failure that local checks cannot: env vars set in the
// wrong Vercel scope, or set but never redeployed.

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.pumpbird.com";

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];
function record(name: string, ok: boolean, detail: string) {
  rows.push({ name, ok, detail });
  console.log(`[${ok ? "  ok  " : " FAIL "}] ${name.padEnd(24)} ${detail}`);
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000)
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 200) };
  }
  return { status: r.status, body };
}

async function main() {
  const base = (process.argv.slice(2).find((a) => a.startsWith("http")) ?? DEFAULT_BASE).replace(
    /\/$/,
    ""
  );
  console.log(`\nVERIFYING DEPLOYED SITE: ${base}`);
  console.log("=".repeat(72));

  // 1. the site is up
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(15_000) });
    record("site", r.ok, `HTTP ${r.status}`);
  } catch (e) {
    record("site", false, (e as Error).message);
  }

  // 2. the pot route reads the database
  try {
    const { status, body } = await getJson(`${base}/api/pot`);
    const p = body?.pot;
    record(
      "/api/pot",
      status === 200 && p != null,
      status === 200
        ? `epoch ${p?.epoch}, high ${p?.allTimeHighScore}, entries ${p?.totalEntries}`
        : `HTTP ${status}`
    );
  } catch (e) {
    record("/api/pot", false, (e as Error).message);
  }

  // 3. the leaderboard route
  try {
    const { status, body } = await getJson(`${base}/api/leaderboard`);
    record(
      "/api/leaderboard",
      status === 200 && Array.isArray(body?.leaderboard),
      status === 200 ? `${body.leaderboard.length} row(s)` : `HTTP ${status}`
    );
  } catch (e) {
    record("/api/leaderboard", false, (e as Error).message);
  }

  // 4. THE ONE THAT MATTERS: can production quote a dollar?
  try {
    const { status, body } = await getJson(`${base}/api/entry/quote?lives=1`);
    if (status !== 200) {
      record("/api/entry/quote", false, `HTTP ${status}`);
    } else if (!body?.available) {
      record("/api/entry/quote", false, `refusing to quote: ${body?.reason}`);
    } else {
      const tokens = body?.amount?.display?.target;
      const okShape =
        typeof tokens === "number" &&
        tokens > 0 &&
        body.tokenMint &&
        body.treasury &&
        body.treasuryAta;
      record(
        "/api/entry/quote",
        okShape,
        okShape
          ? `$1 = ${tokens.toLocaleString("en-US", { maximumFractionDigits: 2 })} $PUMPBIRD ` +
              `(source ${body.priceSource}, slippage ${body.slippageBps} bps)`
          : "quoted but the payload is missing mint/treasury/amount"
      );
      if (okShape) {
        console.log(`         mint      ${body.tokenMint}`);
        console.log(`         treasury  ${body.treasury}`);
        console.log(`         ATA       ${body.treasuryAta}`);
      }
    }
  } catch (e) {
    record("/api/entry/quote", false, (e as Error).message);
  }

  // 5. a 25 pack quotes proportionally, which proves the maths scales
  try {
    const { body: one } = await getJson(`${base}/api/entry/quote?lives=1`);
    const { body: many } = await getJson(`${base}/api/entry/quote?lives=25`);
    if (one?.available && many?.available) {
      const ratio = Number(many.amount.target) / Number(one.amount.target);
      const sane = ratio > 24 && ratio < 26;
      record("25 pack maths", sane, `25 lives cost ${ratio.toFixed(2)}x one life`);
    } else {
      record("25 pack maths", false, "cannot quote");
    }
  } catch (e) {
    record("25 pack maths", false, (e as Error).message);
  }

  console.log("=".repeat(72));
  const failed = rows.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log("PRODUCTION IS LIVE AND QUOTING. Buy one life yourself before announcing.");
    process.exit(0);
  }
  console.log(`${failed.length} FAILING CHECK(S):`);
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("\nverify script crashed:", e);
  process.exit(1);
});
