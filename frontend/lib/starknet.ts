/**
 * starknet.ts — Starknet address derivation, deployment, and transaction helpers.
 *
 * Handles:
 *  - Deriving the deterministic Starknet address from a Bitcoin public key
 *  - Deploying the BitcoinAccount contract (counterfactual deployment)
 *  - Building and submitting signed transactions
 */

import {
  RpcProvider,
  Account,
  hash,
  CallData,
  transaction,
  EDataAvailabilityMode,
  EDAMode,
  type SignerInterface,
  type TypedData,
  type Signature,
  type Call,
  type InvocationsSignerDetails,
  type DeployAccountSignerDetails,
  type DeclareSignerDetails,
} from "starknet";
import { signWithXverse } from "./bitcoin";

// ── Config ────────────────────────────────────────────────────────────────────

// Starknet Sepolia testnet (public endpoint by Cartridge)
export const STARKNET_RPC = "https://api.cartridge.gg/x/starknet/sepolia";

// Class hash of the BitcoinAccount contract class declared on Sepolia.
// Updated to include bitcoin_message_hash: tx 0x1094b7e8bdefac2c1cc74c05c9aff89b29b65a095c9f03d0398f77d8f5de88
export const BITCOIN_ACCOUNT_CLASS_HASH =
  "0x1c5e4906e319a5c79c3ead6f16c395106c8241cb5fd508a07e78fb3a656aacc";

export const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });

// ── Address derivation ────────────────────────────────────────────────────────

/**
 * Derive the deterministic Starknet contract address for a given Bitcoin public key.
 *
 * The address depends on:
 *  - class_hash: the BitcoinAccount contract class
 *  - salt: pedersen(pk_x_low, pk_x_high) — unique per key
 *  - constructor_calldata: [pk_x.low, pk_x.high, pk_y.low, pk_y.high]
 *  - deployer: 0 (counterfactual)
 *
 * Same Bitcoin key always maps to the same Starknet address, across any app or network.
 */
export function deriveBitcoinAccountAddress(
  publicKeyX: bigint,
  publicKeyY: bigint
): string {
  const { xLow, xHigh, yLow, yHigh } = splitCoordinates(publicKeyX, publicKeyY);

  const constructorCalldata = CallData.compile({
    public_key_x: { low: xLow, high: xHigh },
    public_key_y: { low: yLow, high: yHigh },
  });

  // Salt = hash of the x coordinate to make it unique per key
  const salt = hash.computePedersenHash(
    "0x" + xLow.toString(16),
    "0x" + xHigh.toString(16)
  );

  return hash.calculateContractAddressFromHash(
    salt,
    BITCOIN_ACCOUNT_CLASS_HASH,
    constructorCalldata,
    0 // deployer = 0 for counterfactual
  );
}

// ── Calldata helpers ──────────────────────────────────────────────────────────

/**
 * Build the constructor calldata array for the BitcoinAccount contract.
 * Cairo u256 is serialized as [low: felt252, high: felt252].
 */
export function buildConstructorCalldata(
  publicKeyX: bigint,
  publicKeyY: bigint
): string[] {
  const { xLow, xHigh, yLow, yHigh } = splitCoordinates(publicKeyX, publicKeyY);
  return [
    "0x" + xLow.toString(16),
    "0x" + xHigh.toString(16),
    "0x" + yLow.toString(16),
    "0x" + yHigh.toString(16),
  ];
}

/**
 * Encode a secp256k1 signature (r, s) into the 4-felt format the account contract expects.
 * Mirrors utils.encode_signature in Cairo.
 */
export function encodeSignatureAsCalldata(r: bigint, s: bigint): string[] {
  const { low: rLow, high: rHigh } = splitU256(r);
  const { low: sLow, high: sHigh } = splitU256(s);
  return [
    "0x" + rLow.toString(16),
    "0x" + rHigh.toString(16),
    "0x" + sLow.toString(16),
    "0x" + sHigh.toString(16),
  ];
}

// ── Account state ─────────────────────────────────────────────────────────────

/** Check whether the BitcoinAccount contract is already deployed at the given address. */
export async function isAccountDeployed(address: string): Promise<boolean> {
  try {
    const classHash = await provider.getClassHashAt(address);
    return classHash !== "0x0";
  } catch {
    return false;
  }
}

