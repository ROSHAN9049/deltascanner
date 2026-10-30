# Delta India Testnet Options Strategy — Phase 1

## Scope

This phase enables a bounded **signal and risk-analysis path** for the Delta India Testnet Options universe. It does not submit option orders. `OPTIONS_EXECUTION_ALLOWED` remains `false` and `options_execution_enabled` remains disabled.

The market quote/Greeks feed is read from Delta India's public API. In Testnet mode each contract symbol is joined to the LIVE Testnet product catalogue by exact symbol; a production product ID is never accepted as a Testnet order identifier.

## Two-sided strategy design

The engine analyses both sides, but this phase remains analysis-only. A candidate may be scored and sized without being eligible to submit an order.

### Long-option BUY

The BUY side is long premium only:

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

### Short-option SELL

The SELL side is a same-expiry vertical credit spread only:

- Bullish underlying signal: sell a PUT and buy a lower-strike PUT wing.
- Bearish underlying signal: sell a CALL and buy a higher-strike CALL wing.
- The protective wing is mandatory and must match the short leg's expiry, option type, and verified Testnet contract multiplier.
- The scan cache keeps separate approximately 0.55, 0.27 and 0.10 absolute-delta buckets so BUY contracts, short legs and protective wings are all discoverable.
- Net credit is short-leg bid less protective-wing ask. Quantity is capped by combined spread max loss plus a fee reserve and by a conservative full-width available-balance reserve.
- Missing product ID, multiplier, commission, quote or balance yields zero contracts. Naked calls/puts remain prohibited.

## Not enabled in this phase

- **No option order placement**, even in Testnet.
- Direct Delta Testnet BUY and paired SELL execution remain locked until single-leg protection and paired-leg fill/cancel/unwind/reconciliation behaviour are verified against the Testnet API.
- Credit spreads are not treated as risk-free; the defined-loss formula includes fee reserves, and a fresh exchange margin check is still required before any entry.
- No changes to Momentum, Scalping, Grid settings, existing positions, or LIVE credentials/mode.

## Gate for Phase 2 execution

Before the execution lock can be changed, a separate reviewed PR must implement and test: Testnet product-ID resolution at order time; idempotent single-leg order submission; fill confirmation; full-premium and fee checks against fresh wallet data; supported Testnet reduce-only exit/protection behavior; one-position cap across all option products; exchange-vs-database reconciliation; expiry/time exits; and recovery from partial fills, rejected protection, restarts and lost acknowledgements. Any unverified capability must continue to block new entries.


## Current release gate

The BUY and SELL analysis engines are implemented in the Draft PR, but the execution constant remains hard false. The running Hostless worker and Main branch are not changed by this draft. A later execution PR must prove, with dedicated Testnet orders, that option product IDs, IOC fills, reduce-only exits, bracket protection, short/wing pairing, partial-fill unwind, and reconciliation work exactly as expected.
