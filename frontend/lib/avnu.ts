/**
 * avnu.ts — AVNU DEX aggregator integration for Starknet Sepolia.
 *
 * AVNU provides optimal swap routes across all Sepolia DEXes (Ekubo, JediSwap,
 * etc.) and returns ready-to-execute calldata. We just pass their calls to
 * account.execute() signed via XverseSigner.
 *
 * Docs: https://doc.avnu.fi
 */

const BASE = "https://sepolia.api.avnu.fi";

export const STRK_TOKEN =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const ETH_TOKEN =
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

export interface SwapQuote {
  quoteId: string;
  sellTokenAddress: string;
  buyTokenAddress: string;
  sellAmount: string;  // hex wei
  buyAmount: string;   // hex wei
  priceRatioUsd?: number;
}

/**
 * Fetch a swap quote from AVNU.
 * @param sellAmountStrk  Human-readable sell amount, e.g. "0.5"
 * @param takerAddress    The account that will execute the swap
 */
export async function getSwapQuote(
  sellAmountStrk: string,
  takerAddress: string
): Promise<SwapQuote> {
  const sellWei = parseStrkWei(sellAmountStrk);

  const params = new URLSearchParams({
    sellTokenAddress: STRK_TOKEN,
    buyTokenAddress: ETH_TOKEN,
    sellAmount: "0x" + sellWei.toString(16),
    takerAddress,
    size: "1",
  });

  const res = await fetch(`${BASE}/swap/v2/quotes?${params}`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AVNU quote error ${res.status}: ${text}`);
  }

  const quotes: SwapQuote[] = await res.json();
  if (!quotes || quotes.length === 0) {
    throw new Error("No swap route found — the pair may have no liquidity on Sepolia");
  }

  return quotes[0];
}

export interface AvnuCall {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

/**
 * Build executable calldata for a previously quoted swap.
 * AVNU includes the approve() call automatically when needed.
 */
export async function buildSwap(
  quoteId: string,
  takerAddress: string,
  slippage = 0.005  // 0.5 %
): Promise<AvnuCall[]> {
  const res = await fetch(`${BASE}/swap/v2/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteId, takerAddress, slippage }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AVNU build error ${res.status}: ${text}`);
  }

  const data = await res.json();

  if (!data.calls || data.calls.length === 0) {
    throw new Error("AVNU returned empty calldata");
  }

  return data.calls as AvnuCall[];
}

/** Format a hex wei amount into a human-readable ETH string (6 dp). */
export function formatEth(hexWei: string): string {
  const wei = BigInt(hexWei);
  return (Number(wei) / 1e18).toFixed(6);
}

/** Parse a human-readable STRK string into wei bigint. */
function parseStrkWei(amountStr: string): bigint {
  const [intStr, fracStr = ""] = amountStr.trim().split(".");
  return (
    BigInt(intStr || "0") * 10n ** 18n +
    BigInt(fracStr.padEnd(18, "0").slice(0, 18))
  );
}
