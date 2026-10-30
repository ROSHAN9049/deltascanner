# Delta India Testnet Options — Phase 2 execution foundations

## Dependency and current state

This branch depends on the Phase 1 analysis PR #108. Phase 1 supplies BUY long-premium analysis and SELL defined-risk vertical credit-spread analysis, full-premium / maximum-spread-loss sizing, and the published India Options fee estimate.

Phase 2 adds three isolated records:
- `dd_options_execution_groups`: one account-wide active Options group.
- `dd_options_execution_legs`: the contract, side, matched quantity, partial fills, entry/exit prices and actual commissions per leg.
- `dd_options_execution_orders`: every ENTRY, EXIT or UNWIND attempt, with a unique client order ID and its own acknowledgement/fill state.

These tables are deliberately separate from `dd_delta_positions`, whose existing reconciler is Futures-only.

## Dedicated Testnet API boundary

`worker/execution/delta-options-executor.mjs` is a separate authenticated REST client. It requires:
- `DELTA_EXECUTION_MODE=testnet`
- `DELTA_TESTNET_OPTIONS_API_KEY`
- `DELTA_TESTNET_OPTIONS_API_SECRET`
- the hardcoded Delta India Testnet REST host

It does not fall back to Futures credentials or production keys. Its read methods are scoped to `call_options,put_options`, with a 50-row cursor page limit. Product IDs are accepted only from the exact LIVE Testnet product catalogue. The automated execution allowlist is BTC/ETH only; XAUT remains excluded until its settlement-currency wallet and margin behaviour are independently verified.

## Order lifecycle design

- BUY: one long CALL for a confirmed bullish underlying signal or one long PUT for a confirmed bearish signal. Maximum loss starts from full premium paid, contract value and fee reserves.
- SELL: a vertical credit spread only. Bullish = short PUT plus lower-strike protective PUT. Bearish = short CALL plus higher-strike protective CALL.
- SELL entry sequence: protective BUY first; wait for terminal acknowledgement and exchange-confirmed fills; then submit the short SELL for no more than the protective leg's confirmed filled quantity.
- A missing/unknown acknowledgement is not retried blindly. It transitions to `RECONCILIATION_REQUIRED`.
- If the short leg partially fills, only the unmatched excess protective contracts are unwound. A zero short fill requires full protective-leg unwind before releasing the group.
- SELL exit sequence: cover the short first; only after confirmed short quantity reaches zero may the protective long be sold.
- Every retry must use a new attempt number and client order ID. Exchange order IDs and fills are reconciled, not inferred from an HTTP response alone.
- An expiry deadline is computed 30 minutes before the symbol's exchange settlement timestamp; the eventual exit manager must reconcile exchange positions and open orders before attempting an expiry close.

## Execution lock and release blockers

`OPTIONS_EXECUTION_ALLOWED` remains source-code `false`. `placeOptionOrder()` checks this lock before validating credentials or making a network request. No Options order was sent, no Supabase migration was applied, no Testnet or LIVE configuration was changed, and no deployment was made.

Before any execution unlock, a further review and controlled Testnet validation must confirm:
1. Dedicated Options API credentials are installed only in Hostless secrets and authenticated product/order/position/fill payloads match the current India Testnet API.
2. Wallet collateral currency and available margin are verified for both BTC/ETH option contracts; XAUT stays blocked until separately verified.
3. An atomic reservation/ledger manager writes the group, both leg rows and each order attempt before network submission, and recovers safely from worker restart/lost acknowledgement.
4. Real order fills and commissions are matched using order ID/client order ID and actual option fills; partial/unwind/exit reconciliation is proven.
5. IOC order behaviour, tick-size rounding, reduce-only close semantics and emergency-stop interaction are verified.
6. Cross-strategy risk limits account for existing Momentum/Scalping/Grid exposures before any Options entry is considered.
7. Expiry exit is tested against the actual settlement schedule; if the close is not confirmed the group remains locked for reconciliation.

This Phase 2 PR is infrastructure and fail-closed execution scaffolding only, not an activation request.
