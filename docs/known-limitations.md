# Known Limitations and Deferred Settings Work

This document describes limitations verified in the Delta scanner source as of 2026-10-20. The active scanner configuration is production-market, signal-only with Tradetron bridge routing. These items are intentionally deferred; this documentation does not change worker or strategy behavior.

## 1. TP1 partial-exit percentage is not enforced by the scanner bridge

**What is not enforced:** The Settings value `dd_settings.tp1_pct` (currently 33%) is persisted and used in the direct-execution code path, but the active Tradetron signal bridge transmits a TP1 *price* (for example, `tt_tp1`). The bridge payload does not instruct Tradetron to close a configured percentage of the position. The bridge monitor does not enforce the 33% partial close itself.

**Why deferred:** Enforcing a partial-exit percentage requires coordinated worker/bridge changes and verification of the corresponding Tradetron strategy behavior. This must not be inferred from the Settings value alone.

**Manual action:** Configure and verify the desired partial-close percentage (currently intended to be 33%) in the relevant Tradetron strategy at its TP1 target. Verify the strategy's quantity/lot rounding and test behavior before relying on it.

## 2. Max-hold timeout does not cover API-only Tradetron snapshot positions

**What is not covered:** The scanner's bridge timeout manager checks eligible stored `dd_positions` ledger rows for Momentum and Scalping. Tradetron positions that appear only in read-only Developer API snapshots, but do not have corresponding eligible ledger rows, are not timed out by this manager. The configured `max_hold_minutes` value therefore does not guarantee a timeout for every position shown by the API.

**Why deferred:** Applying exits directly to snapshot-only positions requires a separately reviewed worker change, including identity, side, age, freshness and duplicate-exit protections.

**Manual action:** Monitor snapshot-only positions in Tradetron and configure the intended time-based exit there. Do not assume the scanner's 240-minute setting automatically closes positions that exist only in API snapshots.

## 3. Sparse-volume fallback is not actually restricted to TESTNET

**What is inconsistent:** A comment in `worker/strategy.mjs` describes the sparse-volume fallback as TESTNET-only, but the fallback inside the shared `analyse()` function has no runtime environment guard. That function is used by the production-market signal-only scanner too, so this fallback can qualify signals in production signal analysis.

**Why deferred:** Adding or changing an environment gate can alter the set of signals emitted in production. That is a signal-behavior change and requires its own safety review and explicit approval.

**Manual action:** Treat the controlled sparse-volume fallback as potentially active in production signal analysis. Review signal gate diagnostics and do not rely on the comment as evidence that the fallback is disabled. No Settings toggle for this behavior is provided.

## 4. There is no per-session force-logout for other browsers

**What is limited:** Lock Session clears the HttpOnly session cookie for the current browser only. Sessions are stateless signed cookies, so there is no session list or per-session revocation control in Settings.

**Why deferred:** Selective revocation requires a server-side session registry or revocation mechanism rather than changing the current stateless cookie flow.

**Manual action:** To invalidate existing signed sessions broadly, rotate the server-side `ENGINE_SECRET` used by the dashboard API and redeploy the affected environment. Update any other components that intentionally share that secret. This is a global invalidation workaround, not a per-browser logout feature; re-authenticate legitimate users afterward.

## 5. `trail_r` is stored but not implemented as a configurable bridge trailing rule

**What is not implemented:** The database schema contains `dd_settings.trail_r` (default 1), but the worker does not read that setting. The signal-only Tradetron bridge monitor does not trail stops. The direct-execution path has its own trailing calculation after TP1, but it is not controlled by `trail_r` and does not establish trailing behavior for active Tradetron bridge positions.

**Why deferred:** A configurable trailing feature needs an explicit strategy design, exit-state validation, duplicate/late-exit handling, and tests. Changing worker behavior is outside this UI/documentation batch.

**Manual action:** If trailing is desired for the active Tradetron strategy, configure and verify that rule on the Tradetron strategy side. Do not rely on the stored `trail_r` value or assume the scanner bridge monitor is trailing stops.

## 6. Tradetron position age requires authenticated entry timestamps

**What is limited:** Read-only Tradetron current-position snapshots do not supply an entry timestamp for each open leg. Scanner snapshot-only positions therefore cannot be assigned a trustworthy age from this data alone.

**Enforcement impact:** Position-age tracking requires authenticated fill/activity records that provide a verified entry time, or another independently trusted position.opened_at. Without that timestamp, the scanner cannot safely establish that a snapshot-only position has exceeded max_hold_minutes; the configured 240-minute value does not guarantee an exit for every position shown by the API.

**Why deferred:** Enforcing timeout exits for snapshot-only positions requires a separately reviewed change to position identity, verified entry-time provenance, market-data freshness and duplicate-exit protection. No such logic is added by this documentation update.

**Manual action:** Continue to monitor current Tradetron positions and configure/verify any required time-based exit within the relevant Tradetron strategy. Do not treat a current-position snapshot as authenticated fill history.

---

## 7. Signal-history retention and Free-tier storage

**Retention default:** The worker retention default changed to 1 day to match the current data lifecycle. The Free tier's 500 MB database-size limit requires aggressive pruning. The worker honors `RETENTION_DAYS` (whole-number values from 1 to 3650) and defaults to 1 when it is unset or invalid. Batches remain capped at 5,000 rows and maintenance failures must not stop the scan loop.

**Monitoring:** Disk monitoring reports physical database size for context, but warning/critical decisions use live `public.dd_signals` row counts: warning above 250,000 rows and critical above 500,000 rows. If more than 50,000 rows are older than one day, the monitor requests 1-day retention. Emergency row-count and critical monitoring paths also request 1-day retention. Only `public.dd_signals` rows are deleted by this retention job; the existing `dd_engine_logs` table receives small run-summary events so `/api/health` and Worker Status can report last run, last success, rows deleted, consecutive failures, and configured retention days.

**Physical-size limitation:** Normal `DELETE` plus `VACUUM ANALYZE` makes dead-row space reusable but does not promise a smaller database file. A lower live-row count therefore does not mean the reported `pg_database_size` will immediately fall. `VACUUM FULL` remains deferred because it can require substantial temporary disk space.

---

## Safety note

The UI may disclose these limits, but it must not imply a deferred feature is enforced. Any implementation of the above items that affects entries or exits requires a separate review and explicit approval.
