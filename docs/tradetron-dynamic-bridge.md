# DealDost + Tradetron Signal Bridge

The DealDost scanner is a production-market signal engine only. Tradetron is the execution and Live Offline simulation layer. Direct Delta execution is disabled.

## Runtime contract

The worker sends these runtime variables to the linked Tradetron API strategy:

- `tt_symbol` — selected Delta India instrument symbol, for example `BTCUSD` or `XRPUSD`
- `tt_side` — `BUY` or `SELL`
- `tt_qty` — whole-number contracts
- `tt_ep` — scanner reference entry price
- `tt_sl` — scanner stop price
- `tt_tp1` — scanner 1R target
- `tt_tp` — scanner final target
- `tt_exec_id` — DealDost execution/idempotency identifier
- `tt_buy` — 1 for BUY signal, otherwise 0
- `tt_sell` — 1 for SELL signal, otherwise 0

Legacy `api_buy`/`api_sell` variables are reset to 0 in dynamic mode so the legacy two-symbol bridge does not fire accidentally.

## Existing deployed Signal Bridge contract

The current deployed strategy is `Signal Bridge - Delta Exchange India (13 symbols)`. The scanner therefore defaults to the legacy Signal Bridge contract: selected symbol runtime flag + `<SYMBOL>_qty`, `<SYMBOL>_ep`, `<SYMBOL>_sl`, `<SYMBOL>_tp`, followed by `api_buy=1` or `api_sell=1`. The scanner does not require editing the strategy.

The newer `tt_*` dynamic contract remains documented for future strategy variants but is not enabled by default.

## Validation

1. Keep the existing deployment **Live Offline** and Active.
2. Verify a scanner-confirmed signal appears in Tradetron Runtime Data.
3. Confirm the expected legacy `api_buy`/`api_sell` trigger and selected symbol variable appear after a fresh signal.
4. Confirm the deployed strategy has an instrument/position path that uses those variables.
5. Confirm the resulting simulated trade appears in Tradetron Positions/Statistics.
6. Use the outbound webhook endpoint `/api/tradetron/webhook` to send Tradetron activity events back to DealDost so the scanner can display received fills/events.
7. Only after sufficient forward-test performance should the user manually enable Live Auto.

## Important safety rule

The worker is production-market SIGNAL_ONLY. When bridge mode is enabled, it must not place direct Delta orders. The direct Delta private API path is hard-disabled, preventing dual execution.

## Current limitations

Tradetron API OAuth is write-oriented for external signals. The worker does not assume it can query Tradetron positions back into DealDost. Therefore Tradetron must enforce its own duplicate-position, entry, target and stop rules. DealDost keeps its own signal/audit records and blocks duplicate bridge execution IDs.

Tradetron Initialize Variables have lifecycle limitations and cannot be used for list-based strategies, so dynamic instrument selection should use runtime variables/keywords supported by the strategy type.

## Notes

Tradetron Runtime Data confirms that an API variable reached the strategy, but it does not by itself prove that the strategy consumed the variable to open a position. The deployed strategy's own entry conditions and position builder remain the source of truth. Live Offline does not send broker orders; Live Auto later can.

Official Tradetron guidance used for this contract:
- API signals can control a Tradetron strategy while Tradetron handles execution and position management.
- Hybrid Mode allows external API signals plus Tradetron-side target/stop processing.
- Runtime variables can store entry-time values and be reused in exits.
- GET RUNTIME quantity formulas require QTY mode.
