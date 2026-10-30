# Delta India Testnet Options Strategy — Phase 1

## Scope

This phase enables a bounded **signal and risk-analysis path** for the Delta India Testnet Options universe. It does not submit option orders. `OPTIONS_EXECUTION_ALLOWED` remains `false` and `options_execution_enabled` remains disabled.

The market quote/Greeks feed is read from Delta India's public API. In Testnet mode each contract symbol is joined to the LIVE Testnet product catalogue by exact symbol; a production product ID is never accepted as a Testnet order identifier.

## Long-option setup

The initial executable candidate design is long premium only:

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

## Not enabled in this phase

- **No option order placement**, even in Testnet.
- No naked short calls/puts.
- Credit spreads remain blocked. A future phase must prove leg pairing, atomic or safely sequenced two-leg entry, partial-fill unwind, combined maximum-loss accounting, exchange-side protection for both legs, and orphan-leg reconciliation.
- No changes to Momentum, Scalping, Grid settings, existing positions, or LIVE credentials/mode.

## Gate for Phase 2 execution

Before the execution lock can be changed, a separate reviewed PR must implement and test: Testnet product-ID resolution at order time; idempotent single-leg order submission; fill confirmation; full-premium and fee checks against fresh wallet data; supported Testnet reduce-only exit/protection behavior; one-position cap across all option products; exchange-vs-database reconciliation; expiry/time exits; and recovery from partial fills, rejected protection, restarts and lost acknowledgements. Any unverified capability must continue to block new entries.
