# Delta India Testnet Options — Phase 5 Order Coordinator

## Scope

This phase adds a hard-locked IOC submission coordinator around the existing Phase 2 execution manager, Phase 3 durable order/fill ledger, and Phase 4 restart supervisor.

The coordinator:

1. Checks the source-code Options execution gate and dedicated Testnet executor configuration before any database reservation.
2. Reserves the order attempt through `reserve_dd_options_order_attempt`; Postgres derives the allowed side, quantity and reduce-only flag from the persisted group/leg state.
3. Reads the attempt back by its immutable `client_order_id` and verifies every order identity/size/price field before allowing one IOC request.
4. Persists the exchange acknowledgement and reconciles actual exchange fills into the durable fill ledger.
5. Treats a failed POST as ambiguous, performs one exact `client_order_id` lookup, and durably parks unresolved outcomes. It never blindly retries an ambiguous request.
6. Refuses to resubmit an attempt recovered after an ambiguous reservation or any attempt that is not a fresh `RESERVED` row.
7. Serializes order requests within one execution group in the worker process. The existing worker lease remains the cross-worker serialization control.
8. Updates the restart supervisor to keep checking exact client-order lookups for ambiguous attempts already marked `RECONCILIATION_REQUIRED`.

## Database-enforced entry/exit sequencing

The coordinator delegates sequence and quantity authority to the existing transaction-locked Postgres reservation RPC:

- Credit spread short SELL is rejected unless the protective BUY has confirmed open fills; short quantity is capped to the unmatched protective fill quantity.
- Protective wing exit is rejected until the short leg is exchange-confirmed flat.
- Protective unwind is accepted only after the short entry is terminal and only for unmatched protective quantity.
- Exit/unwind requests are reduce-only and their side/size are derived from persisted fill balances.

This phase does not add the complete automatic strategy state machine that decides *when* to initiate each entry, unwind or exit. It is the durable one-order transport/reconciliation unit required by that later phase.

## Release/safety status

- `OPTIONS_EXECUTION_ALLOWED` remains hard-coded `false`.
- The execution manager still checks the source lock before reserving an order attempt.
- The Delta Testnet Options executor still checks the same lock before its POST.
- The new coordinator is not wired to signal-driven automatic entry, and no order has been submitted.
- No Futures, Grid, E-STOP, dashboard, LIVE setting, Hostless environment variable, Supabase migration, deployment or active position was changed.
- No migration is applied by this PR.

## Remaining blockers

The full entry/exit/unwind state machine, automatic expiry exits, cross-strategy account-wide collateral/margin gate, controlled Testnet fill/reject/timeout/restart drills, XAUT settlement exclusion verification, and independent release review remain outstanding. This PR is not an activation or release PR.
