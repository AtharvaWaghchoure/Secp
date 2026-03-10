"use client";

import { useState } from "react";
import { connectXverse, type BitcoinWallet } from "@/lib/bitcoin";

interface Props {
  onConnected: (wallet: BitcoinWallet) => void;
}

export default function ConnectWallet({ onConnected }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    setLoading(true);
    setError(null);
    try {
      const wallet = await connectXverse();
      onConnected(wallet);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="text-center max-w-md">
        <p className="text-slate-400 text-sm leading-relaxed">
          Connect your Bitcoin wallet. Your Bitcoin key will control a Starknet
          account — no new seed phrase or wallet needed.
        </p>
      </div>

      <button
        onClick={handleConnect}
        disabled={loading}
        className="flex items-center gap-3 bg-orange-500 hover:bg-orange-400 disabled:bg-orange-800 disabled:cursor-not-allowed text-white font-semibold px-8 py-3 rounded-xl transition-colors"
      >
        {loading ? (
          <>
            <Spinner />
            Connecting…
          </>
        ) : (
          <>
            <BitcoinIcon />
            Connect Xverse
          </>
        )}
      </button>

      {error && (
        <p className="text-red-400 text-sm bg-red-950 border border-red-800 rounded-lg px-4 py-2">
          {error}
        </p>
      )}

      <p className="text-slate-600 text-xs">
        Don&apos;t have Xverse?{" "}
        <a
          href="https://www.xverse.app"
          target="_blank"
          rel="noopener noreferrer"
          className="text-orange-500 hover:underline"
        >
          Install it here
        </a>
      </p>
    </div>
  );
}

function BitcoinIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.548v-.002zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.415-.614.32.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      className="w-4 h-4 animate-spin"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
