"use client";

import { useState, useEffect } from "react";
import type { BitcoinWallet } from "@/lib/bitcoin";
import { getStrkBalance } from "@/lib/starknet";
import SwapDemo from "./SwapDemo";
import StealthSend from "./StealthSend";
import StealthClaim from "./StealthClaim";
import BTCCollateral from "./BTCCollateral";
import PrivacyPool from "./PrivacyPool";
import WalletConnectTab from "./WalletConnectTab";

interface Props {
  wallet: BitcoinWallet;
  starknetAddress: string;
}

type Tab = "swap" | "stealth" | "claim" | "collateral" | "pool" | "wc";

export default function SignDemo({ wallet, starknetAddress }: Props) {
  const [tab, setTab] = useState<Tab>("swap");
  const [strkBalance, setStrkBalance] = useState<string>("…");

  useEffect(() => {
    getStrkBalance(starknetAddress).then(setStrkBalance);
  }, [starknetAddress]);

  return (
    <div className="w-full max-w-xl flex flex-col gap-4">
      {/* Balance */}
      <p className="text-slate-600 text-xs text-center">
        Balance:{" "}
        <span className="text-slate-400 font-mono">{strkBalance} STRK</span>
      </p>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-slate-900 rounded-lg p-1">
        {([["swap", "DeFi Swap"], ["stealth", "Stealth Send"], ["claim", "Claim"], ["collateral", "BTC Loan"], ["pool", "Pool"], ["wc", "WalletConnect"]] as [Tab, string][]).map(
          ([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-md text-xs font-semibold transition-colors ${
                tab === t
                  ? "bg-slate-700 text-white"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {label}
              {t === "stealth" && (
                <span className="ml-1.5 text-purple-400 text-xs">Privacy</span>
              )}
              {t === "swap" && (
                <span className="ml-1.5 text-green-400 text-xs">DeFi</span>
              )}
              {t === "claim" && (
                <span className="ml-1.5 text-yellow-400 text-xs">Receive</span>
              )}
              {t === "collateral" && (
                <span className="ml-1.5 text-orange-400 text-xs">DeFi</span>
              )}
              {t === "pool" && (
                <span className="ml-1.5 text-teal-400 text-xs">Shield</span>
              )}
              {t === "wc" && (
                <span className="ml-1.5 text-blue-400 text-xs">SDK</span>
              )}
            </button>
          )
        )}
      </div>

      {/* ── DeFi Swap ── */}
      {tab === "swap" && (
        <div className="border border-slate-700 rounded-xl p-4 flex flex-col gap-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            STRK → ETH — Bitcoin Key Authorizes On-Chain
          </h2>
          <SwapDemo wallet={wallet} starknetAddress={starknetAddress} />
        </div>
      )}

      {/* ── Stealth Send ── */}
      {tab === "stealth" && (
        <div className="border border-purple-900 rounded-xl p-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-purple-400 mb-4">
            Stealth Send — Privacy-Preserving Transfer
          </h2>
          <StealthSend wallet={wallet} starknetAddress={starknetAddress} />
        </div>
      )}

      {/* ── Stealth Claim ── */}
      {tab === "claim" && (
        <div className="border border-yellow-900 rounded-xl p-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-yellow-400 mb-4">
            Claim Stealth Payments — Sweep to Your Address
          </h2>
          <StealthClaim starknetAddress={starknetAddress} wallet={wallet} />
        </div>
      )}

      {/* ── BTC Collateral ── */}
      {tab === "collateral" && (
        <div className="border border-orange-900 rounded-xl p-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-orange-400 mb-4">
            BTC Collateral — Borrow STRK Against Bitcoin
          </h2>
          <BTCCollateral wallet={wallet} starknetAddress={starknetAddress} />
        </div>
      )}

      {/* ── Privacy Pool ── */}
      {tab === "pool" && (
        <div className="border border-teal-900 rounded-xl p-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-teal-400 mb-4">
            Privacy Pool — Fixed-Denomination Shielded Transfers
          </h2>
          <PrivacyPool wallet={wallet} starknetAddress={starknetAddress} />
        </div>
      )}

      {/* ── WalletConnect ── */}
      {tab === "wc" && (
        <div className="border border-blue-900 rounded-xl p-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-400 mb-4">
            WalletConnect — Connect Any Starknet dApp
          </h2>
          <WalletConnectTab wallet={wallet} />
        </div>
      )}
    </div>
  );
}
