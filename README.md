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

Required variables when enabling the futures bridge:
- `TRADETRON_BRIDGE_ENABLED=true`
- `TRADETRON_AUTH_TOKEN=<fresh Tradetron API auth token>`
- `TRADETRON_SUPPORTED_SYMBOLS=<comma-separated symbols configured in the linked strategy>`
- `TRADETRON_CAPITAL_USD=51.5` for the project's INR 5,000 planning capital (the sizing value is USD, not INR). Change it only by converting the intended INR capital to USD; a fresh exchange rate may be used whenever capital is recalibrated.

The default supported-symbol allowlist matches the inspected 13-symbol strategy: BTCUSD, ETHUSD, AAPLXUSD, ADAUSD, ALGOUSD, AMDBUSD, AMZNXUSD, ATOMUSD, AVAXUSD, BCHUSD, BNBUSD, CBRSBUSD and COINXUSD. This variable only allows symbols already configured in Tradetron; it does not add strategy legs. Signals for symbols outside the allowlist are blocked rather than reported as sent.

For multiple static baskets, set `TRADETRON_BRIDGES_JSON` to a validated JSON array containing each bridge's unique `id`, `symbols` list and unique `authToken`. When set, it fully replaces single-token symbol routing, and entries and exits are sent through the mapped bridge. Configure it only after each Tradetron strategy and its token are created/verified; never put actual tokens in source control or chat. See `docs/tradetron-dynamic-bridge.md` for the format.

Optional:
- `TRADETRON_BASE_URL=https://api.tradetron.tech`
- `TRADETRON_TIMEOUT_MS=10000`

A separate Options route is disabled by default. Only after creating and verifying a dedicated Options strategy in Tradetron, configure:
- `TRADETRON_OPTIONS_BRIDGE_ENABLED=true`
- `TRADETRON_OPTIONS_AUTH_TOKEN=<token linked to that separate Options strategy>`

The futures bridge writes the legacy `<SYMBOL>_q` quantity read by the inspected strategy, plus `<SYMBOL>_qty` for compatibility, entry/exit metadata, the symbol-specific `_el/_es` entry trigger, and `api_buy/api_sell`. On verified webhook-linked Momentum/Scalping futures positions, the scanner can request `_xl/_xs` exits when fresh market marks cross stop/target or max-hold rules. This exit monitor requires Tradetron outbound activity to be configured and the simulated position to be synced back into `dd_positions`; it is not proof of an exchange-side bracket. The auth token is never printed in logs.

In SIGNAL_ONLY mode, outstanding Tradetron entry signals reserve position slots until an authenticated activity event syncs them to a position or close. The scanner enforces a hard maximum of **two total open/reserved slots** (or a lower setting). If outbound activity events are not configured or arrive late, the scanner intentionally pauses new entries once these slots are used rather than risking duplicate or untracked positions.

Keep the Tradetron deployment in **Live Offline** while validating the bridge. Do not switch to Live Auto until the end-to-end signal, symbol routing, quantity, and exit behavior have been verified. Tradetron outbound activity can be posted to `/api/tradetron/webhook` so the scanner can display received fills/events.

### Inbound Tradetron activity endpoint

The scanner has an inbound endpoint for activity events, if a supported sender/relay is configured:

`/api/tradetron/webhook`

Set `TRADETRON_WEBHOOK_SECRET` as a **sensitive Production environment variable in the Vercel `deltascanner` project** (this path is a Vercel serverless function, not a Railway worker endpoint), then redeploy the Vercel project. Configure the sender to provide the same secret as `Authorization: Bearer <secret>` or `x-tradetron-webhook-secret: <secret>`; the `?secret=<secret>` fallback should only be used if the sender cannot set headers. Never put the secret in source control.

Tradetron's current public integrations page advertises outbound webhooks for fills, errors, and kill-switch events to HTTPS endpoints. That confirms the platform advertises an outbound-webhook capability, but the account-specific configuration and payload fields still need a Live Offline test. Confirm that the chosen event type can call `/api/tradetron/webhook` with the configured authentication header. **TT SIGNALS** means the scanner sent a signal to Tradetron; it does not prove a fill occurred. **TT EVENTS** only increases after an authenticated event is received. Keep the Tradetron deployment in **Live Offline** until the signal → execution → event → dashboard round-trip is verified.

The parser accepts JSON and form-encoded payloads and normalizes common event/side field shapes.
