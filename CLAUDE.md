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

## Provider migration: CoinVera → Helius + Jupiter

**What happened:** CoinVera's dashboard/API domain (coinvera.io) started
returning persistent 502 Bad Gateway errors mid-build, blocking further
development. Research at that point (see below) found CoinVera is a
niche/boutique vendor used mainly by one bot author (ahk780) — **not**
used by any of ~8 other independently-built Solana copy-trading bots
sampled on GitHub, which overwhelmingly converge on **Helius** (RPC +
Enhanced WebSockets) as baseline infrastructure, often paired with
**Shyft** (Yellowstone gRPC) for pre-parsed per-DEX buy/sell events.
Decision: drop CoinVera entirely, rebuild wallet-trade detection and
price lookups on **Helius alone for v1** (chosen over Helius+Shyft
together — Shyft adds real redundancy value but also ~$199/mo and
dual-feed dedup/failover complexity that isn't justified yet for a
personal-scale bot; add Shyft later if parsing maintenance or reliability
actually becomes a problem — see "Escalation thresholds" below).

**The core architectural difference this caused:** CoinVera handed us a
pre-parsed `{trade: 'buy', solAmount, ca, dexs}` event directly. Helius
does not — `transactionSubscribe` delivers full raw transactions matching
watched accounts, and detection logic had to be built from scratch.

**How detection works now (`walletWatcher.ts`):** rather than parsing
DEX-specific instructions (the Shyft-style approach), we compare
`meta.preTokenBalances`/`meta.postTokenBalances` for the watched wallet
across the transaction. Any mint whose balance for that owner *increased*
is a buy. **This is deliberately DEX-agnostic** — it works for any DEX
the wallet trades on, including ones we've never explicitly coded a
parser for, and doesn't depend on trusting a vendor's own trade
classification. `dex` (needed separately, only for routing OUR copy-buy
through SolanaPortal) is resolved by scanning the transaction's account
keys against a static map of known program IDs (`dexMapper.ts`,
`resolveDexFromAccountKeys`).

