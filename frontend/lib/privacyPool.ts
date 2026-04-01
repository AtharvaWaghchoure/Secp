/**
 * privacyPool.ts — Client-side note generation, commitment/nullifier computation,
 * and withdrawal signing for the PrivacyPool contract.
 *
 * Note lifecycle:
 *   1. generateNote()      → create fresh secp256k1 keypair
 *   2. computeCommitment() → poseidon hash of pubkey (stored on-chain at deposit)
 *   3. computeNullifier()  → separate poseidon hash (revealed at withdrawal)
 *   4. signWithdrawal()    → sign (nullifier, recipient) with note privkey
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hash } from "starknet";

// ── Domain separators (must match Cairo constants) ────────────────────────────

// 'pool_note_v1' as felt252 hex
const NOTE_DOMAIN = "0x706f6f6c5f6e6f74655f7631";
// 'pool_null_v1' as felt252 hex
const NULL_DOMAIN = "0x706f6f6c5f6e756c6c5f7631";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PoolNote {
  privkeyHex: string;
  pubkeyXLow: string;  // x.low  as hex
  pubkeyXHigh: string; // x.high as hex
  pubkeyParity: string; // "0" or "1"
  pubkeyXFull: string;  // full 32-byte x as hex (for sig verification)
  pubkeyYFull: string;  // full 32-byte y as hex
  commitment: string;   // felt252 hex
  nullifier: string;    // felt252 hex
  depositTxHash?: string;
  savedAt: number;
}

const STORAGE_KEY = "secp_pool_notes_v1";

// ── Note generation ───────────────────────────────────────────────────────────

/** Generate a fresh secp256k1 note keypair and compute its commitment + nullifier. */
export function generateNote(): PoolNote {
  const privBytes = crypto.getRandomValues(new Uint8Array(32));
  const pubBytes = secp256k1.getPublicKey(privBytes, false); // uncompressed 65 bytes

  // x = bytes 1..33, y = bytes 33..65
  const xBytes = pubBytes.slice(1, 33);
  const yBytes = pubBytes.slice(33, 65);

  const xBig = BigInt("0x" + bytesToHex(xBytes));
  const yBig = BigInt("0x" + bytesToHex(yBytes));

  const mask128 = (1n << 128n) - 1n;
  const xLow = xBig & mask128;
  const xHigh = xBig >> 128n;
  const parity = yBig & 1n;

  const xLowHex = "0x" + xLow.toString(16);
  const xHighHex = "0x" + xHigh.toString(16);
  const parityHex = "0x" + parity.toString(16);

  const commitment = computeCommitment(xLowHex, xHighHex, parityHex);
  const nullifier = computeNullifier(xLowHex, xHighHex, parityHex);

  return {
    privkeyHex: bytesToHex(privBytes),
    pubkeyXLow: xLowHex,
    pubkeyXHigh: xHighHex,
    pubkeyParity: parity.toString(),
    pubkeyXFull: "0x" + bytesToHex(xBytes),
    pubkeyYFull: "0x" + bytesToHex(yBytes),
    commitment,
    nullifier,
    savedAt: Date.now(),
  };
}

// ── Hash computation (must match Cairo) ───────────────────────────────────────

/**
 * commitment = poseidon(['pool_note_v1', x_low, x_high, parity])
 * Matches privacy_pool.cairo compute_commitment().
 */
export function computeCommitment(
  xLow: string,
  xHigh: string,
  parity: string
): string {
  const result = hash.computePoseidonHashOnElements([
    NOTE_DOMAIN,
    xLow,
    xHigh,
    parity,
  ]);
  return "0x" + BigInt(result).toString(16).padStart(64, "0");
}

/**
 * nullifier = poseidon(['pool_null_v1', x_low, x_high, parity])
 * Matches privacy_pool.cairo compute_nullifier().
 */
export function computeNullifier(
  xLow: string,
  xHigh: string,
  parity: string
): string {
  const result = hash.computePoseidonHashOnElements([
    NULL_DOMAIN,
    xLow,
    xHigh,
    parity,
  ]);
  return "0x" + BigInt(result).toString(16).padStart(64, "0");
}

// ── Withdrawal signing ────────────────────────────────────────────────────────

/**
 * Sign a withdrawal request with the note private key.
 *
 * Message: bitcoin_message_hash(poseidon(nullifier, recipient_address))
 * This matches what privacy_pool.cairo verifies in withdraw().
 *
 * Returns [r.low, r.high, s.low, s.high] as hex strings.
 */
export function signWithdrawal(
  note: PoolNote,
  recipientAddress: string
): string[] {
  // poseidon(nullifier, recipient) — must match Cairo
  const msgFelt = hash.computePoseidonHashOnElements([
    note.nullifier,
    recipientAddress,
  ]);
  const msgHex = "0x" + BigInt(msgFelt).toString(16).padStart(64, "0");

  // Apply Bitcoin message prefix: SHA256(SHA256("\x18Bitcoin Signed Message:\n" + varint + msgHex))
  const msgHashBytes = bitcoinMessageHashBytes(msgHex);

  const privBytes = hexToBytes(note.privkeyHex);
  // v2: secp256k1.sign() returns compact 64-byte Uint8Array directly
  const sigBytes = secp256k1.sign(msgHashBytes, privBytes, { prehash: false });

  const rBytes = sigBytes.slice(0, 32);
  const sBytes = sigBytes.slice(32, 64);
  const r = BigInt("0x" + bytesToHex(rBytes));
  const s = BigInt("0x" + bytesToHex(sBytes));

  const mask128 = (1n << 128n) - 1n;
  return [
    "0x" + (r & mask128).toString(16),
    "0x" + (r >> 128n).toString(16),
    "0x" + (s & mask128).toString(16),
    "0x" + (s >> 128n).toString(16),
  ];
}

// ── Local storage ─────────────────────────────────────────────────────────────

export function saveNote(note: PoolNote): void {
  const notes = loadNotes();
  notes.push(note);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

export function loadNotes(): PoolNote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function updateNote(commitment: string, patch: Partial<PoolNote>): void {
  const notes = loadNotes();
  const idx = notes.findIndex((n) => n.commitment === commitment);
  if (idx >= 0) {
    notes[idx] = { ...notes[idx], ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  }
}

// ── Bitcoin message hash (matches utils.cairo) ────────────────────────────────

/**
 * Compute Bitcoin message hash bytes for a hex-encoded felt252.
 * SHA256(SHA256("\x18Bitcoin Signed Message:\n" + varint(66) + "0x" + hex64(felt)))
 */
function bitcoinMessageHashBytes(feltHex: string): Uint8Array {
  const normalized = feltHex.replace(/^0x/, "").padStart(64, "0");
  const msg = "\x18Bitcoin Signed Message:\n\x420x" + normalized;
  const first = sha256(new TextEncoder().encode(msg));
  return sha256(first);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
