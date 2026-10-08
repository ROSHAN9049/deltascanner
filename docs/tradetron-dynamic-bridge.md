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

Unsupported symbols are blocked before the scanner records a Tradetron signal as sent.

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

## Futures exits

The worker can send a scanner-driven `<SYMBOL>_xl` or `<SYMBOL>_xs` exit trigger only when all of the following are true:

1. The worker is in production `SIGNAL_ONLY` mode and the Tradetron API route is configured.
2. Tradetron's outbound activity webhook has materialized an open row in `dd_positions` with `origin=TRADETRON`.
3. The position is tagged to the scanner's `MOMENTUM` or `SCALPING` engine.
4. Market data is fresh and the scanner observes the configured stop, final target, or maximum holding time.

A submitted exit trigger is recorded to prevent repeated triggers while awaiting the Tradetron activity webhook to confirm the position update/close. This is a signal to Tradetron, not direct Delta order placement. If the outbound webhook is not configured or positions cannot be linked to a scanner engine, automatic scanner-driven exits will not run.

This monitor does not claim exchange-side/Tradetron-side protection exists until verified in actual deployment. Before relying on it, validate one Live Offline entry and one stop/target exit. TP1 partial-close/break-even logic is not implemented by this legacy bridge contract.

## Options are a separate route

The existing futures basket has no Options legs. The scanner's `tt_option_*` variables are not consumed by the existing 13-symbol futures strategy.

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
5. Configure Tradetron's outbound webhook to call the scanner's `/api/tradetron/webhook` endpoint.
6. Confirm a fill/position event appears in the scanner's `dd_tradetron_events` table and that the corresponding open row appears in `dd_positions` with `origin=TRADETRON`.
7. In Live Offline, verify the stop/target exit trigger is consumed and a close event comes back to the scanner.
8. Do not enable Live Auto until the whole signal → position → exit → webhook round-trip and adequate forward-test behavior are verified.

## Known limitations

- A single static 13-symbol Signal Bridge does not cover the full 231+ scanner universe.
- Runtime `tt_symbol` does not choose arbitrary instrument legs in the existing strategy.
- Multiple futures bridges require a deterministic scanner-side symbol-to-bridge/API-token mapping and separate verification.
- Options need a dedicated strategy and separate bridge credentials.
- Tradetron Live Offline uses live prices but does not send exchange orders; do not treat it as evidence of live execution.
