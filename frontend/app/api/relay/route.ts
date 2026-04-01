/**
 * POST /api/relay
 *
 * Gasless meta-transaction relay.
 *
 * The user signs their intent (calls + nonce) with their Bitcoin key via Xverse.
 * This endpoint submits the signed intent on-chain using the relayer's funded account,
 * paying the gas. The user never needs to hold STRK.
 *
 * The target BitcoinAccount's execute_from_outside() verifies the secp256k1
 * signature on-chain — the relayer cannot forge or alter the calls.
 */
import { NextRequest, NextResponse } from "next/server";
import { RpcProvider, Account, Signer } from "starknet";

const STARKNET_RPC =
  process.env.STARKNET_RPC || "https://api.cartridge.gg/x/starknet/sepolia";

// Reuse the funder account as the relayer (or set dedicated RELAYER_* env vars)
const RELAYER_ADDRESS =
  process.env.RELAYER_ADDRESS || process.env.FUNDER_ADDRESS;
const RELAYER_PRIVATE_KEY =
  process.env.RELAYER_PRIVATE_KEY || process.env.FUNDER_PRIVATE_KEY;

interface NormalizedCall {
  to: string;
  selector: string;
  calldata: string[];
}

/**
 * Serialize (calls, signature, nonce) into flat felt252 calldata for
 * execute_from_outside(calls: Array<Call>, signature: Array<felt252>, nonce: felt252).
 *
 * Cairo Array<Call> encoding:
 *   [length, call0.to, call0.selector, call0.calldata.len, ...call0.calldata, ...]
 *
 * Cairo Array<felt252> encoding:
 *   [length, elem0, elem1, ...]
 */
function serializeCalldata(
  calls: NormalizedCall[],
  signature: string[],
  nonce: string
): string[] {
  const data: string[] = [];

  // Array<Call>
  data.push("0x" + calls.length.toString(16));
  for (const call of calls) {
    data.push(call.to);
    data.push(call.selector);
    data.push("0x" + call.calldata.length.toString(16));
    data.push(...call.calldata);
  }

  // Array<felt252> signature
  data.push("0x" + signature.length.toString(16));
  data.push(...signature);

  // nonce: felt252
  data.push("0x" + BigInt(nonce).toString(16));

  return data;
}

export async function POST(req: NextRequest) {
  try {
    const { userAddress, calls, signature, nonce } = await req.json();

    if (!RELAYER_ADDRESS || !RELAYER_PRIVATE_KEY) {
      return NextResponse.json(
        {
          error:
            "Relay not configured (missing FUNDER_ADDRESS / FUNDER_PRIVATE_KEY env vars)",
        },
        { status: 500 }
      );
    }

    const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });
    const signer = new Signer(RELAYER_PRIVATE_KEY);
    const relayer = new Account({ provider, address: RELAYER_ADDRESS, signer });

    const calldata = serializeCalldata(calls, signature, nonce);

    const relayCall = {
      contractAddress: userAddress,
      entrypoint: "execute_from_outside",
      calldata,
    };

    // Estimate fee — execute_from_outside runs bitcoin_message_hash + secp256k1 in
    // execute phase so estimation captures the real cost. Use 3× boost for safety.
    const estimate = await relayer.estimateInvokeFee([relayCall]);
    const boostedL2Gas =
      BigInt(estimate.resourceBounds.l2_gas.max_amount) * 3n;

    const tx = await relayer.execute([relayCall], {
      resourceBounds: {
        ...estimate.resourceBounds,
        l2_gas: {
          max_amount: boostedL2Gas,
          max_price_per_unit:
            estimate.resourceBounds.l2_gas.max_price_per_unit,
        },
      },
    });

    return NextResponse.json({ txHash: tx.transaction_hash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Relay failed";
    console.error("[relay]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
