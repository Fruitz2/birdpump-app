import type { Metadata } from "next";
import "./globals.css";
import { WalletProvider } from "@/components/wallet/WalletProvider";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://birdpump-app.vercel.app";
const TITLE = "PUMP.BIRD — The Highscore Takes the Pot.";
const DESCRIPTION =
  "Pay $1 in $PUMPBIRD, play the game, beat the highscore — win the entire pot. Built on pump.fun, on Solana.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: TITLE,
    template: "%s · PUMP.BIRD"
  },
  description: DESCRIPTION,
  applicationName: "PUMP.BIRD",
  keywords: [
    "pumpbird",
    "pump.bird",
    "pump.fun",
    "solana",
    "memecoin",
    "flappy bird",
    "game",
    "pot",
    "highscore"
  ],
  authors: [{ name: "PUMP.BIRD" }],
  creator: "PUMP.BIRD",
  publisher: "PUMP.BIRD",
  formatDetection: { email: false, address: false, telephone: false },
  themeColor: "#65ff48",
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "PUMP.BIRD",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US"
    // images: handled automatically by app/opengraph-image.png
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    creator: "@pumpbird"
    // images: handled automatically by app/twitter-image.png
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" }
  },
  other: {
    "telegram:channel": "@pumpbird"
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
