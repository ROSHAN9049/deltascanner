# Delta India Testnet Options Strategy — Phase 1 and Phase 2

## Scope

Phase 1 established a bounded **signal and risk-analysis path** for the Delta India Testnet Options universe. Phase 2 adds an authenticated, manually confirmed Testnet-only order path. It remains disabled by default: `OPTIONS_EXECUTION_ALLOWED` must be explicitly `true` together with `DELTA_EXECUTION_MODE=testnet` and `DELTA_ENVIRONMENT=TESTNET`. Missing or malformed variables keep the gate closed.

The market quote/Greeks feed is read from Delta India's public API. In Testnet mode each contract symbol is joined to the LIVE Testnet product catalogue by exact symbol; a production product ID is never accepted as a Testnet order identifier.

## Long-option setup

The initial candidate-analysis design is long premium first:

- Underlyings: BTC and ETH only, subject to a matching LIVE Testnet product. Delta India's current Options guide lists BTC and ETH; other underlyings stay out until India-specific support and settlement rules are verified.
- Underlying direction: only a CONFIRMED underlying signal with score at least 80.
- Instrument: CALL for bullish direction; PUT for bearish direction.
- Target absolute delta: 0.45–0.65 (existing `analyseOption` policy).
- Expiry: configured 2–14 DTE; option symbols are parsed and settlement time is asset-aware.
- Liquidity: positive bid/ask, spread no wider than the configured threshold, minimum OI and volume (existing settings).
- Anti-chase: existing underlying 24-hour move filter.
- Worker memory: at most 24 selected contracts per underlying, near-the-money within 20%, balanced between calls and puts.

## Risk model

Long option quantity is not sized from a stop-loss percentage of the premium. Maximum loss starts from the **full premium paid**, multiplied by the explicit Testnet product `contract_value`, plus a conservative two-sided taker-fee allowance. Quantity is the smaller of:

1. the configured per-trade risk budget (capped at 0.30% of account equity), and
2. the available-balance limit for the premium and estimated entry fee.

Unknown contract value, fee, ask, equity, or available balance produces quantity zero. No guessed contract multiplier is used.

The strategy continues to display the existing option stop/target reference levels for analysis. They are not treated as exchange-side protection and do not authorize entry.

## Phase 2 — manual Testnet entry controls

The Phase 2 implementation is an **entry-only manual path**. It does not enable automatic Options trading and does not alter Momentum, Scalping, Grid, Futures, existing positions, or any stored risk percentage.

- The API re-resolves the exact LIVE product from the Delta India Testnet catalogue at preview and execution time. Production product IDs are never accepted.
- Every candidate must be fresh, timestamped, CONFIRMED and have a worker-provided `analysisReady` marker. The API obtains a fresh Testnet bid/ask and wallet snapshot; the confirmation token is signed with the Testnet secret, expires after 60 seconds and is single-use.
- Long BUY orders use a Testnet limit order at the fresh ask. Maximum loss includes the full premium, product `contract_value`, and a conservative fee allowance.
- A SELL candidate is accepted only as a vertical defined-risk spread with matching underlying, option type, expiry and multiplier. The protective option BUY limit order must be fully filled before the short SELL limit order is sent. Partial hedge fills are canceled and reduce-only unwound; unknown fill/cancel results retain the hedge for reconciliation. A definitively rejected short triggers a reduce-only market unwind, which is treated as complete only after a full fill is confirmed.
- For a spread, the risk calculation includes both the final vertical-spread loss and the standalone protective-leg premium exposure in case the short leg is not accepted. Unknown product, fee, quote, available balance, equity, fill state or position snapshot blocks the order.
- Maximum allowed loss is the lesser of the pre-existing Options per-trade risk budget and **0.5% of verified account equity**. This hard ceiling does not increase or overwrite the existing Options or Futures risk settings.
- The API checks the existing Options position cap, current Testnet option positions, active/unknown orders and recent fills. Replayed confirmations are rejected by deterministic per-leg client order IDs and a database reservation.
- Both the Hostless API App and Worker must use the Testnet profile. The authenticated API App requires the private Delta Testnet key/secret to sign manual Options orders. Those credentials and `ENGINE_SECRET` must never be placed in the Site.

The feature is still **operationally locked by default**. Keep `OPTIONS_EXECUTION_ALLOWED=false` or absent on both Hostless Worker and API App during deployment and verification. Preview does not require the flag to be enabled; the final execution button and API remain blocked while it is false.

