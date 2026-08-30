import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { pool } from '../db/pool.js';
import { logEvent } from '../services/logger.js';
import { getTradingMode, setTradingMode, getAutoBuyAmountSol, setAutoBuyAmountSol } from '../services/settingsService.js';
import { manualPartialSell, panicSell } from '../services/exitManager.js';
import { executeBuy, setNotifier } from '../services/signalHandler.js';
import { config } from '../config/env.js';

export function startApiServer(refreshWatchlist: () => Promise<void>) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  function broadcast(event: { type: string; payload: unknown }) {
    const message = JSON.stringify(event);
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(message);
    });
  }
  setNotifier(broadcast);

  // ── Watchlist wallets ──────────────────────────────────────────
  app.get('/api/wallets', async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM watchlist_wallets ORDER BY created_at DESC`);
    res.json(rows);
  });

  app.post('/api/wallets', async (req, res) => {
    const { address, owner, label } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO watchlist_wallets (address, owner, label) VALUES ($1, $2, $3) RETURNING *`,
      [address, owner ?? null, label ?? null],
    );
    await logEvent({ category: 'manual_action', level: 'info', message: `Wallet added to watchlist: ${address}`, context: { owner } });
    await refreshWatchlist();
    res.status(201).json(rows[0]);
  });

  app.patch('/api/wallets/:id', async (req, res) => {
    const { active } = req.body;
    await pool.query(`UPDATE watchlist_wallets SET active = $1 WHERE id = $2`, [active, req.params.id]);
    await logEvent({ category: 'manual_action', level: 'info', message: `Wallet #${req.params.id} active=${active}` });
    await refreshWatchlist();
    res.sendStatus(204);
  });

  // ── Global trading mode / auto buy amount ─────────────────────
  app.get('/api/settings', async (_req, res) => {
    res.json({ tradingMode: await getTradingMode(), autoBuyAmountSol: await getAutoBuyAmountSol() });
  });

  app.post('/api/settings/mode', async (req, res) => {
    const { mode } = req.body; // 'auto' | 'manual'
    await setTradingMode(mode);
    await logEvent({ category: 'manual_action', level: 'info', message: `Global trading mode set to ${mode}` });
    res.sendStatus(204);
  });

  app.post('/api/settings/auto-buy-amount', async (req, res) => {
    const { amountSol } = req.body;
    await setAutoBuyAmountSol(amountSol);
    await logEvent({ category: 'manual_action', level: 'info', message: `Auto buy amount set to ${amountSol} SOL` });
    res.sendStatus(204);
  });

  // ── Active trades ──────────────────────────────────────────────
  app.get('/api/positions', async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC`);
    res.json(rows);
  });

  async function loadPosition(id: string) {
    const { rows } = await pool.query(`SELECT * FROM positions WHERE id = $1`, [id]);
    return rows[0];
  }

  app.post('/api/positions/:id/sell', async (req, res) => {
    const position = await loadPosition(req.params.id);
    if (!position) return res.sendStatus(404);
    if (position.management_mode !== 'manual') {
      return res.status(400).json({ error: 'Partial sell is only available for manual-mode positions' });
    }
    await manualPartialSell(mapDbPosition(position), req.body.pct);
    res.sendStatus(204);
  });

  app.post('/api/positions/:id/panic', async (req, res) => {
    const position = await loadPosition(req.params.id);
    if (!position) return res.sendStatus(404);
    await panicSell(mapDbPosition(position));
    res.sendStatus(204);
  });

  // ── Manual signal execution (the "Buy" button on a pending notification) ──
  // Body should be the full pending_signal payload the dashboard received
  // over WS (wallet, mint, dexs, parentSignature, solAmount), plus the
  // user-chosen solAmount to actually spend (may differ from the detected amount).
  app.post('/api/signals/:id/execute', async (req, res) => {
    const { solAmount, wallet, mint, dexs, parentSignature } = req.body;
    await executeBuy(Number(req.params.id), { wallet, mint, dexs, parentSignature, solAmount }, solAmount, 'manual');
    res.sendStatus(204);
  });

  httpServer.listen(config.port, () => {
    logEvent({ category: 'system', level: 'success', message: `API server listening on port ${config.port}` });
  });

  return { app, wss };
}

function mapDbPosition(row: any) {
  return {
    id: row.id,
    walletId: row.wallet_id,
    signalEventId: row.signal_event_id,
    mint: row.mint,
    dex: row.dex,
    entryPriceSol: Number(row.entry_price_sol),
    entryPriceUsd: row.entry_price_usd !== null ? Number(row.entry_price_usd) : null,
    tokenAmountTotal: Number(row.token_amount_total),
    tokenAmountRemaining: Number(row.token_amount_remaining),
    solSize: Number(row.sol_size),
    managementMode: row.management_mode,
    status: row.status,
    entrySignature: row.entry_signature,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}
