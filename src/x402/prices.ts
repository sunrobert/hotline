// What the paid feed sells: a spot price in USD, read from Coinbase's public price API.
// The feed only carries a short list, so a typo is refused before anyone pays.

export interface Quote {
  asset: string;
  price_usd: number;
  as_of: string;
  source: string;
}

const NAMES: Record<string, string> = {
  BTC: "BTC", BITCOIN: "BTC",
  ETH: "ETH", ETHER: "ETH", ETHEREUM: "ETH",
  SOL: "SOL", SOLANA: "SOL",
  USDC: "USDC", EURC: "EURC",
  AVAX: "AVAX", AVALANCHE: "AVAX",
  LINK: "LINK", CHAINLINK: "LINK",
  DOGE: "DOGE", DOGECOIN: "DOGE",
  XRP: "XRP", RIPPLE: "XRP",
};

/** "ethereum", "Eth", " ETH " -> "ETH". Null for anything the feed does not carry. */
export function normalizeAsset(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return NAMES[raw.trim().toUpperCase()] ?? null;
}

export async function coinbaseSpot(asset: string, doFetch: typeof fetch = fetch): Promise<Quote | null> {
  try {
    const res = await doFetch(`https://api.coinbase.com/v2/prices/${encodeURIComponent(asset)}-USD/spot`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { amount?: string } };
    const price = Number(body.data?.amount);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { asset, price_usd: price, as_of: new Date().toISOString(), source: "coinbase" };
  } catch {
    return null;
  }
}
