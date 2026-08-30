// FAQ content — single source of truth shared by the landing section markup
// (LandingClient) and the FAQPage JSON-LD emitted from app/page.tsx.
// Numbers here mirror the live product rules: $1 per life, packs of 1/5/10/25
// (PaidGameSession), 75/25 pot/treasury split (entry flow), deterministic
// server-side replay (lib/game/simulator.ts).

export type FaqItem = { q: string; a: string };

export const FAQ_ITEMS: FaqItem[] = [
  {
    q: "What is Pump.Bird?",
    a: "A Flappy-style arcade game on Solana. Every paid entry feeds one shared pot. Beat the all-time highscore and the entire pot pays out to your wallet. Then your score becomes the new target."
  },
  {
    q: "How much does it cost to play?",
    a: "One dollar per life, paid in $PUMPBIRD at the live market price. You can buy a pack of 1, 5, 10 or 25 lives in a single transaction and play them back to back."
  },
  {
    q: "What do I need to start?",
    a: "A Phantom wallet holding some $PUMPBIRD plus a little SOL for network fees. Signing in is a free one-time signature that proves you own the wallet. It spends nothing."
  },
  {
    q: "What happens when I beat the highscore?",
    a: "The server verifies your run, then sends the full pot to your wallet automatically. No claiming, no waiting. The leaderboard crowns you champion until someone beats your score."
  },
  {
    q: "Where does my entry go?",
    a: "75% of every entry grows the pot. The remaining 25% goes to the buyback and burn treasury."
  },
  {
    q: "How do I know runs are fair?",
    a: "Every run is deterministic. The server replays your exact inputs tick by tick and only accepts a score it can reproduce itself. There is no client-side trust and no way to submit an edited score."
  },
  {
    q: "Can I practice for free?",
    a: "Yes. Free play runs the exact same game with no wallet and no entry fee. Free scores never touch the leaderboard or the pot, so warm up as long as you like."
  }
];
