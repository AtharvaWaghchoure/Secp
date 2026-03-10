/// Utility helpers for the Bitcoin account contract.
use core::sha256::compute_sha256_u32_array;

/// Convert a felt252 to u256. felt252 always fits in u256.
pub fn felt252_to_u256(value: felt252) -> u256 {
    value.into()
}

// ── Bitcoin message hash ──────────────────────────────────────────────────────
//
// Xverse (and all Bitcoin wallets) apply a prefix when signing messages via
// MessageSigningProtocols.ECDSA:
//   hash = SHA256(SHA256("\x18Bitcoin Signed Message:\n" + varint(len) + message))
//
// The "message" we pass to Xverse is the Starknet tx hash formatted as a
// 66-character hex string: "0x" + 64 lowercase hex chars (always padded with
// leading zeros to fill 32 bytes). The length varint is 0x42 (= 66 decimal).
//
// Total input to the outer SHA256: 92 bytes = 23 complete u32 words:
//   word 0-6  : static preamble  "\x18Bitcoin Signed Message:\n\x420x"
//   word 7-14 : 32 hex chars for the high 16 bytes of tx_hash  (8 words)
//   word 15-22: 32 hex chars for the low  16 bytes of tx_hash  (8 words)
//
// __validate__ applies this same transform so on-chain verification matches
// exactly what Xverse produces.

/// Convert a nibble (0-15) to its lowercase ASCII hex character byte.
fn nibble_to_ascii(nibble: u128) -> u128 {
    if nibble < 10 {
        nibble + 48 // '0'–'9'
    } else {
        nibble + 87 // 'a'–'f'  (97 - 10)
    }
}

/// Extract 2 bytes at big-endian pair position `pair` (0 = MSB pair, 7 = LSB
/// pair) from a u128 that represents 16 bytes big-endian, then return those 2
/// bytes encoded as 4 ASCII hex chars packed into a u32.
///
/// We use integer division to avoid bit-shift operators (Cairo lexer parses >>
/// as two comparison operators in this edition).
fn u128_hex_word(v: u128, pair: u32) -> u32 {
    // Extract the 16-bit (2-byte) value at big-endian pair position:
    //   pair 0: bytes  0-1  → divide by 2^112 = 0x10000000000000000000000000000
    //   pair 1: bytes  2-3  → divide by 2^96  = 0x1000000000000000000000000
    //   pair 2: bytes  4-5  → divide by 2^80  = 0x100000000000000000000
    //   pair 3: bytes  6-7  → divide by 2^64  = 0x10000000000000000
    //   pair 4: bytes  8-9  → divide by 2^48  = 0x1000000000000
    //   pair 5: bytes 10-11 → divide by 2^32  = 0x100000000
    //   pair 6: bytes 12-13 → divide by 2^16  = 0x10000
    //   pair 7: bytes 14-15 → divide by 2^0   = 0x1
    let two_bytes: u128 = match pair {
        0 => (v / 0x10000000000000000000000000000_u128) & 0xFFFF_u128,
        1 => (v / 0x1000000000000000000000000_u128) & 0xFFFF_u128,
        2 => (v / 0x100000000000000000000_u128) & 0xFFFF_u128,
        3 => (v / 0x10000000000000000_u128) & 0xFFFF_u128,
        4 => (v / 0x1000000000000_u128) & 0xFFFF_u128,
        5 => (v / 0x100000000_u128) & 0xFFFF_u128,
        6 => (v / 0x10000_u128) & 0xFFFF_u128,
        _ => v & 0xFFFF_u128, // pair 7: LSB pair
    };

    // Split two_bytes into byte0 (high) and byte1 (low)
    let b0 = two_bytes / 256;
    let b1 = two_bytes & 0xFF_u128;

    // Convert each byte to 2 hex chars
    let c0 = nibble_to_ascii(b0 / 16);
    let c1 = nibble_to_ascii(b0 % 16);
    let c2 = nibble_to_ascii(b1 / 16);
    let c3 = nibble_to_ascii(b1 % 16);

    // Pack 4 ASCII bytes into a u32 (big-endian)
    (c0 * 0x1000000_u128 + c1 * 0x10000_u128 + c2 * 0x100_u128 + c3).try_into().unwrap()
}

/// Pack four u32 words (big-endian) into a u128.
fn u32s_to_u128(w0: u32, w1: u32, w2: u32, w3: u32) -> u128 {
    let w0: u128 = w0.into();
    let w1: u128 = w1.into();
    let w2: u128 = w2.into();
    let w3: u128 = w3.into();
    // 2^96, 2^64, 2^32
    w0 * 0x1000000000000000000000000_u128
        + w1 * 0x10000000000000000_u128
        + w2 * 0x100000000_u128
        + w3
}

