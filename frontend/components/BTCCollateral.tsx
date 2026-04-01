"use client";

import { useState, useEffect, useCallback } from "react";
import type { BitcoinWallet } from "@/lib/bitcoin";
import {
  lockCollateral,
  borrowStrk,
  repayStrk,
  getBTCPosition,
  type BTCPosition,
} from "@/lib/starknet";

interface Props {
  wallet: BitcoinWallet;
  starknetAddress: string;
}

type Tab = "lock" | "borrow" | "repay" | "position";
type Phase = "idle" | "signing" | "pending" | "done" | "error";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSats(sats: bigint): string {
  return (Number(sats) / 1e8).toFixed(6) + " BTC";
}

function formatStrk(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(4) + " STRK";
}

function ltvColor(ltv: number): string {
  if (ltv < 30) return "bg-green-500";
  if (ltv < 45) return "bg-yellow-500";
  return "bg-red-500";
}

function ltvTextColor(ltv: number): string {
  if (ltv < 30) return "text-green-400";
  if (ltv < 45) return "text-yellow-400";
  return "text-red-400";
}

// ── Main component ────────────────────────────────────────────────────────────

export default function BTCCollateral({ wallet, starknetAddress }: Props) {
  const [tab, setTab] = useState<Tab>("lock");
  const [position, setPosition] = useState<BTCPosition | null>(null);
  const [loadingPosition, setLoadingPosition] = useState(false);

  // Lock tab state
  const [btcAmount, setBtcAmount] = useState("0.01");
  const [lockPhase, setLockPhase] = useState<Phase>("idle");
  const [lockTxHash, setLockTxHash] = useState<string | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);

  // Borrow tab state
  const [borrowAmount, setBorrowAmount] = useState("");
  const [borrowPhase, setBorrowPhase] = useState<Phase>("idle");
  const [borrowTxHash, setBorrowTxHash] = useState<string | null>(null);
  const [borrowError, setBorrowError] = useState<string | null>(null);

  // Repay tab state
  const [repayAmount, setRepayAmount] = useState("");
  const [repayPhase, setRepayPhase] = useState<Phase>("idle");
  const [repayTxHash, setRepayTxHash] = useState<string | null>(null);
  const [repayError, setRepayError] = useState<string | null>(null);

  const refreshPosition = useCallback(async () => {
    setLoadingPosition(true);
    try {
      const p = await getBTCPosition(starknetAddress);
      setPosition(p);
    } catch {
      // no position yet
    } finally {
      setLoadingPosition(false);
    }
  }, [starknetAddress]);

  useEffect(() => {
    refreshPosition();
  }, [refreshPosition]);

  // ── Preview calculations ───────────────────────────────────────────────────

  const STRK_PER_SAT = 5_000_000_000_000_000n;
  const previewSats = BigInt(
    Math.max(0, Math.round(parseFloat(btcAmount || "0") * 1e8))
  );
  const previewCollateralValue = previewSats * STRK_PER_SAT;
  const previewMaxBorrow = previewCollateralValue / 2n;

  const availableToBorrow =
    position && position.maxBorrow > position.debtStrk
      ? position.maxBorrow - position.debtStrk
      : 0n;

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleLock() {
    if (!btcAmount || parseFloat(btcAmount) <= 0) return;
    setLockPhase("signing");
    setLockError(null);
    try {
      const result = await lockCollateral(
        wallet.address,
        wallet.publicKeyX,
        wallet.publicKeyY,
        btcAmount
      );
      setLockTxHash(result.transaction_hash);
      setLockPhase("done");
      setTimeout(refreshPosition, 5000);
    } catch (err) {
      setLockError(err instanceof Error ? err.message : "Lock failed");
      setLockPhase("error");
    }
  }

  async function handleBorrow() {
    if (!borrowAmount || parseFloat(borrowAmount) <= 0) return;
    setBorrowPhase("signing");
    setBorrowError(null);
    try {
      const result = await borrowStrk(
        wallet.address,
        wallet.publicKeyX,
        wallet.publicKeyY,
        borrowAmount
      );
      setBorrowTxHash(result.transaction_hash);
      setBorrowPhase("done");
      setTimeout(refreshPosition, 5000);
    } catch (err) {
      setBorrowError(err instanceof Error ? err.message : "Borrow failed");
      setBorrowPhase("error");
    }
  }

  async function handleRepay() {
    if (!repayAmount || parseFloat(repayAmount) <= 0) return;
    setRepayPhase("signing");
    setRepayError(null);
    try {
      const result = await repayStrk(
        wallet.address,
        wallet.publicKeyX,
        wallet.publicKeyY,
        repayAmount
      );
      setRepayTxHash(result.transaction_hash);
      setRepayPhase("done");
      setTimeout(refreshPosition, 5000);
    } catch (err) {
      setRepayError(err instanceof Error ? err.message : "Repay failed");
      setRepayPhase("error");
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* Explainer */}
      <p className="text-slate-500 text-xs leading-relaxed">
        Prove you own BTC by signing with your Bitcoin key. The secp256k1
        signature is verified on-chain —{" "}
        <span className="text-orange-400">no bridge, no wrap, no custodian</span>.
        Lock BTC as collateral and borrow STRK at 50% LTV.
      </p>

      {/* Position snapshot */}
      {position && position.collateralSats > 0n && (
        <div className="bg-slate-900 border border-orange-900 rounded-lg px-4 py-3 flex flex-col gap-2">
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">Collateral</span>
            <span className="text-orange-300 font-mono">
              {formatSats(position.collateralSats)}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">Borrowed</span>
            <span className="text-slate-300 font-mono">
              {formatStrk(position.debtStrk)}
            </span>
          </div>
          <div className="flex justify-between text-xs items-center">
            <span className="text-slate-500">LTV</span>
            <span className={`font-mono font-semibold ${ltvTextColor(position.ltvPercent)}`}>
              {position.ltvPercent.toFixed(1)}%
            </span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-1.5 mt-1">
            <div
              className={`h-1.5 rounded-full transition-all ${ltvColor(position.ltvPercent)}`}
              style={{ width: `${Math.min(100, position.ltvPercent * 2)}%` }}
            />
          </div>
        </div>
      )}

      {/* Sub-tabs */}
      <div className="flex gap-1 bg-slate-900 rounded-lg p-1">
        {(
          [
            ["lock", "Lock BTC"],
            ["borrow", "Borrow"],
            ["repay", "Repay"],
            ["position", "Position"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              tab === t
                ? "bg-slate-700 text-white"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Lock tab ── */}
      {tab === "lock" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-slate-500 text-xs">BTC Amount</label>
            <input
              type="text"
              value={btcAmount}
              onChange={(e) => setBtcAmount(e.target.value)}
              placeholder="0.01"
              disabled={lockPhase === "signing"}
              className="bg-slate-900 border border-slate-700 focus:border-orange-600 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none"
            />
          </div>

          {previewSats > 0n && (
            <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 flex flex-col gap-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">Collateral value</span>
                <span className="text-slate-300 font-mono">
                  {formatStrk(previewCollateralValue)}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">Max borrow (50%)</span>
                <span className="text-orange-300 font-mono">
                  {formatStrk(previewMaxBorrow)}
                </span>
              </div>
            </div>
          )}

          {lockPhase === "done" && lockTxHash && (
            <div className="bg-green-950 border border-green-800 rounded-lg px-3 py-2 flex flex-col gap-1">
              <p className="text-green-400 text-xs font-semibold">
                ✓ Collateral locked on-chain
              </p>
              <a
                href={`https://sepolia.voyager.online/tx/${lockTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-green-500 underline underline-offset-2"
              >
                View on Voyager ↗
              </a>
              <button
                onClick={() => {
                  setLockPhase("idle");
                  setLockTxHash(null);
                }}
                className="text-slate-500 text-xs underline underline-offset-2 text-left"
              >
                Lock more
              </button>
            </div>
          )}

          {lockPhase === "error" && lockError && (
            <p className="text-red-400 text-xs bg-red-950 border border-red-800 rounded-lg px-3 py-2">
              {lockError}
            </p>
          )}

          {lockPhase !== "done" && (
            <button
              onClick={handleLock}
              disabled={
                lockPhase === "signing" || !btcAmount || parseFloat(btcAmount) <= 0
              }
              className="w-full bg-orange-600 hover:bg-orange-500 disabled:bg-orange-900 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
            >
              {lockPhase === "signing"
                ? "Waiting for Xverse…"
                : "Lock BTC Collateral"}
            </button>
          )}
        </div>
      )}

      {/* ── Borrow tab ── */}
      {tab === "borrow" && (
        <div className="flex flex-col gap-3">
          {availableToBorrow > 0n ? (
            <>
              <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 flex flex-col gap-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Available to borrow</span>
                  <span className="text-orange-300 font-mono">
                    {formatStrk(availableToBorrow)}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Current debt</span>
                  <span className="text-slate-300 font-mono">
                    {formatStrk(position?.debtStrk ?? 0n)}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-slate-500 text-xs">STRK Amount</label>
                <input
                  type="text"
                  value={borrowAmount}
                  onChange={(e) => setBorrowAmount(e.target.value)}
                  placeholder="0.5"
                  disabled={borrowPhase === "signing"}
                  className="bg-slate-900 border border-slate-700 focus:border-orange-600 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none"
                />
              </div>

              {borrowPhase === "done" && borrowTxHash && (
                <div className="bg-green-950 border border-green-800 rounded-lg px-3 py-2 flex flex-col gap-1">
                  <p className="text-green-400 text-xs font-semibold">
                    ✓ STRK borrowed
                  </p>
                  <a
                    href={`https://sepolia.voyager.online/tx/${borrowTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-green-500 underline underline-offset-2"
                  >
                    View on Voyager ↗
                  </a>
                  <button
                    onClick={() => { setBorrowPhase("idle"); setBorrowTxHash(null); }}
                    className="text-slate-500 text-xs underline underline-offset-2 text-left"
                  >
                    Borrow more
                  </button>
                </div>
              )}

              {borrowPhase === "error" && borrowError && (
                <p className="text-red-400 text-xs bg-red-950 border border-red-800 rounded-lg px-3 py-2">
                  {borrowError}
                </p>
              )}

              {borrowPhase !== "done" && (
                <button
                  onClick={handleBorrow}
                  disabled={
                    borrowPhase === "signing" ||
                    !borrowAmount ||
                    parseFloat(borrowAmount) <= 0
                  }
                  className="w-full bg-orange-600 hover:bg-orange-500 disabled:bg-orange-900 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
                >
                  {borrowPhase === "signing" ? "Waiting for Xverse…" : "Borrow STRK"}
                </button>
              )}
            </>
          ) : (
            <p className="text-slate-500 text-xs text-center py-4">
              No borrow capacity. Lock BTC collateral first.
            </p>
          )}
        </div>
      )}

      {/* ── Repay tab ── */}
      {tab === "repay" && (
        <div className="flex flex-col gap-3">
          {position && position.debtStrk > 0n ? (
            <>
              <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Outstanding debt</span>
                  <span className="text-red-300 font-mono">
                    {formatStrk(position.debtStrk)}
                  </span>
                </div>
              </div>

              <p className="text-slate-600 text-xs">
                Approve + repay in one transaction — you sign once.
              </p>

              <div className="flex flex-col gap-1">
                <label className="text-slate-500 text-xs">STRK to repay</label>
                <input
                  type="text"
                  value={repayAmount}
                  onChange={(e) => setRepayAmount(e.target.value)}
                  placeholder={(Number(position.debtStrk) / 1e18).toFixed(4)}
                  disabled={repayPhase === "signing"}
                  className="bg-slate-900 border border-slate-700 focus:border-orange-600 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none"
                />
              </div>

              {repayPhase === "done" && repayTxHash && (
                <div className="bg-green-950 border border-green-800 rounded-lg px-3 py-2 flex flex-col gap-1">
                  <p className="text-green-400 text-xs font-semibold">✓ Repaid</p>
                  <a
                    href={`https://sepolia.voyager.online/tx/${repayTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-green-500 underline underline-offset-2"
                  >
                    View on Voyager ↗
                  </a>
                </div>
              )}

              {repayPhase === "error" && repayError && (
                <p className="text-red-400 text-xs bg-red-950 border border-red-800 rounded-lg px-3 py-2">
                  {repayError}
                </p>
              )}

              {repayPhase !== "done" && (
                <button
                  onClick={handleRepay}
                  disabled={
                    repayPhase === "signing" ||
                    !repayAmount ||
                    parseFloat(repayAmount) <= 0
                  }
                  className="w-full bg-orange-600 hover:bg-orange-500 disabled:bg-orange-900 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors"
                >
                  {repayPhase === "signing"
                    ? "Waiting for Xverse…"
                    : "Approve & Repay"}
                </button>
              )}
            </>
          ) : (
            <p className="text-slate-500 text-xs text-center py-4">
              No outstanding debt.
            </p>
          )}
        </div>
      )}

      {/* ── Position tab ── */}
      {tab === "position" && (
        <div className="flex flex-col gap-3">
          {position ? (
            position.collateralSats > 0n ? (
              <div className="flex flex-col gap-2">
                <div className="border border-orange-900 rounded-xl px-4 py-3 flex flex-col gap-2.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">BTC Collateral</span>
                    <span className="text-orange-300 font-mono">
                      {formatSats(position.collateralSats)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Value in STRK</span>
                    <span className="text-slate-300 font-mono">
                      {formatStrk(position.collateralValueStrk)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Borrowed</span>
                    <span className="text-slate-300 font-mono">
                      {formatStrk(position.debtStrk)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Max borrow (50% LTV)</span>
                    <span className="text-orange-300 font-mono">
                      {formatStrk(position.maxBorrow)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs items-center">
                    <span className="text-slate-500">LTV</span>
                    <span className={`font-mono font-semibold ${ltvTextColor(position.ltvPercent)}`}>
                      {position.ltvPercent.toFixed(1)}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-700 rounded-full h-2 mt-1">
                    <div
                      className={`h-2 rounded-full transition-all ${ltvColor(position.ltvPercent)}`}
                      style={{ width: `${Math.min(100, position.ltvPercent * 2)}%` }}
                    />
                  </div>
                  <p className="text-slate-600 text-xs">
                    Liquidation at 50% LTV · Price: 500K STRK/BTC (demo)
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-slate-500 text-xs text-center py-4">
                No position yet. Lock BTC collateral to get started.
              </p>
            )
          ) : (
            <p className="text-slate-500 text-xs text-center py-4 animate-pulse">
              {loadingPosition ? "Loading position…" : "No position found."}
            </p>
          )}

          <button
            onClick={refreshPosition}
            disabled={loadingPosition}
            className="text-slate-500 text-xs underline underline-offset-2"
          >
            {loadingPosition ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}
    </div>
  );
}
