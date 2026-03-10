import { NextRequest, NextResponse } from "next/server";
import { RpcProvider, Account, Signer } from "starknet";

const RPC = "https://api.cartridge.gg/x/starknet/sepolia";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// Sends 0.1 STRK to a new account so it can afford the deploy fee.
// Set FUNDER_ADDRESS and FUNDER_PRIVATE_KEY in .env.local.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { address?: string };
    const { address } = body;

    if (!address || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
      return NextResponse.json({ error: "invalid address" }, { status: 400 });
    }

    const funderAddress = process.env.FUNDER_ADDRESS;
    const funderKey = process.env.FUNDER_PRIVATE_KEY;
    if (!funderAddress || !funderKey) {
      return NextResponse.json(
        { error: "funder not configured — set FUNDER_ADDRESS and FUNDER_PRIVATE_KEY" },
        { status: 503 }
      );
    }

    const provider = new RpcProvider({ nodeUrl: RPC });
    const signer = new Signer(funderKey);
    const funder = new Account({ provider, address: funderAddress, signer });

    // 0.1 STRK = 10^17 wei (18 decimals)
    const amount = 100_000_000_000_000_000n;
    const low = amount & ((1n << 128n) - 1n);

    const { transaction_hash } = await funder.execute([
      {
        contractAddress: STRK,
        entrypoint: "transfer",
        calldata: [address, "0x" + low.toString(16), "0x0"],
      },
    ]);

    return NextResponse.json({ transaction_hash });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "fund failed" },
      { status: 500 }
    );
  }
}
