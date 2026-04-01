"use client";

import { useState, useCallback } from "react";
import ConnectWallet from "@/components/ConnectWallet";
import AccountInfo from "@/components/AccountInfo";
import SignDemo from "@/components/SignDemo";
import type { BitcoinWallet } from "@/lib/bitcoin";

type Step = "connect" | "account" | "sign";

export default function Home() {
  const [wallet, setWallet] = useState<BitcoinWallet | null>(null);
  const [starknetAddress, setStarknetAddress] = useState<string>("");
  const [step, setStep] = useState<Step>("connect");
  const [copied, setCopied] = useState(false);

  const copyAddress = useCallback(() => {
    if (!starknetAddress) return;
    navigator.clipboard.writeText(starknetAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [starknetAddress]);

  function handleConnected(w: BitcoinWallet) {
    setWallet(w);
    setStep("account");
  }

  function handleDeployRequest(addr: string) {
    setStarknetAddress(addr);
    setStep("sign");
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-orange-500 text-xl">₿</span>
          <span className="font-semibold text-sm tracking-wide">
            Secp
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 bg-slate-900 px-3 py-1 rounded-full">
            Sepolia Testnet
          </span>
          {starknetAddress && (
            <button
              onClick={copyAddress}
              title={starknetAddress}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-900 hover:bg-slate-800 px-3 py-1 rounded-full transition-colors"
            >
              <span className="font-mono">
                {starknetAddress.slice(0, 6)}…{starknetAddress.slice(-4)}
              </span>
              {copied ? (
                <span className="text-green-400">✓</span>
              ) : (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          )}
        </div>
      </header>

      {/* Step indicator */}
      <div className="flex justify-center gap-2 pt-8 pb-2">
        {(["connect", "account", "sign"] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                step === s
                  ? "bg-orange-500 text-white"
                  : i < ["connect", "account", "sign"].indexOf(step)
                  ? "bg-green-600 text-white"
                  : "bg-slate-800 text-slate-500"
              }`}
            >
              {i < ["connect", "account", "sign"].indexOf(step) ? "✓" : i + 1}
            </div>
            <span
              className={`text-xs hidden sm:inline ${
                step === s ? "text-slate-200" : "text-slate-600"
              }`}
            >
              {s === "connect"
                ? "Connect Bitcoin Wallet"
                : s === "account"
                ? "View Starknet Account"
                : "Send STRK"}
            </span>
            {i < 2 && <span className="text-slate-700 text-xs">—</span>}
          </div>
        ))}
      </div>

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12 gap-8">
        {/* Hero text — only on connect step */}
        {step === "connect" && (
          <div className="text-center max-w-lg">
            <h1 className="text-3xl font-bold mb-3">
              Your Bitcoin key.{" "}
              <span className="text-purple-400">Your Starknet account.</span>
            </h1>
            <p className="text-slate-400 text-sm leading-relaxed">
              The first account abstraction wallet controlled entirely by a
              Bitcoin secp256k1 key. No new seed phrases. No bridges. Your
              Bitcoin wallet signs Starknet transactions directly.
            </p>
          </div>
        )}

        {/* Steps */}
        {step === "connect" && <ConnectWallet onConnected={handleConnected} />}

        {step === "account" && wallet && (
          <AccountInfo wallet={wallet} onDeployRequest={handleDeployRequest} />
        )}

        {step === "sign" && wallet && starknetAddress && (
          <SignDemo wallet={wallet} starknetAddress={starknetAddress} />
        )}

        {/* Back button */}
        {step !== "connect" && (
          <button
            onClick={() => setStep(step === "sign" ? "account" : "connect")}
            className="text-slate-600 hover:text-slate-400 text-xs transition-colors"
          >
            ← Back
          </button>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 px-6 py-4 text-center text-slate-600 text-xs">
        Built for Re&#123;define&#125; Hackathon 2026 · Privacy &amp; Bitcoin on Starknet
      </footer>
    </div>
  );
}
