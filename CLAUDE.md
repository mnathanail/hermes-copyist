# Hermes Copyist — Project Context

This file exists so any future Claude Code session (or human) can pick this
project back up without re-deriving the design decisions below. Read this
before making architectural changes.

## What this is

A standalone Solana copy-trading execution bot, sibling to ArgusTrench but
philosophically opposite: ArgusTrench discovers and filters trade
candidates (hard-gate veto cascade). Hermes does **no discovery or
filtering** — the user manually vets wallets and adds them via the UI.
Hermes's only job is faithful, well-logged execution.

Repo name origin: "Hermes" (Greek god of trade/commerce, fast messenger)
+ "Copyist" (one who copies). Chosen over "Echo" specifically to avoid
Echo's cursed/tragic mythological connotation for something that holds
real funds.

## Origin / reference implementation

Built after reviewing github.com/ahk780/pumpfun-copy-trading-bot in detail
(not just the README — the actual source). That review found:

1. It's a React/TS SPA with a near-empty Express backend (pure WS relay).
   All trading logic — including **private key signing** — happens
   client-side in the browser.
2. `config.privateKey` (raw base58) is stored in **plaintext in
   `localStorage`** (`ConfigPanel.tsx`), despite README claims the key
   "never leaves your device." Technically true it doesn't hit their
   server, but browser localStorage is a bad custody boundary regardless
   (XSS, malicious extensions, etc.). **This was the primary motivation
   for rebuilding rather than forking.**
3. No persistence — positions/trades live only in React state, gone on
   refresh.
4. Single-wallet copy only, no risk/exposure checks beyond an in-memory
   "seen mint" Set.
5. Sequential position-price polling with a fixed delay between each
   check — doesn't scale with position count.
6. Good ideas worth keeping: CoinVera for real-time trade signal
   WebSocket + price data, SolanaPortal for building unsigned Solana
   transactions, Jito for submission.

## Decisions locked during planning (in order)

1. **Standalone project**, not a module inside ArgusTrench.
2. **Backend/worker language**: Node/TypeScript — better Solana SDK
   ecosystem than PHP.
3. **Key custody**: env var (`.env`), loaded once at process boot, kept
   only in memory, never in DB, never logged, never sent to the API/UI
   layer. Explicitly chosen as the "simple, less secure" option for v1 —
   acceptable for personal/single-server use. **If this ever moves to a
   shared or staging server, rotate the key and move to a real secrets
   manager.**
4. **Scope**: multiple wallets from v1 (not single-wallet like the
   reference).
5. **Wallet vetting is manual and out-of-band**: the user finds and
   judges wallets themselves; the system's only job is to copy + manage
   risk on execution, never to discover or score candidates.
6. **`watchlist_wallets.owner`**: nullable free-text nickname for whoever
   controls the wallet. Informational only — never used in execution
   logic, purely for the user's own reference in the UI.
7. **Exit strategy model**: `exit_strategies` + `exit_strategy_tiers`,
   normalized from day one even though v1 ships exactly one shared
   "default" strategy for every wallet. This means low/medium/risky
   presets later are new *rows*, not new *code* — `watchlist_wallets.
   strategy_id` is nullable and falls back to "default".
8. **Exit ladder semantics**: each tier's `sell_portion_pct` is a
   percentage of the position's **current remaining** token amount, not
   the original total — so tiers and manual partial sells compound
   consistently ("sell 25% of what's left").
9. **Auto/Manual toggle is global** (`settings.trading_mode`) and
   controls how *new* signals are handled — it is NOT retroactive.
10. **`positions.management_mode` is a snapshot** taken at position-open
    time. Changing the global toggle later never affects an
    already-open position — explicitly decided over the alternative
    (live-retroactive toggle) as safer: it never silently removes a
    position's automatic stop-loss.
11. **Auto mode**: signal → immediate buy at `settings.
    auto_buy_amount_sol` (default 0.1 SOL) → exit ladder runs
    unattended (tiers, stop-loss, timeout — see `exitManager.
    evaluateAutoExit`).
12. **Manual mode**: signal → dashboard notification (amount field +
    Buy button) → if bought, position appears in "Active Trades" with
    **no automatic exit at all**. User closes it themselves, any
    percentage, any time, via `manualPartialSell`.
