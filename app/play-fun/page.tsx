"use client";

// Free-play mode. No wallet, no payment, no settlement. Local-only.
//
// The game sits in a proper arcade cabinet (marquee, frame, hint line) — the
// same visual language as the landing page — instead of a bare canvas with
// links floating in a corner. The in-game fullscreen/sound buttons anchor to
// the cabinet's screen because PumpBirdGame mounts inside .pf-screen.

import "./play-fun.css";
import { useCallback, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { PumpBirdGame, type GameResult } from "@/components/game/PumpBirdGame";

function makeSeed(): string {
  return "fun:" + Math.random().toString(36).slice(2, 12) + ":" + Date.now();
}

export default function PlayFunPage() {
  const [seed, setSeed] = useState<string>(() => makeSeed());
  // First visit shows the START screen (the click is also the audio-unlock
  // gesture); every retry restarts instantly — "TAP TO RETRY" means it.
  const [autoStart, setAutoStart] = useState(false);

  const handleComplete = useCallback((_r: GameResult) => {
    // Score presentation lives on the in-game death screen; the old floating
    // duplicate cue under it is gone.
  }, []);

  const playAgain = useCallback(() => {
    setAutoStart(true);
    setSeed(makeSeed());
  }, []);

  return (
    <div className="pf-root">
      <header className="pf-top">
        <div className="pf-top-side">
          <Link href="/" className="pf-btn">◂ HOME</Link>
        </div>
        <Image
          className="pf-logo"
          src="/assets/pumpbird/logo.png"
          alt="PUMP.BIRD"
          width={140}
          height={40}
          unoptimized
          priority
        />
        <div className="pf-top-side right">
          <Link href="/play" className="pf-btn real">PLAY FOR REAL ↗</Link>
        </div>
      </header>

      <main className="pf-stage">
        <div className="pf-cab">
          {/* direct child of .pf-cab — inside .pf-cab-in the clip-path would
              slice the half of the tab that straddles the top edge */}
          <div className="pf-marquee">
            <Image src="/assets/pumpbird/logo.png" alt="" width={90} height={20} unoptimized />
            FREE PLAY
          </div>
          <div className="pf-cab-in">
            <div className="pf-screen">
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
            </div>
          </div>
        </div>
        <p className="pf-hint">TAP OR SPACE TO FLAP · M SOUND · F FULLSCREEN</p>
      </main>
    </div>
  );
}