/** Fetch the ETH balance of an address (for display purposes). */
export async function getEthBalance(address: string): Promise<string> {
  const ETH_TOKEN = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
  try {
    const result = await provider.callContract({
      contractAddress: ETH_TOKEN,
      entrypoint: "balanceOf",
      calldata: [address],
    });
    // result is [low, high] as felt252
    const low = BigInt(result[0]);
    const high = BigInt(result[1]);
    const wei = (high << 128n) | low;
    // Convert from wei to ETH with 6 decimal places
    const eth = Number(wei) / 1e18;
    return eth.toFixed(6);
  } catch {
    return "0.000000";
  }
}

const STRK_TOKEN = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/** Fetch the STRK balance of an address (used for V3 transaction fees). */
export async function getStrkBalance(address: string): Promise<string> {
  try {
    const result = await provider.callContract({
      contractAddress: STRK_TOKEN,
      entrypoint: "balanceOf",
      calldata: [address],
    });
    const low = BigInt(result[0]);
    const high = BigInt(result[1]);
    const units = (high << 128n) | low;
    return (Number(units) / 1e18).toFixed(4);
  } catch {
    return "0.0000";
  }
}

// ── Deployment ────────────────────────────────────────────────────────────────

/**
 * Custom SignerInterface that routes all signing through Xverse.
 *
 * starknet.js calls signDeployAccountTransaction / signTransaction with full
 * transaction details. We compute the same hash the Signer class would, then
 * hand it to Xverse (which applies the Bitcoin message prefix), matching what
 * the Cairo contract's __validate__ / __validate_deploy__ expects.
 */
class XverseSigner implements SignerInterface {
  constructor(private readonly bitcoinAddress: string) {}

  async getPubKey(): Promise<string> {
    return "0x0"; // not used by this account type
  }

  async signMessage(_: TypedData, __: string): Promise<Signature> {
    throw new Error("signMessage not supported");
  }

  async signTransaction(
    calls: Call[],
    details: InvocationsSignerDetails
  ): Promise<Signature> {
    const det = details as Extract<InvocationsSignerDetails, { walletAddress: string }>;
    const compiledCalldata = transaction.getExecuteCalldata(calls, det.cairoVersion);
    const nonceDAM =
      det.nonceDataAvailabilityMode === EDataAvailabilityMode.L1
        ? EDAMode.L1
        : EDAMode.L2;
    const feeDAM =
      det.feeDataAvailabilityMode === EDataAvailabilityMode.L1
        ? EDAMode.L1
        : EDAMode.L2;
    const txHash = hash.calculateInvokeTransactionHash({
      senderAddress: det.walletAddress,
      version: det.version,
      compiledCalldata,
      chainId: det.chainId,
      nonce: det.nonce,
      accountDeploymentData: det.accountDeploymentData,
      nonceDataAvailabilityMode: nonceDAM,
      feeDataAvailabilityMode: feeDAM,
      resourceBounds: det.resourceBounds,
      tip: det.tip,
      paymasterData: det.paymasterData,
    });
    return this._signHash(txHash);
  }

  async signDeployAccountTransaction(
    details: DeployAccountSignerDetails
  ): Promise<Signature> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const det = details as any;
    const compiledCalldata = CallData.compile(det.constructorCalldata);
    const nonceDAM =
      det.nonceDataAvailabilityMode === EDataAvailabilityMode.L1
        ? EDAMode.L1
        : EDAMode.L2;
    const feeDAM =
      det.feeDataAvailabilityMode === EDataAvailabilityMode.L1
        ? EDAMode.L1
        : EDAMode.L2;
    const txHash = hash.calculateDeployAccountTransactionHash({
      contractAddress: det.contractAddress,
      classHash: det.classHash,
      compiledConstructorCalldata: compiledCalldata,
      salt: det.addressSalt,
      version: det.version,
      chainId: det.chainId,
      nonce: det.nonce,
      nonceDataAvailabilityMode: nonceDAM,
      feeDataAvailabilityMode: feeDAM,
      resourceBounds: det.resourceBounds,
      tip: det.tip,
      paymasterData: det.paymasterData,
    });
    return this._signHash(txHash);
  }

  async signDeclareTransaction(_: DeclareSignerDetails): Promise<Signature> {
    throw new Error("signDeclareTransaction not supported");
  }

  // Exposed after signing so callers can verify on-chain
  lastTxHash: string | null = null;
  lastSignature: string[] | null = null;

  private async _signHash(txHash: string): Promise<Signature> {
    // Cairo's bitcoin_message_hash always encodes the felt252 as 64 hex chars (zero-padded),
    // so the Bitcoin message prefix always has varint 0x42 (= 66 = len("0x" + 64 hex chars)).
    // starknet.js returns hashes without leading zeros (e.g. "0x1abc" instead of "0x000...1abc"),
    // which would produce a different varint and thus a different hash.
    // Normalize to exactly "0x" + 64 hex chars to match what Cairo encodes.
    const normalized = "0x" + txHash.replace(/^0x/, "").padStart(64, "0");
    const { r, s } = await signWithXverse(this.bitcoinAddress, normalized);
    const sig = encodeSignatureAsCalldata(r, s);
    this.lastTxHash = normalized;
    this.lastSignature = sig;
    return sig;
  }
}

