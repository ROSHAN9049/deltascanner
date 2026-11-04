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
