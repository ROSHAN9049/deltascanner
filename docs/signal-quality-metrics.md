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

- **Reported limit:** 500 MB for the prior free-tier setup. Confirm the current plan and storage meter in Supabase; plan limits and provider accounting can change.
- **Observed old-project footprint:** 2,060,499 rows over about eight days, `dd_signals` table plus indexes about 1,537 MB, `details` JSONB about 504 MB, and `blocked_reasons` about 140 MB. The figures are historical observations from the old project, not a measurement of the new database.
- **Retention is now automatic in the worker** when `DATABASE_URL` exists: the first maintenance run is scheduled five minutes after worker startup, then repeats every six hours. It removes expired `public.dd_signals` rows only, with separate autocommitted deletes in batches of at most 5,000 and a 100 ms pause between full batches.
- **Emergency row-count rule:** if `dd_signals` is above 500,000 rows, the retention task tightens its target to at most three days. The disk monitor also requests three-day retention when physical database size exceeds the critical threshold. If `RETENTION_ENABLED=false`, deletion remains disabled.
- **Physical-size caveat:** standard `VACUUM` lets PostgreSQL reuse dead-row space inside the database but does not return most space to the operating system. The `pg_database_size()` figure may stay high after pruning. The new monitor therefore logs both the current database size and signal row count, and calculates growth per day when a roughly 24-hour-old sample is available.
- **Manual recovery remains available:** run **Diagnose database disk usage** first, then use **Prune dd_signals safely** with `confirm=false` to preview before choosing a confirmed prune. Automatic maintenance does not replace checking the provider's current storage meter.

Never use an improvised `VACUUM FULL` as an emergency action: it takes an exclusive lock and needs temporary disk space for a new copy of the table. Reclaiming physical space from the operating system may require a planned `pg_repack` operation or a dump/restore, neither of which is performed by this worker change.

## 8. Retention & Deduplication

### Implemented worker behavior

- **Auto-retention:** seven days by default, configured through `RETENTION_DAYS`. Runs every six hours, with the first run five minutes after startup, using a direct PostgreSQL pool loaded from `src/ledger/pg-adapter.mjs`. This pool is separate from the scanner's REST database adapter.
- **Emergency retention:** when `dd_signals` exceeds 500,000 rows, retain at most the most recent three days. A database size above `DISK_CRITICAL_MB` also requests three-day retention.
- **Batched deletion:** deletes target only `public.dd_signals`. The batch size is configurable up to 5,000 rows and every full batch is followed by a 100 ms pause. The maintenance path never issues deletes against `dd_trades`, `dd_positions`, `dd_orders`, `dd_tradetron_events`, `position_ledger`, `webhook_events`, or `system_meta`.
- **Deduplication:** five-minute default window through `DEDUP_WINDOW_MINUTES`. The in-memory key is `symbol:strategy`; same score within ±1, same stage, and same side are skipped only while within the window from the last successful insert. Stage or side changes still persist. Cache is process-local and capped by `DEDUP_CACHE_MAX`; a restart intentionally starts cold and stores the first eligible observation.
- **Details trimming:** `trimDetails()` uses a dedicated main-signal allowlist and a separate options allowlist capped at 15 scalar fields. Null/undefined values, nested objects, non-finite numbers, and strings longer than 200 characters are omitted. Main signal details are intended to average below about 200 bytes per row; measure the actual stored JSONB size after deployment because records containing every BTC-regime field may be larger than that target. Options retain their core contract measurements and prioritized route/underlying context within the explicit field cap.
- **Disk monitor:** checks every 30 minutes and logs `[Disk] dd_signals: X rows, db: Y MB`. It warns above `DISK_WARN_MB` (default 400 MB), requests emergency retention above `DISK_CRITICAL_MB` (default 450 MB), and reports growth above 50 MB/day when a baseline sample about 24 hours old is available.
- **Failure policy:** maintenance errors are logged as warnings and do not terminate the scan loop. If `DATABASE_URL` is absent, retention and the disk monitor are disabled; the REST-based scanner continues unchanged. Set `DATABASE_URL` in Railway to the new Supabase PostgreSQL connection string without exposing it in logs.

### Expected impact (estimates, not guarantees)

Baseline measured on the old project:

| Measure | Observed value |
|---|---:|
| Signal rows | 2,060,499 over about eight days |
| `dd_signals` table plus indexes | 1,537 MB |
| `details` JSONB | 504 MB |
| `blocked_reasons` JSONB | 140 MB |
| Estimated full-row footprint | Roughly 780 bytes/row (not the details-column size) |
| Estimated `details` column average | Roughly 257 bytes/row |

