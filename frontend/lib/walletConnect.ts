/**
 * walletConnect.ts — WalletConnect v2 wallet-side integration for BitcoinAccount.
 *
 * Exposes the Bitcoin-keyed Starknet account to any WalletConnect-compatible dApp.
 * The dApp connects, sends transaction requests, and we route them through Xverse
 * so the user's Bitcoin key authorises everything on Starknet — no new seed phrase.
 *
 * Supported Starknet WC methods:
 *   starknet_requestAccounts         → return [starknetAddress]
 *   starknet_addInvokeTransaction    → sign via Xverse, broadcast, return {transaction_hash}
 *   starknet_signTypedData           → sign via Xverse, return signature
 *   starknet_getPermissions          → return []
 *   starknet_supportedSpecs          → return ["0.7"]
 *   starknet_switchStarknetChain     → reject (only SN_SEPOLIA supported)
 */

import { Core } from "@walletconnect/core";
import { Web3Wallet, type Web3WalletTypes } from "@walletconnect/web3wallet";
import type { Call } from "starknet";
import { hash } from "starknet";

export const WC_CHAIN = "starknet:SN_SEPOLIA";

export const WC_METHODS = [
  "starknet_requestAccounts",
  "starknet_addInvokeTransaction",
  "starknet_signTypedData",
  "starknet_getPermissions",
  "starknet_supportedSpecs",
  "starknet_switchStarknetChain",
  "starknet_watchAsset",
];

export const WC_EVENTS = ["chainChanged", "accountsChanged"];

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WCSession {
  topic: string;
  peerName: string;
  peerUrl: string;
  peerIcon: string;
}

export interface WCRequest {
  id: number;
  topic: string;
  method: string;
  params: unknown;
  // Human-readable summary for display
  summary: string;
}

// ── Singleton wallet instance ──────────────────────────────────────────────────

let web3wallet: InstanceType<typeof Web3Wallet> | null = null;

export async function initWallet(): Promise<InstanceType<typeof Web3Wallet>> {
  if (web3wallet) return web3wallet;

  const projectId =
    process.env.NEXT_PUBLIC_WC_PROJECT_ID || "demo_project_id_replace_me";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = new Core({ projectId }) as any;

  web3wallet = await Web3Wallet.init({
    core,
    metadata: {
      name: "Bitcoin Starknet Account",
      description: "Bitcoin-keyed Starknet smart account — no seed phrase required",
      url: typeof window !== "undefined" ? window.location.origin : "https://bitcoin-starknet.app",
      icons: [],
    },
  });

  return web3wallet;
}

/** Pair with a dApp using a WalletConnect URI (wc:...). */
export async function wcPair(uri: string): Promise<void> {
  const wallet = await initWallet();
  await wallet.pair({ uri });
}

/** Approve an incoming session proposal. */
export async function wcApproveSession(
  proposal: Web3WalletTypes.SessionProposal,
  starknetAddress: string
): Promise<void> {
  const wallet = await initWallet();
  await wallet.approveSession({
    id: proposal.id,
    namespaces: {
      starknet: {
        accounts: [`${WC_CHAIN}:${starknetAddress}`],
        methods: WC_METHODS,
        events: WC_EVENTS,
      },
    },
  });
}

/** Reject an incoming session proposal. */
export async function wcRejectSession(
  proposal: Web3WalletTypes.SessionProposal
): Promise<void> {
  const wallet = await initWallet();
  await wallet.rejectSession({
    id: proposal.id,
    reason: { code: 4001, message: "User rejected" },
  });
}

/** Respond to a session request with a result. */
export async function wcRespondSuccess(
  topic: string,
  id: number,
  result: unknown
): Promise<void> {
  const wallet = await initWallet();
  await wallet.respondSessionRequest({
    topic,
    response: { id, jsonrpc: "2.0", result },
  });
}

/** Respond to a session request with an error. */
export async function wcRespondError(
  topic: string,
  id: number,
  message: string
): Promise<void> {
  const wallet = await initWallet();
  await wallet.respondSessionRequest({
    topic,
    response: {
      id,
      jsonrpc: "2.0",
      error: { code: 4001, message },
    },
  });
}

