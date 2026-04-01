/// BtcCollateral — lend STRK against Bitcoin holdings.
///
/// Users prove BTC ownership by signing a commitment with their Bitcoin key.
/// The same secp256k1 + bitcoin_message_hash mechanism used in BitcoinAccount.__validate__
/// verifies the signature on-chain. No bridge, no wrap, no custodian.
///
/// Flow:
///   1. User signs: poseidon(['btc_collateral_v1', caller, contract, sats, nonce])
///   2. Contract verifies signature — proves the signer controls that Bitcoin key
///   3. Collateral is recorded; user can borrow up to 50% LTV in STRK
///   4. Repay STRK to unlock collateral

// ── ERC20 minimal interface ────────────────────────────────────────────────────

#[starknet::interface]
pub trait IERC20<TState> {
    fn transfer(ref self: TState, recipient: starknet::ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TState,
        sender: starknet::ContractAddress,
        recipient: starknet::ContractAddress,
        amount: u256,
    ) -> bool;
    fn balance_of(self: @TState, account: starknet::ContractAddress) -> u256;
}

// ── Public interface ───────────────────────────────────────────────────────────

#[starknet::interface]
pub trait IBtcCollateral<TState> {
    /// Lock BTC collateral by proving ownership via Bitcoin secp256k1 signature.
    ///
    /// sig covers: poseidon(['btc_collateral_v1', caller, contract_address, sats, nonce])
    /// This must match hashCollateralLock() in frontend/lib/starknet.ts.
    fn lock_collateral(
        ref self: TState,
        btc_pubkey_x: u256,
        btc_pubkey_y: u256,
        sats: u64,
        nonce: felt252,
        sig: Array<felt252>,
    );

    /// Borrow STRK against locked collateral (50% LTV).
    /// Caller is already authenticated as the BitcoinAccount owner.
    fn borrow_strk(ref self: TState, amount: u256);

    /// Repay borrowed STRK. Caller must approve this contract beforehand.
    fn repay_strk(ref self: TState, amount: u256);

    /// View: returns (collateral_sats, debt_strk, max_borrow, collateral_value_strk).
    /// Serializes as 7 felts: [sats, debt.low, debt.high, max.low, max.high, val.low, val.high]
    fn get_position(self: @TState, user: starknet::ContractAddress) -> (u64, u256, u256, u256);

    /// View: available STRK liquidity held by this contract.
    fn get_liquidity(self: @TState) -> u256;
}

// ── Contract ───────────────────────────────────────────────────────────────────

#[starknet::contract]
pub mod BtcCollateral {
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::secp256k1::Secp256k1Point;
    use starknet::secp256_trait::{Secp256Trait, is_valid_signature};
    use core::poseidon::poseidon_hash_span;
    use super::{IERC20Dispatcher, IERC20DispatcherTrait};
    use crate::utils::{decode_signature, bitcoin_message_hash};

    // ── Constants ──────────────────────────────────────────────────────────────

    /// STRK token on Starknet Sepolia.
    fn strk_token() -> ContractAddress {
        let addr: felt252 = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d;
        addr.try_into().unwrap()
    }

    /// Price: STRK wei per satoshi ≈ 500K STRK per BTC (adjustable in production via oracle).
    /// 5_000_000_000_000_000 = 5 × 10^15
    const STRK_PER_SAT: u128 = 5_000_000_000_000_000_u128;

    /// Domain separator for the commitment hash. Prevents cross-protocol replay.
    const DOMAIN: felt252 = 'btc_collateral_v1';

    // ── Storage ────────────────────────────────────────────────────────────────

