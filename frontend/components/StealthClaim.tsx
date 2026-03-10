"use client";

import { useState } from "react";
import {
  scanAllAnnouncements,
  claimStealthPayment,
  type ClaimablePayment,
} from "@/lib/stealthClaim";

interface Props {
  /** Recipient's own Starknet address — stealth STRK is swept here. */
  starknetAddress: string;
}

type Phase = "idle" | "scanning" | "ready" | "claiming" | "done" | "error";

export default function StealthClaim({ starknetAddress }: Props) {
  const [privkey, setPrivkey] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [payments, setPayments] = useState<ClaimablePayment[]>([]);
  const [claimingIdx, setClaimingIdx] = useState<number | null>(null);
  const [claimResults, setClaimResults] = useState<
    Record<number, { deployTx: string; sweepTx: string }>
  >({});
  const [error, setError] = useState<string | null>(null);

  // Very loose validation — just needs to be 64 hex chars (with or without 0x)
  const privkeyValid = /^(0x)?[0-9a-fA-F]{64}$/.test(privkey.trim());

  async function handleScan() {
    setPhase("scanning");
    setError(null);
    setPayments([]);
    try {
      const found = await scanAllAnnouncements(privkey.trim());
      setPayments(found);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
      setPhase("error");
    }
  }

  async function handleClaim(idx: number) {
    setClaimingIdx(idx);
    setError(null);
    try {
      const result = await claimStealthPayment(payments[idx], starknetAddress);
      setClaimResults((prev) => ({ ...prev, [idx]: result }));
      setClaimingIdx(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed");
      setClaimingIdx(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Warning */}
      <div className="bg-yellow-950 border border-yellow-700 rounded-xl p-3 flex flex-col gap-1">
        <p className="text-yellow-400 text-xs font-semibold">
          Private key required — stays in your browser
        </p>
        <p className="text-yellow-600 text-xs leading-relaxed">
          Scanning requires your secp256k1 private key to recompute shared
          secrets. It is never sent to any server or logged anywhere. Use only
          on a device you trust.
        </p>
      </div>

      {/* Explainer */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-purple-400">
          How claiming works
        </h3>
        <ol className="text-slate-500 text-xs leading-relaxed list-decimal list-inside space-y-1">
          <li>
            For each stealth payment sent to you, recompute{" "}
            <code className="text-slate-400">S = sk · R</code> and derive{" "}
            <code className="text-slate-400">
              sk_stealth = (sk + H(S)) mod n
            </code>
            .
          </li>
          <li>
            Deploy the BitcoinAccount at the stealth address — signed
            automatically with sk_stealth (no Xverse popup).
          </li>
          <li>Sweep all STRK to your main address.</li>
        </ol>
      </div>

      {/* Private key input */}
      {phase !== "done" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-slate-500 text-xs">
              Your Bitcoin private key{" "}
              <span className="text-slate-600">(64 hex chars)</span>
            </label>
            <input
              type="password"
              value={privkey}
              onChange={(e) => setPrivkey(e.target.value)}
              placeholder="64 hex characters…"
              disabled={phase === "scanning" || claimingIdx !== null}
              className="bg-slate-900 border border-slate-700 focus:border-purple-600 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none disabled:opacity-50"
            />
          </div>

          {phase === "error" && error && (
            <p className="text-red-400 text-xs bg-red-950 border border-red-800 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            onClick={handleScan}
            disabled={!privkeyValid || phase === "scanning" || claimingIdx !== null}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            {phase === "scanning" ? "Scanning on-chain registry…" : "Scan for Payments"}
          </button>
        </div>
      )}

      {/* Scan results */}
      {phase === "ready" && (
        <>
          {payments.length === 0 ? (
            <p className="text-slate-500 text-xs text-center py-2">
              No funded stealth payments found in local announcements.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-green-400 text-xs font-semibold">
                {payments.length} claimable payment
                {payments.length > 1 ? "s" : ""} found
              </p>

              {payments.map((p, idx) => {
                const claimed = claimResults[idx];
                const isClaiming = claimingIdx === idx;

                return (
                  <div
                    key={idx}
                    className="border border-purple-800 rounded-xl p-4 flex flex-col gap-3"
                  >
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 text-xs">Balance</span>
                      <span className="text-green-400 text-xs font-mono font-semibold">
                        {p.balance} STRK
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-slate-500 text-xs">
                        Stealth address
                      </span>
                      <span className="font-mono text-xs text-slate-400 break-all">
                        {p.announcement.stealthAddress}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-slate-500 text-xs">
                        Ephemeral key R
                      </span>
                      <span className="font-mono text-xs text-slate-400 break-all">
                        {p.announcement.ephemeralPubkey}
                      </span>
                    </div>

                    {claimed ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-green-400 text-xs font-semibold">
                          ✓ Claimed
                        </p>
                        <Field label="Deploy tx" value={claimed.deployTx} />
                        <Field label="Sweep tx" value={claimed.sweepTx} />
                        <a
                          href={`https://sepolia.voyager.online/tx/${claimed.sweepTx}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-purple-400 hover:text-purple-300 underline underline-offset-2"
                        >
                          View sweep on Voyager ↗
                        </a>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleClaim(idx)}
                        disabled={isClaiming || claimingIdx !== null}
                        className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white font-semibold py-2 rounded-lg text-xs transition-colors"
                      >
                        {isClaiming
                          ? "Deploying stealth account… (~10 s)"
                          : `Deploy & Claim ${p.balance} STRK`}
                      </button>
                    )}
                  </div>
                );
              })}

              {error && claimingIdx === null && (
                <p className="text-red-400 text-xs bg-red-950 border border-red-800 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
            </div>
          )}
        </>
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