13. **Panic sell**: lives in the "Active Trades" section, on every open
    position, regardless of mode. Always instant, always 100% of
    remaining. This is distinct from a manual-mode partial sell — panic
    is the one-button full-close override; manual partial sell is
    "sell exactly X% now."
14. **Logging philosophy — "never a black box"**: every decision point
    (not just trades — ignored signals, risk-guard rejections, mode
    changes) writes to both (a) the `event_log` Postgres table, keyed by
    `correlation_id` (`signal:<id>` or `position:<id>`) for retrace
    queries, and (b) rotated JSON file logs via pino, so a crash before
    a DB write still leaves a trail. See `services/logger.ts`.
15. **DB engine**: Postgres (not SQLite) — chosen for this project
    despite v1's modest scale, for easier future migration path.

## Architecture map

```
src/
  config/env.ts           — all env vars, single source of truth
  db/pool.ts               — pg Pool
  db/migrations/001_init.sql — full v1 schema (see below)
  types/index.ts           — TS types mirroring every table
  services/
    logger.ts              — dual-sink logging (pino file + event_log)
    settingsService.ts      — global trading_mode / auto_buy_amount_sol
    walletWatcher.ts         — CoinVera WS subscription, emits 'buy' events
    priceService.ts          — CoinVera REST price lookup
    riskGuard.ts             — pre-buy checks (dedupe, exposure caps)
    solanaExecution.ts        — build/sign/submit/confirm via SolanaPortal+Jito
    exitManager.ts            — tiers, stop-loss, timeout, manual partial, panic
    positionMonitor.ts         — interval loop, AUTO positions only
    signalHandler.ts           — orchestrates: watcher event -> mode fork -> buy or notify
  api/server.ts             — Express REST + WS broadcast for the dashboard
  index.ts                  — wires everything together, entrypoint
```

Data flow for a detected buy:
```
WalletWatcher (CoinVera WS)
  -> emits 'buy'
  -> signalHandler.handleDetectedBuy
       -> writes signal_events row (mode snapshotted)
       -> AUTO: riskGuard check -> solanaExecution.executeOrder -> positions row
       -> MANUAL: WS broadcast to dashboard, waits for POST /api/signals/:id/execute
positionMonitor (every 10s, AUTO positions only)
  -> priceService.fetchTokenPrice
  -> exitManager.evaluateAutoExit -> may call performExit -> exit_fills row
Active Trades UI (manual positions, and panic button for all)
  -> POST /api/positions/:id/sell  (manual_partial)
  -> POST /api/positions/:id/panic (panic_full)
```

## CoinVera / SolanaPortal / Jito contract — CONFIRMED

Verified by pulling the actual source of a second reference implementation,
`ahk780/solana-copy-trading-bot` (a server-side Node bot by the same author
as the original browser-based reference — NOT the same repo, more mature,
worth knowing about if further contract questions come up). This replaced
several incorrect assumptions made during initial scaffolding:

- **CoinVera WS subscribe**: `{ apiKey, method: 'subscribeTrade', tokens: [...] }`.
  Confirmed correct as originally scaffolded. Caveat: the reference only
  ever populated `tokens` with one address — the array shape strongly
  implies multi-wallet support but hasn't been smoke-tested with 2+ real
  addresses.
