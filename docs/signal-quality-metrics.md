# Signal Quality Metrics

## 1. Why measure before recalibrating

The scanner writes repeated dd_signals observations. A single symbol/strategy can appear many times during a day, so a raw row count or score histogram is not the same as a count of distinct actionable opportunities. Measure stage, readiness, blockers, correlated events, and recorded closed trades separately before changing any score threshold or gate.

The current Signal frequency report performs counting and grouping inside PostgreSQL. It does not export or transfer millions of dd_signals rows. Its seven-day signal aggregates have no 100,000-row sample limit. The report also inspects all-time signal count and oldest/newest timestamps so observed history coverage is measured rather than assumed.

## 2. Score, stage, readiness, and blockers are different

A score is not proof a signal is action-ready.

- **CONFIRMED stage** is a persisted stage label. Do not assume it guarantees ready=true.
- **ready=true** is the worker's readiness flag.
- **ready=true and an empty blocked_reasons array** is the report's stricter action-ready subset.
- **Unique (symbol, strategy, UTC date) tuples** for ready rows collapse repeated scans within a single day. This is a useful frequency proxy, not a unique entry/trade ID.

The report counts these metrics separately. dd_signals.blocked_reasons and dd_signals.details.blocked are also reported separately: the current engine persistence path writes downstream gate reasons to blocked_reasons, while details.blocked may retain strategy-evaluation reasons. Do not combine the two counts or infer that every reason came from the same stage of evaluation.

## 3. Key counts and the signal-to-action view

The report returns these counts for the rolling 7-day window unless noted otherwise:

1. **Total observations:** all dd_signals rows with captured_at > NOW() - INTERVAL '7 days'. These are repeated observations, not unique trades.
2. **Unique symbols:** distinct non-empty symbols.
3. **CONFIRMED stage:** rows with stage = 'CONFIRMED'.
4. **ready=true:** rows explicitly marked ready by the worker, regardless of the stage label.
5. **ready=true and no blockers:** rows with ready IS TRUE and a JSON array of blockers with length zero.
6. **Unique ready (symbol, strategy) combinations:** distinct combinations with at least one ready observation in 7 days.
7. **Unique ready (symbol, strategy, UTC date) tuples:** the same tuple counted once per day over the last seven days. The report also shows this count divided by seven to provide a daily frequency proxy.
8. **Tradetron event correlation:** a heuristic signal-to-event join on symbol, compatible side when available, and timestamps within ±5 minutes. dd_tradetron_events holds received/synchronized events; an event match is **not proof of outbound delivery**.
9. **Closed-trade correlation:** the report uses dd_trades, not dd_fills, for recorded trade history. A heuristic joins an action-ready signal to a trade by symbol, compatible side when available, and opened_at within ±5 minutes. dd_trades records closed trades, not every raw exchange fill.

When an event or trade table is empty, identifiers are missing, key coverage is poor, or matches are ambiguous, correlation is reported as UNKNOWN rather than assuming zero. The actual table row count remains visible as a separate metric.

## 4. How to run

### GitHub Actions

1. Open the repository's **Actions** tab.
2. Select **Signal frequency report**.
3. Choose **Run workflow** on the main branch.
4. Confirm the repository secret DATABASE_URL is configured. Its value is not printed.
5. Read the run summary and download signal-frequency-report.json from the artifact. The report artifact is retained for seven days.

The workflow is workflow_dispatch only. It does not run on pushes or on a schedule. It uses Node 22 and runs SQL aggregates directly against the database.

### Manual

Set DATABASE_URL in the local environment without putting the connection string in a command or log, then run:

    npm install --no-audit --no-fund
    node scripts/signal-frequency-report.mjs --output=signal-frequency-report.json

To export closed trades separately for manual inspection:

    node scripts/export-trades.mjs > trades.json

The report prints aligned human-readable tables and writes signal-frequency-report.json. It aggregates counts directly in PostgreSQL without exporting raw signal rows. The separate trade exporter writes selected dd_trades rows to stdout and status messages to stderr. All database scripts use read-only queries, except the explicitly confirmed prune script, and close the pool in a finally block.

## 5. Interpreting the numbers

- **CONFIRMED/day** is not the actionable opportunity frequency.
- **ready=true/day** is a repeated-observation count, so it can still be inflated by repeated scans.
- **ready=true and no blockers/day** is a stricter repeated-observation metric.
- **Unique ready (symbol, strategy, UTC date) per day over seven days** is the report's conservative frequency proxy because it collapses repeated scans within a symbol/strategy/day. It may undercount multiple legitimate entries on the same day and must not be treated as a definitive trade count.
- **Recorded dd_trades rows** are aggregate closed-trade records. One trade may refer to multiple entry or exit fill IDs. The source does not record every raw exchange fill as its own row.
- **Tradetron event matches** are heuristic correlations, not confirmation that a signal was delivered or executed.

For the initial 2–8 actionable opportunities/day target, use the seven-day unique ready-tuple metric as a rough measurement—not a performance guarantee or risk recommendation. Below two/day, review data coverage and readiness blockers. At 2–8/day, validate delivery/trade evidence. Above eight/day, investigate possible over-signaling and repeated opportunities before considering any reviewed recalibration.

Do not recalibrate the score from CONFIRMED counts alone. Review readiness, unique ready-tuple frequency, blocker distributions, event-table population, and recorded trade counts together. If confirmed counts are large but ready metrics are small, investigate the gates that separate these counts. If events or trades cannot be correlated reliably, investigate data linkage before interpreting the funnel.

## 6. Coverage and known limitations

