"use client";

// Landing page — full conversion of the supplied index.html. CSS stays in
// app/landing.css verbatim so the design is preserved exactly. Dynamic data
// (pot, leaderboard, $PUMPBIRD price, wallet connect) is wired into the
// backend API via the same Authorization scheme the game flow uses.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useWallet } from "@/components/wallet/WalletProvider";
import { apiGet } from "@/lib/client/api";
import { avatarUrl } from "@/lib/profile/avatars";
import {
  PumpBirdGame,
  toggleGlobalSound,
  useSoundPref,
  type GameResult
} from "@/components/game/PumpBirdGame";
import { PaidGameSession } from "@/components/game/PaidGameSession";
import { FAQ_ITEMS } from "@/components/landing/faq-data";

type GameMode = "idle" | "fun" | "paid";

function makeFunSeed(): string {
  return "fun:" + Math.random().toString(36).slice(2, 12) + ":" + Date.now();
}

type Pot = {
  pot: {
    potTokenAmount: string;
    allTimeHighScore: number;
    allTimeHighWallet: string | null;
    totalEntries?: number;
  };
};
type Leaderboard = {
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
type Quote = {
  available?: boolean;
  tokenUsd?: number;
  tokenDecimals?: number;
  amount?: { display?: { target?: number } };
};

const POT_POLL_MS = 5_000;
const BOARD_POLL_MS = 15_000;
const QUOTE_POLL_MS = 30_000;

const BASE_ASSETS = "/assets/pumpbird/";

function short(s: string): string {
  return s.length > 8 ? s.slice(0, 4) + "…" + s.slice(-4) : s;
}

// Deterministic thousands separator. toLocaleString depends on the runtime's
// ICU data, which is one server/client formatting drift away from a hydration
// mismatch — a pure regex formats identically everywhere.
function thousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtUsd(n: number): string {
  const fixed = n.toFixed(2);
  const dot = fixed.indexOf(".");
  return "$" + thousands(fixed.slice(0, dot)) + fixed.slice(dot);
}

function fmtTokenRaw(raw: string, decimals: number): string {
  try {
    const big = BigInt(raw);
    const div = BigInt(10) ** BigInt(decimals);
    const whole = big / div;
    const n = Number(whole);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return thousands(whole.toString());
  } catch {
    return "—";
  }
}

function fmtNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return thousands(String(Math.floor(n)));
}

function fmtPrice(n: number): string {
  if (n >= 100) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(4);
  if (n >= 0.0001) return "$" + n.toFixed(6);
  return "$" + n.toExponential(2);
}