/**
 * Deploy the BitcoinAccount contract for a given Bitcoin key.
 *
 * The account address must already be funded with STRK (for V3 tx fees)
 * before calling this. Returns the deploy transaction hash.
 */
export async function deployBitcoinAccount(
  bitcoinAddress: string,
  publicKeyX: bigint,
  publicKeyY: bigint
): Promise<string> {
  const starknetAddress = deriveBitcoinAccountAddress(publicKeyX, publicKeyY);
  const constructorCalldata = buildConstructorCalldata(publicKeyX, publicKeyY);

  const { low: xLow, high: xHigh } = splitU256(publicKeyX);
  const salt = hash.computePedersenHash(
    "0x" + xLow.toString(16),
    "0x" + xHigh.toString(16)
  );

  const signer = new XverseSigner(bitcoinAddress);
  const account = new Account({ provider, address: starknetAddress, signer });

  const payload = {
    classHash: BITCOIN_ACCOUNT_CLASS_HASH,
    constructorCalldata,
    addressSalt: salt,
    contractAddress: starknetAddress,
  };

  // Fee estimation runs with skipValidate=true (empty sig, no __validate_deploy__ simulation).
  // The estimate therefore excludes the cost of bitcoin_message_hash (double SHA256) + secp256k1
  // verification in __validate_deploy__. We boost l2_gas.max_amount by 20× to cover validation.
  // In V3 txs, max_amount is a cap — the user only pays for gas actually consumed, not the full cap.
  const estimate = await account.estimateAccountDeployFee(payload);
  const estimatedL2Gas = BigInt(estimate.resourceBounds.l2_gas.max_amount);
  const boostedL2Gas = estimatedL2Gas * 20n;

  const { transaction_hash } = await account.deployAccount(payload, {
    resourceBounds: {
      ...estimate.resourceBounds,
      l2_gas: {
        max_amount: boostedL2Gas,
        max_price_per_unit: estimate.resourceBounds.l2_gas.max_price_per_unit,
      },
    },
  });

  return transaction_hash;
}

// ── STRK transfer ─────────────────────────────────────────────────────────────

/**
 * Transfer STRK tokens from the BitcoinAccount to a recipient.
 *
 * Builds a real Starknet invoke transaction, signs it via Xverse, and
 * broadcasts it. The contract's __validate__ verifies the Bitcoin
 * secp256k1 signature on-chain — no new seed phrase, no bridge.
 */
export interface SendResult {
  transaction_hash: string;
  /** The normalized tx hash that was signed (0x + 64 hex chars) */
  signedTxHash: string;
  /** 4-felt signature [r.low, r.high, s.low, s.high] */
  signature: string[];
}

