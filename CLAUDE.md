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
6. Its data/execution vendors (CoinVera for signals, SolanaPortal for tx
   building, Jito for submission) were initially kept — CoinVera was
   later replaced; see "Provider migration" below.

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

## Direction change (2026-09-25): Hermes becomes a mirror bot

Planned in the "Hermes Mirror — Πλάνο υλοποίησης" doc. Decisions:

16. **Mirror, not ladder.** Buy `BUY_AMOUNT_SOL` (env, default 0.1) when
    a watched wallet buys; when it sells, sell the SAME PERCENTAGE of our
    remaining position. No stop-loss/timeout for now (noted for later).
17. **One position per token.** The wallet that opens it is the
    *leader*; only the leader's buys (re-buys add another
    `BUY_AMOUNT_SOL`, no cap for now) and sells move it. Other wallets'
    trades on that token are recorded as `duplicate_token` /
    `follower_sell` and shown in the UI, never executed.
18. **Fully blind** — no pre-buy filters. Up to 5 wallets.
    pump.fun + PumpSwap only.
19. **Paper mode first**, stored in the DB and shown in the UI.
20. **Signal source: PumpPortal `subscribeAccountTrade`** (same API key as
    ArgusTrench). Chosen over Helius: Helius's `transactionSubscribe`
    needs the $49/mo Developer plan and returns raw transactions we'd
    have to decode; GMGN has no wallet-trade websocket at all (REST
    polling only). PumpPortal is metered (0.01 SOL / 10k events ≈ 0.015
    SOL/month for 5 wallets) and sends decoded buys AND sells.
    Known blind spot: token *transfers* are not trades, so PumpPortal
    doesn't see them — add Helius Free `logsSubscribe` alongside later.
21. **Execution: GMGN** (quote for paper fills, swap for live) — already
    proven in ArgusTrench incl. Token-2022. SolanaPortal goes away.
22. **Railway** hosting; `BUY_AMOUNT_SOL` etc. are Railway variables
    (changing one redeploys, open positions live in the DB).

Note on the previous "CoinVera → Helius + Jupiter" migration: it was
documented here and in the README, but the code never landed in `src/`
(the 2026-09-25 "Railway version" commit only touched docs). It is
superseded by decision 20 and has been removed from these docs.

## Phases

0. Repo sync ✅ (2026-09-25; also fixed package-lock drift that made
   `npm ci` fail)
1. **PumpPortal signal source + smoke test** ← current
2. Mirror engine: migration 002, per-mint queue, PaperExecutor
3. Dashboard + API auth
4. Paper run, 3–7 days
5. Live via GMGN swap

## Signal layer (`src/signals/`, Phase 1)

- `types.ts` — `TradeSignal` (source-agnostic), `SignalSource` interface.
- `pumpPortalEvents.ts` — lenient parser. Required: signature, mint,
  traderPublicKey, txType buy|sell, tokenAmount, solAmount. Bonding-curve
  fields optional because a PumpSwap (`pool: 'pump-amm'`) event hasn't
  been captured yet — Argus's strict parser would drop it silently.
  `sellPct = tokenAmount / (tokenAmount + newTokenBalance)`, 100% if the
  remainder is < 0.1% (dust). Field set confirmed from a real event
  captured by Argus on 2026-09-09 (used as the test fixture; the trader
  is one of our watched wallets).
- `pumpPortalSource.ts` — one websocket, all wallets on it. Ported from
  Argus's `pumpportalConnection.ts` WITH its three incident fixes
  (send-before-OPEN crash, `unexpected-response` listener blocking
  reconnect → 27h deaf, resubscribe on reconnect) plus a ping/pong
  heartbeat for half-open sockets. Emits `disconnected`/`connected`
  status so blind windows can be recorded.
- Tests: `npm test` (node:test via tsx). `*.test.ts` are excluded from
  the build.

## Smoke test (Phase 1 gate)

`scripts/smoke-test.ts` — observe only: no DB, no key, no execution.
`PUMPPORTAL_API_KEY=… SMOKE_TEST_WALLETS=a,b npm run smoke-test`.
Prints every buy/sell (with sell %, pool, target price), flags
duplicate_token / no_position / missing-balance cases, records blind
windows, and writes a JSONL file. Gate: run 24h, then every trade on
GMGN/Solscan for those wallets must be in the file.

The old CoinVera/Helius smoke test (with a live round trip through
SolanaPortal) was removed; live execution is tested in Phase 5 via GMGN.

## Legacy code still in `src/` until Phase 2

`walletWatcher.ts` (CoinVera), `dexMapper.ts`, `priceService.ts`
(CoinVera), `signalHandler.ts`, `solanaExecution.ts` (SolanaPortal) and
the ladder in `exitManager.ts`/`positionMonitor.ts`. `index.ts` still
wires the CoinVera watcher, so the main app does NOT detect anything
until Phase 2 replaces it. `config/env.ts` still requires
`COINVERA_API_KEY`.

## Remaining open items

- API has no auth (Phase 3).
- No dashboard frontend yet (Phase 3).
- Transfers not detected (see decision 20).
- Re-buy cap: none for now, revisit before live.
- Safety net (SL/timeout/kill-switch/daily cap) — decide before live.

## Relationship to ArgusTrench

Separate repo, separate DB, no shared code currently. Conceptually
complementary: if ArgusTrench's discovery/veto pipeline ever needs an
execution backend, Hermes's `solanaExecution.ts` + `exitManager.ts`
pattern is the reusable part — but that integration was explicitly
deferred; ArgusTrench and Hermes ship independently for now.
