# DealDost + Tradetron Signal Bridge

## Execution boundary

The DeltaScanner worker reads live Delta Exchange India production market data and emits signals only. It does not place direct Delta production orders. Tradetron remains the intended execution / Live Offline layer.

Keep the existing strategy `Signal Bridge - Delta Exchange India (13 symbols)` as a preserved reference until a replacement is validated.

## Existing futures bridge is static

The inspected strategy has a fixed 13-symbol instrument basket; it cannot use an arbitrary `tt_symbol` runtime string as a Position Builder instrument. The worker must not claim that a signal for a coin outside that basket was routed successfully.

The default supported-symbol allowlist is:

`BTCUSD,ETHUSD,AAPLXUSD,ADAUSD,ALGOUSD,AMDBUSD,AMZNXUSD,ATOMUSD,AVAXUSD,BCHUSD,BNBUSD,CBRSBUSD,COINXUSD`

To change the allowlist for a single strategy, set Railway variable `TRADETRON_SUPPORTED_SYMBOLS` to the comma-separated set of futures symbols actually configured in the linked Tradetron strategy. Adding a symbol to this variable does not add a leg to Tradetron; the strategy itself must be updated first.

### Multiple static bridges for a larger universe

When multiple Tradetron basket strategies have actually been created and each has its own API token, configure Railway variable `TRADETRON_BRIDGES_JSON` as a JSON array. When present, it **replaces** the single-token routing/allowlist; do not use a partial route table while expecting fallback to the existing strategy.

Example only (replace placeholder tokens in Railway Variables; never paste actual tokens into chat or source control):

```json
[
  { "id": "bridge-01", "symbols": ["BTCUSD", "ETHUSD"], "authToken": "<TOKEN_FOR_BRIDGE_01>" },
  { "id": "bridge-02", "symbols": ["ADAUSD", "AVAXUSD"], "authToken": "<TOKEN_FOR_BRIDGE_02>" }
]
```

Each route must have a unique ID, unique API token and non-overlapping symbol set. The router validates that every symbol belongs to only one bridge and routes both entry and exit triggers through the same bridge. This is only configuration support: it does not create the Tradetron strategies or add their position-builder legs. Do not configure it until all selected basket strategies and their tokens are verified in Tradetron Live Offline.

Unsupported symbols are blocked before the scanner records a Tradetron signal as sent, and confirmed futures rows are marked `ready=false` with an explicit route blocker before the READY column. Dashboard execution coverage reports active ticker count versus mapped futures symbols without exposing credentials.

## Futures entry contract

For a supported coin, the worker writes quantity and price metadata before raising any entry trigger:

- `<SYMBOL>_q` — quantity consumed by the inspected Signal Bridge.
- `<SYMBOL>_qty` — compatibility alias for the newer scanner contract.
- `<SYMBOL>_ep`, `<SYMBOL>_sl`, `<SYMBOL>_tp` — scanner reference entry, stop and final target.
- `<SYMBOL>_el` — 1 for long entry; otherwise 0.
- `<SYMBOL>_es` — 1 for short entry; otherwise 0.
- `<SYMBOL>_xl` — long exit trigger.
- `<SYMBOL>_xs` — short exit trigger.
- `api_buy` / `api_sell` — legacy global trigger.
- `tt_engine`, `tt_symbol`, `tt_side`, `tt_qty`, `tt_ep`, `tt_sl`, `tt_tp1`, `tt_tp`, `tt_exec_id`, `tt_buy`, `tt_sell` — supplementary runtime metadata; the existing 13-symbol strategy does not dynamically select an instrument from `tt_symbol`.

The strategy's own entry condition remains the final source of truth. Receiving an API variable is not proof of an executed simulated trade.

## Signal-only position cap

The worker enforces a hard maximum of two total open/reserved positions in SIGNAL_ONLY mode, respecting any lower setting. A `PENDING` or `SIGNAL_SENT` Tradetron entry reserves a slot until an authenticated activity event confirms that it became active or closed. When the outbound event hook is not configured or delivery is delayed, new entries may pause at the cap by design. This fail-closed behavior prevents the scanner from continuously adding untracked simulated positions. Configure and test the activity event sender before expecting automatic slot recycling.

## Futures exits

The worker can send a scanner-driven `<SYMBOL>_xl` or `<SYMBOL>_xs` exit trigger only when all of the following are true:

