"use client";

import { useState } from "react";
import type { BitcoinWallet } from "@/lib/bitcoin";
import { deriveStealthPayment } from "@/lib/stealth";
import { sendStrk, getStrkBalance, verifySignatureOnChain, announceOnChain } from "@/lib/starknet";
import { saveAnnouncement } from "@/lib/stealthClaim";

interface Props {
  wallet: BitcoinWallet;
  starknetAddress: string;
}

type Phase = "input" | "derived" | "signing" | "verifying" | "announcing" | "done" | "error";

export default function StealthSend({ wallet, starknetAddress }: Props) {
  const [recipientPubkey, setRecipientPubkey] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [phase, setPhase] = useState<Phase>("input");
  const [stealth, setStealth] = useState<{
    ephemeralPubkey: string;
    stealthAddress: string;
    stealthPubkeyX: bigint;
    stealthPubkeyY: bigint;
  } | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [onChainVerified, setOnChainVerified] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Recipient pubkey: 33-byte compressed secp256k1, 66 hex chars, 02 or 03 prefix
  const pubkeyValid = /^0[23][0-9a-fA-F]{64}$/.test(recipientPubkey.trim());
  const amountValid =
    /^\d+(\.\d+)?$/.test(amount.trim()) && parseFloat(amount) > 0;

  function handleDerive() {
    try {
      const result = deriveStealthPayment(recipientPubkey.trim());
      setStealth({
        ephemeralPubkey: result.ephemeralPubkey,
        stealthAddress: result.stealthAddress,
        stealthPubkeyX: result.stealthPubkeyX,
        stealthPubkeyY: result.stealthPubkeyY,
      });
      setPhase("derived");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Derivation failed");
      setPhase("error");
    }
  }

  async function handleSend() {
    if (!stealth) return;
    setPhase("signing");
    setError(null);
    try {
      const result = await sendStrk(
        wallet.address,
        wallet.publicKeyX,
        wallet.publicKeyY,
        stealth.stealthAddress,
        amount
      );
      setTxHash(result.transaction_hash);
      setPhase("verifying");

      // Persist to localStorage (fallback / instant)
      saveAnnouncement({
        ephemeralPubkey: stealth.ephemeralPubkey,
        stealthAddress: stealth.stealthAddress,
        stealthPubkeyX: stealth.stealthPubkeyX.toString(),
        stealthPubkeyY: stealth.stealthPubkeyY.toString(),
        sentAt: Date.now(),
      });

      const verified = await verifySignatureOnChain(
        starknetAddress,
        result.signedTxHash,
        result.signature
      );
      setOnChainVerified(verified);

      // Publish announcement on-chain (fire; failure is non-fatal)
      setPhase("announcing");
      try {
        await announceOnChain(
          wallet.address,
          wallet.publicKeyX,
          wallet.publicKeyY,
          stealth.stealthAddress,
          stealth.ephemeralPubkey
        );
      } catch {
        // On-chain announce failed — localStorage fallback is already saved
      }
      setPhase("done");

      getStrkBalance(starknetAddress); // refresh (fire and forget)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
      setPhase("error");
    }
  }

  function handleReset() {
    setPhase("input");
    setStealth(null);
    setTxHash(null);
    setOnChainVerified(null);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Explainer */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-purple-400">
          How it works
        </h3>
        <ol className="text-slate-500 text-xs leading-relaxed list-decimal list-inside space-y-1">
          <li>
            Enter the recipient&apos;s Bitcoin public key — they share this
            once, like an address.
          </li>
          <li>
            A one-time stealth Starknet address is derived via ECDH. Nobody
            watching the chain can link it to the recipient.
          </li>
          <li>
            Your Bitcoin key signs the send transaction on-chain. The stealth
            address holds the funds until the recipient claims them.
          </li>
        </ol>
      </div>

      {/* Step 1: input */}
      {(phase === "input" || phase === "error") && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-slate-500 text-xs">
              Recipient Bitcoin public key{" "}
              <span className="text-slate-600">(compressed, 66 hex chars)</span>
            </label>
            <input
              type="text"
              value={recipientPubkey}
              onChange={(e) => setRecipientPubkey(e.target.value)}
              placeholder="02 or 03 + 64 hex chars…"
              className="bg-slate-900 border border-slate-700 focus:border-purple-600 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none"
            />
            <p className="text-slate-600 text-xs">
              Your own pubkey for testing:{" "}
              <button
                className="text-purple-400 underline underline-offset-2"
                onClick={() => setRecipientPubkey(wallet.publicKeyHex)}
              >
                use mine
              </button>
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-slate-500 text-xs">Amount (STRK)</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.01"
              className="bg-slate-900 border border-slate-700 focus:border-purple-600 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none"
            />
          </div>

          {phase === "error" && error && (
            <p className="text-red-400 text-xs bg-red-950 border border-red-800 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            onClick={handleDerive}
            disabled={!pubkeyValid || !amountValid}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            Derive Stealth Address
          </button>
        </div>
      )}

      {/* Step 2: show derived address */}
      {(phase === "derived" || phase === "signing" || phase === "announcing") && stealth && (
        <div className="flex flex-col gap-3">
          <div className="border border-purple-800 rounded-xl p-4 flex flex-col gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-purple-400">
              One-Time Stealth Address Derived
            </h3>
            <Field
              label="Ephemeral pubkey R (share with recipient for scanning)"
              value={stealth.ephemeralPubkey}
            />
            <Field
              label="Stealth Starknet address (send funds here)"
              value={stealth.stealthAddress}
            />
            <p className="text-slate-600 text-xs leading-relaxed">
              This address is mathematically linked to the recipient&apos;s
              Bitcoin key but indistinguishable from a random address on-chain.
              The recipient scans published ephemeral keys to discover payments.
            </p>
          </div>

          <button
            onClick={handleSend}
            disabled={phase === "signing" || phase === "announcing"}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            {phase === "signing"
              ? "Waiting for Xverse…"
              : phase === "announcing"
              ? "Publishing announcement on-chain…"
              : `Send ${amount} STRK to Stealth Address`}
          </button>

          <button
            onClick={handleReset}
            disabled={phase === "signing" || phase === "announcing"}
            className="text-slate-500 text-xs underline underline-offset-2"
          >
            Start over
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
      {phase === "done" && txHash && stealth && (
        <div className="border border-green-800 rounded-xl p-4 flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-green-400">
            ✓ Stealth Payment Sent
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
                ? "✓ __validate__ confirmed: secp256k1 signature valid on-chain"
                : "⚠ On-chain check inconclusive (tx may still be pending)"}
            </div>
          )}

          <Field label="Transaction hash" value={txHash} />
          <Field
            label="Stealth address (recipient scans for this)"
            value={stealth.stealthAddress}
          />
          <Field
            label="Ephemeral key R (publish so recipient can scan)"
            value={stealth.ephemeralPubkey}
          />

          <p className="text-slate-600 text-xs leading-relaxed">
            The recipient computes{" "}
            <code className="text-slate-400">S = sk · R</code> for each
            published R, derives the stealth address, and checks for a balance.
            Claiming requires a custom signer with{" "}
            <code className="text-slate-400">
              sk_stealth = sk + H(S) mod n
            </code>
            .
          </p>

          <a
            href={`https://sepolia.voyager.online/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-purple-400 hover:text-purple-300 underline underline-offset-2"
          >
            View on Voyager ↗
          </a>

          <button
            onClick={handleReset}
            className="text-slate-500 text-xs underline underline-offset-2"
          >
            Send another
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-slate-500 text-xs">{label}</span>
      <span className="font-mono text-xs text-slate-300 break-all">{value}</span>
    </div>
  );
}
