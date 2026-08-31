"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { PaidGameSession } from "@/components/game/PaidGameSession";

export default function PlayPage() {
  const router = useRouter();
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#030a03",
        display: "flex",
        flexDirection: "column"
      }}
    >
      <div
        style={{
          position: "absolute",
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
            display: "inline-flex",
            alignItems: "center",
            minHeight: 44,
            background: "rgba(0,255,65,0.1)",
            border: "2px solid #00ff41",
            color: "#00ff41",
            textShadow: "0 0 6px #00ff41",
            padding: "0 14px",
            letterSpacing: 1
          }}
        >
          ◂ HOME
        </Link>
        <Link
          href="/play-fun"
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 9,
            display: "inline-flex",
            alignItems: "center",
            minHeight: 44,
            background: "rgba(217,255,90,0.08)",
            border: "2px solid #d9ff5a",
            color: "#d9ff5a",
            textShadow: "0 0 6px #d9ff5a",
            padding: "0 14px",
            letterSpacing: 1
          }}
        >
          TRY FREE ↗
        </Link>
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <PaidGameSession onExit={() => router.push("/")} />
      </div>
    </div>
  );
}