1. The worker is in production `SIGNAL_ONLY` mode and the Tradetron API route is configured.
2. Tradetron's outbound activity webhook has materialized an open row in `dd_positions` with `origin=TRADETRON`.
3. The position is tagged to the scanner's `MOMENTUM` or `SCALPING` engine.
4. Market data is fresh and the scanner observes the configured stop, final target, or maximum holding time.

A submitted exit trigger is recorded to prevent repeated triggers while awaiting an authenticated activity event to confirm the position update/close. This is a signal to Tradetron, not direct Delta order placement. If event delivery is unavailable or positions cannot be linked to a scanner engine, automatic scanner-driven exits will not run.

The inbound endpoint `/api/tradetron/webhook` rejects POST requests until `TRADETRON_WEBHOOK_SECRET` is configured. Because this endpoint is a Vercel serverless function, set the secret as a **sensitive Production environment variable on the Vercel `deltascanner` project**, then redeploy Vercel; setting it only in Railway will not configure this handler. The sender must provide the secret using `Authorization: Bearer <secret>` or `x-tradetron-webhook-secret: <secret>`; `?secret=<secret>` is supported only for senders that cannot set headers and is less preferred because URLs may be logged. Keep the secret out of source control.

Tradetron's current public integrations page advertises outbound webhooks for fills, errors, and kill-switch events to HTTPS endpoints. This confirms the platform advertises outbound webhooks, but does not prove the feature is configured on this account or that the exact position fields needed by this parser are included. Configure the relevant event type to call `/api/tradetron/webhook` with the authentication header, then confirm an actual Live Offline event increments `TT EVENTS` and materializes a position. The current dashboard's zero-event state is not evidence of a round trip.

This monitor does not claim exchange-side/Tradetron-side protection exists until verified in actual deployment. Before relying on it, validate one Live Offline entry and one stop/target exit. TP1 partial-close/break-even logic is not implemented by this legacy bridge contract.

## Options are a separate route

The existing futures basket has no Options legs. The Options scanner is hard-limited to exactly three underlyings: BTC, ETH and Gold (Delta symbol XAUT). It never expands to the 231+ perpetual-futures universe. The scanner's `tt_option_*` variables are not consumed by the existing 13-symbol futures strategy.

Options routing is fail-closed unless these Railway variables are explicitly configured after a dedicated Tradetron Options strategy exists:

- `TRADETRON_OPTIONS_BRIDGE_ENABLED=true`
- `TRADETRON_OPTIONS_AUTH_TOKEN=<token linked to the dedicated Options strategy>`

Do not enable these settings before creating and verifying the appropriate Options BUY and defined-risk Options SELL strategy in Tradetron. Do not route naked/unhedged short options.

## Required Railway variables

Futures:
- `TRADETRON_BRIDGE_ENABLED=true`
- `TRADETRON_AUTH_TOKEN=<token linked to the current futures strategy>`
- `TRADETRON_SUPPORTED_SYMBOLS=<comma-separated symbols actually configured in that strategy>`

Options (only after a separate strategy has been created and validated):
- `TRADETRON_OPTIONS_BRIDGE_ENABLED=true`
- `TRADETRON_OPTIONS_AUTH_TOKEN=<separate strategy token>`

The scanner must not log token values.

## Validation checklist

1. Confirm the relevant Tradetron deployment is Active in **Live Offline**.
2. Confirm a scanner-confirmed, supported-symbol signal appears in Tradetron Runtime Data.
3. Confirm the correct `<SYMBOL>_q` quantity and entry flag are received.
4. Confirm a simulated position is actually created in Tradetron Positions/Statistics.
5. Configure a supported activity sender or relay to call `/api/tradetron/webhook`, with `TRADETRON_WEBHOOK_SECRET` and the required authentication header. Confirm the chosen sender is actually supported; do not assume Tradetron's inbound API automatically emits outbound events.
6. Confirm an authenticated fill/position event appears in `dd_tradetron_events` and that the corresponding row appears in `dd_positions` with `origin=TRADETRON`.
7. In Live Offline, verify the stop/target exit trigger is consumed and a close event comes back to the scanner.
8. Do not enable Live Auto until the whole signal → position → exit → event round-trip and adequate forward-test behavior are verified.

## Known limitations

- A single static 13-symbol Signal Bridge does not cover the full 231+ scanner universe.
- Runtime `tt_symbol` does not choose arbitrary instrument legs in the existing strategy.
- Multiple futures bridges require a deterministic scanner-side symbol-to-bridge/API-token mapping and separate verification.
- Options need a dedicated strategy and separate bridge credentials.
- Tradetron Live Offline uses live prices but does not send exchange orders; do not treat it as evidence of live execution.
