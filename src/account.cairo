/// BitcoinAccount — a Starknet account contract controlled by a Bitcoin (secp256k1) key.
///
/// How it works:
///   - The account stores the owner's Bitcoin public key (x, y on secp256k1).
///   - __validate__ checks that the Starknet transaction hash was signed with that key.
///   - The signature format in the transaction is [r.low, r.high, s.low, s.high] (4 felts).
///   - Any Bitcoin wallet that can sign arbitrary messages (e.g. Xverse) can control this account.
use starknet::account::Call;

// Returned by __validate__ and __validate_deploy__ on success (selector of "VALID").
pub const VALIDATED: felt252 = 'VALID';

// ──────────────────────────────────────────────────────────────────────────────
// SRC-6: Starknet standard account interface
// ──────────────────────────────────────────────────────────────────────────────

#[starknet::interface]
pub trait ISRC6<TState> {
    fn __execute__(ref self: TState, calls: Array<Call>) -> Array<Span<felt252>>;
    fn __validate__(self: @TState, calls: Array<Call>) -> felt252;
}

// ──────────────────────────────────────────────────────────────────────────────
// External interface for this account
// ──────────────────────────────────────────────────────────────────────────────

#[starknet::interface]
pub trait IBitcoinAccount<TState> {
    /// Returns the stored Bitcoin public key as (x, y).
    fn get_public_key(self: @TState) -> (u256, u256);

    /// Rotate the key. Can only be called by the account itself (via __execute__).
    fn set_public_key(ref self: TState, new_x: u256, new_y: u256);

    /// Execute calls on behalf of the account without requiring a full Starknet transaction
    /// from the account itself. The caller (a relayer / paymaster) pays the gas.
    ///
    /// The user signs hash_outside_execution(nonce, calls) with their Bitcoin key,
    /// and any relayer can submit this signed intent on-chain.
    /// Each nonce can only be used once (replay protection).
    fn execute_from_outside(
        ref self: TState,
        calls: Array<Call>,
        signature: Array<felt252>,
        nonce: felt252,
    ) -> Array<Span<felt252>>;

    /// Off-chain view: verify whether a (hash, signature) pair is valid for this account.
    /// Returns VALIDATED on success, 0 on failure.
    fn is_valid_signature(self: @TState, hash: felt252, signature: Array<felt252>) -> felt252;
}

// ──────────────────────────────────────────────────────────────────────────────
// Contract
// ──────────────────────────────────────────────────────────────────────────────

#[starknet::contract(account)]
pub mod BitcoinAccount {
    use starknet::account::Call;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess, Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{get_caller_address, get_contract_address, get_tx_info};
    use core::poseidon::poseidon_hash_span;
    use starknet::secp256k1::Secp256k1Point;
    use starknet::secp256_trait::{Secp256Trait, is_valid_signature};
    use starknet::SyscallResultTrait;
    use core::num::traits::Zero;

    use super::{VALIDATED, ISRC6, IBitcoinAccount};
    use crate::utils::{decode_signature, bitcoin_message_hash};

    #[storage]
    struct Storage {
        /// Bitcoin public key x-coordinate (secp256k1).
        public_key_x: u256,
        /// Bitcoin public key y-coordinate (secp256k1).
        public_key_y: u256,
        /// Tracks used nonces for execute_from_outside (replay protection).
        used_nonces: Map<felt252, bool>,
    }

