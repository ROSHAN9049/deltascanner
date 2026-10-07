# DealDost + Tradetron Dynamic Bridge

This build keeps the DealDost scanner as the signal engine and Tradetron as the TESTNET execution/position-management layer.

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

## Required Tradetron setup

1. Link the Tradetron strategy through API OAuth.
2. Set **Hybrid Mode = Yes** when the strategy contains Tradetron-side target/stop/repair logic.
3. Configure the strategy to read the runtime variables above with **Get Runtime / Get Runtime Number**.
4. Configure the traded instrument from `tt_symbol` using Tradetron's runtime/traded-instrument keywords.
5. Configure the position builder to use **QTY**, not LOTS or VALUE, when quantity is read from `tt_qty`.
6. Use `tt_buy > 0` and `tt_sell > 0` as the external entry triggers.
7. Store the entry-time SL/TP values in runtime variables or use them directly in the appropriate position/exit logic.
8. Reset the trigger variables to 0 after the entry/exit cycle so the same signal cannot loop.
9. Keep the Tradetron deployment in **Live Offline** or **Paper Trade** while validating signal reception, instrument routing, quantity and exits.
10. Only after end-to-end TESTNET validation should execution be considered for unattended operation.

## Important safety rule

The worker is TESTNET-only. When bridge mode is enabled, it must not also place direct Delta orders. The direct Delta private API path remains disabled by the bridge branch, preventing dual execution.

## Current limitations

Tradetron API OAuth is write-oriented for external signals. The worker does not assume it can query Tradetron positions back into DealDost. Therefore Tradetron must enforce its own duplicate-position, entry, target and stop rules. DealDost keeps its own signal/audit records and blocks duplicate bridge execution IDs.

Tradetron Initialize Variables have lifecycle limitations and cannot be used for list-based strategies, so dynamic instrument selection should use runtime variables/keywords supported by the strategy type.

## Validation sequence

Use this order:

1. API token linked to the intended strategy.
2. Hybrid Mode enabled if Tradetron-side exits are used.
3. Live Offline/Paper deployment active.
4. Confirm runtime variables appear after a safe test entry.
5. Confirm `tt_symbol` selects the intended instrument.
6. Confirm QTY equals `tt_qty`.
7. Confirm SL/TP values are the intended TESTNET values.
8. Confirm trigger reset prevents repeated entries.
9. Test one BUY and one SELL on a low-risk TESTNET instrument.
10. Only then enable `TRADETRON_DYNAMIC_BRIDGE_ENABLED=true`.

Official Tradetron guidance used for this contract:
- API signals can control a Tradetron strategy while Tradetron handles execution and position management.
- Hybrid Mode allows external API signals plus Tradetron-side target/stop processing.
- Runtime variables can store entry-time values and be reused in exits.
- GET RUNTIME quantity formulas require QTY mode.
