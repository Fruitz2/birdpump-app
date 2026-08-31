"use client";

// /counter — broadcast-grade livestream counter.
//
// Styles live in app/counter/counter.css (imported at page level).
// This component is pure structure + data behavior.

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/client/api";
import { avatarUrl } from "@/lib/profile/avatars";

type PotApi = {
  pot: {
    epoch: number;
    allTimeHighScore: number;
    allTimeHighWallet: string | null;
    potTokenAmount: string;
    treasuryTokenAmount: string;
    totalEntries: number;
    updatedAt: string;
  };
};

type LeaderboardApi = {
  leaderboard: Array<{
    rank: number;
    wallet: string;
    displayName: string | null;
    avatarId: string | null;
    bestScore: number;
    totalPlays: number;
    totalWonTokens: string;
  }>;
};

type QuoteApi = {
  available?: boolean;
  tokenUsd?: number;
  tokenSol?: number;
  solUsd?: number;
  tokenDecimals?: number;
  priceSource?: string;
};

const POLL_MS = 4_000;
const CLOCK_MS = 1_000;

const ASSETS = "/assets/pumpbird/";

export function CounterClient() {
  const [pot, setPot] = useState<PotApi["pot"] | null>(null);
  const [board, setBoard] = useState<LeaderboardApi["leaderboard"]>([]);
  const [quote, setQuote] = useState<QuoteApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState<string>("--:--:--");
  const [lastUpdateTs, setLastUpdateTs] = useState<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const [p, l, q] = await Promise.all([
        apiGet<PotApi>("/api/pot").catch(() => null),
        apiGet<LeaderboardApi>("/api/leaderboard?limit=5").catch(() => null),
        apiGet<QuoteApi>("/api/entry/quote").catch(() => null)
      ]);
      if (cancelled) return;
      if (p) setPot(p.pot);
      if (l) setBoard(l.leaderboard);
      // Only accept quote if it has real price data — dev/pre-launch returns
      // a `{ available: false }` sentinel that we treat as "no quote".
      if (q && q.available !== false && typeof q.tokenUsd === "number") {
        setQuote(q);
      } else {
        setQuote(null);
      }
      setLastUpdateTs(Date.now());
      setError(null);
    }
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(
        `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
      );
    };
    tick();
    const id = setInterval(tick, CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  const potUsdDisplay = useMemo(() => {
    if (!pot || !quote) return null;
    const decimals = quote.tokenDecimals ?? 6;
    const tokenUsd = quote.tokenUsd;
    if (typeof tokenUsd !== "number") return null;
    try {
      const raw = BigInt(pot.potTokenAmount);
      const div = BigInt(10) ** BigInt(decimals);
      const whole = Number(raw / div) + Number(raw % div) / Math.pow(10, decimals);
      return whole * tokenUsd;
    } catch {
      return null;
    }
  }, [pot, quote]);

  const champion = board[0] ?? null;
  const championName =
    champion?.displayName ?? (champion?.wallet ? shortWallet(champion.wallet) : null);

  const isPotZero = !pot || pot.potTokenAmount === "0";

  const tickerItems = useMemo(() => {
    const items: string[] = [
      "PAY $1 · PLAY PUMP.BIRD",
      "BEAT THE HIGH SCORE · TAKE THE POT",
      "LIVE ON SOLANA",
      "WINNER TAKES EVERYTHING"
    ];
    if (quote?.tokenUsd != null) items.push(`$PUMPBIRD ${formatPrice(quote.tokenUsd)}`);
    if (quote?.solUsd != null) items.push(`SOL/USD $${formatPrice(quote.solUsd)}`);
    if (pot) items.push(`EPOCH ${pot.epoch}`);
    if (pot) items.push(`${thousands(String(pot.totalEntries))} ENTRIES PLAYED`);
    if (pot && pot.allTimeHighScore > 0) {
      items.push(`HIGH SCORE TO BEAT · ${pot.allTimeHighScore}`);
    }
    items.push("BUILT ON PUMP.FUN");
    return items;
  }, [pot, quote]);

  return (
    <div className="ctr-root">
      <div className="ctr-overlay-scanlines" aria-hidden="true" />
      <div className="ctr-overlay-grain" aria-hidden="true" />
      <div className="ctr-overlay-vignette" aria-hidden="true" />

      {/* HEADER */}
      <header className="ctr-header">
        <div className="ctr-header-l">
          <img className="ctr-logo" src={`${ASSETS}logo.png`} alt="PUMP.BIRD" />
          <span className="ctr-header-tag">▎THE HIGHSCORE TAKES THE POT ▎</span>
        </div>
        <div className="ctr-header-r">
          <span className="ctr-led-dot" />
          <span className="ctr-header-mono">LIVE</span>
          <span className="ctr-header-sep">•</span>
          <span className="ctr-header-mono">{clock}</span>
          <span className="ctr-header-sep">•</span>
          <span className="ctr-header-mono">EPOCH {pot?.epoch ?? "—"}</span>
        </div>
      </header>

      {/* HERO */}
      <section className="ctr-hero">
        <div className="ctr-hero-pot">
          <div className="ctr-pot-label">
            <span className="ctr-arcade">POT</span>
            <span className="ctr-pot-hint">↳ winner takes everything</span>
          </div>
          <RollingNumber
            value={pot?.potTokenAmount ?? "0"}
            decimals={quote?.tokenDecimals ?? 6}
            isZero={isPotZero}
          />
          <div className="ctr-pot-sub">
            <img className="ctr-pot-coin" src={`${ASSETS}icon-coin.png`} alt="" />
            <span className="ctr-pot-token">$PUMPBIRD</span>
            <span className="ctr-pot-usd-eq">≈</span>
            <span className="ctr-pot-usd">
              {potUsdDisplay !== null ? formatUsd(potUsdDisplay) : "$0.00"}
            </span>
          </div>
          <div className="ctr-pot-meta">
            <span>EPOCH {pot?.epoch ?? "—"}</span>
            <span>UPD {formatRelative(lastUpdateTs)}</span>
            <span>POLL {POLL_MS / 1000}s</span>
            <span>ORACLE {(quote?.priceSource ?? "—").toString().toUpperCase()}</span>
          </div>
        </div>

        <div className="ctr-hero-mascot">
          <div className="ctr-mascot-wrap">
            <img className="ctr-mascot" src={`${ASSETS}hero-bird.png`} alt="" />
            <div className="ctr-speech">
              <div className="ctr-speech-tag">
                {pot && pot.allTimeHighScore > 0
                  ? `BEAT ${pot.allTimeHighScore} — WIN EVERYTHING`
                  : "BE THE FIRST TO PLAY"}
              </div>
              <div className="ctr-speech-shout">CAN YOU TAKE IT?</div>
            </div>
          </div>
        </div>
      </section>

      {/* MID: KING + TICKER */}
      <section className="ctr-mid">
        <div className="ctr-king">
          <div className="ctr-section-head">
            <img className="ctr-icon" src={`${ASSETS}icon-crown.png`} alt="" />
            <span className="ctr-arcade">K I N G</span>
            <span className="ctr-line" />
            <span className="ctr-board-sub">↳ current champion</span>
          </div>
          <div className="ctr-king-body">
            <div className="ctr-king-portrait">
              <div className="ctr-king-corners">
                <span /><span /><span /><span />
              </div>
              {champion ? (
                <>
                  <img src={avatarUrl(champion.avatarId)} alt="" />
                  <img className="ctr-king-crown" src={`${ASSETS}icon-crown.png`} alt="" />
                </>
              ) : (
                <div className="ctr-king-empty">
                  <img className="ctr-king-empty-ic" src={`${ASSETS}icon-crown.png`} alt="" />
                  THRONE IS EMPTY
                </div>
              )}
            </div>
            <div className="ctr-king-meta">
              {championName ? (
                <div className="ctr-king-name">{championName}</div>
              ) : (
                <div className="ctr-king-name is-empty">NO KING YET</div>
              )}
              <div className="ctr-king-wallet">
                {champion?.wallet ? shortWallet(champion.wallet) : "first winner takes the crown"}
              </div>
              <div className="ctr-king-score-row">
                <div>
                  <div className="ctr-king-score-n">{pot?.allTimeHighScore ?? 0}</div>
                  <div className="ctr-king-score-l">LOCKED HIGH</div>
                </div>
                <div>
                  <div className="ctr-king-score-w">
                    {champion ? formatTokenInt(champion.totalWonTokens, quote?.tokenDecimals ?? 6) : "0"}
                  </div>
                  <div className="ctr-king-score-l">TOTAL WON $PB</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="ctr-ticker">
          <div className="ctr-section-head">
            <span className="ctr-arcade">POT.TICKER</span>
            <span className="ctr-line" />
            <span className="ctr-board-sub">↳ live data</span>
          </div>
          {/* Five rows, no duplicates: POT VAL repeated the hero's USD line
              and ORACLE repeated the hero meta — seven rows also overflowed
              the 320px band at the 1920x1080 design resolution, slicing the
              bottom row in half. */}
          <DataRow k="HIGH SCORE" v={String(pot?.allTimeHighScore ?? 0)} accent="pink" />
          <DataRow k="ENTRIES" v={thousands(String(pot?.totalEntries ?? 0))} />
          <DataRow
            k="BURN POOL"
            v={pot ? formatTokenInt(pot.treasuryTokenAmount, quote?.tokenDecimals ?? 6) : "0"}
            unit="$PB"
            accent="teal"
          />
          <DataRow
            k="$PB / USD"
            v={quote?.tokenUsd != null ? formatPrice(quote.tokenUsd) : "—"}
            unit="$"
            accent="pump"
          />
          <DataRow k="SOL / USD" v={quote?.solUsd != null ? formatPrice(quote.solUsd) : "—"} unit="$" />
        </div>
      </section>

      {/* BOARD: horizontal top-5 strip */}
      <section className="ctr-board">
        <div className="ctr-section-head">
          <span className="ctr-arcade">LEADERBOARD ⟂ TOP 5</span>
          <span className="ctr-line" />
          <span className="ctr-board-sub">↳ rank by best score</span>
        </div>
        <div className="ctr-board-cards">
          {board.length === 0 && (
            <div className="ctr-board-empty">
              {/* the coin, not the step-4 emblem — that one carries a baked-in
                  "4" badge that floated meaninglessly in the empty state */}
              <img src={`${ASSETS}icon-coin.png`} alt="" className="ctr-empty-emblem" />
              <span>NO ENTRIES YET · POT IS WAITING · PAY $1 · TAKE IT</span>
            </div>
          )}
          {board.slice(0, 5).map((row, i) => {
            const rankIcon =
              i === 0 ? "icon-crown.png" :
              i === 1 ? "icon-trophy.png" :
              i === 2 ? "icon-star.png" : null;
            return (
              <div key={row.wallet} className={`ctr-card r${i + 1}`}>
                <div className="ctr-card-rank">
                  {rankIcon ? (
                    <img src={`${ASSETS}${rankIcon}`} alt={`#${i + 1}`} />
                  ) : (
                    String(i + 1).padStart(2, "0")
                  )}
                </div>
                <div className="ctr-card-name-row">
                  <img className="ctr-card-av" src={avatarUrl(row.avatarId)} alt="" />
                  <span className="ctr-card-name">
                    {row.displayName ?? shortWallet(row.wallet)}
                  </span>
                </div>
                <div className="ctr-card-stats">
                  <div className="ctr-card-score">{row.bestScore}</div>
                  <div className="ctr-card-won">
                    {formatTokenInt(row.totalWonTokens, quote?.tokenDecimals ?? 6)}
                    <span className="ctr-card-won-u"> $PB</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* MARQUEE */}
      <div className="ctr-marquee" aria-hidden="true">
        <div className="ctr-marquee-track">
          {[...tickerItems, ...tickerItems].map((item, i) => (
            <span key={i} className="ctr-marquee-item">
              <span className="ctr-marquee-dot">●</span>
              {item}
            </span>
          ))}
        </div>
      </div>

      {error && <div className="ctr-error">{error}</div>}
    </div>
  );
}