## Not included in Phase 2

- Automatic Options entry, automatic close/expiry management, or unattended overnight risk management.
- Naked short calls/puts or unhedged credit orders.
- Live/production Options order routing.
- Automatic recovery that guesses the state of an ambiguous exchange acknowledgement. Such cases retain protective exposure and require reconciliation before another order.
- Changes to Momentum, Scalping, Grid, Futures settings, risk percentages or existing positions.


## Phase 3 — Isolated Delta India Demo execution

The execution path now has an independent mode selector. The default is fail-closed:

- `OPTIONS_EXECUTION_MODE=disabled`: no Options order routing.
- `OPTIONS_EXECUTION_MODE=demo`: only Delta India Demo/Testnet, only when `DELTA_EXECUTION_MODE=testnet`, `DELTA_ENVIRONMENT=TESTNET`, `OPTIONS_EXECUTION_ALLOWED=true`, the exact REST host is `https://cdn-ind.testnet.deltaex.org`, the dedicated Demo API keypair is configured, and the 60-second exit monitor is enabled.
- `OPTIONS_EXECUTION_MODE=live`: permanently blocked by this build. No live Options route is implemented.

Demo credentials are read only from `DELTA_DEMO_API_KEY` and `DELTA_DEMO_API_SECRET`. They must be generated from the separate Delta Demo account and stored directly in the private Hostless Worker environment. Do not use live-account keys, commit credentials, or paste credentials into chat.

Demo auto-entry has a separate `OPTIONS_DEMO_AUTO_EXECUTE=true` opt-in. Do not turn on global `FULL_AUTO_EXECUTE` for Options Demo testing; that flag remains reserved for existing Futures/global automation and must not be changed for this feature.

The Demo candidate-quality override is separately gated by `ALLOW_MANUAL_OVERRIDE_FOR_TEST=true`. It may log and relax only underlying confirmation/stage, OI, volume, IV Rank/Percentile, regime and target-delta-band analysis filters. The normalized score must still be at least 80. Hard controls remain: approved BTC/ETH contract identity, exact Demo product ID and contract multiplier, valid quote, configured 2–14 DTE, spread no wider than 1.50%, verified account equity and available balance, configured Options loss budget plus 0.5% hard equity cap, daily loss limit, DB trading enabled, E-STOP false, Options strategy enabled, BUY/SELL strategy toggle, strictest of the global and Options-specific open-position caps, SELL protective BUY fill before any short SELL, exchange-side bracket acknowledgement, fill confirmation and exchange position reconciliation.

The market scanner still includes BTC, ETH and XAUT as configured. This India Options executor currently routes only verified BTC and ETH contracts. XAUT Options remain scan-only until the India-specific contract and settlement rules are verified.

Each entry order requests an exchange-side SL/TP bracket. After fill, the executor verifies either explicit bracket data on the parent order or both active reduce-only stop-loss and take-profit child orders returned by the Demo exchange. If neither representation confirms protection, it cancels any still-open parent and reduces the confirmed filled quantity. An ambiguous cancellation or unwind moves the position to reconciliation-required and blocks blind retry. After fill, the executor also verifies the signed contract quantity in the Demo account's Options position snapshot.

The 60-second exit monitor and Demo credentials must remain enabled while any Demo Options position is open, even after setting `OPTIONS_EXECUTION_MODE=disabled` to stop new entries. The Demo transport remains pinned to the Testnet host so existing positions can still be managed; disable the monitor or remove the Demo keys only after the Demo account and `dd_option_positions` have no open/reconciliation-required rows.

Configure both the Hostless `deltascanner-api` Worker and `deltascanner-api-v2` API App with the common Demo execution profile and dedicated Demo keypair, because the Worker poller calls the separate API App preview/execute routes. On the Worker only, additionally set `AUTO_EXECUTE_OPTIONS=true` and `OPTIONS_DEMO_AUTO_EXECUTE=true`; keep `FULL_AUTO_EXECUTE` unchanged. Keep both services on the exact Demo/Testnet URL and do not place Demo keys in the Site service. Leave all live keys and production settings untouched. The environment template keeps `OPTIONS_EXECUTION_MODE=disabled`, Demo credentials empty, `OPTIONS_EXECUTION_ALLOWED=false`, and `OPTIONS_EXIT_MONITOR_ENABLED=false` by default.