    // ── Events ────────────────────────────────────────────────────────────────

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        PublicKeyChanged: PublicKeyChanged,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PublicKeyChanged {
        pub old_x: u256,
        pub new_x: u256,
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    #[constructor]
    fn constructor(ref self: ContractState, public_key_x: u256, public_key_y: u256) {
        // Verify the point is actually on secp256k1 before storing.
        // The syscall returns Err for off-curve points, so we handle both Err and Ok(None).
        let valid = match Secp256Trait::<Secp256k1Point>::secp256_ec_new_syscall(
            public_key_x, public_key_y,
        ) {
            Result::Ok(maybe) => maybe.is_some(),
            Result::Err(_) => false,
        };
        assert(valid, 'Invalid secp256k1 point');

        self.public_key_x.write(public_key_x);
        self.public_key_y.write(public_key_y);
    }

    // ── SRC-6: __execute__ and __validate__ ──────────────────────────────────

    #[abi(embed_v0)]
    impl SRC6Impl of ISRC6<ContractState> {
        /// Execute a batch of calls. Only callable by the Starknet protocol (caller == 0).
        fn __execute__(ref self: ContractState, calls: Array<Call>) -> Array<Span<felt252>> {
            let caller = get_caller_address();
            assert(caller.is_zero(), 'Only protocol can call execute');
            _execute_calls(calls)
        }

        /// Validate an InvokeTransaction by checking the secp256k1 signature.
        fn __validate__(self: @ContractState, calls: Array<Call>) -> felt252 {
            self._validate_tx()
        }
    }

    // ── Deploy validation (standalone entry point) ────────────────────────────

    /// Validate a DeployAccountTransaction.
    /// Same secp256k1 check — proves the deployer owns the Bitcoin key.
    #[external(v0)]
    fn __validate_deploy__(
        self: @ContractState,
        class_hash: felt252,
        contract_address_salt: felt252,
        public_key_x: u256,
        public_key_y: u256,
    ) -> felt252 {
        self._validate_tx()
    }

    // ── Declare validation (standalone entry point) ───────────────────────────

    /// Validate a DeclareTransaction (registering a new contract class).
    /// Required for the account to upgrade itself or deploy other contracts.
    /// The class_hash of what's being declared is available here if you want
    /// to restrict which classes this account is allowed to declare.
    #[external(v0)]
    fn __validate_declare__(self: @ContractState, class_hash: felt252) -> felt252 {
        self._validate_tx()
    }

    // ── IBitcoinAccount ───────────────────────────────────────────────────────

    #[abi(embed_v0)]
    impl BitcoinAccountImpl of IBitcoinAccount<ContractState> {
        fn get_public_key(self: @ContractState) -> (u256, u256) {
            (self.public_key_x.read(), self.public_key_y.read())
        }

        fn set_public_key(ref self: ContractState, new_x: u256, new_y: u256) {
            // Must go through __execute__ (signed by the account itself).
            assert(get_caller_address() == get_contract_address(), 'Caller must be account');

            let valid = match Secp256Trait::<Secp256k1Point>::secp256_ec_new_syscall(new_x, new_y) {
                Result::Ok(maybe) => maybe.is_some(),
                Result::Err(_) => false,
            };
            assert(valid, 'Invalid secp256k1 point');

            let old_x = self.public_key_x.read();
            self.public_key_x.write(new_x);
            self.public_key_y.write(new_y);
            self.emit(PublicKeyChanged { old_x, new_x });
        }

        fn execute_from_outside(
            ref self: ContractState,
            calls: Array<Call>,
            signature: Array<felt252>,
            nonce: felt252,
        ) -> Array<Span<felt252>> {
            // Replay protection: each nonce can only be used once.
            assert(!self.used_nonces.read(nonce), 'Nonce already used');
            self.used_nonces.write(nonce, true);

            // Compute the canonical hash of this intent and apply the Bitcoin message prefix.
            let calls_hash = hash_outside_execution(nonce, calls.span());
            let msg_hash = bitcoin_message_hash(calls_hash);
            assert(self._check_signature(msg_hash, signature.span()), 'Invalid outside sig');

            _execute_calls(calls)
        }

        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            let msg_hash = bitcoin_message_hash(hash);
            if self._check_signature(msg_hash, signature.span()) {
                VALIDATED
            } else {
                0
            }
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// Pull tx hash + signature from execution context and verify.
        ///
        /// The signature is expected to be produced by a Bitcoin wallet (e.g. Xverse)
        /// via signMessage(ECDSA), which internally applies the Bitcoin message prefix:
        ///   SHA256(SHA256("\x18Bitcoin Signed Message:\n" + varint(66) + "0x" + hex64(tx_hash)))
        /// We apply the same transform here before verifying.
        fn _validate_tx(self: @ContractState) -> felt252 {
            let tx_info = get_tx_info().unbox();
            let tx_hash = tx_info.transaction_hash;
            let signature = tx_info.signature;

            let msg_hash = bitcoin_message_hash(tx_hash);
            assert(self._check_signature(msg_hash, signature), 'Invalid signature');
            VALIDATED
        }

        /// Core secp256k1 ECDSA verification.
        ///
        /// Signature encoding — 4 felts:
        ///   [r.low (u128 as felt252), r.high (u128 as felt252),
        ///    s.low (u128 as felt252), s.high (u128 as felt252)]
        fn _check_signature(self: @ContractState, hash: u256, sig: Span<felt252>) -> bool {
            let (r, s) = match decode_signature(sig) {
                Option::Some(v) => v,
                Option::None => { return false; },
            };

            let pk_x = self.public_key_x.read();
            let pk_y = self.public_key_y.read();

            let public_key = match Secp256Trait::<Secp256k1Point>::secp256_ec_new_syscall(
                pk_x, pk_y,
            ) {
                Result::Ok(Option::Some(p)) => p,
                _ => { return false; },
            };

            is_valid_signature::<Secp256k1Point>(hash, r, s, public_key)
        }
    }

    // ── Outside execution hash ────────────────────────────────────────────────

    /// Compute the canonical hash for execute_from_outside.
    ///
    /// Hash structure (Poseidon over felt252 array):
    ///   ['secp_outside_v1', nonce, calls.len, call0.to, call0.selector, hash(call0.calldata), ...]
    ///
    /// This must match hashOutsideExecution() in frontend/lib/starknet.ts.
    fn hash_outside_execution(nonce: felt252, calls: Span<Call>) -> felt252 {
        let mut data: Array<felt252> = array![
            'secp_outside_v1', // domain separator
            nonce,
            calls.len().into(),
        ];

        let mut i: usize = 0;
        loop {
            if i >= calls.len() {
                break;
            }
            let call = calls.at(i);
            let to_felt: felt252 = (*call.to).into();
            data.append(to_felt);
            data.append(*call.selector);
            data.append(poseidon_hash_span(*call.calldata));
            i += 1;
        };

        poseidon_hash_span(data.span())
    }

    // ── Call execution ────────────────────────────────────────────────────────

    fn _execute_calls(calls: Array<Call>) -> Array<Span<felt252>> {
        let mut results: Array<Span<felt252>> = array![];
        let mut calls = calls;
        loop {
            match calls.pop_front() {
                Option::None => { break; },
                Option::Some(call) => {
                    let result = starknet::syscalls::call_contract_syscall(
                        call.to, call.selector, call.calldata,
                    )
                        .unwrap_syscall();
                    results.append(result);
                },
            }
        };
        results
    }
}
