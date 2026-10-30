# Delta India Testnet Options — Phase 3 order ledger

## Scope

Phase 3 adds an isolated durable order-attempt and fill-evidence component for the Options execution ledger introduced by Phase 2. It does not connect the component to the exchange submit path or turn Options execution on.

The module is `worker/execution/delta-options-order-ledger.mjs`. Its only responsibilities are to persist an immutable attempt before a future submit, validate acknowledgement identity, mark ambiguous results as unknown, and aggregate actual fills into durable quantity/VWAP/commission evidence.

## Required ordering

1. A valid Options execution group and leg must already exist in `dd_options_execution_groups` and `dd_options_execution_legs`.
2. `persistAttempt` reads the exact leg by both leg ID and group ID, validates symbol/product/role/side/quantity and explicit reduce-only intent, and inserts a `RESERVED` order-attempt row.
3. The component reads the row back and verifies all immutable fields. No later integration may submit an exchange request unless that durable read-back succeeds.
4. A future submitter must call the dedicated Testnet executor using the persisted client order ID. A transport timeout must become `UNKNOWN`; the same attempt must never be blindly resubmitted.
5. `recordAcknowledgement` accepts only an acknowledgement matching client order ID, exchange order ID, product ID, symbol, side and requested size.
6. `reconcileFills` pages the Testnet fill endpoint with a strict page bound, matches the exact exchange order ID and product/side metadata, deduplicates fill IDs, then records actual filled quantity, weighted-average price and commission evidence.

## State and accounting rules

- Order attempts begin at `RESERVED`.
- Missing, malformed or conflicting acknowledgements must remain unavailable for normal progression and be reconciled.
- An exchange acknowledgement marked `closed` is not treated as proof of a full fill; actual fills determine the quantity and VWAP.
- Unknown commission values remain NULL. Missing fees are never treated as zero.
- Fill quantities exceeding requested quantity are written as `RECONCILIATION_REQUIRED`.
- EXIT and UNWIND attempts must reverse the persisted leg's entry side and explicitly use reduce-only semantics.
- Client order IDs are immutable and idempotent. Reusing one ID with different order details is rejected.

## Not yet implemented

This component is groundwork, not a complete strategy runner. A further phase still must add and test:

- a worker-owned coordinator for BUY entries, protective-first credit-spread entries, short-leg quantity matching and exact excess-wing unwind;
- exchange position/open-order reconciliation against each Options group and leg after restarts;
- durable EXIT/UNWIND attempt progression and short-first spread exits;
- an expiry scheduler that closes before settlement and keeps unresolved groups locked;
- cross-strategy equity/margin reservation against existing Futures and Grid exposures;
- verified India Testnet wallet collateral and fee semantics;
- controlled Testnet order, partial-fill, rejection, timeout, restart, expiry and E-STOP drills.

## Safety state

`OPTIONS_EXECUTION_ALLOWED` remains hard-coded `false`. The Phase 2 manager's `submitReservedOrder` remains a hard stop. This PR does not submit orders, apply Supabase migrations, modify worker settings or credentials, deploy Hostless, or change Futures, Grid, E-STOP or LIVE mode.
