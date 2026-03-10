/**
 * bitcoin.ts — Xverse wallet integration and Bitcoin key utilities.
 *
 * Handles:
 *  - Connecting to Xverse via sats-connect
 *  - Extracting the secp256k1 public key (x, y)
 *  - Signing Starknet transaction hashes using Xverse's signMessage
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import Wallet, { AddressPurpose, MessageSigningProtocols } from "sats-connect";

export interface BitcoinWallet {
  address: string;       // Bitcoin address (P2WPKH)
  publicKeyHex: string;  // Compressed public key hex (33 bytes, 66 hex chars)
  publicKeyX: bigint;    // Uncompressed x coordinate
  publicKeyY: bigint;    // Uncompressed y coordinate
}

// Shape of a single account entry returned by sats-connect getAccounts
interface SatsAccount {
  address: string;
  publicKey: string;
  purpose: string;
}

/**
 * Connect to Xverse and return the payment address + public key.
 * Throws if the user rejects or Xverse is not installed.
 */
export async function connectXverse(): Promise<BitcoinWallet> {
  const response = await Wallet.request("getAccounts", {
    purposes: [AddressPurpose.Payment],
    message: "Connect your Bitcoin wallet to create a Starknet account",
  });

  if (response.status !== "success") {
    throw new Error(
      (response.error as { message?: string })?.message ??
        "Wallet connection rejected"
    );
  }

  const accounts = response.result as SatsAccount[];
  const paymentAccount = accounts.find(
    (a) => a.purpose === AddressPurpose.Payment
  );

  if (!paymentAccount) {
    throw new Error("No payment address returned by Xverse");
  }

  const { x, y } = decompressPublicKey(paymentAccount.publicKey);

  return {
    address: paymentAccount.address,
    publicKeyHex: paymentAccount.publicKey,
    publicKeyX: x,
    publicKeyY: y,
  };
}

/**
 * Ask Xverse to sign an arbitrary message (the Starknet tx hash).
 *
 * Xverse uses Bitcoin's message signing standard:
 *   double-SHA256("Bitcoin Signed Message:\n" + varint(len) + message)
 *
 * We pass the hex tx hash as the message string.
 * Returns { r, s } extracted from the 65-byte compact signature.
 */
/**
 * Compute the hash that Bitcoin wallets actually sign when you call signMessage.
 *
 * Standard Bitcoin message signing:
 *   Hash = SHA256(SHA256("\x18Bitcoin Signed Message:\n" + varint(len) + message))
 *
 * This is what Xverse signs under MessageSigningProtocols.ECDSA.
 * The Cairo contract must verify against THIS hash, not the raw tx hash.
 */
export function bitcoinMessageHash(message: string): bigint {
  const prefix = "\x18Bitcoin Signed Message:\n";
  const msgBytes = new TextEncoder().encode(message);
  const lenByte = new Uint8Array([msgBytes.length]); // varint for messages < 253 bytes
  const prefixBytes = new TextEncoder().encode(prefix);
  const combined = new Uint8Array(
    prefixBytes.length + lenByte.length + msgBytes.length
  );
  combined.set(prefixBytes, 0);
  combined.set(lenByte, prefixBytes.length);
  combined.set(msgBytes, prefixBytes.length + lenByte.length);
  const hash = sha256(sha256(combined));
  return BigInt("0x" + bytesToHex(hash));
}

export async function signWithXverse(
  bitcoinAddress: string,
  txHashHex: string
): Promise<{ r: bigint; s: bigint; signatureHex: string; messageHash: bigint }> {
  let signatureB64 = "";

  const response = await Wallet.request("signMessage", {
    address: bitcoinAddress,
    message: txHashHex,
    protocol: MessageSigningProtocols.ECDSA,
  });

  if (response.status !== "success") {
    throw new Error(
      (response.error as { message?: string })?.message ?? "Signing rejected"
    );
  }

  signatureB64 = (response.result as { signature: string }).signature;

  // Decode base64 → 65 bytes: [recovery_id (1)] [r (32)] [s (32)]
  const sigBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
  if (sigBytes.length !== 65) {
    throw new Error(`Unexpected signature length: ${sigBytes.length}`);
  }

  const r = BigInt("0x" + bytesToHex(sigBytes.slice(1, 33)));
  const s = BigInt("0x" + bytesToHex(sigBytes.slice(33, 65)));
  const signatureHex = bytesToHex(sigBytes);

  // The hash Xverse actually signed (Bitcoin message prefix applied)
  const messageHash = bitcoinMessageHash(txHashHex);

  return { r, s, signatureHex, messageHash };
}

/**
 * Decompress a 33-byte secp256k1 public key (02/03 prefix) into (x, y).
 */
export function decompressPublicKey(compressedHex: string): {
  x: bigint;
  y: bigint;
} {
  const point = secp256k1.Point.fromHex(compressedHex);
  return { x: point.x, y: point.y };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
