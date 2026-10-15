# Signal Quality Metrics

## 1. Why measure before recalibrating

The scanner writes repeated dd_signals observations. A single symbol/strategy can appear many times during a day, so a raw row count or score histogram is not the same as a count of distinct actionable opportunities. Measure stage, readiness, blockers, correlated events, and recorded closed trades separately before changing any score threshold or gate.

The current Signal frequency report performs counting and grouping inside PostgreSQL. It does not export or transfer millions of dd_signals rows. Its 30-day signal aggregates have no 100,000-row sample limit. The report also inspects all-time signal count and oldest/newest timestamps so observed history coverage is measured rather than assumed.

## 2. Score, stage, readiness, and blockers are different

A score is not proof a signal is action-ready.

- **CONFIRMED stage** is a persisted stage label. Do not assume it guarantees ready=true.
- **ready=true** is the worker's readiness flag.
- **ready=true and an empty blocked_reasons array** is the report's stricter action-ready subset.
- **Unique (symbol, strategy, UTC date) tuples** for ready rows collapse repeated scans within a single day. This is a useful frequency proxy, not a unique entry/trade ID.

The report counts these metrics separately. dd_signals.blocked_reasons and dd_signals.details.blocked are also reported separately: the current engine persistence path writes downstream gate reasons to blocked_reasons, while details.blocked may retain strategy-evaluation reasons. Do not combine the two counts or infer that every reason came from the same stage of evaluation.

## 3. Key counts and the signal-to-action view

The report returns these counts for the rolling 30-day window unless noted otherwise:

1. **Total observations:** all dd_signals rows with captured_at > NOW() - INTERVAL '30 days'. These are repeated observations, not unique trades.
2. **Unique symbols:** distinct non-empty symbols.
3. **CONFIRMED stage:** rows with stage = 'CONFIRMED'.
4. **ready=true:** rows explicitly marked ready by the worker, regardless of the stage label.
5. **ready=true and no blockers:** rows with ready IS TRUE and a JSON array of blockers with length zero.
6. **Unique ready (symbol, strategy) combinations:** distinct combinations with at least one ready observation in 30 days.
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

The report prints aligned human-readable tables and writes signal-frequency-report.json. The separate trade exporter writes selected dd_trades rows to stdout and status messages to stderr. All database scripts use read-only queries and close the pool in a finally block.

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

- The report uses exact aggregate queries for all dd_signals records in the rolling 30-day window; it does not apply the former 100,000-row raw-export limit.
- The all-time signal count and oldest row timestamp measure the retained history currently present in the table. They do not establish the database's retention policy or guarantee that history is never pruned.
- dd_signal_cache remains a latest snapshot per symbol/strategy and is not used as historical signal evidence.
- Daily grouping uses UTC calendar dates. The rolling 30-day window can overlap 31 UTC dates because it begins and ends partway through a day.
- dd_tradetron_events may be empty or may contain events unrelated to outbound signal delivery. Empty event history produces UNKNOWN correlation, not an assertion that no delivery happened.
- Signal-to-event and signal-to-trade correlation uses ±5-minute windows. Repeated same-symbol observations can make a match ambiguous; ambiguous/incomplete correlation is not converted into zero.
- dd_trades contains closed-trade aggregate records. The dd_fills table is not used by the report because the inspected worker path does not write raw exchange fills into it.
- The score distribution excludes missing or out-of-range scores from its band percentages and reports the excluded count separately.
- Block-reason analysis maps known reason types into categories and aggregates unknown reasons into Other/Uncategorized. Engine/downstream reasons and strategy-evaluation reasons remain separate.

## 7. Decision guide

- **Fewer than 2 unique ready tuples/day:** check date coverage and investigate readiness blockers before changing a score.
- **2–8 unique ready tuples/day:** reasonable initial monitoring range; still verify event coverage and recorded trades.
- **More than 8 unique ready tuples/day:** investigate potential over-signaling and duplicate/repeated observations before changing thresholds.
- **CONFIRMED much higher than ready/action-ready:** review gate results rather than assuming a score problem.
- **Event correlation is UNKNOWN or event rows are absent:** investigate webhook configuration, event capture, and linkage; do not interpret UNKNOWN as zero deliveries.
- **Trade correlation is UNKNOWN or no recent closed trades are recorded:** investigate trade-history persistence and linkage separately; remember dd_trades only stores closed-trade aggregates.

These are review guidelines, not automated trading controls. The report makes no live setting changes, and live score/gate recalibration remains on hold until the measured ready-signal data has been reviewed.
