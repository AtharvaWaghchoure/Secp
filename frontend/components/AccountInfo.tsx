"use client";

import { useEffect, useState } from "react";
import type { BitcoinWallet } from "@/lib/bitcoin";
import {
  deriveBitcoinAccountAddress,
  isAccountDeployed,
  getEthBalance,
  getStrkBalance,
  deployBitcoinAccount,
} from "@/lib/starknet";

interface Props {
  wallet: BitcoinWallet;
  onDeployRequest: (starknetAddress: string) => void;
}

export default function AccountInfo({ wallet, onDeployRequest }: Props) {
  const [starknetAddress, setStarknetAddress] = useState<string>("");
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [ethBalance, setEthBalance] = useState<string>("…");
  const [strkBalance, setStrkBalance] = useState<string>("…");
  const [loading, setLoading] = useState(true);
  const [deployStatus, setDeployStatus] = useState<
    "idle" | "signing" | "broadcasting" | "done" | "error"
  >("idle");
  const [deployTxHash, setDeployTxHash] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [fundStatus, setFundStatus] = useState<
    "idle" | "funding" | "funded" | "error"
  >("idle");

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const addr = deriveBitcoinAccountAddress(
          wallet.publicKeyX,
          wallet.publicKeyY
        );
        setStarknetAddress(addr);

        const [dep, eth, strk] = await Promise.all([
          isAccountDeployed(addr),
          getEthBalance(addr),
          getStrkBalance(addr),
        ]);
        setDeployed(dep);
        setEthBalance(eth);
        setStrkBalance(strk);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [wallet]);

  // Auto-fund the account when balance is too low to deploy
  useEffect(() => {
    if (
      !loading &&
      !deployed &&
      strkBalance !== "…" &&
      parseFloat(strkBalance) < 0.05 &&
      fundStatus === "idle"
    ) {
      setFundStatus("funding");
      fetch("/api/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: starknetAddress }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.error) throw new Error(data.error);
          setFundStatus("funded");
          // Refresh balance after the funding tx has time to confirm
          setTimeout(
            () => getStrkBalance(starknetAddress).then(setStrkBalance),
            8000
          );
        })
        .catch(() => setFundStatus("error"));
    }
  }, [loading, deployed, strkBalance, starknetAddress, fundStatus]);

  async function handleDeploy() {
    setDeployStatus("signing");
    setDeployError(null);
    try {
      // deployBitcoinAccount calls signDeployAccountTransaction which triggers the Xverse popup,
      // then immediately broadcasts. We can't easily split them, so stay in "signing" until done.
      const txHash = await deployBitcoinAccount(
        wallet.address,
        wallet.publicKeyX,
        wallet.publicKeyY
      );
      setDeployTxHash(txHash);
      setDeployStatus("done");
      // Wait briefly then advance to sign demo
      setTimeout(() => onDeployRequest(starknetAddress), 2000);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : "Deploy failed");
      setDeployStatus("error");
    }
  }

  return (
    <div className="w-full max-w-xl flex flex-col gap-4">
      {/* Bitcoin side */}
      <Section title="Bitcoin Wallet" accent="orange">
        <Row label="Address" value={wallet.address} mono />
        <Row
          label="Public Key"
          value={truncate(wallet.publicKeyHex, 20)}
          mono
          title={wallet.publicKeyHex}
        />
        <Row
          label="Key X"
          value={"0x" + truncateHex(wallet.publicKeyX.toString(16), 16)}
          mono
          title={"0x" + wallet.publicKeyX.toString(16)}
        />
        <Row
          label="Key Y"
          value={"0x" + truncateHex(wallet.publicKeyY.toString(16), 16)}
          mono
          title={"0x" + wallet.publicKeyY.toString(16)}
        />
      </Section>

      {/* Arrow */}
      <div className="flex justify-center text-slate-500 text-xl">↓</div>

      {/* Starknet side */}
      <Section title="Starknet Account" accent="purple">
        {loading ? (
          <p className="text-slate-500 text-sm">Deriving address…</p>
        ) : (
          <>
            <Row label="Address" value={starknetAddress} mono fullWidth />
            <Row
              label="Status"
              value={
                deployed === null
                  ? "Checking…"
                  : deployed
                  ? "✓ Deployed"
                  : "Not deployed yet"
              }
              accent={deployed ? "green" : "yellow"}
            />
            <Row label="ETH Balance" value={`${ethBalance} ETH`} />
            <Row label="STRK Balance" value={`${strkBalance} STRK`} />
          </>
        )}
      </Section>

      {/* Auto-funding status */}
      {fundStatus === "funding" && (
        <p className="text-slate-400 text-xs text-center animate-pulse">
          Requesting deployment funds…
        </p>
      )}
      {fundStatus === "funded" && (
        <p className="text-green-400 text-xs text-center">
          ✓ Funded — balance updating…
        </p>
      )}
      {fundStatus === "error" && (
        <p className="text-yellow-400 text-xs text-center">
          Auto-fund unavailable — get STRK from the{" "}
          <a
            href="https://starknet-faucet.vercel.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Sepolia faucet
          </a>
        </p>
      )}

      {/* Deploy button + status */}
      {!loading && !deployed && deployStatus !== "done" && (
        <button
          onClick={handleDeploy}
          disabled={deployStatus === "signing" || deployStatus === "broadcasting"}
          className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors"
        >
          {deployStatus === "signing"
            ? "Waiting for Xverse…"
            : deployStatus === "broadcasting"
            ? "Broadcasting…"
            : "Deploy Starknet Account"}
        </button>
      )}

      {deployStatus === "done" && deployTxHash && (
        <div className="border border-green-800 rounded-xl p-4 flex flex-col gap-2">
          <p className="text-green-400 text-xs font-semibold">✓ Deploy transaction sent</p>
          <p className="text-slate-500 text-xs">Tx hash</p>
          <span className="font-mono text-xs text-slate-300 break-all">{deployTxHash}</span>
          <p className="text-slate-500 text-xs">Advancing to sign demo…</p>
        </div>
      )}

      {deployStatus === "error" && deployError && (
        <p className="text-red-400 text-xs bg-red-950 border border-red-800 rounded-lg px-3 py-2">
          {deployError}
        </p>
      )}

      {!loading && deployed && (
        <div className="flex flex-col gap-3">
          <div className="text-center text-green-400 text-sm font-medium">
            ✓ Your Bitcoin key controls this Starknet account
          </div>
          <button
            onClick={() => onDeployRequest(starknetAddress)}
            className="w-full bg-purple-600 hover:bg-purple-500 text-white font-semibold py-3 rounded-xl transition-colors"
          >
            Send STRK →
          </button>
        </div>
      )}
    </div>
  );
}

