/**
 * POST /api/pool-withdraw
 *
 * Gasless withdrawal relay for the PrivacyPool contract.
 *
 * The note holder signs (nullifier, recipient) with their note private key
 * off-chain. This endpoint submits the withdrawal on behalf of the recipient —
 * the recipient never needs to hold STRK to receive it.
 *
 * Privacy: the relayer sees the note pubkey and recipient but cannot
 * prevent or reorder withdrawals (the note signature is verified on-chain).
 */
import { NextRequest, NextResponse } from "next/server";
import { RpcProvider, Account, Signer } from "starknet";

const STARKNET_RPC =
  process.env.STARKNET_RPC || "https://api.cartridge.gg/x/starknet/sepolia";

const RELAYER_ADDRESS =
  process.env.RELAYER_ADDRESS || process.env.FUNDER_ADDRESS;
const RELAYER_PRIVATE_KEY =
  process.env.RELAYER_PRIVATE_KEY || process.env.FUNDER_PRIVATE_KEY;

/** PrivacyPool deployed on Starknet Sepolia. */
const PRIVACY_POOL_ADDRESS =
  "0x04cee13dde30159a3bb5c388ce7826cfa7d87ebb86dd7f5dc109d7c899c81570";

export async function POST(req: NextRequest) {
  try {
    const { notePubkeyX, notePubkeyY, recipient, sig } = await req.json();
    // sig: [r_low, r_high, s_low, s_high] as hex strings

    if (!RELAYER_ADDRESS || !RELAYER_PRIVATE_KEY) {
      return NextResponse.json(
        { error: "Relay not configured (missing FUNDER_ADDRESS / FUNDER_PRIVATE_KEY)" },
        { status: 500 }
      );
    }

    if (!notePubkeyX || !notePubkeyY || !recipient || !Array.isArray(sig) || sig.length !== 4) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });
    const signer = new Signer(RELAYER_PRIVATE_KEY);
    const relayer = new Account({ provider, address: RELAYER_ADDRESS, signer });

    // withdraw(note_pubkey_x: u256, note_pubkey_y: u256, recipient: ContractAddress, sig: Array<felt252>)
    // u256 is [low, high]; Array<felt252> is [length, ...elems]
    const xBig = BigInt(notePubkeyX);
    const yBig = BigInt(notePubkeyY);
    const mask128 = (1n << 128n) - 1n;
    const xLow = "0x" + (xBig & mask128).toString(16);
    const xHigh = "0x" + (xBig >> 128n).toString(16);
    const yLow = "0x" + (yBig & mask128).toString(16);
    const yHigh = "0x" + (yBig >> 128n).toString(16);

    const withdrawCall = {
      contractAddress: PRIVACY_POOL_ADDRESS,
      entrypoint: "withdraw",
      calldata: [
        xLow,
        xHigh,
        yLow,
        yHigh,
        recipient,
        "4",   // Array<felt252> length
        ...sig, // [r_low, r_high, s_low, s_high]
      ],
    };

    // withdraw() does bitcoin_message_hash + secp256k1 verify in execute phase
    // so estimate captures the real cost. 3× boost is sufficient.
    const estimate = await relayer.estimateInvokeFee([withdrawCall]);
    const boostedL2Gas = BigInt(estimate.resourceBounds.l2_gas.max_amount) * 3n;

    const tx = await relayer.execute([withdrawCall], {
      resourceBounds: {
        ...estimate.resourceBounds,
        l2_gas: {
          max_amount: boostedL2Gas,
          max_price_per_unit: estimate.resourceBounds.l2_gas.max_price_per_unit,
        },
      },
    });

    return NextResponse.json({ txHash: tx.transaction_hash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Pool withdraw relay failed";
    console.error("[pool-withdraw]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