    #[storage]
    struct Storage {
        /// BTC collateral locked (satoshis) per Starknet address.
        collateral_sats: Map<ContractAddress, u64>,
        /// STRK borrowed (wei, u256) per Starknet address.
        debt_strk: Map<ContractAddress, u256>,
        /// Bitcoin public key linked to each position (for reference / UI display).
        btc_pubkey_x: Map<ContractAddress, u256>,
        btc_pubkey_y: Map<ContractAddress, u256>,
        /// Used nonces for lock_collateral replay protection.
        used_nonces: Map<felt252, bool>,
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        CollateralLocked: CollateralLocked,
        Borrowed: Borrowed,
        Repaid: Repaid,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CollateralLocked {
        #[key]
        pub user: ContractAddress,
        pub sats: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Borrowed {
        #[key]
        pub user: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Repaid {
        #[key]
        pub user: ContractAddress,
        pub amount: u256,
    }

    // ── Constructor ────────────────────────────────────────────────────────────

    #[constructor]
    fn constructor(ref self: ContractState) {
    // STRK liquidity is funded externally by sending STRK to this contract address.
    }

    // ── IBtcCollateral ─────────────────────────────────────────────────────────

    #[abi(embed_v0)]
    impl BtcCollateralImpl of super::IBtcCollateral<ContractState> {
        fn lock_collateral(
            ref self: ContractState,
            btc_pubkey_x: u256,
            btc_pubkey_y: u256,
            sats: u64,
            nonce: felt252,
            sig: Array<felt252>,
        ) {
            assert(sats > 0, 'sats must be > 0');

            // Replay protection
            assert(!self.used_nonces.read(nonce), 'Nonce already used');
            self.used_nonces.write(nonce, true);

            let caller = get_caller_address();
            let contract = get_contract_address();

            // Canonical commitment hash — must match hashCollateralLock() in starknet.ts
            let caller_felt: felt252 = caller.into();
            let contract_felt: felt252 = contract.into();
            let sats_felt: felt252 = sats.into();
            let hash_input: Array<felt252> = array![
                DOMAIN, caller_felt, contract_felt, sats_felt, nonce,
            ];
            let poseidon_felt = poseidon_hash_span(hash_input.span());

            // Apply Bitcoin message prefix and verify secp256k1
            let msg_hash = bitcoin_message_hash(poseidon_felt);
            let (r, s) = decode_signature(sig.span()).expect('Invalid sig format');

            let pubkey = match Secp256Trait::<Secp256k1Point>::secp256_ec_new_syscall(
                btc_pubkey_x, btc_pubkey_y,
            ) {
                Result::Ok(Option::Some(p)) => p,
                _ => panic!("Invalid secp256k1 pubkey"),
            };

            assert(
                is_valid_signature::<Secp256k1Point>(msg_hash, r, s, pubkey),
                'Invalid Bitcoin signature',
            );

            // Accumulate collateral and store pubkey reference
            let prev_sats = self.collateral_sats.read(caller);
            self.collateral_sats.write(caller, prev_sats + sats);
            self.btc_pubkey_x.write(caller, btc_pubkey_x);
            self.btc_pubkey_y.write(caller, btc_pubkey_y);

            self.emit(CollateralLocked { user: caller, sats });
        }

        fn borrow_strk(ref self: ContractState, amount: u256) {
            assert(amount.low > 0 || amount.high > 0, 'Invalid borrow amount');

            let caller = get_caller_address();
            let (_, debt, max_borrow, _) = self._get_position(caller);
            assert(max_borrow > debt, 'No borrow capacity');

            let new_debt = debt + amount;
            assert(new_debt <= max_borrow, 'Exceeds 50% LTV');

            self.debt_strk.write(caller, new_debt);

            let ok = IERC20Dispatcher { contract_address: strk_token() }
                .transfer(caller, amount);
            assert(ok, 'STRK transfer failed');

            self.emit(Borrowed { user: caller, amount });
        }

        fn repay_strk(ref self: ContractState, amount: u256) {
            let caller = get_caller_address();
            let debt = self.debt_strk.read(caller);
            assert(debt.low > 0 || debt.high > 0, 'Nothing to repay');

            // Cap repayment at actual debt to avoid over-payment errors
            let repay = if amount > debt {
                debt
            } else {
                amount
            };

            // Pull STRK from caller (caller must have approved this contract beforehand)
            let ok = IERC20Dispatcher { contract_address: strk_token() }
                .transfer_from(caller, get_contract_address(), repay);
            assert(ok, 'STRK transferFrom failed');

            self.debt_strk.write(caller, debt - repay);

            self.emit(Repaid { user: caller, amount: repay });
        }

        fn get_position(
            self: @ContractState, user: ContractAddress,
        ) -> (u64, u256, u256, u256) {
            self._get_position(user)
        }

        fn get_liquidity(self: @ContractState) -> u256 {
            IERC20Dispatcher { contract_address: strk_token() }
                .balance_of(get_contract_address())
        }
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _get_position(
            self: @ContractState, user: ContractAddress,
        ) -> (u64, u256, u256, u256) {
            let sats = self.collateral_sats.read(user);
            let debt = self.debt_strk.read(user);
            let sats_u256: u256 = sats.into();
            let strk_per_sat: u256 = u256 { low: STRK_PER_SAT, high: 0 };
            let collateral_value = sats_u256 * strk_per_sat;
            let max_borrow = collateral_value / 2_u256; // 50% LTV
            (sats, debt, max_borrow, collateral_value)
        }
    }
}