export async function sendStrk(
  bitcoinAddress: string,
  publicKeyX: bigint,
  publicKeyY: bigint,
  recipient: string,
  amountStrk: string
): Promise<SendResult> {
  const starknetAddress = deriveBitcoinAccountAddress(publicKeyX, publicKeyY);
  const signer = new XverseSigner(bitcoinAddress);
  const account = new Account({ provider, address: starknetAddress, signer });

  const amount = parseStrkAmount(amountStrk);
  const { low: amountLow, high: amountHigh } = splitU256(amount);

  const calls: Call[] = [
    {
      contractAddress: STRK_TOKEN,
      entrypoint: "transfer",
      calldata: [
        recipient,
        "0x" + amountLow.toString(16),
        "0x" + amountHigh.toString(16),
      ],
    },
  ];

  // estimateFee uses skipValidate=true — the estimate excludes the cost of
  // bitcoin_message_hash (double SHA256) + secp256k1 in __validate__.
  // Boost l2_gas.max_amount by 20× to cover validation.
  // In V3 txs, max_amount is a cap; the user only pays for gas actually consumed.
  const estimate = await account.estimateInvokeFee(calls);
  const boostedL2Gas = BigInt(estimate.resourceBounds.l2_gas.max_amount) * 20n;

  const { transaction_hash } = await account.execute(calls, {
    resourceBounds: {
      ...estimate.resourceBounds,
      l2_gas: {
        max_amount: boostedL2Gas,
        max_price_per_unit: estimate.resourceBounds.l2_gas.max_price_per_unit,
      },
    },
  });

  return {
    transaction_hash,
    signedTxHash: signer.lastTxHash ?? transaction_hash,
    signature: signer.lastSignature ?? [],
  };
}

/**
 * Call is_valid_signature on-chain (view, no fee) to prove the signature is valid.
 * Returns true when the contract returns the VALIDATED sentinel ('VALID').
 */
export async function verifySignatureOnChain(
  contractAddress: string,
  txHash: string,
  signature: string[]
): Promise<boolean> {
  try {
    const result = await provider.callContract({
      contractAddress,
      entrypoint: "is_valid_signature",
      calldata: [txHash, "4", ...signature],
    });
    // VALIDATED = 'VALID' = 0x56414c4944
    return BigInt(result[0]) === 0x56414c4944n;
  } catch {
    return false;
  }
}

// ── Stealth Registry ──────────────────────────────────────────────────────────

/** Deployed StealthRegistry contract on Sepolia. */
export const STEALTH_REGISTRY =
  "0x02793374add811d87ecebd2308ba2bdd9c4a608376b25d960b84bbe0d7d2d4a5";

export interface OnChainAnnouncement {
  sender: string;
  stealthAddress: string;
  ephemeralPubkeyXLow: string;
  ephemeralPubkeyXHigh: string;
  ephemeralPubkeyParity: string; // "2" or "3"
}

/**
 * Publish a stealth payment announcement on-chain.
 * Called by the sender after sending STRK to the stealth address.
 * Bundles announce() into the same account.execute() call or as a separate invoke.
 */
export async function announceOnChain(
  bitcoinAddress: string,
  publicKeyX: bigint,
  publicKeyY: bigint,
  stealthAddress: string,
  ephemeralPubkeyHex: string // 66 hex chars, compressed
): Promise<string> {
  const senderStarknetAddress = deriveBitcoinAccountAddress(publicKeyX, publicKeyY);
  const signer = new XverseSigner(bitcoinAddress);
  const account = new Account({ provider, address: senderStarknetAddress, signer });

  // Parse ephemeral pubkey: first byte = parity (02/03), remaining 32 bytes = x
  const parity = parseInt(ephemeralPubkeyHex.slice(0, 2), 16); // 2 or 3
  const xHex = ephemeralPubkeyHex.slice(2); // 64 hex chars = 32 bytes
  const xBig = BigInt("0x" + xHex);
  const { low: xLow, high: xHigh } = splitU256(xBig);

  const calls: Call[] = [
    {
      contractAddress: STEALTH_REGISTRY,
      entrypoint: "announce",
      calldata: [
        stealthAddress,
        "0x" + xLow.toString(16),
        "0x" + xHigh.toString(16),
        "0x" + parity.toString(16),
      ],
    },
  ];

  const estimate = await account.estimateInvokeFee(calls);
  const boostedL2Gas = BigInt(estimate.resourceBounds.l2_gas.max_amount) * 20n;

  const { transaction_hash } = await account.execute(calls, {
    resourceBounds: {
      ...estimate.resourceBounds,
      l2_gas: {
        max_amount: boostedL2Gas,
        max_price_per_unit: estimate.resourceBounds.l2_gas.max_price_per_unit,
      },
    },
  });

  return transaction_hash;
}

