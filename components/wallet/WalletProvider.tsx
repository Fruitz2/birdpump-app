"use client";

// Phantom wallet + SIWS session manager.
//
// Single source of truth for: connection state, wallet pubkey, JWT session,
// signMessage / signAndSendTransaction. Stores the JWT in localStorage with an
// explicit expiry so we don't carry an expired token across reloads.

import bs58 from "bs58";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { apiPost } from "@/lib/client/api";

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString: () => string; toBase58: () => string };
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{
    publicKey: { toString: () => string; toBase58: () => string };
  }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  signAndSendTransaction(
    tx: Transaction | VersionedTransaction
  ): Promise<{ signature: string }>;
  on?: (event: "connect" | "disconnect", cb: () => void) => void;
  removeListener?: (event: "connect" | "disconnect", cb: () => void) => void;
};

const SESSION_KEY = "bp:session:v1";

type Session = {
  token: string;
  wallet: string;
  expiresAt: string; // ISO
};

function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (new Date(parsed.expiresAt).getTime() <= Date.now() + 30_000) {
      window.localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveSession(s: Session): void {
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* localStorage disabled */
  }
}

function clearSession(): void {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* localStorage disabled */
  }
}

type WalletContextValue = {
  ready: boolean;
  installed: boolean;
  wallet: string | null;
  connected: boolean;
  authed: boolean;
  session: Session | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signIn: () => Promise<void>;
  signMessage: (msg: string) => Promise<string>; // returns base58 signature
  signAndSend: (tx: Transaction | VersionedTransaction) => Promise<string>;
  getProvider: () => PhantomProvider | null;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function detectProvider(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  if (w.phantom?.solana?.isPhantom) return w.phantom.solana;
  if (w.solana?.isPhantom) return w.solana;
  return null;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const providerRef = useRef<PhantomProvider | null>(null);

  // Initialize on mount
  useEffect(() => {
    const provider = detectProvider();
    providerRef.current = provider;
    setInstalled(!!provider);

    // Try restore session
    const stored = loadSession();
    if (stored) setSession(stored);

    // Try silent reconnect if provider available + matches stored wallet.
    // We wrap the rejection swallow in a function so any thrown non-Error
    // (Phantom occasionally rejects with an Event object) becomes a noop
    // rather than bubbling to next-devtools as "[object Event]".
    if (provider) {
      const silent = async () => {
        try {
          const res = await provider.connect({ onlyIfTrusted: true });
          const pk = res.publicKey.toBase58();
          setWallet(pk);
          if (stored && stored.wallet !== pk) {
            clearSession();
            setSession(null);
          }
        } catch {
          // user has not previously trusted this site — expected on first load
        } finally {
          setReady(true);
        }
      };
      void silent();

      const onConnect = () => {
        const pk = provider.publicKey?.toBase58();
        if (pk) setWallet(pk);
      };
      const onDisconnect = () => {
        setWallet(null);
        setSession(null);
        clearSession();
      };
      provider.on?.("connect", onConnect);
      provider.on?.("disconnect", onDisconnect);
      return () => {
        provider.removeListener?.("connect", onConnect);
        provider.removeListener?.("disconnect", onDisconnect);
      };
    } else {
      setReady(true);
      return undefined;
    }
  }, []);

  const connect = useCallback(async () => {
    const provider = providerRef.current ?? detectProvider();
    if (!provider) {
      window.open("https://phantom.app/", "_blank", "noopener");
      throw new Error("phantom_not_installed");
    }
    providerRef.current = provider;
    const res = await provider.connect();
    const pk = res.publicKey.toBase58();
    setWallet(pk);
  }, []);

  const disconnect = useCallback(async () => {
    const provider = providerRef.current;
    try {
      await provider?.disconnect();
    } catch {
      /* ignore */
    }
    setWallet(null);
    setSession(null);
    clearSession();
  }, []);

  const signMessage = useCallback(
    async (msg: string) => {
      const provider = providerRef.current;
      if (!provider) throw new Error("phantom_not_installed");
      const bytes = new TextEncoder().encode(msg);
      const result = await provider.signMessage(bytes);
      return bs58.encode(result.signature);
    },
    []
  );

  const signAndSend = useCallback(
    async (tx: Transaction | VersionedTransaction) => {
      const provider = providerRef.current;
      if (!provider) throw new Error("phantom_not_installed");
      const result = await provider.signAndSendTransaction(tx);
      return result.signature;
    },
    []
  );

  const signIn = useCallback(async () => {
    const provider = providerRef.current ?? detectProvider();
    if (!provider) {
      window.open("https://phantom.app/", "_blank", "noopener");
      throw new Error("phantom_not_installed");
    }
    let pk = provider.publicKey?.toBase58();
    if (!pk) {
      const res = await provider.connect();
      pk = res.publicKey.toBase58();
      setWallet(pk);
    }
    const nonce = await apiPost<{ nonce: string; message: string; expiresAt: string }>(
      "/api/auth/nonce",
      { wallet: pk }
    );
    const sig = await signMessage(nonce.message);
    const verified = await apiPost<{ token: string; expiresAt: string; wallet: string }>(
      "/api/auth/verify",
      { wallet: pk, nonce: nonce.nonce, signature: sig }
    );
    const sess: Session = {
      token: verified.token,
      wallet: verified.wallet,
      expiresAt: verified.expiresAt
    };
    saveSession(sess);
    setSession(sess);
  }, [signMessage]);

  const getProvider = useCallback(() => providerRef.current ?? detectProvider(), []);

  const value: WalletContextValue = {
    ready,
    installed,
    wallet,
    connected: wallet !== null,
    authed: session !== null,
    session,
    connect,
    disconnect,
    signIn,
    signMessage,
    signAndSend,
    getProvider
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
