"use client";

import { useCallback, useState } from "react";
import { useWallet } from "./WalletProvider";

type Props = {
  className?: string;
  label?: string;
  onError?: (msg: string) => void;
};

function shortAddr(s: string): string {
  return s.slice(0, 4) + "…" + s.slice(-4);
}

export function ConnectButton({ className, label, onError }: Props) {
  const { ready, installed, wallet, authed, signIn, disconnect } = useWallet();
  const [busy, setBusy] = useState(false);

  const handle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!installed) {
        window.open("https://phantom.app/", "_blank", "noopener");
        return;
      }
      if (authed) {
        await disconnect();
        return;
      }
      await signIn();
    } catch (e) {
      const msg = (e as Error).message ?? "Wallet error";
      if (msg !== "phantom_not_installed") onError?.(msg);
    } finally {
      setBusy(false);
    }
  }, [authed, busy, disconnect, installed, onError, signIn]);

  let text = label ?? "Connect Wallet";
  if (!ready) text = "…";
  else if (!installed) text = "Get Phantom";
  else if (authed && wallet) text = shortAddr(wallet);
  else if (wallet) text = "Sign In";

  return (
    <button
      type="button"
      onClick={handle}
      disabled={!ready || busy}
      className={className ?? "btn-wallet"}
      aria-label={text}
    >
      {authed && <span className="led" aria-hidden="true" />}
      <span className="full">{busy ? "…" : text}</span>
    </button>
  );
}
