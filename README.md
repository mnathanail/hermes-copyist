# Hermes Copyist

Multi-wallet Solana copy-trading execution engine. You vet and add wallets
manually through the dashboard; Hermes watches them and mirrors their buys,
either fully automatically or with your manual approval, then manages the
exit with a tiered take-profit ladder, stop-loss, and timeout.

Built as a standalone sibling project to [ArgusTrench](../argus-trench) —
where ArgusTrench is a decision engine (discovers and filters candidates),
Hermes is a pure execution layer (you decide which wallets to trust, it
executes faithfully).

## Why this exists

Started from reviewing [ahk780/pumpfun-copy-trading-bot](https://github.com/ahk780/pumpfun-copy-trading-bot)
as a reference. Kept the good ideas (CoinVera for trade signals, SolanaPortal
+ Jito for execution), but rebuilt the parts that mattered for real use:

- **Server-side signing.** The reference implementation stored the raw
  private key in browser `localStorage` and signed transactions client-side.
  Here, the key lives only in the backend process's environment — the
  dashboard never sees it.
- **Persistent, queryable logging.** The reference implementation kept
  trades/positions only in React state — lost on refresh. Every decision
  here is a row in `event_log`, correlated by signal/position ID, mirrored
  to rotated file logs so nothing is lost even if the DB write fails.
- **Multi-wallet from day one**, each with its own nickname/owner and,
  eventually, its own risk profile (see `exit_strategies`).
- **A real risk layer before buying** (dedupe, exposure caps) — the
  reference implementation's only check was "have I seen this mint before."

## Core concepts (v1)

- **Auto / Manual toggle** (global): controls how *new* signals are
  handled. A position's `management_mode` is a **snapshot** taken at open
  time — changing the global toggle later never affects an already-open
  position.
- **Auto mode**: signal → bought immediately with the configured SOL
  amount → exit ladder (tiers, stop-loss, timeout) runs unattended.
- **Manual mode**: signal → dashboard notification with an amount field
  and a Buy button → if bought, the position sits in "Active Trades" with
  **no** automatic exit — you close it yourself, any percentage, any time.
- **Panic sell**: available on every open position regardless of mode —
  always an instant, full, manual close.
- **Exit strategies**: v1 ships one shared "default" ladder for all
  wallets, but the schema already supports per-wallet strategies
  (low/medium/risky presets) as a future data-only change.

## Setup

```bash
cp .env.example .env    # fill in DATABASE_URL, WALLET_PRIVATE_KEY, COINVERA_API_KEY, ...
npm install
npm run migrate         # applies src/db/migrations/001_init.sql
npm run dev
```

## Smoke test (do this before building anything else)

Before trusting the execution layer with a dashboard on top of it, verify
the CoinVera/SolanaPortal/Jito contract against real wallets:

```bash
# Dry run — observes real WS traffic, spends nothing:
SMOKE_TEST_WALLETS=addr1,addr2 npm run smoke-test

# Live — spends ~0.01 SOL on one real buy+sell round trip:
SMOKE_TEST_WALLETS=addr1,addr2 SMOKE_TEST_LIVE=true npm run smoke-test
```

Pick at least 2 actively-trading wallets so the multi-wallet subscribe
(architecturally supported but never tested with 2+ real addresses in
either reference implementation) gets a real check. See
`scripts/smoke-test.ts` for what exactly it verifies.

## Status

Scaffold stage — core services are structured and typed against the
finalized v1 design. The CoinVera / SolanaPortal / Jito wire contract has
been **verified** against a second, server-side reference implementation
by the same original author (see `CLAUDE.md` for the full diff of what
that corrected). Remaining open items before this trades real funds:

- Multi-wallet WS subscribe is architecturally in place but not yet
  smoke-tested end-to-end with 2+ live wallets.
- Risk guard limits and default exit-strategy numbers are placeholders.
- No dashboard frontend yet — API + WS backend only.

See `CLAUDE.md` for full architecture context and the reasoning behind
each design decision, for picking this back up in a future session.
