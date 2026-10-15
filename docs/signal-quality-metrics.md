# Signal Quality Metrics

## 1. Why measure before recalibrating

The scanner writes repeated observations, not one row per unique trade. A score histogram by itself cannot show how many actionable signals survive readiness gates, whether Tradetron received them, or whether an exchange fill was recorded. Establish a measured baseline before changing any score thresholds or gates. This workflow is analysis-only and does not change live trading behavior.

The exports read only the last 30 days. The actual history may be shorter, and the database schema does not establish an automatic 30-day retention policy.

## 2. Score versus readiness

A score is one input to readiness; it is not proof that a signal can be acted on. A row can have a high score but fail a separate gate for direction, RSI/VWAP, volume, anti-chase, candle range, EMA distance, BTC compatibility, spread, estimated cost versus risk, or stop validity. A row labelled CONFIRMED, an accepted Tradetron delivery, and an actual fill are three distinct events and must be counted separately.

The engine persistence path should also be interpreted carefully: dd_signals.blocked_reasons is the persisted gate-reason field, while details.blocked may preserve strategy-evaluation reasons. The report presents these sources separately and does not merge their counts. Consult current worker persistence logic before interpreting either field as exclusively strategy-level or engine-level.

## 3. The six counts

1. **Total observations:** number of exported dd_signals rows. Repeated scans can create multiple rows for the same symbol and strategy.
2. **Unique symbols:** distinct non-empty symbol values in dd_signals.
3. **CONFIRMED observations:** rows whose stage is exactly CONFIRMED. This is an observation count, not a unique-trade count.
4. **CONFIRMED with empty blockers:** confirmed rows that explicitly have ready=true and an empty blocked_reasons field. Missing readiness data is UNKNOWN, not zero.
5. **Tradetron event correlation (proxy):** confirmed/ready signal observations uniquely correlated with dd_tradetron_events using symbol, compatible side when available, and event timestamp within five minutes. That table stores received/synchronized events; a match is not proof of outbound signal delivery. Ambiguous or incomplete correlation is UNKNOWN.
6. **Actual fills (correlated):** recorded dd_fills rows uniquely correlated after delivery using symbol, compatible side when available, and a timestamp heuristic within fifteen minutes of the signal. This is not an order-ID match because the requested event export does not include a shared order identifier. Treat the count as an estimate, not proof of causality.

A position record is not proof of an exchange fill. dd_fills is the more direct recorded-fill source.

## 4. How to run

### GitHub Actions

1. In the repository, open Actions.
2. Select **Signal frequency report**.
3. Choose **Run workflow** on the main branch.
4. Ensure the repository secret DATABASE_URL is configured. The workflow will not print its value.
5. Open the run summary and download the report artifact. Artifact retention is seven days.

The workflow is triggered by workflow_dispatch only; it does not run on pushes or on a schedule.

### Manual

Set DATABASE_URL in the local shell without putting the connection string into a command log, then run:

    npm install --no-audit --no-fund
    node scripts/export-signals.mjs > signals.json
    node scripts/export-fills.mjs > fills.json
    node scripts/export-tradetron-events.mjs > events.json
    node scripts/signal-frequency-report.mjs --signals=signals.json --fills=fills.json --events=events.json

The report prints aligned human-readable tables and writes signal-frequency-report.json. The three exporters write only the selected records as JSON to stdout; diagnostics go to stderr. All database interactions are SELECT-only and the scripts close their pool in a finally block.

## 5. Interpreting results

- **Total observations** measures scan-history volume, not unique trades.
- **Unique symbols** indicates breadth, not actionability.
- **CONFIRMED observations** measures the frequency of the stage emitted by the strategy pipeline.
- **CONFIRMED with empty blockers** requires ready=true as well as no persisted blocker reasons.
- **Tradetron event correlation** uses heuristic correlation and is not proof of outbound delivery. UNKNOWN means the inputs do not support a reliable count; it must not be read as zero events.
- **Recorded fills** are rows in dd_fills. A single trade can generate multiple partial-fill rows, and one signal may not map cleanly to one fill.

The report shows averages over days with observations and a separate full-30-calendar-day average. Review actual oldest-row age, timestamp span, missing timestamp percentages, ambiguous matches, and score validity before using a daily average. Frequencies are provisional when history is short.

The report's quick triage bands are approximately 0–2 CONFIRMED observations per observed day (review gates and coverage), 3–10/day (potentially healthy for initial ₹5,000-capital monitoring), and above 10/day (investigate possible over-signaling). This is a review heuristic, not a performance guarantee or a risk recommendation. Do not recalibrate from frequency alone.

Recalibrate a score only after sufficient history shows a persistent signal-frequency or quality problem and after blocker, correlation, and fill quality have been reviewed. Investigate block reasons instead when most observations are WATCH/SETUP, confirmed-ready counts are low, or one gate accounts for a large proportion of blocks. If CONFIRMED observations materially exceed correlated deliveries or fills, investigate event coverage, routing, and data linkage before changing the score. If fills greatly exceed CONFIRMED observations, check date windows, partial fills, and data integrity before assuming a scanner defect.

## 6. Known limitations

- Exports ask for the last 30 days, capped at 100,000 signal rows and 10,000 rows per fills/events source. Older rows outside the query or records beyond the limit are not included.
- Observed oldest-row age is a measurement of the returned sample, not a guarantee of the configured retention policy.
- dd_signal_cache is a latest snapshot per symbol/strategy and is not used as historical signal evidence.
- Correlation is heuristic: events use a five-minute window, and fill matching uses a fifteen-minute window. Repeated observations for the same symbol can make a match ambiguous.
- The event export has no order ID, and the fill export has no execution ID; direct event-to-fill linkage is therefore unavailable in these exports.
- Tradetron event rows may be missing or incomplete. The table stores received/synchronized events and may not record outbound signal delivery. A match is a proxy, not proof of delivery. Missing identifiers, timestamps, ambiguous matches, insufficient key coverage, or suspicious timestamp gaps produce UNKNOWN rather than a zero count.
- Partial fills can create multiple dd_fills rows for one order or trade.
- The score distribution excludes missing or out-of-range scores from its band percentages; the excluded count is shown separately.
- Exported strings and nested JSON are capped/sanitized to avoid leaking suspicious credential-like values or oversized payloads.

## 7. Decision tree

- **Below 2 CONFIRMED observations/day:** investigate restrictive gates and verify that the history window is long enough.
- **2–8/day:** a provisional healthy-frequency zone for current capital; verify routing and fills before concluding quality is good.
- **Above 8/day:** review over-signaling and consider recalibrating the score or tightening gates only after evidence review.
- **CONFIRMED materially exceeds correlated fills:** investigate routing, Tradetron event coverage, and correlation limitations first.
- **Fills materially exceed CONFIRMED observations:** investigate partial fills, time-window mismatch, and data integrity rather than immediately treating it as a strategy problem.

The decision-tree thresholds are a conservative operational guide and differ slightly from the quick triage bands above; neither is an automated trigger to change live behavior.
