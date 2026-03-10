use snforge_std::{
    declare, ContractClassTrait, DeclareResultTrait, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;
use starknet::secp256k1::Secp256k1Point;
use starknet::secp256_trait::{Secp256Trait, is_valid_signature};
use starknet::SyscallResultTrait;

use bitcoin_starknet_account::account::{
    IBitcoinAccountDispatcher, IBitcoinAccountDispatcherTrait, VALIDATED,
};
use bitcoin_starknet_account::utils::{encode_signature, bitcoin_message_hash};

// ─── Test vectors ─────────────────────────────────────────────────────────────
//
// Private key = 1  →  public key = secp256k1 generator G.
// MSG_HASH = felt252(0x01) — the raw Starknet tx hash passed to __validate__.
//
// The contract applies the Bitcoin message prefix before verifying:
//   bitcoin_message_hash(0x01)
//     = SHA256(SHA256("\x18Bitcoin Signed Message:\n\x42" + "0x" + "00"*62 + "01"))
//     = 0x0ff7f9644c0d619266b77b26b4a9b5a0d877d5290fc528781281f4ff80ef46ac
//
// SIG_R / SIG_S are the RFC6979 secp256k1 signature over that 32-byte hash
// with private key = 1. Computed with @noble/curves v2.0.1.

// Public key: secp256k1 generator G (well-known constant, verifiable).
const G_X: u256 = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
const G_Y: u256 = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;

// Starknet tx hash passed to is_valid_signature / __validate__.
const MSG_HASH: felt252 = 0x01;

// Signature over bitcoin_message_hash(0x01) with private key = 1.
// Computed with @noble/curves v2.0.1 sign(hash, privKey, { prehash: false }).
const SIG_R: u256 = 0x8fb12a76acff69cd1a4ff5e4b8cefc9e4627cc60a7df7b13a24326e90ece335e;
const SIG_S: u256 = 0x11d4b58504be2351a8af4c24cfa100fd522119827f115591209009e39522fb1c;

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn deploy_bitcoin_account(pk_x: u256, pk_y: u256) -> (ContractAddress, IBitcoinAccountDispatcher) {
    let contract = declare("BitcoinAccount").unwrap().contract_class();

    // Constructor calldata: u256 is serialized as [low: felt252, high: felt252]
    let mut calldata: Array<felt252> = array![];
    calldata.append(pk_x.low.into());
    calldata.append(pk_x.high.into());
    calldata.append(pk_y.low.into());
    calldata.append(pk_y.high.into());

    let (contract_address, _) = contract.deploy(@calldata).unwrap();
    (contract_address, IBitcoinAccountDispatcher { contract_address })
}

// ─── bitcoin_message_hash unit test ───────────────────────────────────────────

/// Verify that Cairo's bitcoin_message_hash(0x01) matches the JS reference:
///   SHA256(SHA256("\x18Bitcoin Signed Message:\n\x42" + "0x" + "00"*62 + "01"))
///   = 0x0ff7f9644c0d619266b77b26b4a9b5a0d877d5290fc528781281f4ff80ef46ac
#[test]
fn test_bitcoin_message_hash_known_vector() {
    let expected: u256 = 0x0ff7f9644c0d619266b77b26b4a9b5a0d877d5290fc528781281f4ff80ef46ac;
    let result = bitcoin_message_hash(0x01_felt252);
    assert(result == expected, 'bitcoin_message_hash mismatch');
}

/// Verify bitcoin_message_hash for the exact DEMO_TX_HASH used in SignDemo.tsx.
///
/// DEMO_TX_HASH = 0x06a6e0f52ece7a3e63c7e9f29f81e4b4b6f5b4c3d2e1f0a9b8c7d6e5f4a3b2c1
///
/// Expected value computed by the JS bitcoinMessageHash() function in bitcoin.ts:
///   SHA256(SHA256("\x18Bitcoin Signed Message:\n\x42" +
///     "0x06a6e0f52ece7a3e63c7e9f29f81e4b4b6f5b4c3d2e1f0a9b8c7d6e5f4a3b2c1"))
///   = 0x4c75ecf0f5ee3357a0f5626f894be09b5c3dc1a33697d89d64cb495f24a8a6fa
///
/// If this test fails, the hash computation diverges between Cairo and JS and
/// that is why is_valid_signature returns 0 on-chain.
#[test]
fn test_bitcoin_message_hash_demo_tx_hash() {
    let tx_hash: felt252 = 0x06a6e0f52ece7a3e63c7e9f29f81e4b4b6f5b4c3d2e1f0a9b8c7d6e5f4a3b2c1;
    let expected: u256 = 0x4c75ecf0f5ee3357a0f5626f894be09b5c3dc1a33697d89d64cb495f24a8a6fa;
    let result = bitcoin_message_hash(tx_hash);
    assert(result == expected, 'bmh mismatch for demo tx hash');
}

/// Directly verify that the @noble/curves signature for bitcoin_message_hash(0x01)
/// is accepted by Cairo's raw secp256k1 syscall (bypassing the contract interface).
#[test]
fn test_raw_secp256k1_verify_bitcoin_hash() {
    let hash: u256 = 0x0ff7f9644c0d619266b77b26b4a9b5a0d877d5290fc528781281f4ff80ef46ac;
    let r: u256 = 0x8fb12a76acff69cd1a4ff5e4b8cefc9e4627cc60a7df7b13a24326e90ece335e;
    let s: u256 = 0x11d4b58504be2351a8af4c24cfa100fd522119827f115591209009e39522fb1c;

    let pubkey: Secp256k1Point = Secp256Trait::<Secp256k1Point>::secp256_ec_new_syscall(G_X, G_Y)
        .unwrap_syscall()
        .unwrap();

    let valid = is_valid_signature::<Secp256k1Point>(hash, r, s, pubkey);
    assert(valid, 'raw secp256k1 verify failed');
}

// ─── Deployment tests ─────────────────────────────────────────────────────────

#[test]
fn test_deploy_stores_public_key() {
    let (_addr, dispatcher) = deploy_bitcoin_account(G_X, G_Y);
    let (stored_x, stored_y) = dispatcher.get_public_key();
    assert(stored_x == G_X, 'Wrong stored x');
    assert(stored_y == G_Y, 'Wrong stored y');
}

/// The secp256k1 syscall panics at VM level for off-curve points.
#[test]
#[should_panic]
fn test_deploy_with_invalid_point_panics() {
    deploy_bitcoin_account(1_u256, 1_u256); // (1, 1) is not on secp256k1
}

// ─── Signature validation tests ───────────────────────────────────────────────

/// End-to-end: a real secp256k1 signature produced by a Bitcoin-compatible
/// signer (k256 / RFC 6979) must be accepted by the Cairo contract.
///
/// This is the core proof-of-concept: the same key that controls a Bitcoin
/// wallet can now authorize a Starknet transaction.
#[test]
fn test_e2e_real_bitcoin_signature_accepted() {
    let (_addr, dispatcher) = deploy_bitcoin_account(G_X, G_Y);

    // Encode (r, s) into the 4-felt format the contract expects.
    let sig = encode_signature(SIG_R, SIG_S);

    // is_valid_signature must return VALIDATED ('VALID') for the matching hash.
    let result = dispatcher.is_valid_signature(MSG_HASH, sig);
    assert(result == VALIDATED, 'Real sig must return VALIDATED');
}

/// The same signature over a *different* hash must be rejected.
#[test]
fn test_e2e_wrong_hash_rejected() {
    let (_addr, dispatcher) = deploy_bitcoin_account(G_X, G_Y);
    let sig = encode_signature(SIG_R, SIG_S);

    let different_hash: felt252 = 0x02; // signed hash was 0x01
    let result = dispatcher.is_valid_signature(different_hash, sig);
    assert(result == 0, 'Wrong hash must return 0');
}

/// A signature with zeroed (r, s) is always invalid.
#[test]
fn test_e2e_zero_signature_rejected() {
    let (_addr, dispatcher) = deploy_bitcoin_account(G_X, G_Y);
    let bad_sig: Array<felt252> = array![0, 0, 0, 0];
    let result = dispatcher.is_valid_signature(MSG_HASH, bad_sig);
    assert(result == 0, 'Zero sig must return 0');
}

/// Signature array with wrong number of felts returns 0 without panicking.
#[test]
fn test_signature_wrong_length_returns_zero() {
    let (_addr, dispatcher) = deploy_bitcoin_account(G_X, G_Y);
    let bad_sig: Array<felt252> = array![1, 2]; // needs 4 felts
    let result = dispatcher.is_valid_signature(MSG_HASH, bad_sig);
    assert(result == 0, 'Wrong len must return 0');
}

// ─── Key rotation tests ───────────────────────────────────────────────────────

/// set_public_key called from an external address must be rejected.
#[test]
#[should_panic(expected: ('Caller must be account',))]
fn test_set_public_key_from_external_panics() {
    let (addr, dispatcher) = deploy_bitcoin_account(G_X, G_Y);
    let random_caller: ContractAddress = 0x1234.try_into().unwrap();
    start_cheat_caller_address(addr, random_caller);
    dispatcher.set_public_key(G_X, G_Y);
    stop_cheat_caller_address(addr);
}

/// set_public_key called by the account itself (via __execute__) must succeed.
#[test]
fn test_set_public_key_from_self_succeeds() {
    let (addr, dispatcher) = deploy_bitcoin_account(G_X, G_Y);

    // Simulate __execute__ calling set_public_key by spoofing caller = contract.
    start_cheat_caller_address(addr, addr);
    dispatcher.set_public_key(G_X, G_Y);
    stop_cheat_caller_address(addr);

    let (x, y) = dispatcher.get_public_key();
    assert(x == G_X, 'x unchanged after rotation');
    assert(y == G_Y, 'y unchanged after rotation');
}