- **CoinVera WS trade message** (was wrong — assumed `type`/`side`/
  `walletAddress`/`mint`/`priceInSol` fields that don't exist): actual
  shape is `{ signer, signature, dexs, ca, trade, solAmount, tokenAmount }`.
  `signer` = wallet address, `ca` = mint, `trade` = `'buy'|'sell'`. A buy
  is `trade === 'buy' && solAmount < 0` (negative = SOL leaving the
  signer's wallet). No per-unit price field — see below for how entry
  price/amount are now sourced instead. Subscription ack is a separate
  message shape: `{ type: 'subscribeTrade', status: 'success' }`.
- **CoinVera REST price** (URL was wrong): confirmed
  `GET https://api.coinvera.io/api/v1/price?ca=<mint>`, header
  `x-api-key`, response `{ priceInSol, priceInUsd }`.
- **SolanaPortal response** (was wrong — assumed a `{ transaction: "..." }`
  wrapper): the endpoint returns the base64 unsigned transaction as a
  **bare JSON string**, not wrapped in an object.
- **Jito submission encoding** (was wrong — used base64 + explicit
  encoding param): confirmed the signed transaction must be **base58**-
  encoded, passed as `params: [signedTxBase58]` with no `encoding` field.
- **DEX routing — new requirement, wasn't handled at all originally**:
  SolanaPortal's `dex` param is required and DEX-specific (`pumpfun`,
  `jupiter`, `meteora`, `raydium`) — it can't be hardcoded to `'pumpfun'`.
  CoinVera's `dexs` array (human-readable names like `"Pump.fun"`,
  `"Raydium AMMv4"`) must be translated via `dexMapper.ts` (logic ported
  from the reference's `dexMapper.js`). `positions.dex` now persists this
  per-position so exits route to the same DEX as entry.
- **Entry price/token amount — changed approach**: since the confirmed
  trade message has no price field for OUR trade (only the copied
  wallet's `solAmount`/`tokenAmount`), entry data is now read back
  AFTER the buy confirms: `getActualTokenBalance()` (on-chain SPL
  balance query, raw BigInt + decimals, avoiding float rounding —
  ported from the reference's approach) for `token_amount_total`, and
  `fetchTokenPrice()` for `entry_price_sol`/`entry_price_usd`. This is
  more accurate than the original estimate-from-signal approach anyway.

## Smoke test

`scripts/smoke-test.ts` — standalone diagnostic script, no DB or dashboard
required. Verifies the CoinVera/SolanaPortal/Jito contract above against
real wallets before anything else depends on it. Dry-run by default
(observes WS traffic, executes nothing); `SMOKE_TEST_LIVE=true` does one
real buy→confirm→read-back→sell round trip with a small amount
(`SMOKE_TEST_BUY_AMOUNT_SOL`, default 0.01) on the first detected buy,
then exits. Run with 2+ real wallet addresses specifically to check the
still-unverified multi-wallet subscribe behavior.

Required a small architecture change to support this: `WalletWatcher`'s
constructor now optionally takes `staticAddresses: string[]`, bypassing
`watchlist_wallets` entirely when provided. Normal app usage (`new
WalletWatcher()` in `index.ts`) is unaffected — it still reads from the
DB as before. `WalletWatcher` also now emits a `'raw'` event for every
parsed WS message (not just recognized buys), which the smoke test uses
to eyeball sells/acks/unexpected shapes too; production code only ever
listens for `'buy'`.

Also required splitting `tsconfig.json` in two: the base config now
includes both `src/**/*` and `scripts/**/*` for typechecking (`tsc
--noEmit`, editors), while `tsconfig.build.json` (used by `npm run
build`) restricts to `src/**/*` with `rootDir: "src"` — `scripts/` isn't
part of the shipped `dist/` output, only run directly via `tsx`.

## Remaining open items (not contract-related)

- **Risk guard limits** (`riskGuard.ts`): `MAX_CONCURRENT_POSITIONS` (10)
  and `MAX_TOTAL_SOL_EXPOSURE` (5 SOL) are placeholder numbers.
- **Default exit strategy numbers** (seeded in `001_init.sql`): stop-loss
  20%, timeout 1hr, tiers at +30/+60/+120% selling 25% each time —
  explicitly placeholders per planning conversation ("θα τα βρούμε στην
  πορεία").
- **No dashboard frontend yet.** Backend (API + WS) is scaffolded;
  the UI (wallet management, mode toggle, Active Trades with
  partial/panic sell buttons, pending-signal notifications) is not built.
- **Default slippage (15%) and Jito tip (0.0005 SOL)** in
  `exitManager.ts` / `signalHandler.ts` are hardcoded placeholders, not
  yet wired to per-wallet or per-strategy config.
- **Multi-wallet WS subscribe** is architecturally in place but not yet
  smoke-tested end-to-end with 2+ live wallets (see above).

## Relationship to ArgusTrench

Separate repo, separate DB, no shared code currently. Conceptually
complementary: if ArgusTrench's discovery/veto pipeline ever needs an
execution backend, Hermes's `solanaExecution.ts` + `exitManager.ts`
pattern is the reusable part — but that integration was explicitly
deferred; ArgusTrench and Hermes ship independently for now.
