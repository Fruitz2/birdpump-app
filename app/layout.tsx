import type { Metadata } from "next";
import "./globals.css";
import { WalletProvider } from "@/components/wallet/WalletProvider";

export const metadata: Metadata = {
  title: "PUMP.BIRD — The Highscore Takes the Pot",
  description:
    "Play Pump.Bird for $1 worth of $PUMPBIRD. Beat the highscore and take the entire pot. Built on pump.fun, on Solana.",
  metadataBase: new URL("https://birdpump.fun"),
  openGraph: {
    title: "PUMP.BIRD",
    description: "Beat the highscore, take the pot.",
    images: ["/assets/pumpbird/logo.png"]
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@600;700;800&family=Oxanium:wght@600;700;800&family=Rajdhani:wght@500;600;700&family=Press+Start+2P&family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
