"use client";

// Free-play mode. No wallet, no payment, no settlement. Local-only.

import { useCallback, useState } from "react";
import Link from "next/link";
import { PumpBirdGame, type GameResult } from "@/components/game/PumpBirdGame";

function makeSeed(): string {
  return "fun:" + Math.random().toString(36).slice(2, 12) + ":" + Date.now();
}

export default function PlayFunPage() {
  const [seed, setSeed] = useState<string>(() => makeSeed());
  const [lastResult, setLastResult] = useState<GameResult | null>(null);
  // First visit shows the START screen (the click is also the audio-unlock
  // gesture); every retry restarts instantly — "TAP TO RETRY" means it.
  const [autoStart, setAutoStart] = useState(false);

  const handleComplete = useCallback((r: GameResult) => {
    setLastResult(r);
  }, []);

  const playAgain = useCallback(() => {
    setLastResult(null);
    setAutoStart(true);
    setSeed(makeSeed());
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#030a03"
      }}
    >
      <PumpBirdGame
        key={seed}
        mode="fun"
        seed={seed}
        variant="custom"
        autoStart={autoStart}
        onComplete={handleComplete}
        onExit={() => (window.location.href = "/")}
        onRestart={playAgain}
      />

      {lastResult !== null && (
        <FunReplayCue score={lastResult.score} onAgain={playAgain} />
      )}

      <div
        style={{
          position: "fixed",
          top: 12,
          left: 12,
          zIndex: 50,
          display: "flex",
          gap: 8
        }}
      >
        <Link
          href="/"
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 9,
            background: "rgba(0,255,65,0.1)",
            border: "2px solid #00ff41",
            color: "#00ff41",
            textShadow: "0 0 6px #00ff41",
            padding: "6px 10px",
            letterSpacing: 1,
            textDecoration: "none"
          }}
        >
          ◂ HOME
        </Link>
        <Link
          href="/play"
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 9,
            background: "rgba(255,45,120,0.1)",
            border: "2px solid #ff2d78",
            color: "#ff2d78",
            textShadow: "0 0 6px #ff2d78",
            padding: "6px 10px",
            letterSpacing: 1,
            textDecoration: "none"
          }}
        >
          PLAY FOR REAL ↗
        </Link>
      </div>
    </div>
  );
}

function FunReplayCue({ score, onAgain }: { score: number; onAgain: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(7,18,7,0.9)",
        border: "2px solid #00ff41",
        boxShadow: "0 0 16px rgba(0,255,65,0.4)",
        padding: "10px 16px",
        zIndex: 50,
        display: "flex",
        gap: 16,
        alignItems: "center"
      }}
    >
      <span
        style={{
          fontFamily: "'Press Start 2P', monospace",
          fontSize: 10,
          color: "#00ff41",
          textShadow: "0 0 6px #00ff41",
          letterSpacing: 2
        }}
      >
        SCORE {String(score).padStart(3, "0")}
      </span>
      <button
        type="button"
        onClick={onAgain}
        style={{
          fontFamily: "'Press Start 2P', monospace",
          fontSize: 10,
          background: "rgba(255,45,120,0.15)",
          border: "2px solid #ff2d78",
          color: "#ff2d78",
          textShadow: "0 0 6px #ff2d78",
          padding: "6px 12px",
          letterSpacing: 1,
          cursor: "pointer"
        }}
      >
        ↺ AGAIN
      </button>
    </div>
  );
}