/// Compute the Bitcoin message hash for a Starknet tx hash:
///   SHA256(SHA256("\x18Bitcoin Signed Message:\n" + varint(66) + "0x" + hex64(tx_hash)))
///
/// This matches exactly what Xverse produces when `signMessage(ECDSA)` is
/// called with the tx hash formatted as a 66-character hex string.
pub fn bitcoin_message_hash(tx_hash: felt252) -> u256 {
    let hash: u256 = tx_hash.into();

    // Static preamble — 7 words (28 bytes):
    //   "\x18Bitcoin Signed Message:\n" (25 bytes)
    //   + varint(66) = 0x42             (1 byte)
    //   + "0x"                          (2 bytes)
    let mut msg: Array<u32> = array![
        0x18426974_u32, // "\x18Bit"
        0x636f696e_u32, // "coin"
        0x20536967_u32, // " Sig"
        0x6e656420_u32, // "ned "
        0x4d657373_u32, // "Mess"
        0x6167653a_u32, // "age:"
        0x0a423078_u32, // "\n" + 0x42 (varint=66) + "0x"
    ];

    // hex64(tx_hash): 64 ASCII chars = 16 u32 words.
    // First 8 words: hex of hash.high (big-endian, MSB pair first).
    msg.append(u128_hex_word(hash.high, 0));
    msg.append(u128_hex_word(hash.high, 1));
    msg.append(u128_hex_word(hash.high, 2));
    msg.append(u128_hex_word(hash.high, 3));
    msg.append(u128_hex_word(hash.high, 4));
    msg.append(u128_hex_word(hash.high, 5));
    msg.append(u128_hex_word(hash.high, 6));
    msg.append(u128_hex_word(hash.high, 7));
    // Next 8 words: hex of hash.low.
    msg.append(u128_hex_word(hash.low, 0));
    msg.append(u128_hex_word(hash.low, 1));
    msg.append(u128_hex_word(hash.low, 2));
    msg.append(u128_hex_word(hash.low, 3));
    msg.append(u128_hex_word(hash.low, 4));
    msg.append(u128_hex_word(hash.low, 5));
    msg.append(u128_hex_word(hash.low, 6));
    msg.append(u128_hex_word(hash.low, 7));

    // First SHA256 — 92 bytes = 23 complete u32 words, no partial word.
    let [h0, h1, h2, h3, h4, h5, h6, h7] = compute_sha256_u32_array(msg, 0, 0);

    // Second SHA256 — input is the 32-byte first hash = 8 complete words.
    let [g0, g1, g2, g3, g4, g5, g6, g7] = compute_sha256_u32_array(
        array![h0, h1, h2, h3, h4, h5, h6, h7], 0, 0,
    );

    // Pack 8 u32 words → u256 (big-endian: words 0-3 → high, words 4-7 → low).
    u256 { high: u32s_to_u128(g0, g1, g2, g3), low: u32s_to_u128(g4, g5, g6, g7) }
}

// ── Signature encoding / decoding ────────────────────────────────────────────

/// Decode a secp256k1 signature from a flat Span<felt252>.
///
/// Encoding: [r.low, r.high, s.low, s.high]
///   Each limb is a u128 stored as felt252 (always fits, since u128 < felt252::MAX).
///
/// Returns None if the span doesn't have exactly 4 elements or any element
/// doesn't fit in u128.
pub fn decode_signature(sig: Span<felt252>) -> Option<(u256, u256)> {
    if sig.len() != 4 {
        return Option::None;
    }

    // try_into() on felt252 → u128 returns Option<u128> in Cairo.
    let r_low: u128 = match (*sig[0]).try_into() {
        Option::Some(v) => v,
        Option::None => { return Option::None; },
    };
    let r_high: u128 = match (*sig[1]).try_into() {
        Option::Some(v) => v,
        Option::None => { return Option::None; },
    };
    let s_low: u128 = match (*sig[2]).try_into() {
        Option::Some(v) => v,
        Option::None => { return Option::None; },
    };
    let s_high: u128 = match (*sig[3]).try_into() {
        Option::Some(v) => v,
        Option::None => { return Option::None; },
    };

    let r = u256 { low: r_low, high: r_high };
    let s = u256 { low: s_low, high: s_high };

    Option::Some((r, s))
}

/// Encode a (r, s) secp256k1 signature into the 4-felt format the account expects.
/// Use this in tests and frontend transaction building.
pub fn encode_signature(r: u256, s: u256) -> Array<felt252> {
    array![r.low.into(), r.high.into(), s.low.into(), s.high.into()]
}
