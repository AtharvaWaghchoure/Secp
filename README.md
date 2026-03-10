# Secp

> Your Bitcoin key. Your Starknet account. Your privacy.

A Starknet smart account controlled entirely by a Bitcoin secp256k1 key — with stealth addresses for private payments and a live DeFi swap demo.

No new seed phrases. No bridges. No custodians.

Built for the **Re{define} Hackathon 2026** — Privacy & Bitcoin on Starknet track.

---

## What it does

Every Bitcoin wallet holds a secp256k1 keypair. This project makes that keypair the sole authority over a Starknet smart account. Connect Xverse, get a Starknet address, deploy it, and start using Starknet DeFi — all signed with the key you already own.

On top of that: **stealth addresses**. Send STRK to someone privately. Nobody watching the chain can link the payment to the recipient. The recipient scans a public on-chain registry to find payments directed at them, derives a one-time claim key, and sweeps the funds — all without a new seed phrase.

---

## Demo flow

```
1. Connect Xverse (Bitcoin wallet)
      │
      ▼
2. Account Info
   ├─ Derives your Starknet address from your Bitcoin pubkey (deterministic)
   ├─ Auto-funds with STRK if balance is too low (no faucet needed)
   └─ Deploy — Xverse signs the deploy tx; __validate_deploy__ verifies on-chain
      │
      ▼
3. Three tabs:

   ┌─────────────────────────────────────────────────────────────────┐
   │  DeFi Swap  │  Stealth Send  │  Claim                          │
   └─────────────────────────────────────────────────────────────────┘

   DeFi Swap
   ├─ Get a STRK→ETH quote from AVNU (Ekubo / JediSwap routes)
   ├─ Xverse signs the swap tx
   └─ __validate__ runs secp256k1 verification on-chain ✓

   Stealth Send
   ├─ Enter recipient's Bitcoin public key
   ├─ Derive a one-time Starknet address via ECDH (never on-chain before)
   ├─ Xverse signs the STRK transfer
   └─ Xverse signs a second tx publishing the ephemeral key to StealthRegistry ✓

   Claim
   ├─ Enter your Bitcoin private key (never leaves browser)
   ├─ Scan StealthRegistry on-chain for payments to you
   ├─ One click: deploy stealth account + sweep STRK to your main address
   └─ Signed automatically with derived sk_stealth — no Xverse popup ✓
```

---

## Architecture

### Smart contracts

**`BitcoinAccount`** (`src/account.cairo`)

A SRC-6 compliant Starknet account that stores a secp256k1 public key `(x, y)` and verifies Bitcoin-signed messages in `__validate__`.

```
__validate__ / __validate_deploy__:
  1. tx_hash = get_tx_info().transaction_hash
  2. msg_hash = bitcoin_message_hash(tx_hash)
       = SHA256(SHA256("\x18Bitcoin Signed Message:\n" + 0x42 + "0x" + hex64(tx_hash)))
  3. secp256k1_verify(msg_hash, r, s, stored_pubkey)  →  returns 'VALID'
```

Signature format on-chain: `[r.low, r.high, s.low, s.high]` — four felt252 values encoding the two u256 ECDSA components.

**`StealthRegistry`** (`src/stealth_registry.cairo`)

A public append-only log of stealth payment announcements. Senders call `announce()` after sending to a stealth address; recipients scan `get_announcements()` to find payments directed at them.

```cairo
fn announce(stealth_address, ephemeral_pubkey_x_low, ephemeral_pubkey_x_high, ephemeral_pubkey_parity)
fn get_announcements(from_index: u64, count: u64) -> Array<Announcement>
fn announcement_count() -> u64
```

Emits an `Announced` event indexed on `sender` and `stealth_address` for off-chain filtering.

### Stealth address protocol (ECDH)

**Sender side** (in-browser, `lib/stealth.ts`):