- The report uses exact aggregate queries for all dd_signals records in the rolling 7-day window; it does not apply the former 100,000-row raw-export limit.
- The all-time signal count and oldest row timestamp measure the retained history currently present in the table. They do not establish the database's retention policy or guarantee that history is never pruned.
- dd_signal_cache remains a latest snapshot per symbol/strategy and is not used as historical signal evidence.
- Daily grouping uses UTC calendar dates. The rolling seven-day window can touch eight UTC dates because its start and end may fall partway through different days; the report separately shows active UTC dates and uses seven calendar days for the main daily average.
- dd_tradetron_events may be empty or may contain events unrelated to outbound signal delivery. Empty event history produces UNKNOWN correlation, not an assertion that no delivery happened.
- Signal-to-event and signal-to-trade correlation uses ±5-minute windows. Repeated same-symbol observations can make a match ambiguous; ambiguous/incomplete correlation is not converted into zero.
- dd_trades contains closed-trade aggregate records. The dd_fills table is not used by the report because the inspected worker path does not write raw exchange fills into it.
- The score distribution excludes missing or out-of-range scores from its band percentages and reports the excluded count separately.
- Block-reason analysis maps known reason types into categories and aggregates unknown reasons into Other/Uncategorized. Engine/downstream reasons and strategy-evaluation reasons remain separate.



## 7. Disk Management (Free Tier)

- **Reported limit:** 500 MB for the current free-tier plan. Confirm the active plan and actual storage meter in the provider dashboard; plan limits and accounting can vary.
- **Observed write rate:** approximately 250,000 signal rows/day. The reported database size divided by row count suggests roughly 780 bytes per signal observation as a rough, database-wide estimate—not a direct measurement of the dd_signals table row size.
- **Retention policy:** start by measuring the exact rows that would be deleted with a dry run. A 3–5 day policy is only an operational starting point, not a guarantee that the database will fit in 500 MB.
- **Important capacity arithmetic:** 250,000 rows/day × 780 bytes/row is about 195 MB/day. Three days would be about 585 MB before accounting for other tables, indexes and database overhead. Therefore a 3-day retention target may still exceed a 500 MB limit; use the actual table/database-size diagnostics rather than assuming it fits.
- **Weekly manual prune command:** npm run db:prune-signals -- --days=3 --confirm. The command is destructive: first run without --confirm to preview the exact count; add the flag only after reviewing the preview.
- **Emergency run:** if the database remains over 500 MB after a reviewed 3-day prune, run the prune workflow again with days=2, confirm=false first. Inspect the dry-run count and the disk diagnostic before choosing confirm=true.
- **No scheduled cleanup:** prune is manual-only. Neither workflow runs automatically on a schedule.
- The prune script deletes only from public.dd_signals, in small committed batches, and runs VACUUM (ANALYZE) on that same table after rows were deleted. It never targets closed trades, positions, orders, Tradetron events or the position ledger.
- **Vacuum caveat:** standard VACUUM ANALYZE makes deleted-row space reusable by PostgreSQL but usually does not return most of that space to the operating system, so pg_database_size may not drop by the full number of deleted bytes. Check both the before/after report and the hosting provider's storage meter. Do not run VACUUM FULL as an improvised emergency action: it takes an exclusive lock and requires temporary disk space for a new copy of the table.

### Safe GitHub Actions sequence

1. Run **Diagnose database disk usage** and save the reported database size, largest tables, row-age buckets, and payload-size estimates.
2. Run **Prune dd_signals safely** with days=3, batch_size=5000, and confirm=false. This is a dry run; it must delete nothing.
3. Review the exact row count that would be removed. If acceptable, run the workflow again with days=3, batch_size=5000, and confirm=true.
4. Run **Diagnose database disk usage** again and verify table count, database size, and provider-reported storage.
5. Re-run **Signal frequency report** to measure ready/action-ready signal frequency on the seven-day window.

If the pre-prune diagnostic or the dry run fails, do not proceed to the confirmed prune until the error has been understood.

## 8. Root Cause: Worker Write Rate

Approximately 250,000 observations/day is abnormally high for a scanner history table whose intended purpose is to measure actionable signal flow. The current engine inserts signal-history rows for each scanned MOMENTUM/SCALPING candidate whose stage is not WATCH, plus any WATCH row considered ready. With a broad instrument universe and repeated scan cycles, that can create a large history-write rate.

Investigate, without changing live behavior first:

- Whether the worker persists repeated (symbol, strategy) observations on every scan even when score, side, stage, and readiness have not changed.
- Whether the worker has an intended sampling interval or should record only state transitions.
- Whether scan frequency and the instrument universe changed around the period where the database grew rapidly.
- Whether indexes and JSON payloads (details, blocked_reasons) significantly increase the table's actual total relation size.

A possible future fix is to deduplicate identical (symbol, strategy, score) observations within five-minute buckets or store only meaningful transitions. That would require a separate reviewed worker/data design change and measurement plan. **This request does not change worker code, schema, score logic, or write behavior.**

## 9. Decision guide

- **Fewer than 2 unique ready tuples/day:** check date coverage and investigate readiness blockers before changing a score.
- **2–8 unique ready tuples/day:** reasonable initial monitoring range; still verify event coverage and recorded trades.
- **More than 8 unique ready tuples/day:** investigate potential over-signaling and duplicate/repeated observations before changing thresholds.
- **CONFIRMED much higher than ready/action-ready:** review gate results rather than assuming a score problem.
- **Event correlation is UNKNOWN or event rows are absent:** investigate webhook configuration, event capture, and linkage; do not interpret UNKNOWN as zero deliveries.
- **Trade correlation is UNKNOWN or no recent closed trades are recorded:** investigate trade-history persistence and linkage separately; remember dd_trades only stores closed-trade aggregates.

These are review guidelines, not automated trading controls. The report makes no live setting changes, and live score/gate recalibration remains on hold until the measured ready-signal data has been reviewed.
