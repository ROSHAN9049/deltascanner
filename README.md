# DealDost Delta India Scanner

TESTNET/Demo-only perpetual futures scanner and Node worker using Delta Exchange India's documented v2 API.

## Required environment
DELTA_ENVIRONMENT=TESTNET
DELTA_TESTNET_API_KEY
DELTA_TESTNET_API_SECRET
ENGINE_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
WORKER_ID (optional)

The production Delta URL is intentionally not an executable option in this build. The adapter rejects any non-TESTNET environment before connecting or placing an order.

## Database
Run db/schema.sql against a dedicated Supabase/Postgres trading database. Do not reuse an unrelated website database.

## Railway worker
Use the repository as the Railway service, Node 22+, start command:
node worker/index.mjs

The browser is monitor/control only. All trading REST calls are server-side in the worker and protected by the database lease.

## Official Delta details verified
Demo REST base: https://cdn-ind.testnet.deltaex.org
Demo public WebSocket: wss://socket-ind-pub.testnet.deltaex.org
Demo private WebSocket: wss://socket-ind.testnet.deltaex.org

Authentication uses HMAC-SHA256 over HTTP method + Unix timestamp + request path + query string + JSON body. client_order_id is limited to 32 characters. Products expose contract_value, tick_size, leverage/notional limits and maker/taker commission rates. Wallet balances are available at /v2/wallet/balances, positions at /v2/positions and /v2/positions/margined, fills at /v2/fills, orders at /v2/orders, and bracket protection at /v2/orders/bracket.

## Strategy
Two closed-candle engines: MOMENTUM and SCALPING. Both use trend/RSI/volume/ATR/anti-chase/BTC-regime/spread/cost gates and require score >= 80 for CONFIRMED. Quantity is integer contracts sized from equity risk and product contract_value, capped by configured 3x notional.

Continuous Mode is ON by default on TESTNET. It removes automatic loss pauses/cooldowns/throttles/daily limit while keeping technical safeguards and a configurable max-open-position cap (default 20). Turning it OFF restores the conservative 3-per-engine / 6-total / 15m cooldown / 90m losing-symbol / 2-loss pause / 3% daily loss / expectancy throttle rules.

## Important assumption
Delta documents size as an integer number of contracts. The current docs consulted do not expose a separate minimum-order-size or size-increment field for perpetuals. Therefore this build uses whole contracts and lets the exchange enforce any additional product-specific minimum. Non-vanilla notional types are skipped by the sizing engine.

An 80% win rate cannot be guaranteed. The implementation is intentionally selective; actual win rate must be measured from real Demo fills after sufficient sample size.

## Scanner parity and hardening (2026-10-01)

The Delta TESTNET worker now follows the same scanner-first operating model as DealDost: separate Momentum (5m) and Scalping (1m) bases with 15m context, normalized/sorted closed-candle history, MACD/RSI/VWAP/ATR/volume/momentum scoring, explicit quality breakdowns, stale market-tick gating, exchange-authoritative reconciliation, and strategy-specific RR handling.

Execution remains TESTNET-only. Every new entry still requires a CONFIRMED signal, risk gates, whole-contract sizing, exchange-side SL/TP protection, and verification of the exact product protection levels before the position is considered managed. LIVE/production execution remains unavailable by design.

Railway HOBBY does not provide Static Outbound IPs. Delta API IP allowlisting therefore remains an infrastructure prerequisite until the worker is moved to a stable-egress environment.