```
1. Generate ephemeral keypair (r, R = r·G)
2. Shared secret: S = r · PK_recipient
3. h = SHA256(compress(S))
4. stealth_pk = h·G + PK_recipient
5. stealth_address = deriveBitcoinAccountAddress(stealth_pk)
6. Send STRK to stealth_address
7. Publish R to StealthRegistry
```

**Recipient side** (in-browser, `lib/stealthClaim.ts`):

```
For each announcement (R, stealth_address) from the registry:
  S_check = sk · R                          ← same shared secret
  h = SHA256(compress(S_check))
  expected = deriveBitcoinAccountAddress(h·G + PK_self)
  if expected == stealth_address:
    → payment is mine
    sk_stealth = (sk + h) mod n             ← claim private key
    → deploy BitcoinAccount at stealth_address with stealth_pk
    → sweep STRK to main address
```

The claim step uses `RawSecp256k1Signer` — a custom `SignerInterface` implementation that applies the Bitcoin message prefix locally and signs with `sk_stealth` using `@noble/curves`, without any wallet popup.

### Signing flow for all transactions

```
XverseSigner (Xverse wallet)          RawSecp256k1Signer (stealth claim)
─────────────────────────────         ──────────────────────────────────
starknet.js computes tx_hash          starknet.js computes tx_hash
normalize → "0x" + 64 hex chars       normalize → "0x" + 64 hex chars
Xverse.signMessage(ECDSA)             bitcoinMessageHashBytes(normalized)
  applies Bitcoin prefix internally   secp256k1.sign(hash, sk, {prehash:false})
→ [r.low, r.high, s.low, s.high]     → [r.low, r.high, s.low, s.high]
        │                                       │
        └───────────────────┬───────────────────┘
                            ▼
               __validate__ on-chain
               bitcoin_message_hash + secp256k1_verify ✓
```

### Gas estimation

`estimateInvokeFee` / `estimateAccountDeployFee` use `skipValidate=true` — they never simulate `__validate__`. The double SHA256 + secp256k1 verification costs roughly 3M l2_gas that the estimate misses. All transactions boost `l2_gas.max_amount` by 20×. In V3 transactions, `max_amount` is a cap; users only pay for gas actually consumed.

---

## Repository structure

```
bitcoin_starknet_account/
├── src/
│   ├── lib.cairo                # Module declarations
│   ├── account.cairo            # BitcoinAccount — SRC-6 account, secp256k1 validation
│   ├── utils.cairo              # bitcoin_message_hash, encode/decode_signature
│   └── stealth_registry.cairo  # On-chain ephemeral key announcement log
├── tests/
│   └── test_contract.cairo     # 11 tests: hash vectors, e2e sig accept/reject
└── frontend/
    ├── app/
    │   ├── page.tsx             # 3-step wizard: connect → account info → actions
    │   └── api/fund/route.ts   # Auto-funder: sends 0.1 STRK to new accounts
    ├── components/
    │   ├── ConnectWallet.tsx    # Xverse connection
    │   ├── AccountInfo.tsx      # Address derivation, deploy, auto-fund
    │   ├── SignDemo.tsx         # Tab container (Swap / Stealth Send / Claim)
    │   ├── SwapDemo.tsx         # STRK→ETH via AVNU DEX aggregator
    │   ├── StealthSend.tsx      # Derive stealth address + send + announce
    │   └── StealthClaim.tsx     # Scan registry + deploy + sweep
    └── lib/
        ├── bitcoin.ts           # Xverse connect, signMessage, key decompression
        ├── starknet.ts          # Address derivation, XverseSigner, deploy,
        │                        # sendStrk, executeSwap, announceOnChain,
        │                        # fetchAnnouncements, verifySignatureOnChain
        ├── stealth.ts           # Sender-side ECDH: deriveStealthPayment()
        ├── stealthClaim.ts      # Recipient-side: RawSecp256k1Signer, scan, claim
        └── avnu.ts              # AVNU DEX aggregator: getSwapQuote, buildSwap
```

