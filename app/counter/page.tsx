// Livestream counter page — public, no controls, big readable text.
// Polls /api/pot and /api/leaderboard every few seconds.

import "./counter.css";
import { CounterClient } from "@/components/counter/CounterClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "PUMP.BIRD — Live Counter" };

export default function CounterPage() {
  return <CounterClient />;
}