After retention, deduplication, and detail trimming are active:

- **Estimated write reduction:** 60–70%, depending on how often scores, stages, or sides change. This is an estimate; the worker's `[Dedup]` counters provide the actual skip rate.
- **Estimated details reduction:** around 22% from the measured 257-byte average is the initial planning estimate, with a target main-signal average below about 200 bytes. Verify with the database diagnostics after real traffic; the trim allowlist by itself does not guarantee every JSON object is under 200 bytes.
- **Combined growth estimate:** approximately 50–60% of the former growth rate. Actual database growth also includes indexes and writes to other tables, so monitor rather than assuming this target is achieved.

### Configuration (environment variables)

| Variable | Default | Effect |
|---|---:|---|
| `RETENTION_DAYS` | `7` | Days of signal history to retain in the ordinary run |
| `RETENTION_ENABLED` | `true` | Master switch for automatic deletion |
| `RETENTION_BATCH_SIZE` | `5000` | Rows per delete batch; values above 5,000 are rejected in favor of the default |
| `DEDUP_ENABLED` | `true` | Enable the in-memory signal-observation cache |
| `DEDUP_WINDOW_MINUTES` | `5` | Window for suppressing unchanged signal observations |
| `DEDUP_CACHE_MAX` | `5000` | Maximum in-memory dedup entries |
| `DISK_WARN_MB` | `400` | Database-size warning threshold |
| `DISK_CRITICAL_MB` | `450` | Threshold that requests three-day retention |

### Troubleshooting

- **Retention does not run:** check Railway has `DATABASE_URL` set for the new Supabase project and search the logs for `[Retention]`. A missing variable disables maintenance but does not stop the scanner.
- **Disk monitor is absent:** check `DATABASE_URL` and search for `[Disk]`. The growth-rate warning appears only after a sample roughly 24 hours old is available.
- **Dedup seems too aggressive:** decrease `DEDUP_WINDOW_MINUTES` or temporarily set `DEDUP_ENABLED=false`. Compare `[Dedup]` skipped/candidate stats and remember that the cache is cold after restarts.
- **Signals appear missing:** the history table intentionally does not persist routine `WATCH` rows. It records eligible `SETUP`/`CONFIRMED` rows, with stage and side changes not suppressed by dedup. Check the cache window and the signal stage before interpreting row count.
- **Details fields are absent:** review the approved main/options allowlists in `worker/strategy.mjs`. Main fields such as RSI/VWAP and redundant BTC trend/reason strings are intentionally omitted; options have their own 15-field cap.
- **Database size stays high after cleanup:** this is expected with normal PostgreSQL vacuum behavior. Check row count and growth rate; `pg_database_size()` may not shrink after deletions.

## 9. Root Cause: Worker Write Rate

The old worker persisted qualifying Momentum/Scalping signal history on each roughly one-minute analysis pass. It also wrote candidate options rows individually. With a broad universe, repeated observations of essentially unchanged signal states created high write amplification. A manual-only pruning workflow could not keep up with the rate at which history accumulated.

The implemented deduplication limits repeated writes for the same `symbol:strategy` when score, stage, and side remain effectively unchanged within the configured window. Changes to stage or side continue to be written so the history still captures signal-state transitions. The disk monitor makes growth visible, while batched retention controls the age of rows left in `dd_signals`.

These are persistence/operations changes only: signal scoring, risk gates, position handling, order handling, and trade logic are not changed by this policy.

## 10. Decision guide

- **Fewer than 2 unique ready tuples/day:** check date coverage and investigate readiness blockers before changing a score.
- **2–8 unique ready tuples/day:** reasonable initial monitoring range; still verify event coverage and recorded trades.
- **More than 8 unique ready tuples/day:** investigate potential over-signaling and duplicate/repeated observations before changing thresholds.
- **CONFIRMED much higher than ready/action-ready:** review gate results rather than assuming a score problem.
- **Event correlation is UNKNOWN or event rows are absent:** investigate webhook configuration, event capture, and linkage; do not interpret UNKNOWN as zero deliveries.
- **Trade correlation is UNKNOWN or no recent closed trades are recorded:** investigate trade-history persistence and linkage separately; remember dd_trades only stores closed-trade aggregates.

These are review guidelines, not automated trading controls. The report makes no live setting changes, and live score/gate recalibration remains on hold until the measured ready-signal data has been reviewed.
