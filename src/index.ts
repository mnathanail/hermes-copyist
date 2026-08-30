import { pool } from './db/pool.js';
import { logEvent } from './services/logger.js';
import { WalletWatcher } from './services/walletWatcher.js';
import { handleDetectedBuy } from './services/signalHandler.js';
import { startPositionMonitor } from './services/positionMonitor.js';
import { startApiServer } from './api/server.js';

async function main() {
  await pool.query('SELECT 1'); // fail fast if DB is unreachable
  await logEvent({ category: 'system', level: 'success', message: 'Hermes Copyist starting up' });

  const watcher = new WalletWatcher();

  startApiServer(() => watcher.refreshWatchlist());

  watcher.on('buy', handleDetectedBuy);
  await watcher.start();

  startPositionMonitor();

  await logEvent({ category: 'system', level: 'success', message: 'All services started' });
}

main().catch(async (err) => {
  await logEvent({ category: 'error', level: 'error', message: `Fatal startup error: ${err.message}` });
  console.error(err);
  process.exit(1);
});
