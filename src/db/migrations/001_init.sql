-- Hermes Copyist — initial schema
-- Design finalized in planning conversation: multi-wallet copy trading,
-- shared exit strategy for v1, auto/manual mode locked per-position at open time.

CREATE TYPE trading_mode AS ENUM ('auto', 'manual');
CREATE TYPE signal_status AS ENUM ('auto_executed', 'pending', 'executed_manually', 'ignored', 'expired');
CREATE TYPE position_status AS ENUM ('open', 'closed');
CREATE TYPE exit_trigger_type AS ENUM ('take_profit_tier', 'stop_loss', 'timeout', 'manual_partial', 'panic_full');

-- ─────────────────────────────────────────────────────────────
-- Exit strategies: v1 ships a single "default" strategy shared by
-- every wallet. Designed so low/medium/risky presets can be added
-- later as new rows, with zero changes to the tables or app logic.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE exit_strategies (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    stop_loss_pct NUMERIC NOT NULL,       -- e.g. 20 = -20% hard stop on remaining position
    timeout_ms    BIGINT NOT NULL,        -- force-close if held longer than this
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE exit_strategy_tiers (
    id                SERIAL PRIMARY KEY,
    strategy_id       INTEGER NOT NULL REFERENCES exit_strategies(id) ON DELETE CASCADE,
    tier_order        INTEGER NOT NULL,       -- 1, 2, 3... evaluated in order
    trigger_pct       NUMERIC NOT NULL,       -- e.g. 30 = +30% unrealized gain
    sell_portion_pct  NUMERIC NOT NULL,       -- e.g. 25 = sell 25% of remaining tokens
    UNIQUE (strategy_id, tier_order)
);

-- ─────────────────────────────────────────────────────────────
-- Watchlist: wallets you've vetted manually and added via the UI.
-- `owner` is a free-text nickname for whoever controls the wallet —
-- informational only, never used in execution logic.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE watchlist_wallets (
    id          SERIAL PRIMARY KEY,
    address     TEXT NOT NULL UNIQUE,
    owner       TEXT,                         -- nullable nickname/handle of the wallet's owner
    label       TEXT,                         -- your own free-form tag
    active      BOOLEAN NOT NULL DEFAULT true,
    strategy_id INTEGER REFERENCES exit_strategies(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Global runtime settings — the auto/manual toggle and its
-- companion auto-buy amount live here as simple key/value rows.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
    ('trading_mode', 'auto'),
    ('auto_buy_amount_sol', '0.1');

-- ─────────────────────────────────────────────────────────────
-- Signals: every detected buy from a watched wallet, whether or
-- not it results in a position. Captures mode-at-detection so we
-- can always answer "why did/didn't this get copied?".
-- ─────────────────────────────────────────────────────────────
CREATE TABLE signal_events (
    id                  SERIAL PRIMARY KEY,
    wallet_id           INTEGER NOT NULL REFERENCES watchlist_wallets(id),
    mint                TEXT NOT NULL,
    sol_amount_detected NUMERIC NOT NULL,     -- how much the source wallet spent
    mode_at_detection   trading_mode NOT NULL,
    status              signal_status NOT NULL DEFAULT 'pending',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Positions: management_mode is a SNAPSHOT taken at open time.
-- Changing the global trading_mode setting later never affects
-- an already-open position — it only affects new signals.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE positions (
    id                     SERIAL PRIMARY KEY,
    wallet_id              INTEGER NOT NULL REFERENCES watchlist_wallets(id),
    signal_event_id        INTEGER REFERENCES signal_events(id),
    mint                   TEXT NOT NULL,
    dex                    TEXT NOT NULL,     -- SolanaPortal dex code (pumpfun|jupiter|meteora|raydium), from dexMapper
    entry_price_sol        NUMERIC NOT NULL,
    entry_price_usd        NUMERIC,
    token_amount_total     NUMERIC NOT NULL,  -- amount bought initially
    token_amount_remaining NUMERIC NOT NULL,  -- decreases with each partial exit
    sol_size               NUMERIC NOT NULL,
    management_mode        trading_mode NOT NULL,   -- locked at open, see note above
    status                 position_status NOT NULL DEFAULT 'open',
    entry_signature        TEXT NOT NULL,
    opened_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at              TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────
-- Exit fills: every partial or full sell against a position,
-- tagged with why it happened.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE exit_fills (
    id                 SERIAL PRIMARY KEY,
    position_id        INTEGER NOT NULL REFERENCES positions(id),
    trigger_type       exit_trigger_type NOT NULL,
    requested_pct      NUMERIC,               -- set for manual_partial (e.g. 30)
    token_amount_sold  NUMERIC NOT NULL,
    sol_received       NUMERIC,
    signature          TEXT,
    executed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Event log: the "never a black box" table. Every decision point —
-- not just trades — writes here, tagged with a correlation_id
-- (signal id or position id) so a full retrace is one query away.
-- Mirrored to rotated JSON files on disk via pino (see logger.ts)
-- so a crash before a DB write still leaves a trail.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE event_log (
    id             BIGSERIAL PRIMARY KEY,
    correlation_id TEXT,
    category       TEXT NOT NULL,     -- signal | execution | exit | manual_action | system | error
    level          TEXT NOT NULL,     -- info | warning | error | success
    message        TEXT NOT NULL,
    context        JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_log_correlation ON event_log(correlation_id);
CREATE INDEX idx_event_log_created_at ON event_log(created_at);
CREATE INDEX idx_positions_status ON positions(status);
CREATE INDEX idx_signal_events_wallet ON signal_events(wallet_id);

-- ─────────────────────────────────────────────────────────────
-- Seed the v1 "default" exit strategy — placeholder numbers,
-- meant to be tuned once live. All wallets fall back to this
-- strategy when strategy_id is null.
-- ─────────────────────────────────────────────────────────────
INSERT INTO exit_strategies (name, stop_loss_pct, timeout_ms) VALUES ('default', 20, 3600000);

INSERT INTO exit_strategy_tiers (strategy_id, tier_order, trigger_pct, sell_portion_pct)
VALUES
    (1, 1, 30,  25),
    (1, 2, 60,  25),
    (1, 3, 120, 25);
