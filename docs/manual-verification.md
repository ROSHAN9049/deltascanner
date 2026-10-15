# Manual Verification Workflows

## Purpose

These workflows run only when manually triggered. They never run on push or on a schedule. They do not affect trading.

Both workflows use Node.js 22 to match the repository's existing CI. The BTC diagnostic calls public market data only. The score-distribution workflow runs a read-only PostgreSQL query and analyzes the exported JSON locally in the runner.

## Workflow 1 — BTC 1h Candle Test

What it does: Fetches `BTCUSD` hourly candles through the existing `DeltaAdapter` and reports metadata only: candle count, timestamp range, total duration, expected hourly span, and median spacing when at least two timestamps are available. It never prints candle payloads.

The adapter currently selects its REST base through `server/config.js`. With the default `DELTA_ENVIRONMENT`, it uses the Delta India production public API at `https://api.india.delta.exchange`. The workflow intentionally does not set `DELTA_API_BASE`, because the adapter does not read that variable.

### Important 1h adapter limitation

`worker/delta-adapter.mjs` currently maps only `1m`, `5m`, and `15m` to their corresponding durations. Any other resolution, including `1h`, falls back to a 300-second request-window calculation, while the original resolution string is still sent to the API. Consequently, `candles('BTCUSD', '1h', 250)` requests only about `(250 + 3) × 300` seconds of history—approximately 21.1 hours—instead of approximately 249 hours between 250 hourly candle timestamps. This workflow diagnoses the existing behavior; it does not modify the adapter.

How to run:

1. Open https://github.com/ROSHAN9049/deltascanner/actions
2. Click **BTC 1h candle fetch test** in the left sidebar.
3. Click **Run workflow** on the right.
4. Leave the defaults (`BTCUSD`, `250`) or adjust them.
5. Click the green **Run workflow** button.
6. Wait for the run to complete and refresh the page.
7. Open the new run and expand **Run BTC 1h candle diagnostic**.
8. Read the JSON summary. The run summary also shows the verdict and candle count.

Interpreting the verdict:

| Verdict | Meaning | Action |
|---------|---------|--------|
| PASS | At least 200 candles were returned and their timestamp range is consistent with approximately one-hour spacing. | The data may be suitable for a separately reviewed full EMA200 regime implementation. |
| INSUFFICIENT | Fewer than 200 candles were returned. | Keep the dashboard's 5m/15m approximation; do not enable a full hourly EMA200 regime yet. |
| WRONG_RESOLUTION | At least 200 candles were returned, but their total timestamp span does not match an hourly series for that candle count. | Investigate the resolution/window behavior before relying on the data. |
| FETCH_FAILED | The adapter could not fetch/validate a candle array, or could not be loaded. A sanitized error is included. | Check the workflow logs and public API availability. |

The diagnostic exits with code zero for all four verdicts so a data limitation is recorded as a result rather than being confused with a workflow infrastructure failure. Review the JSON verdict; a green workflow alone is not a PASS verdict.

## Workflow 2 — Score Distribution

Prerequisite: The repository secret `DATABASE_URL` must be set to the intended Supabase PostgreSQL connection string.

### How to set the secret

1. Open https://github.com/ROSHAN9049/deltascanner/settings/secrets/actions
2. Click **New repository secret** (or edit the existing secret).
3. Set the name to `DATABASE_URL`.
4. Use the PostgreSQL connection string copied from the intended Supabase project's database connection settings. For this project, use the Supabase Transaction Pooler connection string configured for PostgreSQL access.
5. Click **Add secret**.

Do not paste the connection string into source code, issues, workflow logs, or chat. The workflow checks only whether the secret is non-empty and never prints its value.

### How to run

1. Open https://github.com/ROSHAN9049/deltascanner/actions
2. Click **Score distribution analysis**.
3. Click **Run workflow**.
4. Wait for the run to complete.
5. Open the new run and expand **Export signal cache (read-only)** and **Analyze score distribution**.
6. Read the JSON report in the log or workflow summary.
7. Download the `signal-cache-scores` artifact if you need the full exported rows. It is retained for 7 days.

If `DATABASE_URL` is missing, the workflow stops with a clear error that links to the Actions secrets settings page. The export script also checks the variable before importing the PostgreSQL adapter.

### Target distribution

The offline calibration profile is:

- 60% of symbols: scores from 0 to under 40
- 30%: scores from 40 to under 70
- 8%: scores from 70 to under 85
- 2%: scores from 85 to 100

If the report shows more than 10% of symbols in the 85–100 band, review calibration before proposing changes. This profile is an analysis target, not a guaranteed outcome, win rate, forecast, or live trading rule.

## Security Notes

- Both workflows are manually triggered only; neither has a push or schedule trigger.
- The PostgreSQL query is `SELECT symbol, strategy, stage, score, details FROM public.dd_signal_cache ORDER BY score DESC`. The export script never writes to the database.
- `DATABASE_URL` is supplied as an encrypted GitHub Actions secret. The scripts do not print the connection string or redact it into logs; secret-like long hex strings inside `details` trigger a warning without printing those values.
- The score export artifact contains the selected cache columns, including `details`; grant repository access only to people who should be able to inspect this data.
- The BTC workflow calls only the public candle-data endpoint through `DeltaAdapter`. It does not connect to PostgreSQL.
- Neither workflow starts the scanner worker, modifies database rows, submits orders, or triggers any trading action.
