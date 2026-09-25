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
as a reference. Kept the good ideas (real-time trade signals, SolanaPortal
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
- **Reliable, widely-adopted infrastructure.** Originally built on CoinVera
  (also what the reference bot used), but CoinVera's domain had a
  multi-day outage mid-build. Migrated to **Helius** (transaction
  streaming) + **Jupiter** (pricing) — see `CLAUDE.md` "Provider
  migration" for the full story and why Helius specifically.

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
cp .env.example .env    # fill in DATABASE_URL, WALLET_PRIVATE_KEY, HELIUS_API_KEY, ...
npm install
npm run migrate         # applies src/db/migrations/001_init.sql
npm run dev
```

You'll need a [Helius](https://dev.helius.xyz) API key on at least the
**Developer plan ($49/mo)** — `transactionSubscribe` (how wallet trades
are detected) isn't available on the free tier. `JUPITER_API_KEY` is
optional; leave it blank to use Jupiter's free `lite-api.jup.ag` tier.

## Smoke test (do this before building anything else)

Before trusting the execution layer with a dashboard on top of it, verify
the Helius/Jupiter/SolanaPortal/Jito contract against real wallets:

```bash
# Dry run — observes real WS traffic, spends nothing:
SMOKE_TEST_WALLETS=addr1,addr2 npm run smoke-test

# Live — spends ~0.01 SOL on one real buy+sell round trip:
SMOKE_TEST_WALLETS=addr1,addr2 SMOKE_TEST_LIVE=true npm run smoke-test
```

Pick at least 2 actively-trading wallets (pump.fun/Raydium) for a
realistic check. See `scripts/smoke-test.ts` for what exactly it verifies,
including a check for Jupiter's known pricing gap on pre-migration
pump.fun tokens.

## Status

Scaffold stage — core services are structured and typed against the
finalized v1 design. The Helius / Jupiter / SolanaPortal / Jito wire
contract has been verified against official documentation (see
`CLAUDE.md` "Provider migration" for the full story, including why
CoinVera was dropped). Remaining open items before this trades real funds:

- Multi-wallet Helius subscribe (`accountInclude` supports up to 50,000
  addresses per docs) hasn't been smoke-tested with the actual production
  wallet count yet.
- `dexMapper.ts`'s program-ID map is only independently verified for
  Pump.fun; the rest are well-known constants not re-checked this session.
- Risk guard limits and default exit-strategy numbers are placeholders.
- No dashboard frontend yet — API + WS backend only.
- Jupiter Price API doesn't cover very new, pre-migration pump.fun tokens
  — flagged, not fixed.

See `CLAUDE.md` for full architecture context and the reasoning behind
each design decision, for picking this back up in a future session.