---

## Deployed contracts (Sepolia)

| Contract | Address |
|---|---|
| BitcoinAccount class | `0x1c5e4906e319a5c79c3ead6f16c395106c8241cb5fd508a07e78fb3a656aacc` |
| StealthRegistry | `0x02793374add811d87ecebd2308ba2bdd9c4a608376b25d960b84bbe0d7d2d4a5` |
| RPC | `https://api.cartridge.gg/x/starknet/sepolia` |

---

## Running locally

### Prerequisites

- [Scarb](https://docs.swmansion.com/scarb/) 2.15.0
- [Starknet Foundry](https://foundry-rs.github.io/starknet-foundry/) 0.56.0
- Node.js 18+
- [Xverse](https://www.xverse.app/) browser extension (enable testnet mode)

### Cairo tests

```bash
snforge test
# 11 passed, 0 failed
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# open http://localhost:3000
```

The app auto-funds new accounts with STRK via `/api/fund`. For this to work in your own deployment, create `frontend/.env.local`:

```
FUNDER_ADDRESS=0x...
FUNDER_PRIVATE_KEY=0x...
```

and fund that address with STRK from the [Sepolia faucet](https://starknet-faucet.vercel.app/). Without this, users can fund themselves manually from the faucet.

---

## Key design decisions

**Why the Bitcoin message prefix?**
Bitcoin wallets cannot sign raw bytes — they always apply `"\x18Bitcoin Signed Message:\n"` + length. Matching this in Cairo means any standard Bitcoin wallet (Xverse, Leather, etc.) works without modifications, and the signature scheme is identical to what users already trust for Bitcoin message signing.

**Why secp256k1 and not the Stark curve?**
Bitcoin keys live on secp256k1. Starknet natively provides a `secp256k1` ECDSA syscall (`is_valid_signature::<Secp256k1Point>`), making on-chain verification practical without ZK proofs or precompiles.

**Why normalize the tx hash to exactly 64 hex chars?**
`starknet.js` returns tx hashes without leading zeros (e.g. `"0x1abc"`). Cairo's `bitcoin_message_hash` encodes the felt252 as `"0x" + 64 hex chars` — 66 characters, varint `0x42`. A shorter string changes the varint, producing a different double-SHA256 hash and an invalid signature. `XverseSigner._signHash` zero-pads to 64 chars to match exactly.

**Why stealth addresses instead of just sending to a known address?**
Sending STRK directly to a recipient's derived Starknet address is permanently linkable — anyone can map Bitcoin pubkey → Starknet address. Stealth addresses break this: each payment goes to a fresh address derived via ECDH. Only the recipient (with their private key) can scan and claim. The sender publishes an ephemeral public key to `StealthRegistry`; nobody else can derive the connection.

**Why RawSecp256k1Signer for claiming?**
Claiming a stealth payment requires signing with `sk_stealth = (sk_recipient + h) mod n`, a derived key that lives nowhere in any wallet. Xverse can't sign with it. `RawSecp256k1Signer` implements the same `SignerInterface` as `XverseSigner` but computes the Bitcoin message hash locally and signs with `@noble/curves secp256k1.sign(..., { prehash: false })`. The private key is computed in memory and never persisted.

**Why a separate StealthRegistry contract instead of events on BitcoinAccount?**
The account contract only knows about its own transfers — it has no way to attach metadata to transfers to other addresses. A standalone registry lets any sender announce any stealth payment, and any recipient scan all announcements from a single contract, regardless of which account sent the funds.

**Why 20× gas boost?**
`estimateInvokeFee` uses `skipValidate=true` — it never runs `__validate__`. The double SHA256 + secp256k1 verify costs ~3M l2_gas that the estimate misses. The 20× multiplier is conservative; `max_amount` is a cap in V3 transactions — users pay only for gas actually consumed.