**Contract confirmed against Helius's official docs**
(helius.dev/docs/enhanced-websockets/transaction-subscribe):
- Endpoint: `wss://mainnet.helius-rpc.com/?api-key=<key>` (unified
  endpoint for standard + enhanced methods, backed by LaserStream; older
  blogs reference `atlas-mainnet.helius-rpc.com`, which may still work
  but isn't the current documented endpoint).
- Subscribe: `{ method: 'transactionSubscribe', params: [{ accountInclude:
  [...], failed: false, vote: false }, { commitment: 'confirmed',
  encoding: 'jsonParsed', transactionDetails: 'full',
  maxSupportedTransactionVersion: 0 }] }`. `accountInclude` supports up
  to **50,000 addresses** — no CoinVera-style "based on your plan" opacity.
- Ack: `{ jsonrpc, result: <subscriptionId>, id }` (standard JSON-RPC
  subscribe pattern, confirmed via docs — unlike CoinVera's ack shape,
  which was never officially documented).
- Notification: `{ method: 'transactionNotification', params: {
  subscription, result: { transaction: { transaction, meta }, signature }
  } }`.
- Helius recommends pinging at least once/minute (10-minute inactivity
  timeout) — we ping every 30s.
- Each `transactionSubscribe` call opens a NEW subscription; Helius warns
  that resubscribing without unsubscribing first causes duplicate
  notifications. `refreshWatchlist()` now unsubscribes (`transactionUnsubscribe`)
  before resubscribing with an updated wallet list.
- **Pricing correction from the initial research pass:** `transactionSubscribe`
  (the Helius-specific extension) requires a **Developer plan ($49/mo)
  or higher** — not available on the free tier. Up to 100 subscriptions
  per connection on Developer, which is far more than needed here.

**Price lookups (`priceService.ts`) — replaced with Jupiter Price API v3**
(confirmed against developers.jup.ag/docs/price): `GET
https://api.jup.ag/price/v3?ids=<mint1>,<mint2>` (or `lite-api.jup.ag`
for the free, unauthenticated, lower-rate-limit tier — used when
`JUPITER_API_KEY` is unset), response `{ <mint>: { usdPrice, decimals,
priceChange24h, blockId } }`. We fetch the target mint + SOL's mint
together and derive `priceInSol = usdPrice(token) / usdPrice(SOL)`.

**KNOWN GAP, flagged not hidden:** Jupiter Price API V3 prices tokens
from last-swapped price, worked outward from reliable tokens like SOL —
very new pump.fun tokens still on the bonding curve (pre-migration to a
real AMM pool) may not be covered yet. `fetchTokenPrice()` returns `null`
in that case, and `smoke-test.ts` explicitly surfaces this if hit rather
than failing silently. **Not fixed in this migration.** The correct fix
if this matters in practice is reading the Pump.fun bonding-curve
account's reserves directly on-chain to compute price ourselves —
tracked as a TODO, not implemented.

**`dexMapper.ts` confidence note:** the Pump.fun program ID
(`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) was confirmed via
Helius's own docs/blog during this migration. The Raydium/Meteora/
Jupiter program IDs in the map are well-known, widely-cited public
constants from general knowledge, NOT independently re-verified in this
session — cross-check against Solscan/each protocol's own docs before
relying on them for real trades, same caution as everything else
unverified in this project.

**`DetectedBuy` shape changed** (simpler than the CoinVera version — dex
resolution now happens once, inside `walletWatcher.ts`, instead of being
deferred to a separate `mapDex()` call in `signalHandler.ts`):
```ts
interface DetectedBuy {
  wallet: WatchlistWallet;
  mint: string;
  solAmount: number; // rough context estimate from the wallet's own SOL
                      // balance delta — NOT used to size our own buy
  dex: string;        // already resolved, ready for executeOrder()
  parentSignature: string;
}
```
The CoinVera-era `sourcePriceInSol` field was dropped — Helius's raw
transaction has no equivalent ready-made price field, and it was
context-only to begin with (our own entry price always comes from
`getActualTokenBalance()` + `fetchTokenPrice()` after OUR buy confirms,
unaffected by this migration).

**Escalation thresholds (from the original vendor-comparison research)
for when to revisit "Helius-only":**
- If parsing/maintenance burden across many DEXs becomes painful → add
  Shyft's Yellowstone gRPC + its documented per-DEX parsers as a second
  detection feed (not a replacement).
- If real redundancy matters more (e.g. the bot starts handling serious
  capital) → run Helius + Shyft in parallel behind a shared internal
  event interface, deduping by signature.
- If Jupiter's pre-migration price gap turns out to matter often →
  implement direct bonding-curve reserve reading as a fallback.

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
    walletWatcher.ts         — Helius transactionSubscribe + balance-delta buy detection, emits 'buy'/'raw'
    dexMapper.ts              — resolves DEX from program IDs seen in a transaction
    priceService.ts          — Jupiter Price API v3 lookup
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
WalletWatcher (Helius transactionSubscribe)
  -> balance-delta detection + dexMapper resolution
  -> emits 'buy' (DetectedBuy: wallet, mint, solAmount, dex, parentSignature)
  -> signalHandler.handleDetectedBuy
       -> writes signal_events row (mode snapshotted)
       -> AUTO: riskGuard check -> solanaExecution.executeOrder -> positions row
       -> MANUAL: WS broadcast to dashboard, waits for POST /api/signals/:id/execute
positionMonitor (every 10s, AUTO positions only)
  -> priceService.fetchTokenPrice (Jupiter)
  -> exitManager.evaluateAutoExit -> may call performExit -> exit_fills row
Active Trades UI (manual positions, and panic button for all)
  -> POST /api/positions/:id/sell  (manual_partial)
  -> POST /api/positions/:id/panic (panic_full)
```

## SolanaPortal / Jito contract — CONFIRMED (unaffected by the CoinVera→Helius migration)

Verified against a second reference implementation's source
(`ahk780/solana-copy-trading-bot`) during the original CoinVera contract
pass. Still accurate — SolanaPortal and Jito are unrelated to the data
provider swap above.

- **SolanaPortal response**: the endpoint returns the base64 unsigned
  transaction as a **bare JSON string**, not wrapped in `{ transaction:
  "..." }`.
- **Jito submission encoding**: the signed transaction must be
  **base58**-encoded, passed as `params: [signedTxBase58]` with no
  `encoding` field.
- **DEX routing**: SolanaPortal's `dex` param is required and
  DEX-specific (`pumpfun`, `jupiter`, `meteora`, `raydium`) — now
  resolved by `dexMapper.ts` from the transaction's own program IDs (see
  "Provider migration" above) rather than from a vendor-supplied label.
  `positions.dex` persists this per-position so exits route to the same
  DEX as entry.
- **Entry price/token amount**: read back AFTER the buy confirms —
  `getActualTokenBalance()` (on-chain SPL balance query, raw BigInt +
  decimals, avoiding float rounding) for `token_amount_total`, and
  `fetchTokenPrice()` (now Jupiter) for `entry_price_sol`/`entry_price_usd`.

## Smoke test

`scripts/smoke-test.ts` — standalone diagnostic script, no DB or dashboard
required. Verifies the Helius/Jupiter/SolanaPortal/Jito contract above
against real wallets before anything else depends on it. Dry-run by
default (observes WS traffic, checks price lookups, executes nothing);
`SMOKE_TEST_LIVE=true` does one real buy→confirm→read-back→sell round
trip with a small amount (`SMOKE_TEST_BUY_AMOUNT_SOL`, default 0.01) on
the first detected buy, then exits. Run with 2+ real wallet addresses.

Required a small architecture change to support this: `WalletWatcher`'s
constructor optionally takes `staticAddresses: string[]`, bypassing
`watchlist_wallets` entirely when provided. Normal app usage (`new
WalletWatcher()` in `index.ts`) is unaffected — it still reads from the
DB as before. `WalletWatcher` also emits a `'raw'` event for every parsed
WS message (subscription ack + every matching transaction, not just
recognized buys), which the smoke test uses to eyeball shape/coverage;
production code only ever listens for `'buy'`.

Also required splitting `tsconfig.json` in two: the base config includes
both `src/**/*` and `scripts/**/*` for typechecking (`tsc --noEmit`,
editors), while `tsconfig.build.json` (used by `npm run build`) restricts
to `src/**/*` with `rootDir: "src"` — `scripts/` isn't part of the
shipped `dist/` output, only run directly via `tsx`.

## Remaining open items

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
- **Jupiter price gap for pre-migration pump.fun tokens** — see
  "Provider migration" above, not fixed.
- **`dexMapper.ts` program IDs beyond Pump.fun** are unverified in this
  session (general knowledge, not re-checked against live docs).
- **Multi-wallet Helius subscribe** is architecturally solid
  (`accountInclude` explicitly supports 50,000 addresses per docs) but
  still worth a real smoke test with the production wallet count.
- **Helius Developer plan ($49/mo) required** for `transactionSubscribe`
  — confirm this is provisioned before expecting the bot to detect
  anything; the free tier is RPC-only.

## Relationship to ArgusTrench

Separate repo, separate DB, no shared code currently. Conceptually
complementary: if ArgusTrench's discovery/veto pipeline ever needs an
execution backend, Hermes's `solanaExecution.ts` + `exitManager.ts`
pattern is the reusable part — but that integration was explicitly
deferred; ArgusTrench and Hermes ship independently for now.
