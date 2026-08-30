import pg from 'pg';
import { config } from '../config/env.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

pool.on('error', (err) => {
  // A pool-level error means a lost connection — this is exactly the kind
  // of thing that must never disappear silently. logger.ts also mirrors
  // this to the file log independently of the DB, so it survives even if
  // the DB itself is what died.
  console.error('[db] Unexpected pool error', err);
});
