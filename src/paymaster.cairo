/// Secp256k1Paymaster — an open relay contract for BitcoinAccount meta-transactions.
///
/// Any relayer can call relay() on behalf of a user, paying the gas themselves.
/// The user's BitcoinAccount verifies the secp256k1 signature inside execute_from_outside.
///
/// This enables fully gasless UX: the user never needs to hold STRK.
/// They sign a typed intent with their Bitcoin key; the relayer submits it.
use starknet::account::Call;

// ── Interface: dispatch target ─────────────────────────────────────────────────

#[starknet::interface]
pub trait IExecuteFromOutside<TState> {
    fn execute_from_outside(
        ref self: TState,
        calls: Array<Call>,
        signature: Array<felt252>,
        nonce: felt252,
    ) -> Array<Span<felt252>>;
}

// ── Paymaster interface ────────────────────────────────────────────────────────

#[starknet::interface]
pub trait ISecp256k1Paymaster<TState> {
    /// Relay a signed intent to the user's BitcoinAccount.
    /// Anyone can call this — the user's secp256k1 signature is verified inside
    /// the target account's execute_from_outside.
    fn relay(
        ref self: TState,
        user_address: starknet::ContractAddress,
        calls: Array<Call>,
        signature: Array<felt252>,
        nonce: felt252,
    );

    fn get_owner(self: @TState) -> starknet::ContractAddress;
}

// ── Contract ───────────────────────────────────────────────────────────────────

#[starknet::contract]
pub mod Secp256k1Paymaster {
    use starknet::{ContractAddress};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::account::Call;
    use super::{IExecuteFromOutsideDispatcher, IExecuteFromOutsideDispatcherTrait};

    #[storage]
    struct Storage {
        owner: ContractAddress,
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        Relayed: Relayed,
    }

    /// Emitted every time a meta-transaction is successfully relayed.
    #[derive(Drop, starknet::Event)]
    pub struct Relayed {
        /// The BitcoinAccount whose execute_from_outside was called.
        #[key]
        pub user: ContractAddress,
        /// The nonce that was consumed (prevents replay).
        pub nonce: felt252,
    }

    // ── Constructor ────────────────────────────────────────────────────────────

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.owner.write(owner);
    }

    // ── ISecp256k1Paymaster ────────────────────────────────────────────────────

    #[abi(embed_v0)]
    impl Secp256k1PaymasterImpl of super::ISecp256k1Paymaster<ContractState> {
        fn relay(
            ref self: ContractState,
            user_address: ContractAddress,
            calls: Array<Call>,
            signature: Array<felt252>,
            nonce: felt252,
        ) {
            // Dispatch to the user's BitcoinAccount.
            // Signature verification (secp256k1 + bitcoin_message_hash) happens there.
            IExecuteFromOutsideDispatcher { contract_address: user_address }
                .execute_from_outside(calls, signature, nonce);

            self.emit(Relayed { user: user_address, nonce });
        }

        fn get_owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }
    }
}
