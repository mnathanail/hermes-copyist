import { config } from '../config/env.js';

export interface PriceData {
  priceInSol: number;
  priceInUsd: number;
}

/**
 * Endpoint and response shape confirmed against
 * ahk780/solana-copy-trading-bot's priceChecker.js during the CoinVera
 * contract verification pass.
 */
export async function fetchTokenPrice(mint: string): Promise<PriceData | null> {
  const url = `https://api.coinvera.io/api/v1/price?ca=${mint}`;

  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.coinveraApiKey,
    },
  });

  if (!response.ok) return null;

  const data = await response.json();
  return {
    priceInSol: data.priceInSol,
    priceInUsd: data.priceInUsd,
  };
}
