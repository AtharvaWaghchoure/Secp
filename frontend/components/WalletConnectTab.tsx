"use client";

import { useState, useEffect, useRef } from "react";
import type { BitcoinWallet } from "@/lib/bitcoin";
import { signWithXverse } from "@/lib/bitcoin";
import {
  deriveBitcoinAccountAddress,
  executeCalls,
  encodeSignatureAsCalldata,
} from "@/lib/starknet";
import {
  initWallet,
  wcPair,
  wcApproveSession,
  wcRejectSession,
  wcRespondSuccess,
  wcRespondError,
  wcDisconnect,
  wcGetSessions,
  handleAutoRequest,
  extractCalls,
  extractTypedData,
  summarizeRequest,
  type WCSession,
  type WCRequest,
} from "@/lib/walletConnect";
import type { Web3WalletTypes } from "@walletconnect/web3wallet";

interface Props {
  wallet: BitcoinWallet;
}

export default function WalletConnectTab({ wallet }: Props) {
  const starknetAddress = deriveBitcoinAccountAddress(
    wallet.publicKeyX,
    wallet.publicKeyY
  );

  const [uri, setUri] = useState("");
  const [pairing, setPairing] = useState(false);
  const [sessions, setSessions] = useState<WCSession[]>([]);
  const [pendingProposal, setPendingProposal] =
    useState<Web3WalletTypes.SessionProposal | null>(null);
  const [pendingRequest, setPendingRequest] = useState<WCRequest | null>(null);
  const [processing, setProcessing] = useState(false);
  const [lastResult, setLastResult] = useState<{
    type: "success" | "error";
    msg: string;
  } | null>(null);
  const initialized = useRef(false);

  // Init WC and register event listeners once
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    initWallet().then((wc) => {
      // Refresh sessions list
      wcGetSessions().then(setSessions);

      // Incoming session proposal from a dApp
      wc.on("session_proposal", (proposal) => {
        setPendingProposal(proposal);
      });

      // Incoming transaction / sign request from a dApp
      wc.on("session_request", async (event) => {
        const { topic, id, params } = event;
        const { request } = params;
        const { method, params: reqParams } = request;

        // Handle auto-respondable methods immediately
        const autoResult = handleAutoRequest(method, reqParams, starknetAddress);
        if (autoResult !== null) {
          await wcRespondSuccess(topic, id, autoResult);
          return;
        }

        // Needs user approval
        setPendingRequest({
          id,
          topic,
          method,
          params: reqParams,
          summary: summarizeRequest(method, reqParams),
        });
      });

      // Session deleted by dApp
      wc.on("session_delete", () => {
        wcGetSessions().then(setSessions);
      });
    });
  }, [starknetAddress]);

  async function handlePair() {
    if (!uri.trim()) return;
    setPairing(true);
    setLastResult(null);
    try {
      await wcPair(uri.trim());
      setUri("");
      // session_proposal event will fire shortly
    } catch (e) {
      setLastResult({
        type: "error",
        msg: e instanceof Error ? e.message : "Pairing failed",
      });
    } finally {
      setPairing(false);
    }
  }

  async function handleApproveSession() {
    if (!pendingProposal) return;
    setProcessing(true);
    try {
      await wcApproveSession(pendingProposal, starknetAddress);
      setPendingProposal(null);
      const updated = await wcGetSessions();
      setSessions(updated);
      setLastResult({ type: "success", msg: "Connected to dApp" });
    } catch (e) {
      setLastResult({
        type: "error",
        msg: e instanceof Error ? e.message : "Session approval failed",
      });
    } finally {
      setProcessing(false);
    }
  }

  async function handleRejectSession() {
    if (!pendingProposal) return;
    await wcRejectSession(pendingProposal);
    setPendingProposal(null);
  }

  async function handleApproveRequest() {
    if (!pendingRequest) return;
    setProcessing(true);
    setLastResult(null);
    const { topic, id, method, params } = pendingRequest;

    try {
      if (method === "starknet_addInvokeTransaction") {
        const calls = extractCalls(params);
        const result = await executeCalls(
          wallet.address,
          wallet.publicKeyX,
          wallet.publicKeyY,
          calls
        );
        await wcRespondSuccess(topic, id, {
          transaction_hash: result.transaction_hash,
        });
        setLastResult({
          type: "success",
          msg: `Tx sent: ${result.transaction_hash.slice(0, 16)}…`,
        });
      } else if (method === "starknet_signTypedData") {
        const typedData = extractTypedData(params);
        // Hash the typed data and sign with Xverse
        const dataStr = JSON.stringify(typedData);
        const { hash: poseidonHash } = await import("starknet").then((m) => ({
          hash: m.hash.computePoseidonHashOnElements([
            starknetAddress,
            ...dataStr.split("").map((c) => "0x" + c.charCodeAt(0).toString(16)),
          ]),
        }));
        const msgHash =
          "0x" + BigInt(poseidonHash).toString(16).padStart(64, "0");
        const { r, s } = await signWithXverse(wallet.address, msgHash);
        const sig = encodeSignatureAsCalldata(r, s);
        await wcRespondSuccess(topic, id, sig);
        setLastResult({ type: "success", msg: "Signed typed data" });
      } else if (method === "starknet_switchStarknetChain") {
        // Unsupported chain
        await wcRespondError(topic, id, "Only SN_SEPOLIA is supported");
        setLastResult({
          type: "error",
          msg: "Chain switch rejected — only Sepolia supported",
        });
      } else {
        await wcRespondError(topic, id, `Unsupported method: ${method}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Request failed";
      await wcRespondError(topic, id, msg).catch(() => {});
      setLastResult({ type: "error", msg });
    } finally {
      setPendingRequest(null);
      setProcessing(false);
    }
  }

  async function handleRejectRequest() {
    if (!pendingRequest) return;
    await wcRespondError(
      pendingRequest.topic,
      pendingRequest.id,
      "User rejected"
    );
    setPendingRequest(null);
  }

  async function handleDisconnect(topic: string) {
    await wcDisconnect(topic);
    const updated = await wcGetSessions();
    setSessions(updated);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Address display */}
      <div className="bg-slate-800 rounded-lg p-3">
        <p className="text-slate-500 text-xs mb-1">Your Starknet address (shared with dApps)</p>
        <p className="font-mono text-xs text-teal-300 break-all">{starknetAddress}</p>
      </div>

      {/* How it works */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3 text-xs text-slate-500 leading-relaxed">
        Connect any Starknet dApp via WalletConnect. Every transaction is
        authorised by your Bitcoin key through Xverse — the dApp sees a normal
        Starknet wallet.
      </div>

      {/* Pair input */}
      <div className="flex flex-col gap-2">
        <label className="text-slate-500 text-xs">Paste WalletConnect URI</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="wc:…"
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-teal-600"
          />
          <button
            onClick={handlePair}
            disabled={!uri.trim() || pairing}
            className="px-4 py-2 bg-teal-700 hover:bg-teal-600 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap"
          >
            {pairing ? "Connecting…" : "Connect"}
          </button>
        </div>
        <p className="text-slate-600 text-xs">
          Open any Starknet dApp → WalletConnect → copy URI → paste above.
        </p>
      </div>

      {/* Status message */}
      {lastResult && (
        <div
          className={`rounded-lg p-2.5 text-xs ${
            lastResult.type === "success"
              ? "bg-green-900/30 border border-green-700/40 text-green-300"
              : "bg-red-900/30 border border-red-700/40 text-red-300"
          }`}
        >
          {lastResult.type === "success" ? "✓" : "✗"} {lastResult.msg}
        </div>
      )}

      {/* Pending session proposal */}
      {pendingProposal && (
        <div className="border border-teal-700 rounded-xl p-4 flex flex-col gap-3">
          <p className="text-teal-400 text-xs font-semibold uppercase tracking-widest">
            Connection Request
          </p>
          <div className="flex items-center gap-3">
            {pendingProposal.params.proposer.metadata.icons?.[0] && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={pendingProposal.params.proposer.metadata.icons[0]}
                alt=""
                className="w-8 h-8 rounded-md"
              />
            )}
            <div>
              <p className="text-white text-sm font-semibold">
                {pendingProposal.params.proposer.metadata.name}
              </p>
              <p className="text-slate-500 text-xs">
                {pendingProposal.params.proposer.metadata.url}
              </p>
            </div>
          </div>
          <p className="text-slate-400 text-xs">
            This dApp wants to connect to your Bitcoin Starknet account.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleRejectSession}
              disabled={processing}
              className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg transition-colors"
            >
              Reject
            </button>
            <button
              onClick={handleApproveSession}
              disabled={processing}
              className="flex-1 py-2 bg-teal-700 hover:bg-teal-600 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {processing ? "Connecting…" : "Approve"}
            </button>
          </div>
        </div>
      )}

      {/* Pending transaction request */}
      {pendingRequest && (
        <div className="border border-yellow-700 rounded-xl p-4 flex flex-col gap-3">
          <p className="text-yellow-400 text-xs font-semibold uppercase tracking-widest">
            Transaction Request
          </p>
          <p className="text-white text-sm">{pendingRequest.summary}</p>

          {pendingRequest.method === "starknet_addInvokeTransaction" && (
            <CallsPreview params={pendingRequest.params} />
          )}

          <p className="text-slate-500 text-xs">
            Approving will open Xverse to sign with your Bitcoin key.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleRejectRequest}
              disabled={processing}
              className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg transition-colors"
            >
              Reject
            </button>
            <button
              onClick={handleApproveRequest}
              disabled={processing}
              className="flex-1 py-2 bg-yellow-700 hover:bg-yellow-600 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {processing ? "Signing…" : "Approve & Sign"}
            </button>
          </div>
        </div>
      )}

      {/* Active sessions */}
      {sessions.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-slate-500 text-xs">Active connections</p>
          {sessions.map((s) => (
            <div
              key={s.topic}
              className="flex items-center gap-3 bg-slate-800 rounded-lg p-3"
            >
              {s.peerIcon && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.peerIcon} alt="" className="w-6 h-6 rounded" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-white text-xs font-semibold truncate">
                  {s.peerName}
                </p>
                <p className="text-slate-600 text-xs truncate">{s.peerUrl}</p>
              </div>
              <button
                onClick={() => handleDisconnect(s.topic)}
                className="text-slate-500 hover:text-red-400 text-xs transition-colors"
              >
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}

      {sessions.length === 0 && !pendingProposal && (
        <p className="text-center text-slate-600 text-xs py-4">
          No active connections. Paste a WalletConnect URI to get started.
        </p>
      )}
    </div>
  );
}

// ── Calls preview ──────────────────────────────────────────────────────────────

function CallsPreview({ params }: { params: unknown }) {
  const p = params as { calls?: Record<string, unknown>[] };
  if (!p?.calls?.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {p.calls.map((call, i) => (
        <div key={i} className="bg-slate-800 rounded-lg p-2.5 text-xs">
          <p className="text-slate-400">
            <span className="text-slate-500">To: </span>
            <span className="font-mono">
              {String(call.contract_address ?? call.contractAddress ?? "").slice(0, 18)}…
            </span>
          </p>
          <p className="text-slate-400">
            <span className="text-slate-500">Call: </span>
            <span className="font-mono text-yellow-300">
              {String(call.entry_point ?? call.entrypoint ?? call.selector ?? "")}
            </span>
          </p>
        </div>
      ))}
    </div>
  );
}
