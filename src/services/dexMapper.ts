/**
 * Translates CoinVera's human-readable `dexs` array (e.g. ["Pump.fun"],
 * ["Raydium AMMv4"]) into the dex code SolanaPortal expects. Confirmed
 * against ahk780/solana-copy-trading-bot's dexMapper.js during the
 * CoinVera contract verification pass.
 */
export function mapDex(dexs: string[] | undefined): string {
  if (!dexs || dexs.length === 0) return 'jupiter';

  const lowered = dexs.map((d) => d.toLowerCase());

  if (lowered.some((d) => d.startsWith('pump.fun'))) return 'pumpfun';
  if (lowered.some((d) => d.includes('fluxbeam') || d.includes('orca whirlpool') || d.includes('raydium launchpad'))) return 'jupiter';
  if (lowered.some((d) => d.includes('meteora'))) return 'meteora';
  if (lowered.some((d) => d.includes('raydium ammv4') || d.includes('raydium cpmm') || d.includes('raydium clmm'))) return 'raydium';

  // Unknown dex name: sanitize and pass through rather than guessing wrong.
  return dexs[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}
