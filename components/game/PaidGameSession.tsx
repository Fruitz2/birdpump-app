"use client";

// Multi-life paid flow:
//   connect → sign-in → pick lives → quote → wallet payment → confirm
//   → play life 0 → submit → play life 1 → submit → … → all lives spent
//
// Players buy a "pack" of N lives in one tx (1, 5, 10, 25 by default), then
// each play consumes one life. Game-over → tap to continue with the next
// life. When the last life is spent, the user gets a buy-more prompt.
//
// Anti-cheat is preserved: each life's seed is seedForLife(ticket.seed, i)
// and the server validates lifeIndex is sequential.

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/wallet/WalletProvider";
import { PumpBirdGame, type GameResult } from "./PumpBirdGame";
import { ApiError, apiGet, apiPost } from "@/lib/client/api";
import { buildEntryTransaction } from "@/lib/client/entry-tx";
import { seedForLife } from "@/lib/game/simulator";

type Quote = {
  available?: boolean;
  reason?: string;
  lives?: number;
  perLifeUsdCents?: number;
  entryUsdCents?: number;
  tokenMint?: string;
  tokenDecimals?: number;
  tokenUsd?: number;
  tokenSol?: number;
  solUsd?: number;
  priceSource?: string;
  amount?: {
    target: string;
    min: string;
    max: string;
    display: { target: number; min: number; max: number };
  };
  slippageBps?: number;
  ttlMs?: number;
  treasury?: string | null;
  treasuryAta?: string | null;
  cluster?: string;
};

function isQuoteReady(q: Quote): q is Quote & {
  amount: NonNullable<Quote["amount"]>;
  tokenUsd: number;
  tokenDecimals: number;
  slippageBps: number;
  ttlMs: number;
  priceSource: string;
  perLifeUsdCents: number;
} {
  return (
    q.available !== false &&
    typeof q.tokenUsd === "number" &&
    typeof q.tokenDecimals === "number" &&
    typeof q.perLifeUsdCents === "number" &&
    q.amount?.display?.target !== undefined
  );
}

type CreatedTicket = {
  ticket: {
    id: string;
    variant: "forked" | "custom";
    seed: string;
    memo: string;
    status: "pending";
    entryUsdCents: number;
    perLifeUsdCents: number;
    lives: number;
    tokenUsd: number;
    quoteExpiresAt: string;
    ticketExpiresAt: string;
  };
  payment: {
    tokenMint: string;
    tokenDecimals: number;
    tokenProgram?: string | null;
    treasury: string;
    treasuryAta: string;
    amount: { target: string; min: string; max: string; display: number };
    memo: string;
    cluster: string;
  };
};

type Settlement =
  | {
      kind: "settled";
      settlementId: string;
      payoutTokenAmount: string;
      payoutSignature: string | null;
      payoutStatus: "sent" | "failed" | "confirmed";
    }
  | { kind: "skipped"; reason: string };

type SubmitResponse = {
  scoreId: string;
  score: number;
  ticks: number;
  tapsCount: number;
  checksum: string;
  lifeIndex: number;
  livesRemaining: number;
  lastLife: boolean;
  settlement: Settlement | null;
};

type Phase =
  | { type: "idle" }
  | { type: "signing-in" }
  | { type: "quote-loading" }
  | { type: "pick-lives"; quote: Quote }
  | { type: "creating-ticket"; lives: number }
  | { type: "paying"; ticket: CreatedTicket }
  | { type: "confirming"; ticket: CreatedTicket; signature: string }
  | { type: "in-game"; ticket: CreatedTicket; lifeIndex: number; autoStart: boolean }
  | {
      type: "submitting-life";
      ticket: CreatedTicket;
      lifeIndex: number;
      localResult: GameResult;
    }
  | {
      type: "life-result";
      ticket: CreatedTicket;
      submit: SubmitResponse;
    }
  | { type: "error"; message: string };

