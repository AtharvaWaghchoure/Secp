"use client";

import { useState } from "react";
import type { BitcoinWallet } from "@/lib/bitcoin";
import { getSwapQuote, buildSwap, formatEth, type SwapQuote } from "@/lib/avnu";
import { executeSwap, verifySignatureOnChain } from "@/lib/starknet";

interface Props {
  wallet: BitcoinWallet;
  starknetAddress: string;
}

type Phase = "input" | "quoted" | "swapping" | "verifying" | "done" | "error";

export default function SwapDemo({ wallet, starknetAddress }: Props) {
  const [amount, setAmount] = useState("0.1");
  const [phase, setPhase] = useState<Phase>("input");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [onChainVerified, setOnChainVerified] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const amountValid =
    /^\d+(\.\d+)?$/.test(amount.trim()) && parseFloat(amount) > 0;

  async function handleGetQuote() {
    setPhase("input");
    setError(null);
    try {
      const q = await getSwapQuote(amount, starknetAddress);
      setQuote(q);
      setPhase("quoted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Quote failed");
      setPhase("error");
    }
  }

  async function handleSwap() {
    if (!quote) return;
    setPhase("swapping");
    setError(null);
    try {
      const calls = await buildSwap(quote.quoteId, starknetAddress);
      const result = await executeSwap(
        wallet.address,
        wallet.publicKeyX,
        wallet.publicKeyY,
        calls
      );
      setTxHash(result.transaction_hash);
      setPhase("verifying");

      const verified = await verifySignatureOnChain(
        starknetAddress,
        result.signedTxHash,
        result.signature
      );
      setOnChainVerified(verified);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swap failed");
      setPhase("error");
    }
  }

  function handleReset() {
    setPhase("input");
    setQuote(null);
    setTxHash(null);
    setOnChainVerified(null);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Explainer */}
      <p className="text-slate-500 text-xs leading-relaxed">
        A real STRK→ETH swap routed through AVNU (Ekubo / JediSwap). Your
        Bitcoin key signs the transaction —{" "}
        <code className="text-slate-400">__validate__</code> verifies the
        secp256k1 signature on-chain before execution.
      </p>

      {/* Step 1: amount input */}
      {(phase === "input" || phase === "error") && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-slate-500 text-xs">Sell (STRK)</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.1"
              className="bg-slate-900 border border-slate-700 focus:border-purple-600 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none"
            />
          </div>

          {phase === "error" && error && (
            <p className="text-red-400 text-xs bg-red-950 border border-red-800 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            onClick={handleGetQuote}
            disabled={!amountValid}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            Get Quote
          </button>
        </div>
      )}

      {/* Step 2: show quote, confirm swap */}
      {(phase === "quoted" || phase === "swapping") && quote && (
        <div className="flex flex-col gap-3">
          <div className="border border-purple-800 rounded-xl p-4 flex flex-col gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-purple-400">
              Best Route via AVNU
            </h3>
            <div className="flex justify-between items-center">
              <span className="text-slate-500 text-xs">You sell</span>
              <span className="text-slate-300 text-xs font-mono">
                {amount} STRK
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500 text-xs">You receive (est.)</span>
              <span className="text-green-400 text-xs font-mono">
                {formatEth(quote.buyAmount)} ETH
              </span>
            </div>
            <p className="text-slate-600 text-xs">
              0.5% max slippage · route via Ekubo / JediSwap
            </p>
          </div>

          <button
            onClick={handleSwap}
            disabled={phase === "swapping"}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            {phase === "swapping"
              ? "Waiting for Xverse…"
              : "Swap with Bitcoin Key"}
          </button>

          <button
            onClick={handleReset}
            disabled={phase === "swapping"}
            className="text-slate-500 text-xs underline underline-offset-2"
          >
            Change amount
          </button>
        </div>
      )}

      {/* Verifying */}
      {phase === "verifying" && (
        <p className="text-slate-400 text-xs text-center animate-pulse">
          Verifying signature on-chain…
        </p>
      )}

      {/* Done */}
      {phase === "done" && txHash && quote && (
        <div className="border border-green-800 rounded-xl p-4 flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-green-400">
            ✓ Swap Executed
          </h3>

          {onChainVerified !== null && (
            <div
              className={`text-xs px-3 py-2 rounded-lg border ${
                onChainVerified
                  ? "bg-green-950 border-green-700 text-green-300"
                  : "bg-yellow-950 border-yellow-700 text-yellow-300"
              }`}
            >
              {onChainVerified
                ? "✓ __validate__ confirmed — secp256k1 signature verified on-chain"
                : "⚠ On-chain check inconclusive (tx may still be pending)"}
            </div>
          )}

          <div className="flex justify-between items-center">
            <span className="text-slate-500 text-xs">Sold</span>
            <span className="text-slate-300 text-xs font-mono">
              {amount} STRK
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-slate-500 text-xs">Received (est.)</span>
            <span className="text-green-400 text-xs font-mono">
              {formatEth(quote.buyAmount)} ETH
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-slate-500 text-xs">Transaction hash</span>
            <span className="font-mono text-xs text-slate-300 break-all">
              {txHash}
            </span>
          </div>

          <p className="text-slate-600 text-xs leading-relaxed">
            Click &quot;Internal Calls&quot; on Voyager to see{" "}
            <code className="text-slate-500">__validate__</code> executing
            secp256k1 verification in the trace.
          </p>

          <a
            href={`https://sepolia.voyager.online/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-purple-400 hover:text-purple-300 underline underline-offset-2 transition-colors"
          >
            View on Voyager (check Internal Calls) ↗
          </a>

          <button
            onClick={handleReset}
            className="text-slate-500 text-xs underline underline-offset-2"
          >
            Swap again
          </button>
        </div>
      )}
    </div>
  );
}