// ── Small UI primitives ───────────────────────────────────────────────────────

function Section({
  title,
  accent,
  children,
}: {
  title: string;
  accent: "orange" | "purple";
  children: React.ReactNode;
}) {
  const border =
    accent === "orange" ? "border-orange-800" : "border-purple-800";
  const heading =
    accent === "orange" ? "text-orange-400" : "text-purple-400";

  return (
    <div className={`border ${border} rounded-xl p-4 flex flex-col gap-3`}>
      <h2 className={`text-xs font-semibold uppercase tracking-widest ${heading}`}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  title,
  accent,
  fullWidth,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
  accent?: "green" | "yellow";
  fullWidth?: boolean;
}) {
  const valueColor =
    accent === "green"
      ? "text-green-400"
      : accent === "yellow"
      ? "text-yellow-400"
      : "text-slate-300";

  if (fullWidth) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-slate-500 text-xs">{label}</span>
        <span
          className={`text-xs ${mono ? "font-mono" : ""} ${valueColor} break-all`}
          title={title}
        >
          {value}
        </span>
      </div>
    );
  }

  return (
    <div className="flex justify-between items-center gap-4">
      <span className="text-slate-500 text-xs shrink-0">{label}</span>
      <span
        className={`text-xs ${mono ? "font-mono" : ""} ${valueColor} truncate`}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function truncate(s: string, keep: number): string {
  if (s.length <= keep * 2 + 3) return s;
  return s.slice(0, keep) + "…" + s.slice(-keep);
}

function truncateHex(hex: string, keep: number): string {
  return truncate(hex, keep);
}
