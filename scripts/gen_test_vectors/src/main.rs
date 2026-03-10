//! Generates secp256k1 test vectors for the BitcoinAccount Cairo contract.
//!
//! Uses private key = 1 so the public key is the well-known generator point G,
//! which is already present in the Cairo tests.  Deterministic ECDSA (RFC 6979)
//! means the same input always produces the same (r, s) — no randomness needed.
//!
//! Output is printed ready to paste into `tests/test_contract.cairo`.

use k256::ecdsa::{signature::hazmat::PrehashSigner, SigningKey};
use k256::elliptic_curve::sec1::ToEncodedPoint;

fn main() {
    // ── Key pair ─────────────────────────────────────────────────────────────
    // Private key = 1  →  public key = G (the secp256k1 generator point).
    let mut key_bytes = [0u8; 32];
    key_bytes[31] = 1;
    let signing_key = SigningKey::from_bytes(&key_bytes.into()).expect("valid key");
    let verifying_key = signing_key.verifying_key();

    // Uncompressed public key: 0x04 || x (32 bytes) || y (32 bytes)
    let encoded = verifying_key.to_encoded_point(false);
    let x_bytes = encoded.x().expect("x coordinate");
    let y_bytes = encoded.y().expect("y coordinate");

    // ── Message hash ─────────────────────────────────────────────────────────
    // We sign the felt252 value 0x01 represented as a 32-byte big-endian array.
    // In the Cairo contract, felt252 tx hashes are cast to u256 via `.into()`,
    // which zero-extends, so 0x01 → u256 { low: 1, high: 0 }.
    // As bytes (big-endian 32-byte) that is 31 zero bytes followed by 0x01.
    let mut msg_hash_bytes = [0u8; 32];
    msg_hash_bytes[31] = 0x01;

    // ── Sign (deterministic RFC 6979) ─────────────────────────────────────────
    let (sig, _recovery_id) = signing_key
        .sign_prehash_recoverable(&msg_hash_bytes)
        .expect("signing failed");

    let r_bytes: [u8; 32] = sig.r().to_bytes().into();
    let s_bytes: [u8; 32] = sig.s().to_bytes().into();

    // ── Split each 256-bit integer into (high u128, low u128) ─────────────────
    // Cairo's u256 is { low: u128, high: u128 } where low holds the least
    // significant 128 bits.  Bytes are big-endian, so bytes[0..16] = high.
    let (r_high, r_low) = split_u256(&r_bytes);
    let (s_high, s_low) = split_u256(&s_bytes);
    let (pkx_high, pkx_low) = split_u256(x_bytes);
    let (pky_high, pky_low) = split_u256(y_bytes);

    // ── Print ─────────────────────────────────────────────────────────────────
    println!("// ── Generated test vectors (private key = 1) ──────────────────");
    println!("// Public key = secp256k1 generator G");
    println!("// pub_x = 0x{}", hex::encode(x_bytes));
    println!("// pub_y = 0x{}", hex::encode(y_bytes));
    println!("// msg_hash (felt252) = 0x01");
    println!("// r = 0x{}", hex::encode(r_bytes));
    println!("// s = 0x{}", hex::encode(s_bytes));
    println!();
    println!("// Paste these constants into tests/test_contract.cairo:");
    println!();
    println!("const PK_X_LOW:  u128 = 0x{pkx_low:032x};");
    println!("const PK_X_HIGH: u128 = 0x{pkx_high:032x};");
    println!("const PK_Y_LOW:  u128 = 0x{pky_low:032x};");
    println!("const PK_Y_HIGH: u128 = 0x{pky_high:032x};");
    println!();
    println!("const MSG_HASH: felt252 = 0x01;");
    println!();
    println!("const SIG_R_LOW:  u128 = 0x{r_low:032x};");
    println!("const SIG_R_HIGH: u128 = 0x{r_high:032x};");
    println!("const SIG_S_LOW:  u128 = 0x{s_low:032x};");
    println!("const SIG_S_HIGH: u128 = 0x{s_high:032x};");
}

/// Split a 32-byte big-endian integer into (high u128, low u128).
fn split_u256(bytes: &[u8]) -> (u128, u128) {
    assert_eq!(bytes.len(), 32, "expected 32 bytes");
    let high = u128::from_be_bytes(bytes[0..16].try_into().unwrap());
    let low = u128::from_be_bytes(bytes[16..32].try_into().unwrap());
    (high, low)
}
