import pino from 'pino';
import path from 'node:path';
import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import type { LogEventInput } from '../types/index.js';

/**
 * Two sinks, on purpose (decided during planning):
 *
 * 1. File logs (this pino instance) — rotated JSON on disk, readable
 *    with tail/grep even if the DB is unreachable or the process is
 *    mid-crash. This is the "something survives no matter what" layer.
 * 2. event_log table — queryable, joinable by correlation_id, powers
 *    the dashboard's retrace view ("show me everything about position #42").
 *
 * Every call to logEvent() writes to both. Never call one without the other.
 */
const fileLogger = pino(
  { level: 'info' },
  pino.destination(path.join(config.logDir, 'hermes.log')),
);

// Keys that must never reach a log line, DB or file, under any circumstance.
const REDACT_KEYS = new Set(['privateKey', 'privateKeyBase58', 'walletPrivateKey']);

function redact(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return context;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    clean[key] = REDACT_KEYS.has(key) ? '[redacted]' : value;
  }
  return clean;
}

export async function logEvent(input: LogEventInput): Promise<void> {
  const context = redact(input.context);

  const pinoMethod = input.level === 'success' ? 'info' : input.level === 'warning' ? 'warn' : input.level;
  fileLogger[pinoMethod]({
    correlationId: input.correlationId,
    category: input.category,
    context,
  }, input.message);

  try {
    await pool.query(
      `INSERT INTO event_log (correlation_id, category, level, message, context)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.correlationId ?? null, input.category, input.level, input.message, context ? JSON.stringify(context) : null],
    );
  } catch (err) {
    // If the DB write fails, the file log above already has it — that's
    // the whole point of having two sinks. Log the failure itself too.
    fileLogger.error({ err }, 'Failed to write event_log row to DB');
  }
}
