# Pitch Deck Content
## Secp
### Re{define} Hackathon 2026 — Privacy & Bitcoin Track

---

## SLIDE 1 — Title

**Headline:** Your Bitcoin Key. Your Starknet Account.

**Subheadline:** Control Starknet DeFi with the key you already own — privately.

**One-liner:** A Starknet smart account controlled entirely by a Bitcoin secp256k1 key, with stealth addresses for private payments and a live DeFi swap demo.

**Tagline options:**
- "No new seed phrase. No bridge. No custodian."
- "Bitcoin security. Starknet speed. Full privacy."

---

## SLIDE 2 — The Problem

**Three problems in one:**

**1. Fragmented key management**
The average crypto user holds Bitcoin in Xverse or Leather but needs a completely separate Starknet wallet with a new seed phrase to access Starknet DeFi. Every new chain = new keys = more attack surface.

**2. No privacy on L2**
Every transaction on Starknet is public. When you send STRK to someone, that address is permanently on-chain and linkable to your identity forever.

**3. Bitcoin is stuck**
$1T+ in Bitcoin wealth sits idle. Bridges are risky (hacks, custody). Wrapped tokens require trust. There is no native way for a Bitcoin key to authorize Starknet transactions.

---

## SLIDE 3 — The Solution

**One Bitcoin key. Three superpowers.**

| | What it unlocks |
|---|---|
| **Account ownership** | Your existing Bitcoin key (secp256k1) controls a Starknet smart account — no new keys |
| **DeFi access** | Swap STRK → ETH on live DEXes (Ekubo, JediSwap via AVNU) signed with your Bitcoin key |
| **Private payments** | Send STRK to anyone with zero on-chain link using stealth addresses |

**The core insight:** Bitcoin wallets already sign messages. Starknet has native secp256k1 verification. Connect the two.

---

## SLIDE 4 — How It Works (Technical, Simple)

**The Signature Bridge**

```
Bitcoin Wallet (Xverse)              Starknet Chain
─────────────────────                ──────────────
Your Bitcoin private key    →    Signs Starknet tx hash
(secp256k1 ECDSA)                with Bitcoin message prefix

                                 __validate__ on-chain:
                                 bitcoin_message_hash(tx_hash)
                                 + secp256k1_verify ✓
                                 → 'VALID'
```

**The magic:** Bitcoin wallets sign messages as:
`SHA256(SHA256("\x18Bitcoin Signed Message:\n" + message))`

The Cairo smart contract applies the **identical transform** before verifying. Zero modifications to Xverse. Zero new standards.

**Address derivation (deterministic):**
```
Bitcoin pubkey (x, y)  →  salt = pedersen(x.low, x.high)
                       →  Starknet address (fixed, forever)
```
Same key = same address = no key management overhead.

---

## SLIDE 5 — Demo: Connect & Deploy

**Step 1: Connect**
- Open the app, click "Connect Xverse"
- App extracts the secp256k1 public key
- Derives your Starknet address instantly (client-side, no network call)

**Step 2: Auto-Fund**
- App detects zero balance
- Calls `/api/fund` — sends 0.1 STRK automatically
- No faucet interaction needed for the demo

**Step 3: Deploy**
- Click "Deploy Starknet Account"
- Xverse popup: sign the deploy transaction hash
- `__validate_deploy__` runs secp256k1 verification on-chain
- Contract is live on Starknet Sepolia

**Highlight for judges:** The Xverse popup is identical to signing a Bitcoin message. The user experience is frictionless — no new concepts to learn.

---

## SLIDE 6 — Demo: DeFi Swap

**Bitcoin key authorizes a real DEX trade**

1. Enter amount: `0.5 STRK`
2. Click **Get Quote** → AVNU aggregator finds best route (Ekubo / JediSwap)
3. See expected ETH output instantly
4. Click **Swap with Bitcoin Key** → Xverse popup
5. Sign → transaction broadcasts
6. Green badge appears: **"✓ `__validate__` confirmed — secp256k1 verified on-chain"**

**On Voyager (block explorer):**
- Open the transaction
- Click "Internal Calls"
- See `__validate__` executing `bitcoin_message_hash` + `secp256k1_verify` in the trace

