# Hermes Copyist

Multi-wallet Solana mirror bot for pump.fun and PumpSwap. You pick up to
5 wallets; when one buys, Hermes buys a fixed amount (`BUY_AMOUNT_SOL`,
default 0.1). When that wallet sells, Hermes sells the same percentage of
its own position. One position per token; a second wallet buying the same
token is recorded and shown, not executed.

Sibling to [ArgusTrench](https://github.com/mnathanail/argus-trench):
Argus discovers and filters, Hermes copies faithfully and logs everything.

## Status

| Phase | What | State |
| --- | --- | --- |
| 0 | Repo sync | done |
| 1 | PumpPortal signal source + smoke test | **in progress** |
| 2 | Mirror engine, migration 002, paper executor | — |
| 3 | Dashboard + API auth | — |
| 4 | Paper run (3–7 days) | — |
| 5 | Live via GMGN swap | — |

Until Phase 2 lands, `src/index.ts` still runs the legacy CoinVera watcher
and detects nothing. See `CLAUDE.md` for every design decision and why.

## Smoke test (Phase 1)

Observe only — no DB, no private key, nothing bought:

```bash
npm install
PUMPPORTAL_API_KEY=... \
SMOKE_TEST_WALLETS=addr1,addr2 \
npm run smoke-test
```

It prints every buy/sell with sell %, pool and the target's price, flags
duplicate-token and missing-balance cases, records disconnect windows,
prints a summary every 5 minutes, and writes a JSONL file under `./logs`.
Run it for 24h and compare against each wallet's activity on GMGN/Solscan.

To run it on Railway instead of your machine: a temporary service from
this repo with start command `npm run smoke-test` and the two variables
above; the output is in the service logs.

## Development

```bash
npm test        # unit tests (node:test)
npm run typecheck
npm run build
```

## Why this exists

Started from reviewing
[ahk780/pumpfun-copy-trading-bot](https://github.com/ahk780/pumpfun-copy-trading-bot),
rebuilt for real use: server-side signing (the key never leaves the
backend env), persistent correlated logging (`event_log` + file logs),
multi-wallet from day one, and DB-backed dedupe.