// ─── RollingNumber ───
// Slot-machine odometer: the pot is padded to at least seven digits with DIM
// leading zeros, so the counter always spans the broadcast frame. A lone "0"
// used to leave ~25% of the 1920x1080 frame empty black and read like a
// watermark; now the zero state is an odometer at rest and a live pot lights
// its digits up left to right. Font size adapts so bigger pots never clip.
const MIN_ODOMETER_DIGITS = 7;

function RollingNumber({
  value,
  decimals,
  isZero
}: {
  value: string;
  decimals: number;
  isZero: boolean;
}) {
  const display = formatTokenInt(value, decimals);
  const digitCount = display.replace(/\D/g, "").length;
  const padCount = Math.max(0, MIN_ODOMETER_DIGITS - digitCount);
  const padded = thousands("0".repeat(padCount) + display.replace(/\D/g, ""));
  // Everything left of the significant part renders dim (zero pot: all dim).
  const liveFrom = isZero ? padded.length : padded.length - display.length;
  const chars = padded.split("");
  // ~0.55em per glyph in Space Grotesk bold; cap so 7-digit pots hit 208px at
  // 1920 wide and longer pots scale down instead of clipping. vh/vw guards
  // keep laptop and sub-1280 layouts intact (they used to rely on media
  // queries that an inline font-size would override).
  const fontPx = Math.min(208, Math.floor(1880 / chars.length));

  return (
    <div
      className={`ctr-pot-number${isZero ? " is-zero" : ""}`}
      style={{ fontSize: `min(${fontPx}px, 19vh, 12.5vw)` }}
    >
      {chars.map((ch, i) => {
        const dim = i < liveFrom ? " dim" : "";
        return /\d/.test(ch) ? (
          <span key={`d-${i}-${ch}`} className={`ctr-pot-digit${dim}`}>{ch}</span>
        ) : (
          <span key={`s-${i}`} className={`ctr-pot-sep${dim}`}>{ch}</span>
        );
      })}
    </div>
  );
}