**What this proves:** A real multi-call DeFi transaction (approve + swap) on Starknet Sepolia, authorized entirely by a Bitcoin key. The signature is verified **on-chain**, not just client-side.

---

## SLIDE 7 — Demo: Stealth Addresses (Privacy)

**The Privacy Problem (visual)**
```
Without stealth:
  Alice's Bitcoin pubkey  →  Alice's Starknet address (public, forever)
  Anyone can track all Alice's payments

With stealth addresses:
  Alice sends to Bob
  →  One-time address derived via ECDH
  →  No on-chain link between Alice, Bob, or the address
  →  Only Bob can find this payment
```

**The Protocol (3 steps):**

**Send (Alice):**
1. Generate ephemeral keypair `(r, R = r·G)`
2. Compute shared secret `S = r · PK_Bob`
3. Derive one-time address: `stealth_addr = H(S)·G + PK_Bob`
4. Send STRK to `stealth_addr`
5. Publish `R` to **StealthRegistry** contract (on-chain, public)

**Scan (Bob):**
- For each announcement `R` in registry: compute `S = sk_Bob · R` → check if address matches
- Only Bob's private key can derive the matching address

**Claim (Bob):**
- `sk_stealth = (sk_Bob + H(S)) mod n`
- Deploy `BitcoinAccount` at stealth address
- Sweep STRK to main address
- No Xverse popup — signing done locally with derived key

---

## SLIDE 8 — The StealthRegistry Contract

**On-chain ephemeral key announcements**

```
Sender calls:  announce(stealth_address, R.x_low, R.x_high, R.parity)
                              ↓
               StealthRegistry (Sepolia)
               0x02793374...d4a5
                              ↓
Recipient:     get_announcements(from_index, count)
               → scan all R values → find matching payments
```

**Why on-chain?**
- Works from any device, any browser — no shared state
- Censorship resistant
- Permanent record — payments discoverable years later
- Emits `Announced` events for efficient off-chain indexing

**Deployed on Sepolia:**
`0x02793374add811d87ecebd2308ba2bdd9c4a608376b25d960b84bbe0d7d2d4a5`

---

## SLIDE 9 — Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (Next.js)                    │
│                                                          │
│  ConnectWallet  →  AccountInfo  →  [Swap|Send|Claim]    │
│                                                          │
│  lib/bitcoin.ts      Xverse connect, sign, key extract  │
│  lib/starknet.ts     Address derive, deploy, XverseSigner│
│  lib/stealth.ts      ECDH sender-side derivation        │
│  lib/stealthClaim.ts Scan, RawSecp256k1Signer, sweep    │
│  lib/avnu.ts         DEX quote + swap calldata          │
└──────────────────┬──────────────────────────────────────┘
                   │
     ┌─────────────┼──────────────┐
     ▼             ▼              ▼
┌─────────┐  ┌──────────┐  ┌──────────────┐
│Bitcoin  │  │AVNU DEX  │  │ Starknet     │
│Account  │  │Aggregator│  │ Sepolia RPC  │
│(Cairo)  │  │(Sepolia) │  │(Cartridge)   │
│         │  │          │  │              │
│__valid- │  │/quotes   │  │              │
│ate__    │  │/build    │  │              │
│secp256k1│  └──────────┘  └──────────────┘
│         │
│Stealth  │
│Registry │
│(Cairo)  │
└─────────┘
```

---

## SLIDE 10 — What Makes This Unique

**Compared to existing approaches:**

| Approach | Problem |
|---|---|
| Wrapped BTC (WBTC) | Custodian holds real BTC. Bridge risk. |
| Bitcoin bridges | Hacks, centralization, different key |
| New Starknet wallet | New seed phrase, separate key management |
| **This project** | **Native Bitcoin key, on-chain secp256k1 verification, zero bridge** |

**Three technical firsts in one demo:**

1. **Native secp256k1 account** — Bitcoin message signing standard implemented in Cairo; any Bitcoin wallet works unchanged

2. **Stealth addresses on Starknet** — Full ECDH privacy cycle: send → announce → scan → claim, entirely on-chain with no trusted intermediary

3. **RawSecp256k1Signer** — First implementation of claim-key signing for stealth addresses: `sk_stealth = (sk + H(S)) mod n` signs real Starknet transactions using the exact Bitcoin message format

