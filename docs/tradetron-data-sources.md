# Tradetron Trade Data Sources — limits and practical path

Last reviewed: 2026-10-17

## What the current Developer REST API gives this scanner

The scanner currently allowlists only the read-only endpoints for deployments, deployment positions, and notifications. A position row observed in production exposed only `instrument`, `quantity`, `open`, `ltp`, and `pnl`. It did not provide side, entry/exit prices, an opened/closed timestamp, an order/execution ID, or fee details. The API client does not assume undocumented `/trades` or `/history` paths exist; their availability and schema remain unverified.

The worker overwrites `dd_tradetron_developer_snapshots` with the latest snapshot on each poll. Deployment P&L history is aggregate, not per-trade. Therefore historical fills cannot be backfilled from the scanner's current snapshot/notification data alone.

## 1. Tradetron “Download Data” CSV

The official FAQ describes a “Download Data” link in the right-side menu for each strategy block on the Deployed Page. It says the download is a CSV containing all positions the engine took for that strategy: [Tradetron FAQ](https://tradetron.tech/faq).

The public FAQ does **not** document the CSV column schema. We have not yet inspected a real downloaded file for this account, so entry/exit fields must not be promised until the actual header row is checked.

### Suggested weekly manual workflow

1. Open Tradetron's Deployed Page.
2. For each relevant deployment, open its right-side menu and choose **Download Data**.
3. Save the original CSV and keep the filename/date for audit.
4. Review its header and rows locally for symbol, deployment identity, explicit side, quantity, entry/exit prices, P&L, and timestamps. Do not assume an absent column.
5. Upload the file to the scanner project's secure/private operational environment, or place it in a private repository workflow artifact. Do not upload a CSV with account data into a public issue or public repository.
6. Run a dry-run first: `node scripts/import-tradetron-csv.mjs ./tradetron-download.csv --deployment-id=YOUR_DEPLOYMENT_ID`.
7. Only after verifying the displayed accepted/skipped counts and field mappings, run with `--apply` from an environment where `DATABASE_URL` is securely configured. The script writes only `dd_api_derived_trades`, deduplicates by a deterministic fingerprint, and can enrich an unverified API row only when one uniquely matching close timestamp lies within 15 minutes.
8. Keep a copy of the original CSV. Share a sanitized sample header plus 2–3 representative rows (no credentials/account secrets) so the parser can be tailored to the exact format.

The importer accepts common CSV aliases, but the actual Tradetron column names have not been validated against a supplied account CSV. Unsupported/missing explicit P&L rows are skipped rather than assigned zero. It never creates records in `dd_trades`, never infers a missing side/price, and always forces `is_verified=false`.

## 2. Tradetron MCP integration

Tradetron publishes a separate MCP connector: [MCP setup guide](https://mcp.tradetron.tech/docs). Its documented setup uses the connector URL `https://mcp.tradetron.tech/mcp` and an OAuth 2.0 authorization-code flow with PKCE using the user's Tradetron login. This is a separate connection; it is **not authenticated by the existing Developer REST API bearer key** and needs its own user-authorized setup.

Published MCP tools include notification/report tools such as `tt_get_strategy_notifications`, `tt_get_strategy_broker_log`, and `tt_export_reports`. Notification feeds are high-level engine notices; broker-log/report exports may include more detailed order or broker outcomes and are worth inspecting next. This scanner has not connected the user's account to Tradetron MCP, so actual fields, per-strategy permissions, downloadable report columns, and whether the broker log includes every fill are not yet verified. Do not label MCP notifications as fills without confirming their content and source semantics.

## 3. Recommended path

- **Short term:** continue recording poll-transition observations into `dd_api_derived_trades`. Every record remains unverified and carries a data-quality label. This provides forward-looking API observations, not a reliable historical trade ledger.
- **Medium term:** manually download the CSV weekly and import only after confirming the actual columns. Use the dry-run, preserve the source file, and request a sanitized sample to harden the parser. A CSV record with explicit entry and exit prices is labelled `FULL` for field completeness only; `is_verified` remains false until provenance and meaning are independently authenticated.
- **Long term:** request from Tradetron a documented authenticated trade-detail/fills endpoint containing deployment/strategy ID, instrument, side, closed quantity, entry and exit fills/prices, timestamps, fees/commission, currency/units, and stable trade/order/execution IDs. Ask for documented P&L semantics and pagination/retention guarantees.

## P&L anomaly note

A row-level `pnl` is displayed as raw and unverified. A heuristic that flags `abs(pnl) > abs(quantity * ltp) * 0.5` is an investigation aid only; contract multipliers, currency/unit differences, cumulative P&L, and symbol mapping can invalidate a simple notional comparison. The scanner marks the row and logs it, but does not hide or rewrite it.
