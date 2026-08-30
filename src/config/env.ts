import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

/**
 * Custody note (decided during planning): the trading private key
 * lives ONLY in this process's environment — loaded once at boot,
 * never written to the DB, never sent to the dashboard/API layer,
 * never logged (see services/logger.ts redaction helper).
 *
 * This is the "simple, less secure" option chosen for v1. If this
 * ever runs on a shared or staging server, rotate the key and move
 * to a proper secrets manager.
 */
export const config = {
  port: Number(process.env.PORT ?? 3000),

  databaseUrl: required('DATABASE_URL'),

  solanaRpcUrl: required('SOLANA_RPC_URL'),
  jitoRpcUrl: process.env.JITO_RPC_URL ?? 'https://mainnet.block-engine.jito.wtf/api/v1/transactions',

  coinveraApiKey: required('COINVERA_API_KEY'),
  coinveraWsUrl: process.env.COINVERA_WS_URL ?? 'wss://api.coinvera.io',

  solanaPortalUrl: process.env.SOLANA_PORTAL_URL ?? 'https://api.solanaportal.io/api/trading',

  // Trading wallet — see custody note above.
  walletAddress: required('WALLET_ADDRESS'),
  privateKeyBase58: required('WALLET_PRIVATE_KEY'),

  logDir: process.env.LOG_DIR ?? './logs',
};
