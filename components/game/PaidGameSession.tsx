"use client";

// Full paid-entry game flow: connect → sign-in → quote → pay → play → submit.
// Owns all the network calls so the page just mounts <PaidGameSession />.

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/wallet/WalletProvider";
import { PumpBirdGame, type GameResult } from "./PumpBirdGame";
import { ApiError, apiGet, apiPost } from "@/lib/client/api";
import { buildEntryTransaction } from "@/lib/client/entry-tx";

type Quote = {
  // Sentinel — when `available: false`, no `amount`/`tokenUsd` fields are
  // present. The price oracle hasn't found a real $PUMPBIRD market yet (token
  // not launched or pre-graduation curve not seeded). Game can't open until
  // this flips to true.
  available?: boolean;
  reason?: string;
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
} {
  return (
    q.available !== false &&
    typeof q.tokenUsd === "number" &&
    typeof q.tokenDecimals === "number" &&
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
    tokenUsd: number;
    quoteExpiresAt: string;
    ticketExpiresAt: string;
  };
  payment: {
    tokenMint: string;
    tokenDecimals: number;
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
  settlement: Settlement | null;
};

type Phase =
  | { type: "idle" }
  | { type: "connecting" }
  | { type: "signing-in" }
  | { type: "quote-loading" }
  | { type: "ready"; quote: Quote }
  | { type: "creating-ticket" }
  | { type: "paying"; ticket: CreatedTicket }
  | { type: "confirming"; ticket: CreatedTicket; signature: string }
  | { type: "playing"; ticket: CreatedTicket }
  | { type: "submitting"; ticket: CreatedTicket; localResult: GameResult }
  | { type: "result"; ticket: CreatedTicket; submit: SubmitResponse }
  | { type: "error"; message: string };

const QUOTE_REFRESH_MS = 5_000;

export function PaidGameSession({ onExit }: { onExit?: () => void }) {
  const wallet = useWallet();
  const [phase, setPhase] = useState<Phase>({ type: "idle" });
  const quotePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setError = useCallback((message: string) => {
    setPhase({ type: "error", message });
  }, []);

  // Poll the quote while we're in idle/ready states
  const startQuotePoll = useCallback(async () => {
    const fetchQuote = async () => {
      try {
        const q = await apiGet<Quote>("/api/entry/quote");
        if (!isQuoteReady(q)) {
          setPhase((cur) =>
            cur.type === "ready" || cur.type === "quote-loading"
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
          cur.type === "ready" || cur.type === "quote-loading"
            ? { type: "ready", quote: q }
            : cur
        );
      } catch (e) {
        if (e instanceof ApiError && e.code === "price_unavailable") {
          setPhase((cur) =>
            cur.type === "ready" || cur.type === "quote-loading"
              ? { type: "error", message: "Price oracle is warming up. Token may not be launched yet." }
              : cur
          );
        } else {
          setPhase((cur) =>
            cur.type === "ready" || cur.type === "quote-loading"
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
  }, []);

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
      startQuotePoll();
    }
  }, [phase.type, startQuotePoll, wallet.authed, wallet.ready]);

  const handleConnect = useCallback(async () => {
    try {
      if (!wallet.installed) {
        window.open("https://phantom.app/", "_blank", "noopener");
        return;
      }
      setPhase({ type: "signing-in" });
      await wallet.signIn();
      await startQuotePoll();
    } catch (e) {
      setError((e as Error).message ?? "Sign-in failed");
    }
  }, [setError, startQuotePoll, wallet]);

  const handlePay = useCallback(async () => {
    if (phase.type !== "ready") return;
    if (!wallet.wallet) {
      await handleConnect();
      return;
    }
    stopQuotePoll();
    setPhase({ type: "creating-ticket" });
    let created: CreatedTicket;
    try {
      created = await apiPost<CreatedTicket>("/api/entry/create", { variant: "custom" });
    } catch (e) {
      setError(`Could not create entry ticket: ${(e as Error).message}`);
      return;
    }
    setPhase({ type: "paying", ticket: created });

    // Build + send tx
    let signature: string;
    try {
      const tx = buildEntryTransaction({
        wallet: wallet.wallet,
        tokenMint: created.payment.tokenMint,
        treasuryAta: created.payment.treasuryAta,
        amountRaw: BigInt(created.payment.amount.target),
        decimals: created.payment.tokenDecimals,
        memo: created.payment.memo
      });
      signature = await wallet.signAndSend(tx);
    } catch (e) {
      setError(`Wallet payment failed: ${(e as Error).message}`);
      return;
    }
    setPhase({ type: "confirming", ticket: created, signature });

    // Confirm with the backend — retries up to 20s in case Helius is a beat behind
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
          // Retry on transient "transaction_not_found" etc
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
    setPhase({ type: "playing", ticket: created });
  }, [handleConnect, phase, setError, stopQuotePoll, wallet]);

  const handleGameComplete = useCallback(
    async (result: GameResult) => {
      if (phase.type !== "playing") return;
      const ticket = phase.ticket;
      setPhase({ type: "submitting", ticket, localResult: result });
      try {
        const res = await apiPost<SubmitResponse>("/api/score/submit", {
          ticketId: ticket.ticket.id,
          taps: result.taps
        });
        setPhase({ type: "result", ticket, submit: res });
      } catch (e) {
        setError(`Could not submit score: ${(e as Error).message}`);
      }
    },
    [phase, setError]
  );

  const handleAgain = useCallback(async () => {
    setPhase({ type: "idle" });
    await startQuotePoll();
  }, [startQuotePoll]);

  // ─────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────
  if (phase.type === "playing") {
    return (
      <PumpBirdGame
        key={phase.ticket.ticket.id}
        mode="paid"
        seed={phase.ticket.ticket.seed}
        variant={phase.ticket.ticket.variant}
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
            busy={phase.type === "connecting" || phase.type === "signing-in"}
            onConnect={handleConnect}
          />
        ) : phase.type === "quote-loading" ? (
          <Loading text="Fetching $PUMPBIRD price…" />
        ) : phase.type === "ready" ? (
          <ReadyPanel quote={phase.quote} onPay={handlePay} onExit={onExit} />
        ) : phase.type === "creating-ticket" ? (
          <Loading text="Locking in your $1 quote…" />
        ) : phase.type === "paying" ? (
          <Loading text="Sign the transaction in Phantom…" />
        ) : phase.type === "confirming" ? (
          <Loading text="Confirming on Solana…" sub={`sig: ${phase.signature.slice(0, 10)}…`} />
        ) : phase.type === "submitting" ? (
          <Loading text="Submitting your score…" sub={`local: ${phase.localResult.score}`} />
        ) : phase.type === "result" ? (
          <ResultPanel res={phase.submit} onAgain={handleAgain} onExit={onExit} />
        ) : phase.type === "error" ? (
          <ErrorPanel
            message={phase.message}
            onRetry={() => {
              setPhase({ type: "idle" });
              startQuotePoll();
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
  padding: 24
};

const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 480,
  border: "2px solid rgba(0,255,65,0.4)",
  background: "rgba(7,18,7,0.85)",
  boxShadow: "0 0 28px rgba(0,255,65,0.25), 0 0 80px rgba(0,255,65,0.08)",
  padding: 28,
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
          ? "Connect your wallet to play for $1 worth of $PUMPBIRD."
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

function ReadyPanel({
  quote,
  onPay,
  onExit
}: {
  quote: Quote;
  onPay: () => void;
  onExit?: () => void;
}) {
  const target = quote.amount?.display?.target;
  const tokenAmount = typeof target === "number" ? formatNumber(target) : "—";
  const tokenUsd = quote.tokenUsd;
  const slippageBps = quote.slippageBps ?? 300;
  const ttlMs = quote.ttlMs ?? 10_000;
  return (
    <>
      <h2 style={h2Style}>Ready to Play</h2>
      <div style={priceBoxStyle}>
        <div style={{ fontSize: 11, color: "#ff2d78", letterSpacing: 1, marginBottom: 4 }}>
          ENTRY
        </div>
        <div style={{ fontSize: 22, color: "#00ff41", letterSpacing: 2 }}>$1.00 USD</div>
        <div style={{ fontSize: 14, color: "#d9ffd6", marginTop: 8 }}>
          = <strong style={{ color: "#00ff41" }}>{tokenAmount}</strong> $PUMPBIRD
        </div>
        <div style={{ fontSize: 9, color: "rgba(217,255,214,0.6)", marginTop: 8 }}>
          @ ${typeof tokenUsd === "number" ? formatPrice(tokenUsd) : "—"} / token · source: {quote.priceSource ?? "—"}
        </div>
        <div style={{ fontSize: 9, color: "rgba(217,255,214,0.6)", marginTop: 4 }}>
          slippage ±{(slippageBps / 100).toFixed(1)}% · quote refresh {Math.round(ttlMs / 1000)}s
        </div>
      </div>
      <button type="button" onClick={onPay} style={primaryBtnStyle}>
        ▶ Pay &amp; Play
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

function ResultPanel({
  res,
  onAgain,
  onExit
}: {
  res: SubmitResponse;
  onAgain: () => void;
  onExit?: () => void;
}) {
  const won =
    res.settlement?.kind === "settled" &&
    Number(res.settlement.payoutTokenAmount) > 0;
  return (
    <>
      <h2 style={h2Style}>{won ? "🏆 You Took the Pot!" : "REKT"}</h2>
      <div style={{ fontSize: 38, color: "#00ff41", margin: "12px 0", letterSpacing: 4 }}>
        {String(res.score).padStart(3, "0")}
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
      {!won && (
        <p style={metaStyle}>Score recorded. Your best updates if it&#39;s your personal high.</p>
      )}
      <button type="button" onClick={onAgain} style={primaryBtnStyle}>
        ↺ Play Again
      </button>
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
  fontSize: 22,
  letterSpacing: 3,
  margin: "0 0 16px"
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
