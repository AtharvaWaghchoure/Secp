/// StealthRegistry — stores ephemeral pubkey announcements for stealth payments.
///
/// Senders call `announce` after sending STRK to a stealth address.
/// Recipients scan all announcements, recompute S = sk·R for each, and check
/// whether the derived stealth address matches. If so the payment is theirs.
///
/// Ephemeral pubkey (33-byte compressed secp256k1) is stored split into:
///   - parity:   felt252  (0x02 or 0x03, the prefix byte)
///   - x_low:    felt252  (low 128 bits of x coordinate)
///   - x_high:   felt252  (high 128 bits of x coordinate)
use starknet::ContractAddress;

#[derive(Drop, Serde, starknet::Store)]
pub struct Announcement {
    pub sender: ContractAddress,
    pub stealth_address: ContractAddress,
    pub ephemeral_pubkey_x_low: felt252,
    pub ephemeral_pubkey_x_high: felt252,
    pub ephemeral_pubkey_parity: felt252,
}

#[starknet::interface]
pub trait IStealthRegistry<TContractState> {
    /// Record a stealth payment announcement on-chain.
    fn announce(
        ref self: TContractState,
        stealth_address: ContractAddress,
        ephemeral_pubkey_x_low: felt252,
        ephemeral_pubkey_x_high: felt252,
        ephemeral_pubkey_parity: felt252,
    );

    /// Retrieve a page of announcements.
    fn get_announcements(
        self: @TContractState,
        from_index: u64,
        count: u64,
    ) -> Array<Announcement>;

    /// Total number of announcements stored.
    fn announcement_count(self: @TContractState) -> u64;
}

#[starknet::contract]
pub mod StealthRegistry {
    use starknet::ContractAddress;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess,
        StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::get_caller_address;
    use super::Announcement;

    #[storage]
    struct Storage {
        announcements: Map<u64, Announcement>,
        count: u64,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Announced: Announced,
    }

    /// Emitted whenever a new stealth payment is announced.
    /// Indexed on sender and stealth_address for efficient off-chain filtering.
    #[derive(Drop, starknet::Event)]
    struct Announced {
        #[key]
        sender: ContractAddress,
        #[key]
        stealth_address: ContractAddress,
        ephemeral_pubkey_x_low: felt252,
        ephemeral_pubkey_x_high: felt252,
        ephemeral_pubkey_parity: felt252,
    }

    #[abi(embed_v0)]
    impl StealthRegistryImpl of super::IStealthRegistry<ContractState> {
        fn announce(
            ref self: ContractState,
            stealth_address: ContractAddress,
            ephemeral_pubkey_x_low: felt252,
            ephemeral_pubkey_x_high: felt252,
            ephemeral_pubkey_parity: felt252,
        ) {
            let idx = self.count.read();
            let sender = get_caller_address();
            self.announcements.write(
                idx,
                Announcement {
                    sender,
                    stealth_address,
                    ephemeral_pubkey_x_low,
                    ephemeral_pubkey_x_high,
                    ephemeral_pubkey_parity,
                },
            );
            self.count.write(idx + 1);
            self.emit(Announced {
                sender,
                stealth_address,
                ephemeral_pubkey_x_low,
                ephemeral_pubkey_x_high,
                ephemeral_pubkey_parity,
            });
        }

        fn get_announcements(
            self: @ContractState,
            from_index: u64,
            count: u64,
        ) -> Array<Announcement> {
            let total = self.count.read();
            let mut result: Array<Announcement> = array![];
            let end = if from_index + count < total {
                from_index + count
            } else {
                total
            };
            let mut i = from_index;
            loop {
                if i >= end {
                    break;
                }
                result.append(self.announcements.read(i));
                i += 1;
            };
            result
        }

        fn announcement_count(self: @ContractState) -> u64 {
            self.count.read()
        }
    }
}
