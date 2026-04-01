# Secp

> Your Bitcoin key. Your Starknet account. Your privacy.

A Starknet smart account controlled entirely by a Bitcoin secp256k1 key — with stealth addresses, gasless meta-transactions, BTC-collateral lending, a fixed-denomination privacy pool, and WalletConnect SDK support.

No new seed phrases. No bridges. No custodians.

Built for the **Re{define} Hackathon 2026** — Privacy & Bitcoin on Starknet track.

**[Demo & Pitch Playlist](https://www.youtube.com/playlist?list=PLCiZws7IzuY8_tCn816EsQMISRCwKI34R)**

---

## What it does

Every Bitcoin wallet holds a secp256k1 keypair. This project makes that keypair the sole authority over a Starknet smart account. Connect Xverse, get a Starknet address, deploy it, and start using Starknet DeFi — all signed with the key you already own.

### Features

**1. Bitcoin Account** — Core secp256k1 smart account. Any transaction on Starknet is authorized by signing with your Bitcoin key through Xverse. No seed phrase conversion. No bridge.

**2. Gasless Paymaster** — `execute_from_outside` meta-transaction pattern. The user signs an intent with their Bitcoin key; a relayer submits it on-chain and pays the gas. Users need zero STRK to transact.

**3. Stealth Addresses** — Send STRK to someone privately via ECDH. The payment goes to a fresh one-time address never seen on-chain before. The recipient scans a public registry to find payments addressed to them and sweeps with a derived key — no Xverse popup.

**4. BTC Collateral Lending** — Lock self-attested Bitcoin collateral by signing a commitment with your Bitcoin key. Borrow up to 50% LTV in STRK. Repay with a single multicall signature. No BTC bridge, no wrapped asset.

**5. Privacy Pool** — Fixed-denomination (1 STRK) shielded pool. Deposit generates a one-time note keypair; the commitment is stored on-chain. Withdraw to any address with a gasless relay — the note private key signs the withdrawal, completely unlinking depositor from recipient.

**6. WalletConnect SDK** — Expose the Bitcoin-keyed account to any Starknet dApp via WalletConnect v2. The dApp sees a normal Starknet wallet; every transaction is routed through Xverse and authorized by the Bitcoin key.

---

## Demo flow

```
1. Connect Xverse (Bitcoin wallet)
      │
      ▼
2. Account Info
   ├─ Derives your Starknet address from Bitcoin pubkey (deterministic)
   ├─ Auto-funds with STRK if balance is too low
   └─ Deploy — Xverse signs; __validate_deploy__ verifies on-chain
      │
      ▼
3. Six tabs:

   ┌────────────────────────────────────────────────────────────────────────────────┐
   │  DeFi Swap  │  Stealth Send  │  Claim  │  BTC Loan  │  Pool  │  WalletConnect  │
   └────────────────────────────────────────────────────────────────────────────────┘

   DeFi Swap
   ├─ Get a STRK→ETH quote from AVNU (Ekubo / JediSwap routes)
   ├─ Standard: Xverse signs the swap tx
   └─ Gasless toggle: relayer pays gas, user signs intent only — zero STRK needed ✓

   Stealth Send
   ├─ Enter recipient's Starknet address
   ├─ Derive a one-time address via ECDH (never on-chain before)
   ├─ Xverse signs the STRK transfer
   └─ Xverse signs a second tx publishing the ephemeral key to StealthRegistry ✓

   Claim
   ├─ Scan StealthRegistry on-chain for payments addressed to you
   ├─ One click: deploy stealth account + sweep STRK to your main address
   └─ Signed with the derived sk_stealth — no Xverse popup needed ✓

   BTC Loan
   ├─ Enter BTC amount → preview collateral value + max borrow (50% LTV)
   ├─ Xverse signs the secp256k1 collateral commitment
   ├─ Borrow STRK, repay with approve+repay multicall (single signature)
   └─ LTV health bar in Position view ✓

   Pool
   ├─ Deposit: generate note keypair → Xverse signs approve+deposit multicall
   ├─ Note saved to localStorage — commitment registered on-chain
   ├─ Withdraw: select note → enter any recipient → sign with note key (no Xverse)
   └─ Relayer pays gas — recipient receives 1 STRK with zero setup ✓

   WalletConnect
   ├─ Paste a wc:… URI from any Starknet dApp
   ├─ Approve the session — dApp sees a standard Starknet wallet
   ├─ dApp sends a transaction → request card appears → Approve & Sign
   └─ Xverse signs → tx executes via BitcoinAccount on-chain ✓
```

---

## Architecture

### Smart contracts

**`BitcoinAccount`** (`src/account.cairo`)

A SRC-6 compliant Starknet account storing a secp256k1 public key `(x, y)`. Verifies Bitcoin-signed messages in `__validate__` and `__validate_deploy__`. Also implements `execute_from_outside` for gasless meta-transactions with nonce replay protection.

```
__validate__ / __validate_deploy__:
  1. tx_hash = get_tx_info().transaction_hash
  2. msg_hash = bitcoin_message_hash(tx_hash)
       = SHA256(SHA256("\x18Bitcoin Signed Message:\n" + 0x42 + "0x" + hex64(tx_hash)))
  3. secp256k1_verify(msg_hash, r, s, stored_pubkey)  →  returns 'VALID'

execute_from_outside(calls, signature, nonce):
  1. intent_hash = poseidon(['secp_outside_v1', nonce, calls_len, call.to, call.selector,
                             poseidon(calldata), ...])
  2. bitcoin_message_hash(intent_hash)
  3. secp256k1_verify → execute calls → mark nonce used
```

**`Secp256k1Paymaster`** (`src/paymaster.cairo`)

Permissionless relay contract. Anyone can call `relay(user_address, calls, signature, nonce)` which forwards to `execute_from_outside` on the user's account and emits a `Relayed` event.

**`StealthRegistry`** (`src/stealth_registry.cairo`)

Append-only on-chain log of stealth payment announcements. Senders call `announce()` after sending to a stealth address; recipients scan `get_announcements()`.

**`BtcCollateral`** (`src/btc_collateral.cairo`)

Lending contract that accepts self-attested BTC collateral. Collateral is proven via `poseidon(['btc_collateral_v1', caller, contract, sats, nonce])` signed with the caller's secp256k1 key. Enforces 50% LTV. Price: 5×10¹⁵ STRK wei per satoshi.

**`PrivacyPool`** (`src/privacy_pool.cairo`)

Fixed-denomination (1 STRK) shielded pool. Commitments use poseidon domain `'pool_note_v1'`; nullifiers use `'pool_null_v1'` — separate domains prevent correlation. Withdrawal verified via `bitcoin_message_hash(poseidon(nullifier, recipient))` signed with the note's secp256k1 key.

### Signing flow

```
XverseSigner (Xverse)           RawSecp256k1Signer (stealth claim)    Note key (privacy pool)
──────────────────────          ──────────────────────────────────    ───────────────────────
starknet.js → tx_hash           starknet.js → tx_hash                 poseidon(nullifier, recipient)
normalize to 0x+64hex           normalize to 0x+64hex                 bitcoin_message_hash()
Xverse signs (adds prefix)      bitcoinMessageHashBytes() locally      secp256k1.sign() locally
→ [r.low,r.high,s.low,s.high]  → [r.low,r.high,s.low,s.high]        → [r.low,r.high,s.low,s.high]
        │                               │                                       │
        └───────────────────────────────┴───────────────────────────────────────┘
                                        ▼
                           __validate__ / withdraw() on-chain
                           bitcoin_message_hash + secp256k1_verify ✓
```

### Gasless relay flow

```
User (browser)                     /api/relay (backend)           Starknet
──────────────                     ────────────────────           ────────
1. Build calls
2. poseidon hash intent
3. Xverse signs hash    ──POST──▶  4. relayer.execute(
                                      execute_from_outside(
                                        calls, sig, nonce))  ──▶  5. verify sig
                                                                   6. run calls ✓
```

### Stealth address protocol (ECDH)

**Sender side** (`lib/stealth.ts`):
```
1. Generate ephemeral keypair (r, R = r·G)
2. Shared secret: S = r · PK_recipient
3. h = SHA256(compress(S))
4. stealth_pk = h·G + PK_recipient
5. stealth_address = deriveBitcoinAccountAddress(stealth_pk)
6. Send STRK to stealth_address
7. Publish R to StealthRegistry
```

**Recipient side** (`lib/stealthClaim.ts`):
```
For each announcement (R, stealth_address) from the registry:
  S_check = sk · R
  h = SHA256(compress(S_check))
  expected = deriveBitcoinAccountAddress(h·G + PK_self)
  if expected == stealth_address:
    sk_stealth = (sk + h) mod n  ← claim private key
    → deploy + sweep
```

---

## Repository structure

```
bitcoin_starknet_account/
├── src/
│   ├── lib.cairo                # Module declarations
│   ├── account.cairo            # BitcoinAccount — SRC-6 + execute_from_outside
│   ├── utils.cairo              # bitcoin_message_hash, encode/decode_signature
│   ├── stealth_registry.cairo   # On-chain ephemeral key announcement log
│   ├── paymaster.cairo          # Secp256k1Paymaster — gasless relay contract
│   ├── btc_collateral.cairo     # BTC-collateral STRK lending, 50% LTV
│   └── privacy_pool.cairo       # Fixed-denomination shielded pool
├── tests/
│   └── test_contract.cairo      # Hash vectors, e2e sig accept/reject
└── frontend/
    ├── app/
    │   ├── page.tsx              # 3-step wizard: connect → account info → actions
    │   └── api/
    │       ├── fund/route.ts     # Auto-funder: sends 0.1 STRK to new accounts
    │       ├── relay/route.ts    # Gasless relay: submits execute_from_outside
    │       └── pool-withdraw/    # Gasless privacy pool withdrawal relay
    │           └── route.ts
    ├── components/
    │   ├── ConnectWallet.tsx     # Xverse connection
    │   ├── AccountInfo.tsx       # Address derivation, deploy, auto-fund
    │   ├── SignDemo.tsx          # Tab container (6 tabs)
    │   ├── SwapDemo.tsx          # STRK→ETH via AVNU + gasless toggle
    │   ├── StealthSend.tsx       # Derive stealth address + send + announce
    │   ├── StealthClaim.tsx      # Scan registry + deploy + sweep
    │   ├── BTCCollateral.tsx     # Lock / Borrow / Repay / Position tabs
    │   ├── PrivacyPool.tsx       # Deposit (generate note) + Withdraw (gasless)
    │   └── WalletConnectTab.tsx  # WC URI pair, session/request approval UI
    └── lib/
        ├── bitcoin.ts            # Xverse connect, signMessage, key decompression
        ├── starknet.ts           # XverseSigner, deploy, sendStrk, executeSwap,
        │                         # executeCalls, lockCollateral, borrowStrk,
        │                         # repayStrk, depositToPool, executeGasless, …
        ├── stealth.ts            # Sender-side ECDH: deriveStealthPayment()
        ├── stealthClaim.ts       # Recipient-side: RawSecp256k1Signer, scan, claim
        ├── avnu.ts               # AVNU DEX aggregator: getSwapQuote, buildSwap
        ├── privacyPool.ts        # Note generation, commitment/nullifier, signing
        └── walletConnect.ts      # WC session management, request handling
```

---

## Deployed contracts (Starknet Sepolia)

| Contract | Address |
|---|---|
| BitcoinAccount class | `0x746a096f8edcb0db7155fd7711f7866a0727b1de7d902f316a1892ad3a28bb9` |
| Secp256k1Paymaster | `0x07d0f833f2bbfac502255d5f1ef2277e2f57afeaee08bb0c69822861939d2a14` |
| StealthRegistry | `0x02793374add811d87ecebd2308ba2bdd9c4a608376b25d960b84bbe0d7d2d4a5` |
| BtcCollateral | `0x006a7fd9126a8ed136e2ae325b8ba78ae628d7851a0e9285d52690f7023628ce` |
| PrivacyPool | `0x04cee13dde30159a3bb5c388ce7826cfa7d87ebb86dd7f5dc109d7c899c81570` |
| RPC | `https://api.cartridge.gg/x/starknet/sepolia` |

---

## Running locally

### Prerequisites

- [Scarb](https://docs.swmansion.com/scarb/) 2.15.0
- [Starknet Foundry](https://foundry-rs.github.io/starknet-foundry/) 0.56.0
- Node.js 18+
- [Xverse](https://www.xverse.app/) browser extension (enable testnet mode)
- Free [WalletConnect project ID](https://cloud.walletconnect.com) (for WC tab)

### Cairo tests

```bash
snforge test
```

### Frontend

```bash
cd frontend
pnpm install
pnpm dev
# open http://localhost:3000
```

Create `frontend/.env.local`:

```
# Relayer account — pays gas for gasless txs and privacy pool withdrawals
FUNDER_ADDRESS=0x...
FUNDER_PRIVATE_KEY=0x...

# WalletConnect — free at https://cloud.walletconnect.com
NEXT_PUBLIC_WC_PROJECT_ID=your_project_id_here
```

Fund the funder address with STRK from the [Sepolia faucet](https://starknet-faucet.vercel.app/). Without it, users can fund themselves manually.

---

## Key design decisions

**Why the Bitcoin message prefix?**
Bitcoin wallets always apply `"\x18Bitcoin Signed Message:\n"` + length before signing. Matching this in Cairo means any standard Bitcoin wallet (Xverse, Leather, etc.) works without modification, and the signature scheme is identical to what users already trust.

**Why secp256k1 and not the Stark curve?**
Bitcoin keys live on secp256k1. Starknet natively provides a `secp256k1` ECDSA syscall (`is_valid_signature::<Secp256k1Point>`), making on-chain verification practical without ZK proofs or precompiles.

**Why normalize the tx hash to exactly 64 hex chars?**
`starknet.js` returns hashes without leading zeros (e.g. `"0x1abc"`). Cairo's `bitcoin_message_hash` encodes as `"0x" + 64 hex chars` — 66 characters, varint `0x42`. A shorter string changes the varint, producing a different hash and an invalid signature. `XverseSigner._signHash` zero-pads to 64 chars to match exactly.

**Why `execute_from_outside` instead of a paymaster protocol?**
Starknet paymasters operate at the protocol level and require the account to implement specific interfaces. `execute_from_outside` is simpler: the user signs an intent, the relayer calls any funded account to submit it. No protocol changes, no allowlist, permissionless.

**Why fixed denomination in the privacy pool?**
Variable amounts leak information about which deposit matches which withdrawal. Fixed denomination (1 STRK) makes all deposits and withdrawals indistinguishable by amount, maximising the anonymity set. Full ZK membership proofs (Garaga + Circom) are the V2 path to unlinking commitment from nullifier.

**Why self-attested BTC collateral?**
A trustless BTC collateral system requires a Bitcoin light client on Starknet — verifying block headers and SPV-proving UTXO inclusion. This is active research territory (Herodotus). The demo uses secp256k1 signature as a proof-of-key-ownership, which is sufficient to demonstrate the UX and mechanism. A trusted oracle is the practical near-term upgrade; a full light client is the trustless endgame.

**Why 20× gas boost?**
`estimateInvokeFee` uses `skipValidate=true` and never simulates `__validate__`. Double SHA256 + secp256k1 verify costs ~3M l2_gas the estimate misses. The 20× multiplier is conservative; `max_amount` is a cap in V3 transactions — users only pay for gas actually consumed.
