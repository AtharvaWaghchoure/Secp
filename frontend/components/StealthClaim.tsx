"use client";

import { useState, useEffect } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  scanAllAnnouncements,
  claimStealthPayment,
  type ClaimablePayment,
} from "@/lib/stealthClaim";
import type { BitcoinWallet } from "@/lib/bitcoin";

const SESSION_KEY = "secp_claim_privkey";

// ── WIF decoder ───────────────────────────────────────────────────────────────
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`Invalid base58 character: ${c}`);
    n = n * 58n + BigInt(i);
  }
  let leading = 0;
  for (const c of s) { if (c !== "1") break; leading++; }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  return new Uint8Array([...new Array(leading).fill(0), ...bytes]);
}

/** Decode a WIF private key string → 64-char lowercase hex. */
function decodeWIF(wif: string): string {
  const decoded = base58Decode(wif.trim());
  // layout: [version 1B] [privkey 32B] [compression flag 1B optional] [checksum 4B]
  const payload = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);
  const hash = sha256(sha256(payload));
  for (let i = 0; i < 4; i++) {
    if (hash[i] !== checksum[i]) throw new Error("Invalid WIF checksum — wrong key or network");
  }
  let key = payload.slice(1); // strip version byte
  if (key.length === 33 && key[32] === 0x01) key = key.slice(0, 32); // strip compression flag
  if (key.length !== 32) throw new Error("WIF decoded to unexpected length");
  return Array.from(key).map(b => b.toString(16).padStart(2, "0")).join("");
}

interface Props {
  /** Recipient's own Starknet address — stealth STRK is swept here. */
  starknetAddress: string;
  wallet: BitcoinWallet;
}

type Phase = "idle" | "scanning" | "ready" | "claiming" | "done" | "error";

export default function StealthClaim({ starknetAddress }: Props) {
  const [privkey, setPrivkey] = useState("");
  const [wifInput, setWifInput] = useState("");
  const [wifError, setWifError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [showXverseGuide, setShowXverseGuide] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) setSavedKey(stored);
  }, []);

  function handleWifChange(raw: string) {
    setWifInput(raw);
    setWifError(null);
    const trimmed = raw.trim();
    if (!trimmed) { setPrivkey(""); return; }
    try {
      setPrivkey(decodeWIF(trimmed));
    } catch (e) {
      setWifError(e instanceof Error ? e.message : "Invalid WIF");
      setPrivkey("");
    }
  }

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
      sessionStorage.setItem(SESSION_KEY, privkey.trim());
      setSavedKey(privkey.trim());
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
          {/* WIF input — primary path */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-500 text-xs">
                Bitcoin private key{" "}
                <span className="text-slate-600">(WIF from Xverse or raw hex)</span>
              </label>
              <button
                onClick={() => setShowXverseGuide(v => !v)}
                className="text-purple-400 text-xs underline underline-offset-2"
              >
                {showXverseGuide ? "hide guide" : "how to get it from Xverse ↗"}
              </button>
            </div>

            {showXverseGuide && (
              <div className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 flex flex-col gap-1 text-xs text-slate-400 leading-relaxed">
                <p className="font-semibold text-slate-300">Export from Xverse:</p>
                <ol className="list-decimal list-inside space-y-0.5 text-slate-500">
                  <li>Open the Xverse extension</li>
                  <li>Tap the wallet name → <span className="text-slate-400">⋯ (3-dot menu)</span></li>
                  <li>Go to <span className="text-slate-400">Wallet settings</span></li>
                  <li>Tap <span className="text-slate-400">Show secret key</span> (or Export)</li>
                  <li>Confirm with your password</li>
                  <li>Copy the <span className="text-slate-400">WIF string</span> (starts with K, L, or c)</li>
                </ol>
                <p className="text-slate-600 mt-0.5">Paste it below — it converts to hex automatically.</p>
              </div>
            )}

            <input
              type="password"
              value={wifInput}
              onChange={(e) => handleWifChange(e.target.value)}
              placeholder="WIF (K… / L… / c…) or 64 hex chars…"
              disabled={phase === "scanning" || claimingIdx !== null}
              className="bg-slate-900 border border-slate-700 focus:border-purple-600 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none disabled:opacity-50"
            />

            {/* WIF decode error */}
            {wifError && (
              <p className="text-red-400 text-xs">{wifError}</p>
            )}

            {/* Decoded hex preview */}
            {privkey && !wifError && wifInput && (
              <p className="text-green-500 text-xs font-mono">
                ✓ Decoded — {privkey.slice(0, 8)}…{privkey.slice(-8)}
              </p>
            )}

            {/* Raw hex fallback */}
            {!wifInput && (
              <input
                type="password"
                value={privkey}
                onChange={(e) => setPrivkey(e.target.value)}
                placeholder="…or paste raw hex directly (64 chars)"
                disabled={phase === "scanning" || claimingIdx !== null}
                className="bg-slate-800 border border-slate-700 focus:border-purple-600 rounded-lg px-3 py-2 text-xs font-mono text-slate-400 placeholder-slate-600 focus:outline-none disabled:opacity-50"
              />
            )}

            {/* use mine — from session */}
            {savedKey && privkey !== savedKey && (
              <p className="text-slate-600 text-xs">
                Your own key for this session:{" "}
                <button
                  className="text-purple-400 underline underline-offset-2"
                  onClick={() => { setPrivkey(savedKey); setWifInput(""); setWifError(null); }}
                  disabled={phase === "scanning" || claimingIdx !== null}
                >
                  use mine
                </button>
              </p>
            )}
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
                        {claimed.deployTx === "(already deployed)" ? (
                          <p className="text-slate-500 text-xs">
                            Deploy — skipped (contract already deployed)
                          </p>
                        ) : (
                          <Field label="Deploy tx" value={claimed.deployTx} />
                        )}
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
                          ? "Sweeping STRK… (~10 s)"
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
