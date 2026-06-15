import { NextResponse } from 'next/server';

export const revalidate = 60;

interface CoinGeckoMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number | null;
  market_cap: number;
  sparkline_in_7d?: {
    price?: number[];
  };
}

export async function GET() {
  const apiKey = process.env.COINGECKO_API_KEY;
  const query = new URLSearchParams({
    vs_currency: 'usd',
    ids: 'bitcoin,ethereum,solana',
    order: 'market_cap_desc',
    sparkline: 'true',
    price_change_percentage: '24h',
  });

  try {
    const response = await fetch(`https://api.coingecko.com/api/v3/coins/markets?${query}`, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { 'x-cg-demo-api-key': apiKey } : {}),
      },
      next: { revalidate: 60 },
    });

    if (!response.ok) {
      return NextResponse.json({ error: `CoinGecko returned ${response.status}` }, { status: 503 });
    }

    const coins = await response.json() as CoinGeckoMarket[];
    return NextResponse.json({
      assets: coins.map((coin) => ({
        id: coin.id,
        symbol: coin.symbol.toUpperCase(),
        name: coin.name,
        price: coin.current_price,
        change24h: coin.price_change_percentage_24h ?? 0,
        marketCap: coin.market_cap,
        sparkline: (coin.sparkline_in_7d?.price ?? []).filter(Number.isFinite),
      })),
      updatedAt: new Date().toISOString(),
      source: 'CoinGecko / USD',
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
