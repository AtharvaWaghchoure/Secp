/**
 * stealthClaim.ts — Recipient-side stealth payment scanning and claiming.
 *
 * The recipient side of the ECDH stealth address protocol:
 *
 *   1. For each published ephemeral key R:
 *        S = sk_recipient · R          (same shared secret)
 *        h = SHA256(compress(S))
 *        stealth_pk = h·G + PK_recipient
 *        address = deriveBitcoinAccountAddress(stealth_pk)
 *      → if address matches the announcement, this payment is ours.
 *
 *   2. Claim private key:  sk_stealth = (sk_recipient + h) mod n
 *
 *   3. Claim flow:
 *        a. Deploy BitcoinAccount at stealth_address using sk_stealth signer.
 *        b. Sweep remaining STRK to recipient's main address.
 *
 * WARNING: Claiming requires the recipient's raw secp256k1 private key in
 * the browser. It is never sent to any server — all operations are local.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
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
import {
  provider,
  BITCOIN_ACCOUNT_CLASS_HASH,
  deriveBitcoinAccountAddress,
  buildConstructorCalldata,
  encodeSignatureAsCalldata,
  getStrkBalance,
  isAccountDeployed,
  splitU256,
  parseStrkAmount,
  fetchAnnouncements,
  type OnChainAnnouncement,
} from "./starknet";

// Fixed additive gas overhead for __validate__ / __validate_deploy__.
// Mirrors the same constant in starknet.ts — estimateFee skips validation
// so the double-SHA256 + secp256k1 cost (~10-15M l2_gas) is never included.
const VALIDATE_GAS_OVERHEAD = 50_000_000n;

const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// ── Announcement storage (localStorage) ──────────────────────────────────────

export interface StealthAnnouncement {
  /** Compressed ephemeral pubkey (66 hex chars). */
  ephemeralPubkey: string;
  /** One-time Starknet stealth address. */
  stealthAddress: string;
  /** Stealth pubkey x coordinate (decimal string). */
  stealthPubkeyX: string;
  /** Stealth pubkey y coordinate (decimal string). */
  stealthPubkeyY: string;
  /** Unix timestamp (ms) when the payment was sent. */
  sentAt: number;
}

const STORAGE_KEY = "stealth_announcements_v1";

export function saveAnnouncement(ann: StealthAnnouncement): void {
  const existing = loadAnnouncements();
  existing.push(ann);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
}

export function loadAnnouncements(): StealthAnnouncement[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StealthAnnouncement[]) : [];
  } catch {
    return [];
  }
}

// ── On-chain → StealthAnnouncement conversion ────────────────────────────────

/**
 * Convert an OnChainAnnouncement (from the registry contract) into the
 * StealthAnnouncement shape used by checkAnnouncement().
 *
 * The registry stores x_low, x_high, parity separately.
 * We reconstruct the 66-char compressed pubkey hex.
 */
export function onChainToAnnouncement(
  oc: OnChainAnnouncement
): StealthAnnouncement {
  const xLow = BigInt(oc.ephemeralPubkeyXLow);
  const xHigh = BigInt(oc.ephemeralPubkeyXHigh);
  const xFull = (xHigh << 128n) | xLow;
  const parity = Number(BigInt(oc.ephemeralPubkeyParity)); // 2 or 3
  const ephemeralPubkey =
    parity.toString(16).padStart(2, "0") +
    xFull.toString(16).padStart(64, "0");
  return {
    ephemeralPubkey,
    stealthAddress: oc.stealthAddress,
    // We don't store pubkey coords on-chain — derive at scan time
    stealthPubkeyX: "0",
    stealthPubkeyY: "0",
    sentAt: 0,
  };
}

/**
 * Scan all on-chain registry announcements for payments to this recipient.
 * Merges with localStorage as a fallback for announcements made before
 * the registry was deployed.
 */
export async function scanAllAnnouncements(
  recipientPrivkeyHex: string
): Promise<ClaimablePayment[]> {
  // Fetch on-chain announcements
  let onChain: StealthAnnouncement[] = [];
  try {
    const raw = await fetchAnnouncements();
    onChain = raw.map(onChainToAnnouncement);
  } catch {
    // Registry unreachable — fall through to localStorage only
  }

  // Merge with localStorage (dedup by stealthAddress)
  const local = loadAnnouncements();
  const seen = new Set(onChain.map((a) => a.stealthAddress.toLowerCase()));
  const merged = [
    ...onChain,
    ...local.filter((a) => !seen.has(a.stealthAddress.toLowerCase())),
  ];

  const bare = recipientPrivkeyHex.replace(/^0x/, "");
  const found: ClaimablePayment[] = [];
  for (const ann of merged) {
    const result = await checkAnnouncement(bare, ann);
    if (result) found.push(result);
  }
  return found;
}

// ── Recipient-side scanning ───────────────────────────────────────────────────

