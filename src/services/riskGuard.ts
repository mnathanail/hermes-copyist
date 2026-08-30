import { pool } from '../db/pool.js';

/**
 * The reference implementation's only pre-buy check was "have I already
 * seen this mint" (an in-memory Set, lost on refresh). This module adds
 * the checks that were flagged as missing during the architecture review:
 * per-wallet dedupe backed by the DB, and basic exposure limits.
 *
 * TODO: exposure limits (MAX_CONCURRENT_POSITIONS, MAX_TOTAL_SOL_EXPOSURE)
 * are placeholders — tune once live.
 */
const MAX_CONCURRENT_POSITIONS = 10;
const MAX_TOTAL_SOL_EXPOSURE = 5;

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export async function canOpenPosition(walletId: number, mint: string, solAmount: number): Promise<RiskCheckResult> {
  const { rows: dupeRows } = await pool.query(
    `SELECT id FROM positions WHERE wallet_id = $1 AND mint = $2 AND status = 'open'`,
    [walletId, mint],
  );
  if (dupeRows.length > 0) {
    return { allowed: false, reason: `Already holding an open position for ${mint} from this wallet` };
  }

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM positions WHERE status = 'open'`,
  );
  if (Number(countRows[0].count) >= MAX_CONCURRENT_POSITIONS) {
    return { allowed: false, reason: `Max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached` };
  }

  const { rows: exposureRows } = await pool.query<{ total: string | null }>(
    `SELECT sum(sol_size) as total FROM positions WHERE status = 'open'`,
  );
  const currentExposure = Number(exposureRows[0].total ?? 0);
  if (currentExposure + solAmount > MAX_TOTAL_SOL_EXPOSURE) {
    return { allowed: false, reason: `Would exceed max total SOL exposure (${MAX_TOTAL_SOL_EXPOSURE})` };
  }

  return { allowed: true };
}
