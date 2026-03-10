/**
 * stealth.ts — ECDH-based stealth address derivation for private payments.
 *
 * Protocol (sender side):
 *
 *   1. Sender generates a one-time ephemeral keypair (r, R = r·G).
 *   2. Sender computes shared secret S = r · PK_recipient  (ECDH on secp256k1).
 *   3. Sender derives stealth pubkey:
 *        stealth_pk = H(S)·G + PK_recipient
 *      where H = SHA256 of the compressed shared point.
 *   4. Sender derives the Starknet address from stealth_pk the same way as a
 *      normal BitcoinAccount address, then sends funds there.
 *   5. Sender publishes R (the ephemeral public key) so the recipient can scan.
 *
 * Recipient scanning (requires Bitcoin private key — currently outside browser):
 *   For each published R:
 *     S_check  = sk_recipient · R        (same shared secret)
 *     stealth  = H(S_check)·G + PK_recipient
 *     address  = deriveBitcoinAccountAddress(stealth.x, stealth.y)
 *   → if address has a balance, it belongs to this recipient.
 *
 *   Claim private key: sk_stealth = (H(S) + sk_recipient) mod n
 *   → recipient deploys a BitcoinAccount with stealth_pk as the constructor arg,
 *     then signs using sk_stealth (requires a custom signer, not Xverse).
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { deriveBitcoinAccountAddress } from "./starknet";

export interface StealthPayment {
  /** Compressed ephemeral public key (33 bytes hex) — publish so recipient can scan. */
  ephemeralPubkey: string;
  /** One-time Starknet address to send funds to. */
  stealthAddress: string;
  /** Stealth secp256k1 pubkey x coordinate — stored in the deployed account. */
  stealthPubkeyX: bigint;
  /** Stealth secp256k1 pubkey y coordinate — stored in the deployed account. */
  stealthPubkeyY: bigint;
}

/**
 * Derive a stealth payment address from the recipient's Bitcoin public key.
 *
 * @param recipientPubkeyHex  Compressed secp256k1 public key of the recipient (66 hex chars).
 */
export function deriveStealthPayment(
  recipientPubkeyHex: string
): StealthPayment {
  // 1. Generate one-time ephemeral key pair
  const ephemeralPrivkey = secp256k1.utils.randomSecretKey();
  const R = secp256k1.getPublicKey(ephemeralPrivkey, true); // 33-byte compressed

  // 2. ECDH: S = r · PK_recipient
  const recipientPoint = secp256k1.Point.fromHex(recipientPubkeyHex);
  const ephemeralScalar = BigInt("0x" + bytesToHex(ephemeralPrivkey));
  const sharedPoint = recipientPoint.multiply(ephemeralScalar);

  // 3. h = SHA256(compressed shared point)  →  scalar mod n
  const sharedBytes = sharedPoint.toBytes(true);
  const h = sha256(sharedBytes);
  // secp256k1 curve order (fixed constant)
  const SECP256K1_N =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const hScalar = BigInt("0x" + bytesToHex(h)) % SECP256K1_N;

  // 4. stealth_pk = h·G + PK_recipient
  const stealthPoint = secp256k1.Point.BASE.multiply(hScalar).add(recipientPoint);

  // 5. Derive Starknet address from stealth pubkey
  const stealthAddress = deriveBitcoinAccountAddress(
    stealthPoint.x,
    stealthPoint.y
  );

  return {
    ephemeralPubkey: bytesToHex(R),
    stealthAddress,
    stealthPubkeyX: stealthPoint.x,
    stealthPubkeyY: stealthPoint.y,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