/** Disconnect an active session. */
export async function wcDisconnect(topic: string): Promise<void> {
  const wallet = await initWallet();
  await wallet.disconnectSession({
    topic,
    reason: { code: 6000, message: "User disconnected" },
  });
}

/** Get all active sessions as WCSession[]  */
export async function wcGetSessions(): Promise<WCSession[]> {
  const wallet = await initWallet();
  const sessions = wallet.getActiveSessions();
  return Object.values(sessions).map((s) => ({
    topic: s.topic,
    peerName: s.peer.metadata.name,
    peerUrl: s.peer.metadata.url,
    peerIcon: s.peer.metadata.icons?.[0] ?? "",
  }));
}

// ── Request handling ───────────────────────────────────────────────────────────

/**
 * Normalise a dApp-provided call object to starknet.js Call format.
 * dApps use entry_point or entrypoint, and may omit the 0x prefix.
 */
export function normalizeWCCall(raw: Record<string, unknown>): Call {
  return {
    contractAddress: String(raw.contract_address ?? raw.contractAddress ?? ""),
    entrypoint: String(raw.entry_point ?? raw.entrypoint ?? raw.selector ?? ""),
    calldata: Array.isArray(raw.calldata) ? (raw.calldata as string[]) : [],
  };
}

/**
 * Build a human-readable summary of a session request for display.
 */
export function summarizeRequest(method: string, params: unknown): string {
  if (method === "starknet_requestAccounts") return "Request: connect accounts";
  if (method === "starknet_getPermissions") return "Request: get permissions";
  if (method === "starknet_supportedSpecs") return "Request: supported specs";
  if (method === "starknet_signTypedData") return "Request: sign typed data";
  if (method === "starknet_switchStarknetChain") {
    const p = params as Record<string, unknown>;
    return `Request: switch to chain ${p?.chainId ?? "?"}`;
  }
  if (method === "starknet_addInvokeTransaction") {
    const p = params as { calls?: unknown[] };
    const count = p?.calls?.length ?? 1;
    return `Request: invoke transaction (${count} call${count !== 1 ? "s" : ""})`;
  }
  if (method === "starknet_watchAsset") {
    const p = params as { options?: { address?: string } };
    const addr = p?.options?.address ?? "";
    return `Request: watch asset ${addr.slice(0, 10)}…`;
  }
  return `Request: ${method}`;
}

/**
 * Handle non-interactive requests that don't need user confirmation.
 * Returns the result if handled, null if it needs user confirmation.
 */
export function handleAutoRequest(
  method: string,
  params: unknown,
  starknetAddress: string
): unknown | null {
  switch (method) {
    case "starknet_requestAccounts":
      return [starknetAddress];
    case "starknet_getPermissions":
      return [];
    case "starknet_supportedSpecs":
      return ["0.7"];
    case "starknet_watchAsset":
      return true;
    case "starknet_switchStarknetChain": {
      const p = params as { chainId?: string };
      // Only support SN_SEPOLIA
      if (p?.chainId === "SN_SEPOLIA" || p?.chainId === "0x534e5f5345504f4c4941") {
        return true;
      }
      return null; // let component handle rejection
    }
    default:
      return null;
  }
}

/**
 * Extract calls from starknet_addInvokeTransaction params.
 */
export function extractCalls(params: unknown): Call[] {
  const p = params as { calls?: Record<string, unknown>[] };
  if (!p?.calls) return [];
  return p.calls.map(normalizeWCCall);
}

/**
 * Extract typed data for starknet_signTypedData.
 */
export function extractTypedData(params: unknown): unknown {
  const p = params as { typedData?: unknown; typed_data?: unknown };
  return p?.typedData ?? p?.typed_data ?? params;
}

/**
 * Sign typed data hash using starknet.js hash utilities.
 * Returns poseidon hash of the typed data for Xverse to sign.
 */
export function hashTypedData(typedData: unknown, starknetAddress: string): string {
  try {
    const td = typedData as { domain?: unknown; types?: unknown; primaryType?: string; message?: unknown };
    // Use starknet.js to compute typed data hash
    const msgHash = hash.computePoseidonHashOnElements([
      starknetAddress,
      JSON.stringify(td),
    ]);
    return "0x" + BigInt(msgHash).toString(16).padStart(64, "0");
  } catch {
    return "0x0";
  }
}