export interface ClaimablePayment {
  announcement: StealthAnnouncement;
  /** Current STRK balance at the stealth address. */
  balance: string;
  /** sk_stealth = (sk_recipient + h) mod n — private key to sign with. */
  claimPrivkey: bigint;
  stealthPubkeyX: bigint;
  stealthPubkeyY: bigint;
}

/**
 * Check whether a single announcement belongs to the given recipient private key.
 * Returns null if the payment is not theirs or the balance is zero.
 */
export async function checkAnnouncement(
  recipientPrivkeyHex: string,
  ann: StealthAnnouncement
): Promise<ClaimablePayment | null> {
  const sk = BigInt("0x" + recipientPrivkeyHex.replace(/^0x/, ""));
  const recipientPoint = secp256k1.Point.BASE.multiply(sk);

  // Recompute shared secret: S = sk · R
  const R = secp256k1.Point.fromHex(ann.ephemeralPubkey);
  const sharedPoint = R.multiply(sk);
  const h = sha256(sharedPoint.toBytes(true));
  const hScalar = BigInt("0x" + bytesToHex(h)) % SECP256K1_N;

  // Derive expected stealth pubkey: h·G + PK_recipient
  const stealthPoint = secp256k1.Point.BASE.multiply(hScalar).add(recipientPoint);
  const expectedAddress = deriveBitcoinAccountAddress(
    stealthPoint.x,
    stealthPoint.y
  );

  // Does it match what was announced?
  if (expectedAddress.toLowerCase() !== ann.stealthAddress.toLowerCase()) {
    return null;
  }

  const balance = await getStrkBalance(ann.stealthAddress);
  if (parseFloat(balance) <= 0) return null;

  const claimPrivkey = (sk + hScalar) % SECP256K1_N;
  return {
    announcement: ann,
    balance,
    claimPrivkey,
    stealthPubkeyX: stealthPoint.x,
    stealthPubkeyY: stealthPoint.y,
  };
}

// ── Claiming ──────────────────────────────────────────────────────────────────

export interface ClaimResult {
  deployTx: string;
  sweepTx: string;
}

/**
 * Deploy the stealth BitcoinAccount and sweep all STRK to sweepToAddress.
 *
 * No Xverse involved — signs everything locally with the derived sk_stealth.
 */