function DataRow({
  k,
  v,
  unit,
  accent
}: {
  k: string;
  v: string;
  unit?: string;
  accent?: "pump" | "pink" | "teal";
}) {
  const cls =
    accent === "pump" ? "ctr-data-v is-pump" :
    accent === "pink" ? "ctr-data-v is-pink" :
    accent === "teal" ? "ctr-data-v is-teal" :
    "ctr-data-v";
  return (
    <div className="ctr-data-row">
      <span className="ctr-data-k">{k}</span>
      <span className={cls}>
        {v}
        {unit && <span className="ctr-data-v-unit">{unit}</span>}
      </span>
    </div>
  );
}

// ─── Helpers ───
function shortWallet(s: string): string {
  if (s.length <= 9) return s;
  return s.slice(0, 4) + "…" + s.slice(-4);
}

// Deterministic thousands separator — toLocaleString depends on the
// runtime's ICU data; a pure regex renders identically on server and client.
function thousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatTokenInt(raw: string, decimals: number): string {
  try {
    const big = BigInt(raw);
    const div = BigInt(10) ** BigInt(decimals);
    const whole = big / div;
    return thousands(whole.toString());
  } catch {
    return "0";
  }
}

function formatPrice(n: number): string {
  if (n >= 100) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toExponential(3);
}

function formatUsd(n: number): string {
  const fixed = n.toFixed(2);
  const dot = fixed.indexOf(".");
  return "$" + thousands(fixed.slice(0, dot)) + fixed.slice(dot);
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}