const QUOTE_REFRESH_MS = 8_000;
const LIFE_OPTIONS = [1, 5, 10, 25];

export function PaidGameSession({ onExit }: { onExit?: () => void }) {
  const wallet = useWallet();
  const [phase, setPhase] = useState<Phase>({ type: "idle" });
  const [selectedLives, setSelectedLives] = useState<number>(5);
  const quotePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setError = useCallback((message: string) => {
    setPhase({ type: "error", message });
  }, []);

  const startQuotePoll = useCallback(
    async (lives: number) => {
      const fetchQuote = async () => {
        try {
          const q = await apiGet<Quote>(`/api/entry/quote?lives=${lives}`);
          if (!isQuoteReady(q)) {
            setPhase((cur) =>
              cur.type === "pick-lives" || cur.type === "quote-loading"
                ? {
                    type: "error",
                    message:
                      "Game opens once $PUMPBIRD is live on pump.fun. Hang tight — the token oracle isn't seeded yet."
                  }
                : cur
            );
            return;
          }
          setPhase((cur) =>
            cur.type === "pick-lives" || cur.type === "quote-loading"
              ? { type: "pick-lives", quote: q }
              : cur
          );
        } catch (e) {
          if (e instanceof ApiError && e.code === "price_unavailable") {
            setPhase((cur) =>
              cur.type === "pick-lives" || cur.type === "quote-loading"
                ? { type: "error", message: "Price oracle is warming up. Token may not be launched yet." }
                : cur
            );
          } else {
            setPhase((cur) =>
              cur.type === "pick-lives" || cur.type === "quote-loading"
                ? { type: "error", message: (e as Error).message }
                : cur
            );
          }
        }
      };
      setPhase({ type: "quote-loading" });
      await fetchQuote();
      if (quotePollRef.current) clearInterval(quotePollRef.current);
      quotePollRef.current = setInterval(fetchQuote, QUOTE_REFRESH_MS);
    },
    []
  );

  const stopQuotePoll = useCallback(() => {
    if (quotePollRef.current) {
      clearInterval(quotePollRef.current);
      quotePollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopQuotePoll(), [stopQuotePoll]);

  // Drive auth state → next phase
  useEffect(() => {
    if (!wallet.ready) return;
    if (phase.type === "idle" && wallet.authed) {
      startQuotePoll(selectedLives);
    }
  }, [phase.type, selectedLives, startQuotePoll, wallet.authed, wallet.ready]);

  const handleConnect = useCallback(async () => {
    try {
      if (!wallet.installed) {
        window.open("https://phantom.app/", "_blank", "noopener");
        return;
      }
      setPhase({ type: "signing-in" });
      await wallet.signIn();
      await startQuotePoll(selectedLives);
    } catch (e) {
      setError((e as Error).message ?? "Sign-in failed");
    }
  }, [selectedLives, setError, startQuotePoll, wallet]);

  // Recompute quote when lives selection changes
  const handleSelectLives = useCallback(
    (lives: number) => {
      setSelectedLives(lives);
      if (wallet.authed) {
        startQuotePoll(lives);
      }
    },
    [startQuotePoll, wallet.authed]
  );

  const handlePay = useCallback(async () => {
    if (phase.type !== "pick-lives") return;
    if (!wallet.wallet) {
      await handleConnect();
      return;
    }
    stopQuotePoll();
    const lives = selectedLives;
    setPhase({ type: "creating-ticket", lives });
    let created: CreatedTicket;
    try {
      created = await apiPost<CreatedTicket>("/api/entry/create", {
        variant: "custom",
        lives
      });
    } catch (e) {
      setError(`Could not create entry ticket: ${(e as Error).message}`);
      return;
    }
    setPhase({ type: "paying", ticket: created });

    let signature: string;
    try {
      const tx = buildEntryTransaction({
        wallet: wallet.wallet,
        tokenMint: created.payment.tokenMint,
        treasuryAta: created.payment.treasuryAta,
        amountRaw: BigInt(created.payment.amount.target),
        decimals: created.payment.tokenDecimals,
        memo: created.payment.memo,
        tokenProgram: created.payment.tokenProgram
      });
      signature = await wallet.signAndSend(tx);
    } catch (e) {
      setError(`Wallet payment failed: ${(e as Error).message}`);
      return;
    }
    setPhase({ type: "confirming", ticket: created, signature });

    const start = Date.now();
    let confirmed = false;
    let lastErr = "";
    while (!confirmed && Date.now() - start < 25_000) {
      try {
        await apiPost("/api/entry/confirm", {
          ticketId: created.ticket.id,
          signature
        });
        confirmed = true;
      } catch (e) {
        if (e instanceof ApiError) {
          if (
            e.code === "payment_invalid" &&
            typeof e.details === "object" &&
            e.details !== null &&
            "message" in e.details &&
            typeof (e.details as { message?: string }).message === "string" &&
            (e.details as { message: string }).message.includes("transaction_not_found")
          ) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          lastErr = `${e.code}${e.message ? `: ${e.message}` : ""}`;
        } else {
          lastErr = (e as Error).message ?? "unknown";
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!confirmed) {
      setError(`Could not confirm payment: ${lastErr || "timeout"}. Refresh to try again.`);
      return;
    }
    setPhase({ type: "in-game", ticket: created, lifeIndex: 0, autoStart: false });
  }, [handleConnect, phase.type, selectedLives, setError, stopQuotePoll, wallet]);

  const handleGameComplete = useCallback(
    async (result: GameResult) => {
      if (phase.type !== "in-game") return;
      const { ticket, lifeIndex } = phase;
      setPhase({ type: "submitting-life", ticket, lifeIndex, localResult: result });
      try {
        const res = await apiPost<SubmitResponse>("/api/score/submit", {
          ticketId: ticket.ticket.id,
          taps: result.taps,
          lifeIndex
        });
        setPhase({ type: "life-result", ticket, submit: res });
      } catch (e) {
        setError(`Could not submit score: ${(e as Error).message}`);
      }
    },
    [phase, setError]
  );

  // After a life ends and is submitted, "next life" mounts the game again
  // with the next life's seed. Auto-starts so the user doesn't have to tap
  // through a start screen between lives.
  const handleNextLife = useCallback(() => {
    if (phase.type !== "life-result") return;
    if (phase.submit.lastLife) return;
    const nextLifeIndex = phase.submit.lifeIndex + 1;
    setPhase({
      type: "in-game",
      ticket: phase.ticket,
      lifeIndex: nextLifeIndex,
      autoStart: true
    });
  }, [phase]);

  const handleBuyMore = useCallback(async () => {
    stopQuotePoll();
    await startQuotePoll(selectedLives);
  }, [selectedLives, startQuotePoll, stopQuotePoll]);

  // ─── Render ───
  if (phase.type === "in-game") {
    const lifeSeed = seedForLife(phase.ticket.ticket.seed, phase.lifeIndex);
    return (
      <PumpBirdGame
        key={`${phase.ticket.ticket.id}:${phase.lifeIndex}`}
        mode="paid"
        seed={lifeSeed}
        variant={phase.ticket.ticket.variant}
        autoStart={phase.autoStart}
        onComplete={handleGameComplete}
        onExit={onExit}
      />
    );
  }

  return (
    <div style={shellStyle}>
      <div style={cardStyle}>
        {!wallet.authed ? (
          <ConnectPanel
            installed={wallet.installed}
            busy={phase.type === "signing-in"}
            onConnect={handleConnect}
          />
        ) : phase.type === "quote-loading" ? (
          <Loading text="Fetching $PUMPBIRD price…" />
        ) : phase.type === "pick-lives" ? (
          <PickLivesPanel
            quote={phase.quote}
            selectedLives={selectedLives}
            onSelectLives={handleSelectLives}
            onPay={handlePay}
            onExit={onExit}
          />
        ) : phase.type === "creating-ticket" ? (
          <Loading text={`Locking in your ${phase.lives}-life pack…`} />
        ) : phase.type === "paying" ? (
          <Loading text="Sign the transaction in Phantom…" />
        ) : phase.type === "confirming" ? (
          <Loading text="Confirming on Solana…" sub={`sig: ${phase.signature.slice(0, 10)}…`} />
        ) : phase.type === "submitting-life" ? (
          <Loading
            text={`Submitting score for life ${phase.lifeIndex + 1}…`}
            sub={`local: ${phase.localResult.score}`}
          />
        ) : phase.type === "life-result" ? (
          <LifeResultPanel
            res={phase.submit}
            ticketLivesTotal={phase.ticket.ticket.lives}
            onNextLife={handleNextLife}
            onBuyMore={handleBuyMore}
            onExit={onExit}
          />
        ) : phase.type === "error" ? (
          <ErrorPanel
            message={phase.message}
            onRetry={() => {
              setPhase({ type: "idle" });
              startQuotePoll(selectedLives);
            }}
            onExit={onExit}
          />
        ) : (
          <Loading text="…" />
        )}
      </div>
    </div>
  );
}

const shellStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#030a03",
  fontFamily: "'Oxanium', 'Rajdhani', system-ui, sans-serif",
  color: "#d9ffd6",
  padding: 24,
  overflow: "auto"
};

const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 480,
  border: "2px solid rgba(0,255,65,0.4)",
  background: "rgba(7,18,7,0.85)",
  boxShadow: "0 0 28px rgba(0,255,65,0.25), 0 0 80px rgba(0,255,65,0.08)",
  padding: 24,
  borderRadius: 6,
  textAlign: "center"
};

function ConnectPanel({
  installed,
  busy,
  onConnect
}: {
  installed: boolean;
  busy: boolean;
  onConnect: () => void;
}) {
  return (
    <>
      <h2 style={h2Style}>Pump.Bird</h2>
      <p style={bodyStyle}>
        {installed
          ? "Connect your wallet to buy a pack of lives in $PUMPBIRD."
          : "Phantom wallet required."}
      </p>
      <button type="button" disabled={busy} onClick={onConnect} style={primaryBtnStyle}>
        {busy ? "…" : installed ? "Connect & Sign In" : "Get Phantom ↗"}
      </button>
      <p style={{ ...metaStyle, marginTop: 14 }}>
        We use a one-time signature to prove wallet ownership. No SOL is spent on sign-in.
      </p>
    </>
  );
}

function PickLivesPanel({
  quote,
  selectedLives,
  onSelectLives,
  onPay,
  onExit
}: {
  quote: Quote;
  selectedLives: number;
  onSelectLives: (n: number) => void;
  onPay: () => void;
  onExit?: () => void;
}) {
  const targetDisplay = quote.amount?.display?.target;
  const tokenUsd = quote.tokenUsd;
  const totalUsd =
    typeof quote.entryUsdCents === "number" ? quote.entryUsdCents / 100 : selectedLives;
  return (
    <>
      <h2 style={h2Style}>Pick Your Pack</h2>
      <p style={{ ...metaStyle, marginBottom: 14 }}>
        ONE transaction. The pot grows with every play.
      </p>
      <div style={livesGridStyle}>
        {LIFE_OPTIONS.map((n) => {
          const active = n === selectedLives;
          return (
            <button
              key={n}
              type="button"
              onClick={() => onSelectLives(n)}
              style={{ ...livesBtnStyle, ...(active ? livesBtnActiveStyle : {}) }}
            >
              <span style={{ fontSize: 22, fontFamily: "'Press Start 2P', monospace" }}>
                {n}
              </span>
              <span style={{ fontSize: 9, opacity: 0.7, marginTop: 4 }}>
                {n === 1 ? "LIFE" : "LIVES"}
              </span>
              <span
                style={{
                  fontSize: 10,
                  marginTop: 6,
                  color: active ? "#65ff48" : "#d9ffd6",
                  fontWeight: 700
                }}
              >
                ${(n * 1).toFixed(0)}
              </span>
            </button>
          );
        })}
      </div>
      <div style={priceBoxStyle}>
        <div style={{ fontSize: 11, color: "#ff2d78", letterSpacing: 1, marginBottom: 4 }}>
          TOTAL
        </div>
        <div style={{ fontSize: 26, color: "#00ff41", letterSpacing: 2 }}>
          ${totalUsd.toFixed(2)} USD
        </div>
        <div style={{ fontSize: 14, color: "#d9ffd6", marginTop: 8 }}>
          = <strong style={{ color: "#00ff41" }}>
            {typeof targetDisplay === "number" ? formatNumber(targetDisplay) : "—"}
          </strong>{" "}
          $PUMPBIRD
        </div>
        <div style={{ fontSize: 9, color: "rgba(217,255,214,0.55)", marginTop: 8 }}>
          @ ${typeof tokenUsd === "number" ? formatPrice(tokenUsd) : "—"} / token · source:{" "}
          {quote.priceSource ?? "—"}
        </div>
      </div>
      <button type="button" onClick={onPay} style={primaryBtnStyle}>
        ▶ Pay &amp; Play {selectedLives} {selectedLives === 1 ? "Game" : "Games"}
      </button>
      <p style={metaStyle}>
        75% of every entry feeds the pot. 25% goes to the buyback &amp; burn treasury.
      </p>
      {onExit && (
        <button type="button" onClick={onExit} style={ghostBtnStyle}>
          ◂ Back
        </button>
      )}
    </>
  );
}

function Loading({ text, sub }: { text: string; sub?: string }) {
  return (
    <>
      <div style={{ ...h2Style, animation: "pb-blink 1s step-end infinite" }}>{text}</div>
      {sub && <p style={metaStyle}>{sub}</p>}
      <style jsx>{`
        @keyframes pb-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
      `}</style>
    </>
  );
}

function LifeResultPanel({
  res,
  ticketLivesTotal,
  onNextLife,
  onBuyMore,
  onExit
}: {
  res: SubmitResponse;
  ticketLivesTotal: number;
  onNextLife: () => void;
  onBuyMore: () => void;
  onExit?: () => void;
}) {
  const won =
    res.settlement?.kind === "settled" &&
    Number(res.settlement.payoutTokenAmount) > 0;
  return (
    <>
      <h2 style={h2Style}>
        {won
          ? "🏆 You Took the Pot!"
          : res.lastLife
          ? "Last Life Spent"
          : "Life Ended"}
      </h2>
      <div style={{ fontSize: 38, color: "#00ff41", margin: "8px 0", letterSpacing: 4 }}>
        {String(res.score).padStart(3, "0")}
      </div>
      <div
        style={{
          fontSize: 10,
          color: res.lastLife ? "#ff2d78" : "#d9ffd6",
          letterSpacing: 2,
          marginBottom: 18
        }}
      >
        LIFE {res.lifeIndex + 1} / {ticketLivesTotal} · {res.livesRemaining} LEFT
      </div>
      {won && res.settlement?.kind === "settled" && (
        <div style={priceBoxStyle}>
          <div style={{ fontSize: 11, color: "#ff2d78", letterSpacing: 1, marginBottom: 4 }}>
            PRIZE
          </div>
          <div style={{ fontSize: 18, color: "#00ff41" }}>
            {formatTokenRaw(res.settlement.payoutTokenAmount, 6)} $PUMPBIRD
          </div>
          {res.settlement.payoutSignature && (
            <a
              href={`https://solscan.io/tx/${res.settlement.payoutSignature}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 9, color: "#16d6a2", marginTop: 8, display: "inline-block" }}
            >
              View payout ↗
            </a>
          )}
        </div>
      )}
      {!res.lastLife ? (
        <button type="button" onClick={onNextLife} style={primaryBtnStyle}>
          ▶ Next Life ({res.livesRemaining} left)
        </button>
      ) : (
        <button type="button" onClick={onBuyMore} style={primaryBtnStyle}>
          ↺ Buy Another Pack
        </button>
      )}
      {onExit && (
        <button type="button" onClick={onExit} style={ghostBtnStyle}>
          ◂ Done
        </button>
      )}
    </>
  );
}

function ErrorPanel({
  message,
  onRetry,
  onExit
}: {
  message: string;
  onRetry: () => void;
  onExit?: () => void;
}) {
  return (
    <>
      <h2 style={{ ...h2Style, color: "#ff2d78", textShadow: "0 0 10px #ff2d78" }}>Error</h2>
      <p style={{ ...bodyStyle, color: "#ff2d78" }}>{message}</p>
      <button type="button" onClick={onRetry} style={primaryBtnStyle}>
        ↺ Retry
      </button>
      {onExit && (
        <button type="button" onClick={onExit} style={ghostBtnStyle}>
          ◂ Exit
        </button>
      )}
    </>
  );
}

const h2Style: React.CSSProperties = {
  fontFamily: "'Press Start 2P', monospace",
  color: "#00ff41",
  textShadow: "0 0 10px #00ff41, 0 0 20px #00ff41",
  fontSize: 20,
  letterSpacing: 3,
  margin: "0 0 14px"
};

const bodyStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#d9ffd6",
  margin: "0 0 18px"
};

const metaStyle: React.CSSProperties = {
  fontSize: 10,
  color: "rgba(217,255,214,0.55)",
  margin: "10px 0 0"
};

const priceBoxStyle: React.CSSProperties = {
  border: "2px solid rgba(0,255,65,0.4)",
  background: "rgba(0,255,65,0.05)",
  padding: 16,
  margin: "0 0 18px",
  borderRadius: 4
};

const primaryBtnStyle: React.CSSProperties = {
  fontFamily: "'Press Start 2P', monospace",
  fontSize: 12,
  background: "rgba(0,255,65,0.12)",
  border: "3px solid #00ff41",
  color: "#00ff41",
  textShadow: "0 0 8px #00ff41",
  padding: "14px 24px",
  letterSpacing: 2,
  margin: "4px 0 0",
  width: "100%",
  cursor: "pointer"
};

const ghostBtnStyle: React.CSSProperties = {
  fontFamily: "'Rajdhani', sans-serif",
  fontSize: 12,
  background: "transparent",
  border: "1px solid rgba(217,255,214,0.3)",
  color: "rgba(217,255,214,0.7)",
  padding: "10px 18px",
  letterSpacing: 1,
  marginTop: 12,
  width: "100%",
  cursor: "pointer"
};

const livesGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 8,
  marginBottom: 16
};

const livesBtnStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "14px 8px",
  background: "rgba(8, 10, 7, 0.7)",
  border: "2px solid rgba(217,255,214,0.18)",
  color: "#d9ffd6",
  fontFamily: "'Rajdhani', sans-serif",
  cursor: "pointer",
  borderRadius: 4,
  letterSpacing: 1
};

const livesBtnActiveStyle: React.CSSProperties = {
  borderColor: "#00ff41",
  background: "rgba(0,255,65,0.12)",
  boxShadow: "0 0 16px rgba(0,255,65,0.4)"
};

function formatNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatPrice(n: number): string {
  if (n >= 0.01) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toExponential(3);
}

function formatTokenRaw(raw: string, decimals: number): string {
  try {
    const big = BigInt(raw);
    const div = BigInt(10) ** BigInt(decimals);
    const whole = big / div;
    return whole.toLocaleString("en-US");
  } catch {
    return raw;
  }
}