export async function claimStealthPayment(
  payment: ClaimablePayment,
  sweepToAddress: string
): Promise<ClaimResult> {
  const { claimPrivkey, stealthPubkeyX, stealthPubkeyY } = payment;
  const stealthAddress = deriveBitcoinAccountAddress(
    stealthPubkeyX,
    stealthPubkeyY
  );

  const signer = new RawSecp256k1Signer(claimPrivkey);
  const account = new Account({ provider, address: stealthAddress, signer });

  // ── 1. Deploy the stealth account (skip if already deployed) ───────────────
  const constructorCalldata = buildConstructorCalldata(
    stealthPubkeyX,
    stealthPubkeyY
  );
  const { low: xLow, high: xHigh } = splitU256(stealthPubkeyX);
  const salt = hash.computePedersenHash(
    "0x" + xLow.toString(16),
    "0x" + xHigh.toString(16)
  );

  let deployTx: string;
  const alreadyDeployed = await isAccountDeployed(stealthAddress);

  if (alreadyDeployed) {
    deployTx = "(already deployed)";
  } else {
    const deployPayload = {
      classHash: BITCOIN_ACCOUNT_CLASS_HASH,
      constructorCalldata,
      addressSalt: salt,
      contractAddress: stealthAddress,
    };

    const deployEst = await account.estimateAccountDeployFee(deployPayload);

    // Additive overhead: __validate_deploy__ runs bitcoin_message_hash (double-SHA256)
    // + secp256k1_verify, which skipValidate=true estimation misses entirely.
    const deployL2Gas =
      BigInt(deployEst.resourceBounds.l2_gas.max_amount) + VALIDATE_GAS_OVERHEAD;

    // Pre-flight: sequencer rejects if max_amount × max_price > balance.
    const l2Price = BigInt(deployEst.resourceBounds.l2_gas.max_price_per_unit);
    const l1DataCost =
      BigInt(deployEst.resourceBounds.l1_data_gas.max_amount) *
      BigInt(deployEst.resourceBounds.l1_data_gas.max_price_per_unit);
    const deployMaxCost = deployL2Gas * l2Price + l1DataCost;
    const SWEEP_RESERVE = parseStrkAmount("0.01");
    const balanceWei = parseStrkAmount(payment.balance);

    if (balanceWei < deployMaxCost + SWEEP_RESERVE) {
      const needed = Number(deployMaxCost + SWEEP_RESERVE) / 1e18;
      throw new Error(
        `Need at least ${needed.toFixed(3)} STRK to claim at current gas prices ` +
          `(${payment.balance} STRK in stealth address). ` +
          `Top up ${stealthAddress} and scan again.`
      );
    }

    const { transaction_hash } = await account.deployAccount(deployPayload, {
      resourceBounds: {
        ...deployEst.resourceBounds,
        l2_gas: {
          max_amount: deployL2Gas,
          max_price_per_unit: deployEst.resourceBounds.l2_gas.max_price_per_unit,
        },
      },
    });
    deployTx = transaction_hash;

    // Wait for deploy to land before the sweep invoke
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  // ── 2. Sweep remaining STRK → recipient ────────────────────────────────────
  const freshBalance = await getStrkBalance(stealthAddress);
  // Reserve 0.005 STRK for the sweep tx fee
  const sweepRaw =
    parseStrkAmount(freshBalance) - parseStrkAmount("0.005");
  if (sweepRaw <= 0n) {
    throw new Error("Balance too low to sweep after deploy fee");
  }

  const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
  const { low: amtLow, high: amtHigh } = splitU256(sweepRaw);
  const sweepCalls: Call[] = [
    {
      contractAddress: STRK,
      entrypoint: "transfer",
      calldata: [
        sweepToAddress,
        "0x" + amtLow.toString(16),
        "0x" + amtHigh.toString(16),
      ],
    },
  ];

  const sweepEst = await account.estimateInvokeFee(sweepCalls);
  // Additive overhead — __validate__ costs the same fixed amount here as on
  // any other invoke. The estimate still runs with skipValidate=true.
  const sweepL2Gas =
    BigInt(sweepEst.resourceBounds.l2_gas.max_amount) + VALIDATE_GAS_OVERHEAD;

  const { transaction_hash: sweepTx } = await account.execute(sweepCalls, {
    resourceBounds: {
      ...sweepEst.resourceBounds,
      l2_gas: {
        max_amount: sweepL2Gas,
        max_price_per_unit: sweepEst.resourceBounds.l2_gas.max_price_per_unit,
      },
    },
  });

  return { deployTx, sweepTx };
}

// ── RawSecp256k1Signer ────────────────────────────────────────────────────────

/**
 * Signs Starknet transactions using a raw secp256k1 private key (sk_stealth).
 *
 * Applies the same Bitcoin message prefix that XverseSigner + Xverse use,
 * so the on-chain __validate__ / __validate_deploy__ will accept the signature.
 */
class RawSecp256k1Signer implements SignerInterface {
  lastTxHash: string | null = null;
  lastSignature: string[] | null = null;

  constructor(private readonly privkey: bigint) {}

  async getPubKey(): Promise<string> {
    return "0x0";
  }

  async signMessage(_: TypedData, __: string): Promise<Signature> {
    throw new Error("signMessage not supported");
  }

  async signDeclareTransaction(_: DeclareSignerDetails): Promise<Signature> {
    throw new Error("signDeclareTransaction not supported");
  }

  async signTransaction(
    calls: Call[],
    details: InvocationsSignerDetails
  ): Promise<Signature> {
    const det = details as Extract<
      InvocationsSignerDetails,
      { walletAddress: string }
    >;
    const compiledCalldata = transaction.getExecuteCalldata(
      calls,
      det.cairoVersion
    );
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

  private _signHash(txHash: string): Signature {
    // Normalize to 0x + 64 hex chars — same as XverseSigner
    const normalized = "0x" + txHash.replace(/^0x/, "").padStart(64, "0");
    // Apply the Bitcoin message prefix and double-SHA256 (matches Cairo's bitcoin_message_hash)
    const msgHashBytes = bitcoinMessageHashBytes(normalized);
    // prehash: false → sign the pre-computed 32-byte hash directly (no extra SHA256)
    // Returns compact format: 64 bytes = r (32) || s (32)
    const sigBytes = secp256k1.sign(msgHashBytes, privkeyToBytes(this.privkey), {
      prehash: false,
    });
    const r = BigInt("0x" + bytesToHex(sigBytes.slice(0, 32)));
    const s = BigInt("0x" + bytesToHex(sigBytes.slice(32, 64)));
    const encoded = encodeSignatureAsCalldata(r, s);
    this.lastTxHash = normalized;
    this.lastSignature = encoded;
    return encoded;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Compute the 32-byte hash that Cairo's bitcoin_message_hash returns.
 * SHA256(SHA256("\x18Bitcoin Signed Message:\n" + varint(len) + message))
 */
function bitcoinMessageHashBytes(message: string): Uint8Array {
  const prefix = "\x18Bitcoin Signed Message:\n";
  const msgBytes = new TextEncoder().encode(message);
  const lenByte = new Uint8Array([msgBytes.length]);
  const prefixBytes = new TextEncoder().encode(prefix);
  const combined = new Uint8Array(
    prefixBytes.length + lenByte.length + msgBytes.length
  );
  combined.set(prefixBytes, 0);
  combined.set(lenByte, prefixBytes.length);
  combined.set(msgBytes, prefixBytes.length + lenByte.length);
  return sha256(sha256(combined));
}

function privkeyToBytes(privkey: bigint): Uint8Array {
  const hex = privkey.toString(16).padStart(64, "0");
  return Uint8Array.from({ length: 32 }, (_, i) =>
    parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