export function LandingClient() {
  const wallet = useWallet();
  const [pot, setPot] = useState<Pot["pot"] | null>(null);
  const [board, setBoard] = useState<Leaderboard["leaderboard"]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The game's persisted audio pref through a hydration-safe external store —
  // header button, in-game toggle and the M key all read/write the same value.
  const soundOn = useSoundPref();
  const [activeSection, setActiveSection] = useState("top");
  const [walletBusy, setWalletBusy] = useState(false);
  const [gameMode, setGameMode] = useState<GameMode>("idle");
  const [funSeed, setFunSeed] = useState<string>(() => makeFunSeed());
  const [funScore, setFunScore] = useState<number | null>(null);
  // When true, the fun game starts playing immediately instead of showing
  // a START GAME overlay — set when the user clicks the cabinet placeholder
  // so the "tap to enter" gesture turns into actually entering.
  const [funAutoStart, setFunAutoStart] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const hamburgerRef = useRef<HTMLButtonElement | null>(null);

  // ─────────────────────────────────────────
  // Live data polling
  // ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const [p, l, q] = await Promise.all([
        apiGet<Pot>("/api/pot").catch(() => null),
        apiGet<Leaderboard>("/api/leaderboard?limit=10").catch(() => null),
        apiGet<Quote>("/api/entry/quote").catch(() => null)
      ]);
      if (cancelled) return;
      if (p) setPot(p.pot);
      if (l) setBoard(l.leaderboard);
      // Only keep quote if it has a real price — the dev/pre-launch sentinel
      // `{ available: false }` would crash the price-display reads otherwise.
      if (q && q.available !== false && typeof q.tokenUsd === "number") {
        setQuote(q);
      } else {
        setQuote(null);
      }
    }
    refresh();
    const potId = setInterval(async () => {
      const p = await apiGet<Pot>("/api/pot").catch(() => null);
      if (!cancelled && p) setPot(p.pot);
    }, POT_POLL_MS);
    const boardId = setInterval(async () => {
      const l = await apiGet<Leaderboard>("/api/leaderboard?limit=10").catch(() => null);
      if (!cancelled && l) setBoard(l.leaderboard);
    }, BOARD_POLL_MS);
    const quoteId = setInterval(async () => {
      const q = await apiGet<Quote>("/api/entry/quote").catch(() => null);
      if (cancelled) return;
      if (q && q.available !== false && typeof q.tokenUsd === "number") {
        setQuote(q);
      } else {
        setQuote(null);
      }
    }, QUOTE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(potId);
      clearInterval(boardId);
      clearInterval(quoteId);
    };
  }, []);

  // ─────────────────────────────────────────
  // Scroll spy for active nav
  // ─────────────────────────────────────────
  useEffect(() => {
    function onScroll() {
      const ids = ["top", "play", "how", "leaderboard", "faq"];
      const y = window.pageYOffset + 120;
      let cur = "top";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.offsetTop <= y) cur = id;
      }
      setActiveSection(cur);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ─────────────────────────────────────────
  // Reveal-on-scroll
  // ─────────────────────────────────────────
  useEffect(() => {
    if (!("IntersectionObserver" in window)) {
      document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // ─────────────────────────────────────────
  // Toast
  // ─────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const handleSoundToggle = useCallback(() => {
    const on = toggleGlobalSound();
    showToast(on ? "Game audio on" : "Game audio muted");
  }, [showToast]);

  // M mutes from anywhere on the landing page, not only once a game cabinet
  // has mounted. Active only while no game is mounted — the game binds its
  // own M handler and two listeners would cancel each other out.
  useEffect(() => {
    if (gameMode !== "idle") return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyM" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      handleSoundToggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gameMode, handleSoundToggle]);

  // Drawer: lock body scroll, close with Escape, move focus into the dialog
  // (and trap Tab inside it) while open, restore focus to the hamburger on
  // close — aria-modal was previously claimed without any of this.
  useEffect(() => {
    if (drawerOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      const panel = drawerPanelRef.current;
      panel?.querySelector<HTMLElement>(".drawer-close")?.focus();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setDrawerOpen(false);
          return;
        }
        if (e.key === "Tab" && panel) {
          const els = Array.from(
            panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")
          ).filter((el) => el.offsetParent !== null);
          if (els.length === 0) return;
          const first = els[0];
          const last = els[els.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      };
      window.addEventListener("keydown", onKey);
      return () => {
        document.body.style.overflow = prev;
        window.removeEventListener("keydown", onKey);
        hamburgerRef.current?.focus();
      };
    }
    return undefined;
  }, [drawerOpen]);

  // ─────────────────────────────────────────
  // Wallet button
  // ─────────────────────────────────────────
  const scrollToArena = useCallback(() => {
    const arena = document.getElementById("play");
    if (arena) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({
        top: arena.getBoundingClientRect().top + window.pageYOffset - 70,
        behavior: reduced ? "auto" : "smooth"
      });
    }
  }, []);

  const handlePlayPaid = useCallback(async () => {
    setDrawerOpen(false);
    setGameMode("paid");
    setFunScore(null);
    scrollToArena();
    if (!wallet.authed && wallet.installed) {
      try {
        setWalletBusy(true);
        await wallet.signIn();
      } catch {
        /* signIn surfaces its own error */
      } finally {
        setWalletBusy(false);
      }
    }
  }, [scrollToArena, wallet]);

  const handlePlayFun = useCallback(() => {
    setDrawerOpen(false);
    setFunScore(null);
    setFunSeed(makeFunSeed());
    setFunAutoStart(false);
    setGameMode("fun");
    scrollToArena();
  }, [scrollToArena]);

  // Click on cabinet placeholder → mount fun game AND auto-start it.
  // One tap to play — matches the "TAP PLAY TO ENTER" cue.
  const handleCabinetClick = useCallback(() => {
    setFunScore(null);
    setFunSeed(makeFunSeed());
    setFunAutoStart(true);
    setGameMode("fun");
  }, []);

  const exitGame = useCallback(() => {
    setGameMode("idle");
    setFunScore(null);
  }, []);

  const handleFunComplete = useCallback((r: GameResult) => {
    setFunScore(r.score);
  }, []);

  const handleWallet = useCallback(async () => {
    if (walletBusy) return;
    setWalletBusy(true);
    try {
      if (!wallet.installed) {
        window.open("https://phantom.app/", "_blank", "noopener");
        showToast("Phantom not found — opening phantom.app");
        return;
      }
      if (wallet.authed) {
        await wallet.disconnect();
        showToast("Wallet disconnected");
        return;
      }
      showToast("Approve in Phantom to sign in…");
      await wallet.signIn();
      showToast("Signed in — you're ready to play");
    } catch (e) {
      const msg = (e as Error).message || "Wallet error";
      // Common Phantom rejections look nicer with context
      if (/User rejected|user denied|user_rejected/i.test(msg)) {
        showToast("Sign-in cancelled");
      } else {
        showToast(`Sign-in failed: ${msg}`);
      }
      console.error("[wallet] sign-in error:", e);
    } finally {
      setWalletBusy(false);
    }
  }, [showToast, wallet, walletBusy]);

  // ─────────────────────────────────────────
  // Derived display values.
  // "—" is reserved for "still loading". A real zero pot reads "$0.00" and a
  // funded pot with no oracle quote yet falls back to the raw token amount,
  // so pre-launch never looks broken.
  // ─────────────────────────────────────────
  const potUsdDisplay = (() => {
    if (!pot) return "—";
    try {
      const raw = BigInt(pot.potTokenAmount);
      if (raw === BigInt(0)) return "$0.00";
      if (!quote || typeof quote.tokenUsd !== "number" || typeof quote.tokenDecimals !== "number") {
        return `${fmtTokenRaw(pot.potTokenAmount, 6)} $PB`;
      }
      const div = BigInt(10) ** BigInt(quote.tokenDecimals);
      const whole = Number(raw / div);
      return fmtUsd(whole * quote.tokenUsd);
    } catch {
      return "—";
    }
  })();
  const potTokenDisplay = pot ? fmtTokenRaw(pot.potTokenAmount, quote?.tokenDecimals ?? 6) : "0";
  const potZero = (() => {
    if (!pot) return false;
    try {
      return BigInt(pot.potTokenAmount) === BigInt(0);
    } catch {
      return false;
    }
  })();
  const champion = board[0] ?? null;
  const championName = champion?.displayName ?? (champion?.wallet ? short(champion.wallet) : "Unclaimed");
  const highscore = pot?.allTimeHighScore ?? 0;
  const totalEntries = pot?.totalEntries ?? 0;
  const playAmtTarget = quote?.amount?.display?.target;
  const playAmt = typeof playAmtTarget === "number" ? `${fmtNumber(playAmtTarget)} $PUMPBIRD` : null;

  // Hero pot caption — reads differently while loading / pre-launch / live.
  const heroPotSub = !pot
    ? "connecting to the vault"
    : potZero
    ? "seeded at launch · every $1 entry feeds it"
    : quote
    ? `${potTokenDisplay} $PB in the vault · winner takes 100%`
    : "winner takes 100% · paid straight to your wallet";

  // Ticker — live data, not slogans. Until the first poll lands the list is
  // deterministic (server and client render the same fallback items).
  const tickerItems: Array<{ t: string; icon: "coin" | "bird" }> = pot
    ? [
        { t: `POT ${potUsdDisplay}`, icon: "coin" },
        {
          t: highscore > 0 ? `HIGH SCORE TO BEAT ${highscore}` : "FIRST RUN SETS THE HIGHSCORE",
          icon: "bird"
        },
        { t: champion ? `CHAMPION ${championName.toUpperCase()}` : "THRONE IS EMPTY", icon: "coin" },
        ...(totalEntries > 0 ? [{ t: `${fmtNumber(totalEntries)} ENTRIES PLAYED`, icon: "bird" as const }] : []),
        ...(quote && typeof quote.tokenUsd === "number"
          ? [{ t: `$PUMPBIRD ${fmtPrice(quote.tokenUsd)}`, icon: "coin" as const }]
          : []),
        { t: "EVERY RUN SERVER-VERIFIED", icon: "bird" },
        { t: "$1 = ONE LIFE", icon: "coin" }
      ]
    : [
        { t: "THE HIGHSCORE TAKES THE POT", icon: "coin" },
        { t: "$1 = ONE LIFE", icon: "bird" },
        { t: "EVERY RUN SERVER-VERIFIED", icon: "coin" },
        { t: "BUILT ON PUMP.FUN", icon: "bird" }
      ];

  return (
    <>
      <div className="bg-fx" />
      <div className="scanlines" />

      {/* HEADER */}
      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href="#top" aria-label="Pump.Bird home">
            <Image src={`${BASE_ASSETS}logo.png`} alt="PUMP.BIRD" width={140} height={40} unoptimized priority />
          </a>
          <nav className="nav-desktop" aria-label="Primary">
            <a href="#top" className={activeSection === "top" ? "active" : ""}>Home</a>
            <a href="#play" className={activeSection === "play" ? "active" : ""}>Play</a>
            <a href="#leaderboard" className={activeSection === "leaderboard" ? "active" : ""}>Leaderboard</a>
            <a href="#how" className={activeSection === "how" ? "active" : ""}>How It Works</a>
            <a href="#faq" className={activeSection === "faq" ? "active" : ""}>FAQ</a>
            <a
              href="https://x.com/PumpBirdonSol"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="PUMP.BIRD on X"
              className="nav-social"
              title="X (Twitter)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231ZM17.083 19.77h1.833L7.084 4.126H5.117Z"/>
              </svg>
            </a>
            <a
              href="https://t.me/pumpbird"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="PUMP.BIRD on Telegram"
              className="nav-social"
              title="Telegram"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.24 3.64 11.94c-.88-.27-.89-.88.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.92-.74 1.14-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
              </svg>
            </a>
          </nav>
          <div className="header-actions">
            <button
              className={`btn-wallet${wallet.authed ? " connected" : ""}`}
              type="button"
              onClick={handleWallet}
              disabled={!wallet.ready || walletBusy}
            >
              {wallet.authed && <span className="led" />}
              <span className="full">
                {walletBusy
                  ? "Signing…"
                  : !wallet.ready
                  ? "…"
                  : !wallet.installed
                  ? "Get Phantom"
                  : wallet.authed && wallet.wallet
                  ? short(wallet.wallet)
                  : "Connect Wallet"}
              </span>
            </button>
            <button
              className={`btn-icon${soundOn ? " playing" : ""}`}
              type="button"
              aria-label={soundOn ? "Mute game audio" : "Unmute game audio"}
              aria-pressed={soundOn}
              title={soundOn ? "Mute game audio" : "Unmute game audio"}
              onClick={handleSoundToggle}
            >
              {soundOn ? "♫" : "♪"}
            </button>
            <button
              ref={hamburgerRef}
              className="hamburger"
              type="button"
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <span /><span /><span />
            </button>
          </div>
        </div>
      </header>

      <main>
        {/* HERO */}
        <section className="hero container" id="top">
          <div className="hero-left">
            <Image className="hero-title" src={`${BASE_ASSETS}logo.png`} alt="PUMP.BIRD" width={520} height={140} unoptimized priority />
            <h1 className="hero-headline">
              <span className="w">The Highscore</span>
              <span className="g">Takes the Pot.</span>
            </h1>
            {/* The one number worth screenshotting, above the fold at display
                scale — not 900px down. */}
            <div className="hero-pot">
              <span className="hp-label">
                <span className="led" aria-hidden="true" /> Live pot
              </span>
              <span className={`hp-value${potZero ? " zero" : ""}`}>{potUsdDisplay}</span>
              <span className="hp-sub">{heroPotSub}</span>
            </div>
            <div className="hero-cta">
              <button type="button" className="btn btn-primary" onClick={handlePlayPaid}>Play Now · $1</button>
              <button type="button" className="btn btn-ghost" onClick={handlePlayFun}>Warm Up Free</button>
            </div>
            <div className="built-on">
              Built on <span className="pf"><span className="pf-pill" /> pump.fun</span>
            </div>
          </div>
          <div className="hero-right">
            <div className="bolt-fx" aria-hidden="true">
              <span className="lightning l1" />
              <span className="lightning l2" />
              <span className="lightning l3" />
            </div>
            <Image className="hero-bird" src={`${BASE_ASSETS}hero-bird.png`} alt="Pump.Bird mascot" width={620} height={620} unoptimized priority />
          </div>
        </section>
      </main>

      {/* TICKER — live data (last known values), rendered twice for the
          seamless loop. The old innerHTML-doubling hack is gone: it survived
          only because the items never re-rendered, which live data breaks. */}
      <div className="ticker" aria-hidden="true">
        <div className="ticker-track">
          {[...tickerItems, ...tickerItems].map((item, i) => (
            <span key={i} className={`item ${i % 2 === 0 ? "g" : "p"}`}>
              <Image
                src={`${BASE_ASSETS}${item.icon === "coin" ? "icon-coin.png" : "avatar-default.png"}`}
                alt=""
                width={20}
                height={20}
                unoptimized
              />
              {item.t}
            </span>
          ))}
        </div>
      </div>

      {/* ARENA */}
      {/* ARENA — the stat bar that used to sit here printed pot / highscore /
          champion 400px away from the vault panel showing the same three
          values at the same moment. The pot moved to the hero; the vault
          keeps the rest. One statement per fact. */}
      <section className="arena container" id="play">
        <div className="arena-main">
          <div className="game-arena arcade reveal">
            <div className="arcade-tab pink game-marquee">
              <Image src={`${BASE_ASSETS}logo.png`} alt="PUMP.BIRD" width={140} height={32} unoptimized />
            </div>
            <div className="arcade-in">
              <div className="game-screen" id="pumpbird-game-root">
                {gameMode === "idle" ? (
                  <button
                    type="button"
                    onClick={handleCabinetClick}
                    aria-label="Tap to play Pump.Bird for free"
                    className="gp gp-clickable"
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      background: "transparent",
                      border: 0,
                      padding: 0,
                      cursor: "pointer",
                      font: "inherit",
                      color: "inherit"
                    }}
                  >
                    <span className="cloud c1" />
                    <span className="cloud c2" />
                    <span className="cloud c3" />
                    <div className="skyline" />
                    <span className="pipe p1" />
                    <span className="pipe p2" />
                    <div className="ground" />
                    <Image className="gbird" src={`${BASE_ASSETS}avatar-default.png`} alt="" width={88} height={88} unoptimized />
                    <div className="gp-text">
                      <span className="big">TAP<br /><span className="g">TO PLAY</span></span>
                      <span className="sub">▸ FREE · NO ENTRY ◂</span>
                    </div>
                    <div className="insert">▸ OR PRESS PLAY NOW FOR $1 ◂</div>
                    <div className="glass" />
                  </button>
                ) : (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "#030a03",
                      overflow: "hidden"
                    }}
                  >
                    <button
                      type="button"
                      onClick={exitGame}
                      aria-label="Exit game"
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        zIndex: 60,
                        background: "rgba(255,45,120,0.15)",
                        border: "2px solid #ff2d78",
                        color: "#ff2d78",
                        fontFamily: "'Press Start 2P', monospace",
                        fontSize: 9,
                        textShadow: "0 0 6px #ff2d78",
                        padding: "6px 9px",
                        letterSpacing: 1,
                        cursor: "pointer"
                      }}
                    >
                      ✕
                    </button>
                    {gameMode === "fun" ? (
                      <PumpBirdGame
                        key={funSeed}
                        mode="fun"
                        seed={funSeed}
                        variant="custom"
                        autoStart={funAutoStart}
                        onComplete={handleFunComplete}
                        onExit={exitGame}
                        onRestart={() => { setFunScore(null); setFunSeed(makeFunSeed()); setFunAutoStart(true); }}
                      />
                    ) : (
                      <PaidGameSession onExit={exitGame} />
                    )}
                    {gameMode === "fun" && funScore !== null && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: 12,
                          left: "50%",
                          transform: "translateX(-50%)",
                          zIndex: 55,
                          display: "flex",
                          gap: 10,
                          background: "rgba(7,18,7,0.92)",
                          border: "2px solid #00ff41",
                          boxShadow: "0 0 16px rgba(0,255,65,0.4)",
                          padding: "8px 12px",
                          fontFamily: "'Press Start 2P', monospace"
                        }}
                      >
                        <span style={{ fontSize: 10, color: "#00ff41", textShadow: "0 0 6px #00ff41", letterSpacing: 2 }}>
                          SCORE {String(funScore).padStart(3, "0")}
                        </span>
                        <button
                          type="button"
                          onClick={() => { setFunScore(null); setFunSeed(makeFunSeed()); }}
                          style={{
                            fontFamily: "'Press Start 2P', monospace",
                            fontSize: 10,
                            background: "rgba(255,45,120,0.15)",
                            border: "2px solid #ff2d78",
                            color: "#ff2d78",
                            textShadow: "0 0 6px #ff2d78",
                            padding: "6px 10px",
                            letterSpacing: 1,
                            cursor: "pointer"
                          }}
                        >
                          ↺ AGAIN
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="play-bar reveal">
            <button type="button" className="btn btn-primary big" onClick={handlePlayPaid}>▶ Play Now · $1</button>
            <p className="play-meta">
              {playAmt ? (
                <>$1 ≈ <span className="green">{playAmt}</span> · <span className="pm-live">live price</span></>
              ) : (
                <>$1 per life · <span className="pm-live">price goes live at launch</span></>
              )}
              {" · "}
              {highscore > 0 ? `beat ${highscore} to take the pot` : "the first highscore takes the crown"}
            </p>
          </div>
        </div>

        <aside className="vault arcade hot reveal" aria-label="The Vault">
          <div className="arcade-tab">Vault</div>
          <div className="arcade-in">
            <div className="vault-door">
              <div className="porthole-wrap">
                <div className="porthole-plate"><i /><i /><i /><i /></div>
                <div className="porthole">
                  <div className="porthole-inner">
                    <Image src={`${BASE_ASSETS}avatar-default.png`} alt="Vaulted Pump.Bird" width={120} height={120} unoptimized />
                  </div>
                </div>
                <div className="bolt-ring">
                  {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                    <i key={i} style={{ ["--i" as keyof React.CSSProperties]: i } as React.CSSProperties} />
                  ))}
                </div>
                <div className="porthole-glow" />
                <div className="hinge"><i /><i /></div>
              </div>
            </div>
            <div className="vault-pot">
              <span className="label">Current Pot</span>
              <span className="big-pot pot">{potUsdDisplay}</span>
            </div>
            <div className="vault-grid">
              <div className="vault-cell"><span className="label">Champion</span><span className="v green">{championName}</span></div>
              <div className="vault-cell"><span className="label">Highscore</span><span className="v pink">{highscore}</span></div>
            </div>
            <div className="vault-foot"><span className="led" /> LIVE POT • REAL TIME · {potTokenDisplay} $PB</div>
          </div>
        </aside>
      </section>

      {/* HOW IT WORKS — the emblems already carry their own step number and
          label plate, so the cards, chips and repeated titles are gone. Four
          badges on a dashed rail, staggered, the payoff step largest, each
          caption adding a fact the emblem doesn't state. */}
      <section className="how container" id="how">
        <SectionHead index="01" title="How it works" sub="four steps, one pot" />
        <div className="how-rail reveal">
          <div className="how-step">
            <Image className="emblem" src={`${BASE_ASSETS}emblem-pay.png`} alt="Step 1 — pay $1" width={160} height={160} unoptimized />
            <p>In $PUMPBIRD, at the live market price. Packs of 1, 5, 10 or 25 lives.</p>
          </div>
          <div className="how-step lift">
            <Image className="emblem" src={`${BASE_ASSETS}emblem-play.png`} alt="Step 2 — play" width={160} height={160} unoptimized />
            <p>Same physics for everyone. One life per entry, played back to back.</p>
          </div>
          <div className="how-step">
            <Image className="emblem" src={`${BASE_ASSETS}emblem-beat.png`} alt="Step 3 — beat the highscore" width={160} height={160} unoptimized />
            <p>The all-time record is the only target. The server replays your run before it counts.</p>
          </div>
          <div className="how-step payoff">
            <Image className="emblem" src={`${BASE_ASSETS}emblem-takepot.png`} alt="Step 4 — take the pot" width={192} height={192} unoptimized />
            <p>100% of it, sent to your wallet automatically. No claiming, no waiting.</p>
          </div>
        </div>
      </section>

      {/* LEADERBOARD */}
      <section className="leaderboard container" id="leaderboard">
        <SectionHead index="02" title="Leaderboard" sub="rank by best score" />
        <div className="lb-layout">
          <aside className="side-panel winner arcade pink reveal">
            <div className="arcade-in">
              <div className="side-title">Champion</div>
              <div className="winner-badge">
                <Image className="crown" src={`${BASE_ASSETS}icon-crown.png`} alt="" width={48} height={48} unoptimized />
                <Image
                  className={`av${champion ? "" : " unclaimed"}`}
                  src={avatarUrl(champion?.avatarId)}
                  alt=""
                  width={112}
                  height={112}
                  unoptimized
                />
              </div>
              <div className={`winner-name${champion ? "" : " unclaimed"}`}>
                {champion ? championName : "Throne is empty"}
              </div>
              <div className="winner-stats">
                <div><span className="k">Score</span><span className="s">{champion?.bestScore ?? 0}</span></div>
                <div><span className="k">Won</span><span className="w">{champion ? fmtTokenRaw(champion.totalWonTokens, quote?.tokenDecimals ?? 6) : 0} $PB</span></div>
              </div>
              <div className="winner-time">{champion ? "ALL-TIME" : "FIRST WINNER TAKES THE CROWN"}</div>
            </div>
          </aside>

          <div className="lb-center">
            <div className="lb-frame arcade reveal">
              <div className="arcade-in">
                <table className="lb-table">
                  {/* Column headers only when there are rows — RANK/PLAYER/
                      SCORE spread over an empty table reads as broken. */}
                  {board.length > 0 && (
                    <thead>
                      <tr><th>Rank</th><th>Player</th><th className="num">Score</th><th className="num">Won</th><th className="num">Plays</th></tr>
                    </thead>
                  )}
                  <tbody>
                    {board.length === 0 && (
                      <tr><td colSpan={5}>
                        <div className="lb-empty">
                          <span className="lb-emblem-crop">
                            <Image src={`${BASE_ASSETS}emblem-takepot.png`} alt="" width={96} height={96} unoptimized />
                          </span>
                          <div className="lb-empty-title">THE BOARD IS EMPTY</div>
                          <p>No scores yet. The first run sets the highscore, and the crown is up for grabs.</p>
                          <button type="button" className="btn btn-ghost sm" onClick={handlePlayFun}>Warm up for free</button>
                        </div>
                      </td></tr>
                    )}
                    {board.map((row, i) => (
                      <tr key={row.wallet} className={i < 3 ? `top${i + 1}` : ""}>
                        <td>
                          <span className="lb-rank">
                            {i === 0 ? <Image src={`${BASE_ASSETS}icon-crown.png`} alt="#1" width={28} height={28} unoptimized /> :
                             i === 1 ? <Image src={`${BASE_ASSETS}icon-trophy.png`} alt="#2" width={28} height={28} unoptimized /> :
                             i === 2 ? <Image src={`${BASE_ASSETS}icon-star.png`} alt="#3" width={28} height={28} unoptimized /> :
                             <span className="n">{i + 1}</span>}
                          </span>
                        </td>
                        <td><span className="lb-player">
                          <Image src={avatarUrl(row.avatarId)} alt="" width={32} height={32} unoptimized />
                          {row.displayName ?? short(row.wallet)}
                        </span></td>
                        <td className="num"><span className="lb-score">{row.bestScore}</span></td>
                        <td className="num"><span className="lb-pot">{fmtTokenRaw(row.totalWonTokens, quote?.tokenDecimals ?? 6)}</span></td>
                        <td className="num"><span className="lb-plays">{fmtNumber(row.totalPlays ?? 0)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Card layout for ≤680px — same data, readable on phones
                    (the table is display:none there). */}
                <div className="lb-cards">
                  {board.length === 0 && (
                    <div className="lb-empty">
                      <span className="lb-emblem-crop">
                        <Image src={`${BASE_ASSETS}emblem-takepot.png`} alt="" width={96} height={96} unoptimized />
                      </span>
                      <div className="lb-empty-title">THE BOARD IS EMPTY</div>
                      <p>No scores yet. The first run sets the highscore, and the crown is up for grabs.</p>
                      <button type="button" className="btn btn-ghost sm" onClick={handlePlayFun}>Warm up for free</button>
                    </div>
                  )}
                  {board.map((row, i) => (
                    <div key={row.wallet} className={`lb-card${i < 3 ? ` top${i + 1}` : ""}`}>
                      <span className="rank">
                        {i === 0 ? <Image src={`${BASE_ASSETS}icon-crown.png`} alt="#1" width={28} height={28} unoptimized /> :
                         i === 1 ? <Image src={`${BASE_ASSETS}icon-trophy.png`} alt="#2" width={28} height={28} unoptimized /> :
                         i === 2 ? <Image src={`${BASE_ASSETS}icon-star.png`} alt="#3" width={28} height={28} unoptimized /> :
                         <span className="n">{i + 1}</span>}
                      </span>
                      <span className="who">
                        <Image src={avatarUrl(row.avatarId)} alt="" width={34} height={34} unoptimized />
                        <span className="col">
                          <span className="nm">{row.displayName ?? short(row.wallet)}</span>
                          <span className="dt">{fmtNumber(row.totalPlays ?? 0)} plays</span>
                        </span>
                      </span>
                      <span className="stats">
                        <span className="s">{row.bestScore}</span>
                        <span className="pw">{fmtTokenRaw(row.totalWonTokens, quote?.tokenDecimals ?? 6)} $PB</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="lb-cta reveal">
              <Link className="btn btn-ghost sm" href="/counter">Open Livestream Counter ↗</Link>
            </div>
          </div>

          <aside className="side-panel legends arcade reveal">
            <div className="arcade-in">
              <div className="side-title">Legends</div>
              <div className="legends-av">
                <Image src={`${BASE_ASSETS}avatar-sunglasses.png`} alt="" width={104} height={104} unoptimized />
              </div>
              <ul className="legends-list">
                {board.slice(0, 5).map((row, i) => (
                  <li key={row.wallet}>
                    <span className="rk">{i + 1}.</span>
                    <span className="nm">{row.displayName ?? short(row.wallet)}</span>
                    <span className="sc">{row.bestScore}</span>
                  </li>
                ))}
                {board.length === 0 && (
                  <li className="empty">No legends yet. Your name goes here.</li>
                )}
              </ul>
              <div className="side-foot">top 5 · all-time</div>
            </div>
          </aside>
        </div>
      </section>

      {/* FAQ */}
      <section className="faq container" id="faq">
        <SectionHead index="03" title="FAQ" sub="straight answers, no fine print" />
        <div className="faq-frame arcade reveal">
          <div className="arcade-tab">Player&apos;s Manual</div>
          <div className="arcade-in">
            <FaqList />
          </div>
        </div>
      </section>

      {/* CTA + FOOTER — the closing block joins the arcade frame system
          instead of being the one big rounded rectangle on the page. */}
      <section className="footer-wrap container">
        <div className="footer-block arcade">
          <div className="arcade-in">
          <div className="cta-panel">
            <div className="about-card reveal">
              <h3>About <span className="pink">$PUMPBIRD</span></h3>
              <p>A memecoin with an actual game attached. Every $1 entry buys one life, feeds the pot, and gets replayed by the server before it counts. Skill gets paid.</p>
              <div className="about-meta">
                <span className="lbl">Launching on</span>
                <span className="val"><span className="pf-pill" /> pump.fun</span>
              </div>
              <div className="about-meta">
                <span className="lbl">Chain</span>
                <span className="val">
                  <svg viewBox="0 0 40 31" aria-hidden="true">
                    <defs>
                      <linearGradient id="sol" x1="0" y1="0" x2="40" y2="31" gradientUnits="userSpaceOnUse">
                        <stop offset="0" stopColor="#9945FF" />
                        <stop offset="1" stopColor="#19FB9B" />
                      </linearGradient>
                    </defs>
                    <path
                      fill="url(#sol)"
                      d="M6.5 22.6c.3-.3.6-.4 1-.4H39c.7 0 1 .8.5 1.3l-5 5c-.3.3-.6.4-1 .4H1c-.7 0-1-.8-.5-1.3l6-5zM6.5 1.4C6.8 1.1 7.2 1 7.5 1H39c.7 0 1 .8.5 1.3l-5 5c-.3.3-.6.4-1 .4H1c-.7 0-1-.8-.5-1.3l6-5zM33.5 11.9c-.3-.3-.6-.4-1-.4H1c-.7 0-1 .8-.5 1.3l5 5c.3.3.6.4 1 .4H39c.7 0 1-.8.5-1.3l-6-5z"
                    />
                  </svg>
                  Solana
                </span>
              </div>
            </div>
            <div className="cta-main reveal">
              <h2 className="cta-title">
                <span className="w">The Pot Is Waiting.</span>
                <span className="g">Can You Take It?</span>
              </h2>
              <button type="button" className="btn btn-primary big" onClick={handlePlayPaid}>Play Pump.Bird</button>
              <p className="cta-sub">Play for $1. Win everything.</p>
            </div>
            <div className="cta-bird-cell reveal">
              {/* The coin-pile bird ships with a baked-in dark backdrop that
                  used to seam against the footer panel. Seated in its own
                  arcade frame, the backdrop becomes the screen it sits on —
                  no art touched. */}
              <div className="cta-bird-frame arcade">
                <div className="arcade-in">
                  <Image className="cta-bird" src={`${BASE_ASSETS}cta-bird-coins.png`} alt="" width={300} height={300} unoptimized />
                  <span className="cta-bird-tag">sitting on the pot</span>
                </div>
              </div>
            </div>
          </div>
          <footer className="footer-bar">
            <Image className="flogo" src={`${BASE_ASSETS}logo.png`} alt="PUMP.BIRD" width={120} height={32} unoptimized />
            <nav className="footer-links" aria-label="Footer">
              <a href="#faq">FAQ</a>
              <a href="#faq">Terms</a>
              <a href="#faq">Privacy</a>
              <a href="https://x.com/PumpBirdonSol" target="_blank" rel="noopener noreferrer">X (Twitter)</a>
              <a href="https://t.me/pumpbird" target="_blank" rel="noopener noreferrer">Telegram</a>
              <a href="/counter">Live Counter</a>
            </nav>
            <span className="footer-copy">© 2026 Pump.Bird. All rights reserved.</span>
          </footer>
          </div>
        </div>
      </section>

      {/* MOBILE DRAWER */}
      <div className={`drawer${drawerOpen ? " open" : ""}`} aria-hidden={!drawerOpen}>
        <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} />
        <div className="drawer-panel" role="dialog" aria-modal="true" aria-label="Menu" ref={drawerPanelRef}>
          <div className="drawer-top">
            <Image src={`${BASE_ASSETS}logo.png`} alt="PUMP.BIRD" width={120} height={32} unoptimized />
            <button className="drawer-close" type="button" aria-label="Close menu" onClick={() => setDrawerOpen(false)}>✕</button>
          </div>
          <nav className="drawer-nav" aria-label="Mobile">
            <a href="#top" onClick={() => setDrawerOpen(false)}>Home</a>
            <button type="button" className="play drawer-cta" onClick={() => { setDrawerOpen(false); handlePlayPaid(); }}>Play Now</button>
            <a href="#leaderboard" onClick={() => setDrawerOpen(false)}>Leaderboard</a>
            <a href="#how" onClick={() => setDrawerOpen(false)}>How It Works</a>
            <a href="#faq" onClick={() => setDrawerOpen(false)}>FAQ</a>
            <button type="button" className="drawer-cta" onClick={() => { setDrawerOpen(false); handlePlayFun(); }}>Play For Fun</button>
            <Link href="/counter" onClick={() => setDrawerOpen(false)}>Live Counter</Link>
            <a href="https://x.com/PumpBirdonSol" target="_blank" rel="noopener noreferrer" onClick={() => setDrawerOpen(false)}>X (Twitter) ↗</a>
            <a href="https://t.me/pumpbird" target="_blank" rel="noopener noreferrer" onClick={() => setDrawerOpen(false)}>Telegram ↗</a>
          </nav>
          <div className="drawer-pot">
            <span className="label">Current Pot</span>
            <span className="v pot">{potUsdDisplay}</span>
          </div>
          <button type="button" className="btn btn-primary big" onClick={() => { setDrawerOpen(false); handlePlayPaid(); }}>Play for $1</button>
        </div>
      </div>

      {/* TOAST */}
      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">
        <span className="led" />
        <span>{toast ?? ""}</span>
      </div>
    </>
  );
}

// Memoized so the 5s data polls never re-render the accordion — the user's
// open/closed choices on the <details> elements stay untouched.
const FaqList = memo(function FaqList() {
  return (
    <div className="faq-list">
      {FAQ_ITEMS.map((item, i) => (
        <details key={item.q} className="faq-item" open={i === 0}>
          <summary>
            <span className="faq-num" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
            <span className="faq-q">{item.q}</span>
            <span className="faq-chev" aria-hidden="true" />
          </summary>
          <p>{item.a}</p>
        </details>
      ))}
    </div>
  );
});

// Section header — left-aligned title, a rule running out to the right and a
// lowercase mono annotation, borrowed from /counter's section heads (the
// strongest pattern in the project). Replaces the emoji-flanked centred
// titles that read as template output.
function SectionHead({ index, title, sub }: { index: string; title: string; sub: string }) {
  return (
    <div className="section-head reveal">
      <span className="sh-index" aria-hidden="true">{index}</span>
      <h2 className="sh-title">{title}</h2>
      <span className="sh-line" aria-hidden="true" />
      <span className="sh-sub">↳ {sub}</span>
    </div>
  );
}
