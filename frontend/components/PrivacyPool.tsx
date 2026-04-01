"use client";

import { useState, useEffect } from "react";
import type { BitcoinWallet } from "@/lib/bitcoin";
import {
  depositToPool,
  getPoolDepositCount,
} from "@/lib/starknet";
import {
  generateNote,
  saveNote,
  loadNotes,
  updateNote,
  signWithdrawal,
  type PoolNote,
} from "@/lib/privacyPool";

interface Props {
  wallet: BitcoinWallet;
  starknetAddress: string;
}

type SubTab = "deposit" | "withdraw";

export default function PrivacyPool({ wallet, starknetAddress }: Props) {
  const [subTab, setSubTab] = useState<SubTab>("deposit");
  const [anonymitySet, setAnonymitySet] = useState<number | null>(null);

  useEffect(() => {
    getPoolDepositCount().then(setAnonymitySet);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Anonymity set pill */}
      <div className="flex items-center justify-center gap-2">
        <div className="bg-slate-800 rounded-full px-3 py-1 text-xs text-slate-400">
          Anonymity set:{" "}
          <span className="text-green-400 font-mono font-semibold">
            {anonymitySet === null ? "…" : anonymitySet} deposits
          </span>
        </div>
        <div className="bg-slate-800 rounded-full px-3 py-1 text-xs text-slate-400">
          Fixed:{" "}
          <span className="text-white font-mono font-semibold">1 STRK</span>
        </div>
      </div>

      {/* Sub-tab switcher */}
      <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
        {(["deposit", "withdraw"] as SubTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            className={`flex-1 py-1.5 rounded-md text-xs font-semibold capitalize transition-colors ${
              subTab === t
                ? "bg-slate-600 text-white"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {t === "deposit" ? "Shield (Deposit)" : "Unshield (Withdraw)"}
          </button>
        ))}
      </div>

      {subTab === "deposit" && (
        <DepositPanel wallet={wallet} starknetAddress={starknetAddress} onDeposited={() => getPoolDepositCount().then(setAnonymitySet)} />
      )}
      {subTab === "withdraw" && (
        <WithdrawPanel />
      )}
    </div>
  );
}

// ── Deposit Panel ──────────────────────────────────────────────────────────────

function DepositPanel({
  wallet,
  starknetAddress,
  onDeposited,
}: {
  wallet: BitcoinWallet;
  starknetAddress: string;
  onDeposited: () => void;
}) {
  const [note, setNote] = useState<PoolNote | null>(null);
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [txHash, setTxHash] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [copied, setCopied] = useState(false);

  function handleGenerate() {
    const n = generateNote();
    setNote(n);
    setStatus("idle");
    setTxHash("");
    setErrMsg("");
  }

  async function handleDeposit() {
    if (!note) return;
    setStatus("busy");
    setErrMsg("");
    try {
      const result = await depositToPool(
        wallet.address,
        wallet.publicKeyX,
        wallet.publicKeyY,
        note.commitment
      );
      const updated: PoolNote = { ...note, depositTxHash: result.transaction_hash };
      saveNote(updated);
      setNote(updated);
      setTxHash(result.transaction_hash);
      setStatus("done");
      onDeposited();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Deposit failed");
      setStatus("error");
    }
  }

  function handleCopyNote() {
    if (!note) return;
    navigator.clipboard.writeText(JSON.stringify(note, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-slate-400 text-xs leading-relaxed">
        Generate a one-time note keypair. The commitment is stored on-chain — your
        deposit address is never linked to withdrawal. Save the note safely; it&apos;s
        your only way to withdraw.
      </p>

      {!note && (
        <button
          onClick={handleGenerate}
          className="w-full py-2.5 bg-green-700 hover:bg-green-600 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Generate Note
        </button>
      )}

      {note && status !== "done" && (
        <div className="flex flex-col gap-3">
          {/* Note preview */}
          <div className="bg-slate-800 rounded-lg p-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-500 text-xs">Commitment</span>
              <button
                onClick={handleCopyNote}
                className="text-xs text-slate-400 hover:text-white transition-colors"
              >
                {copied ? "Copied!" : "Copy note JSON"}
              </button>
            </div>
            <p className="font-mono text-green-400 text-xs break-all">{note.commitment}</p>
            <p className="text-slate-500 text-xs mt-1">
              Private key: <span className="font-mono text-slate-400">{note.privkeyHex.slice(0, 16)}…</span>
            </p>
          </div>

          <div className="bg-amber-900/30 border border-amber-700/40 rounded-lg p-2.5 text-xs text-amber-300">
            ⚠ Save the note JSON before depositing. Without it you cannot withdraw.
          </div>

          {status === "error" && (
            <p className="text-red-400 text-xs">{errMsg}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleGenerate}
              className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg transition-colors"
            >
              Regenerate
            </button>
            <button
              onClick={handleDeposit}
              disabled={status === "busy"}
              className="flex-1 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {status === "busy" ? "Depositing…" : "Deposit 1 STRK"}
            </button>
          </div>
        </div>
      )}

      {status === "done" && (
        <div className="flex flex-col gap-2">
          <div className="bg-green-900/30 border border-green-700/40 rounded-lg p-3 text-xs text-green-300">
            ✓ Deposited! Note saved to local storage.
          </div>
          <a
            href={`https://sepolia.starkscan.co/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-center text-slate-400 hover:text-white underline underline-offset-2 transition-colors"
          >
            View on Starkscan →
          </a>
          <button
            onClick={handleGenerate}
            className="w-full py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg transition-colors"
          >
            New Deposit
          </button>
        </div>
      )}
    </div>
  );
}

// ── Withdraw Panel ─────────────────────────────────────────────────────────────

function WithdrawPanel() {
  const [notes, setNotes] = useState<PoolNote[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [recipient, setRecipient] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [txHash, setTxHash] = useState("");
  const [errMsg, setErrMsg] = useState("");

  useEffect(() => {
    setNotes(loadNotes());
  }, []);

  const selectedNote = selectedIdx !== null ? notes[selectedIdx] : null;

  async function handleWithdraw() {
    if (!selectedNote || !recipient) return;
    setStatus("busy");
    setErrMsg("");
    try {
      // Sign with the note private key (no Xverse needed)
      const sig = signWithdrawal(selectedNote, recipient);

      const resp = await fetch("/api/pool-withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notePubkeyX: selectedNote.pubkeyXFull,
          notePubkeyY: selectedNote.pubkeyYFull,
          recipient,
          sig,
        }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: "Relay failed" }));
        throw new Error(body.error ?? "Relay failed");
      }

      const { txHash: hash } = await resp.json();
      setTxHash(hash);

      // Remove spent note from localStorage
      const remaining = notes.filter((_, i) => i !== selectedIdx);
      localStorage.setItem("secp_pool_notes_v1", JSON.stringify(remaining));
      setNotes(remaining);
      setSelectedIdx(null);
      setStatus("done");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Withdraw failed");
      setStatus("error");
    }
  }

  if (notes.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-slate-500 text-sm">No saved notes found.</p>
        <p className="text-slate-600 text-xs mt-1">
          Deposit first to generate a note, then come back to withdraw.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-slate-400 text-xs leading-relaxed">
        Select a note and specify any recipient address. The withdrawal is relayed
        gaslessly — the recipient needs zero STRK to receive funds.
      </p>

      {/* Note selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-slate-500 text-xs">Saved notes</label>
        {notes.map((n, i) => (
          <button
            key={n.commitment}
            onClick={() => setSelectedIdx(i)}
            className={`text-left p-2.5 rounded-lg border text-xs transition-colors ${
              selectedIdx === i
                ? "border-green-600 bg-green-900/20 text-green-300"
                : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-500"
            }`}
          >
            <span className="font-mono">{n.commitment.slice(0, 20)}…</span>
            {n.depositTxHash && (
              <span className="ml-2 text-slate-600">
                tx: {n.depositTxHash.slice(0, 10)}…
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Recipient input */}
      <div className="flex flex-col gap-1">
        <label className="text-slate-500 text-xs">Recipient Starknet address</label>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="0x..."
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-green-600"
        />
      </div>

      {/* Privacy notice */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-500">
        The recipient address is never linked to your depositor identity on-chain.
        Relay pays gas — recipient receives 1 STRK with zero setup.
      </div>

      {status === "error" && (
        <p className="text-red-400 text-xs">{errMsg}</p>
      )}

      {status === "done" && (
        <div className="flex flex-col gap-2">
          <div className="bg-green-900/30 border border-green-700/40 rounded-lg p-3 text-xs text-green-300">
            ✓ Withdrawn! 1 STRK sent to recipient.
          </div>
          <a
            href={`https://sepolia.starkscan.co/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-center text-slate-400 hover:text-white underline underline-offset-2 transition-colors"
          >
            View on Starkscan →
          </a>
        </div>
      )}

      {status !== "done" && (
        <button
          onClick={handleWithdraw}
          disabled={!selectedNote || !recipient || status === "busy"}
          className="w-full py-2.5 bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {status === "busy" ? "Relaying withdrawal…" : "Withdraw Gaslessly"}
        </button>
      )}
    </div>
  );
}