/**
 * Fetch all announcements from the on-chain registry.
 * Paginates in chunks of 50.
 */
export async function fetchAnnouncements(
  fromIndex = 0,
  maxCount = 200
): Promise<OnChainAnnouncement[]> {
  // Get total count
  const countResult = await provider.callContract({
    contractAddress: STEALTH_REGISTRY,
    entrypoint: "announcement_count",
    calldata: [],
  });
  const total = Number(BigInt(countResult[0]));
  if (total === 0) return [];

  const end = Math.min(total, fromIndex + maxCount);
  const fetchCount = end - fromIndex;
  if (fetchCount <= 0) return [];

  // get_announcements(from_index: u64, count: u64)
  // u64 is serialized as a single felt252
  const result = await provider.callContract({
    contractAddress: STEALTH_REGISTRY,
    entrypoint: "get_announcements",
    calldata: [
      fromIndex.toString(),
      fetchCount.toString(),
    ],
  });

  // Result is a serialized Array<Announcement>
  // Array format: [length, ...items]
  // Each Announcement is 5 felts: sender, stealth_address, x_low, x_high, parity
  const len = Number(BigInt(result[0]));
  const announcements: OnChainAnnouncement[] = [];
  for (let i = 0; i < len; i++) {
    const base = 1 + i * 5;
    announcements.push({
      sender: result[base],
      stealthAddress: result[base + 1],
      ephemeralPubkeyXLow: result[base + 2],
      ephemeralPubkeyXHigh: result[base + 3],
      ephemeralPubkeyParity: BigInt(result[base + 4]).toString(),
    });
  }
  return announcements;
}

// ── DeFi swap via AVNU ────────────────────────────────────────────────────────

import type { AvnuCall } from "./avnu";

/**
 * Execute a swap using pre-built AVNU calldata.
 *
 * Pass in the calls returned by buildSwap(); this function routes them through
 * the XverseSigner so the user's Bitcoin key authorises the transaction on-chain.
 */
export async function executeSwap(
  bitcoinAddress: string,
  publicKeyX: bigint,
  publicKeyY: bigint,
  avnuCalls: AvnuCall[]
): Promise<SendResult> {
  const starknetAddress = deriveBitcoinAccountAddress(publicKeyX, publicKeyY);
  const signer = new XverseSigner(bitcoinAddress);
  const account = new Account({ provider, address: starknetAddress, signer });

  const calls: Call[] = avnuCalls.map((c) => ({
    contractAddress: c.contractAddress,
    entrypoint: c.entrypoint,
    calldata: c.calldata,
  }));

  const estimate = await account.estimateInvokeFee(calls);
  const boostedL2Gas = BigInt(estimate.resourceBounds.l2_gas.max_amount) * 20n;

  const { transaction_hash } = await account.execute(calls, {
    resourceBounds: {
      ...estimate.resourceBounds,
      l2_gas: {
        max_amount: boostedL2Gas,
        max_price_per_unit: estimate.resourceBounds.l2_gas.max_price_per_unit,
      },
    },
  });

  return {
    transaction_hash,
    signedTxHash: signer.lastTxHash ?? transaction_hash,
    signature: signer.lastSignature ?? [],
  };
}

// ── Internal ──────────────────────────────────────────────────────────────────

/** Parse a decimal STRK amount string (e.g. "0.1") into wei (18 decimals). */
export function parseStrkAmount(amountStr: string): bigint {
  const [intStr, fracStr = ""] = amountStr.trim().split(".");
  return (
    BigInt(intStr || "0") * 10n ** 18n +
    BigInt(fracStr.padEnd(18, "0").slice(0, 18))
  );
}

/** Split a bigint into u256 { low: u128, high: u128 } */
export function splitU256(value: bigint): { low: bigint; high: bigint } {
  const mask128 = (1n << 128n) - 1n;
  return { low: value & mask128, high: value >> 128n };
}

/** Split two secp256k1 coordinates into their u128 low/high halves. */
function splitCoordinates(x: bigint, y: bigint) {
  const { low: xLow, high: xHigh } = splitU256(x);
  const { low: yLow, high: yHigh } = splitU256(y);
  return { xLow, xHigh, yLow, yHigh };
}
