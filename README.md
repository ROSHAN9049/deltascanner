# DealDost Delta India Scanner

Production-market signal-only perpetual futures scanner and Node worker using Delta Exchange India's documented v2 API. The scanner reads live Delta India market data and sends signals to Tradetron; it never places direct Delta production orders.

## Required environment
DELTA_ENVIRONMENT=SIGNAL_ONLY
ENGINE_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
WORKER_ID (optional)

Tradetron bridge execution additionally requires:
TRADETRON_BRIDGE_ENABLED=true
TRADETRON_AUTH_TOKEN

The production Delta public market API is the only market-data endpoint used in SIGNAL_ONLY mode. Private Delta execution is structurally disabled.

## Database
Run db/schema.sql against a dedicated Supabase/Postgres trading database. Do not reuse an unrelated website database.

## Railway worker
Use the repository as the Railway service, Node 22+, start command:
node worker/index.mjs

The browser is monitor/control only. Production market-data calls are server-side in the worker and protected by the database lease. Tradetron owns any simulated/live execution.

## Official Delta details verified
Production REST base: https://api.india.delta.exchange
Production public WebSocket: wss://public-socket.india.delta.exchange

Authentication uses HMAC-SHA256 over HTTP method + Unix timestamp + request path + query string + JSON body. client_order_id is limited to 32 characters. Products expose contract_value, tick_size, leverage/notional limits and maker/taker commission rates. Wallet balances are available at /v2/wallet/balances, positions at /v2/positions and /v2/positions/margined, fills at /v2/fills, orders at /v2/orders, and bracket protection at /v2/orders/bracket.

## Strategy
Two closed-candle engines: MOMENTUM and SCALPING. Both use trend/RSI/volume/ATR/anti-chase/BTC-regime/spread/cost gates and require score >= 80 for CONFIRMED. Quantity is integer contracts sized from equity risk and product contract_value, capped by configured 3x notional.

Continuous Mode is ON by default on TESTNET. It removes automatic loss pauses/cooldowns/throttles/daily limit while keeping technical safeguards and a configurable max-open-position cap (default 2). Turning it OFF restores the conservative 3-per-engine / 6-total / 15m cooldown / 90m losing-symbol / 2-loss pause / 3% daily loss / expectancy throttle rules.

## Important assumption
Delta documents size as an integer number of contracts. The current docs consulted do not expose a separate minimum-order-size or size-increment field for perpetuals. Therefore this build uses whole contracts and lets the exchange enforce any additional product-specific minimum. Non-vanilla notional types are skipped by the sizing engine.

An 80% win rate cannot be guaranteed. The implementation is intentionally selective; actual win rate must be measured from real Demo fills after sufficient sample size.

## Tradetron Signal Bridge

Tradetron integration is production-market / signal-only. The scanner never places direct Delta production orders. Tradetron Live Offline is the intended forward-test execution layer. When enabled, confirmed scanner entries are sent to the deployed Tradetron API-controlled Signal Bridge instead of placing a direct Delta order from the worker. This prevents dual execution paths.

Bridge mode also removes the worker's dependency on Delta private API credentials: the worker reads public Delta market data, while Tradetron owns authenticated execution. This is intended to avoid Delta API IP-whitelist coupling on a cloud worker whose outbound IP may change. See `docs/tradetron-dynamic-bridge.md` for the runtime contract and validation sequence.

Required variables when enabling the bridge:
- `TRADETRON_BRIDGE_ENABLED=true`
- `TRADETRON_AUTH_TOKEN=<fresh Tradetron API auth token>`

Optional:
- `TRADETRON_BASE_URL=https://api.tradetron.tech`
- `TRADETRON_TIMEOUT_MS=10000`

The legacy bridge writes `<SYMBOL>=1` for the selected basket member, `<SYMBOL>_qty`, `<SYMBOL>_ep`, `<SYMBOL>_sl`, `<SYMBOL>_tp`, and the deployed strategy's global trigger `api_buy=1` or `api_sell=1`. The scanner uses this exact legacy Signal Bridge contract by default because the existing deployed strategy is a fixed Signal Bridge basket. The auth token is never printed in logs.

Keep the Tradetron deployment in **Live Offline** while validating the bridge. Do not switch to Live Auto until the end-to-end signal, symbol routing, quantity, and exit behavior have been verified. Tradetron outbound activity can be posted to `/api/tradetron/webhook` so the scanner can display received fills/events.
