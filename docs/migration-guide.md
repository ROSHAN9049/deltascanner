# Database Migration Guide

This guide applies the SQL schema and migrations in `ROSHAN9049/deltascanner` to the PostgreSQL database referenced by the GitHub Actions repository secret `DATABASE_URL`. It is designed for the fresh Supabase project. The workflow is manual-only and requires typing `APPLY`.

## 1. First-time setup on a fresh Supabase project

1. Confirm the new Supabase project is running and copy its PostgreSQL connection string from Supabase.
2. In GitHub, open **Settings → Secrets and variables → Actions** and make sure the repository secret named `DATABASE_URL` contains the new project's connection string.
3. Do not put the connection string in source files, workflow inputs, documentation, or logs.
4. Use the manual workflow described in section 3. It runs the base schema first, followed by the ordered migrations below.
5. Review the workflow log and step summary for migration results and the final public-table inventory.

The migration runner never prints the connection string. Files without an internal transaction are applied inside a transaction managed by the runner. The position-ledger migration keeps its existing internal `BEGIN;` / `COMMIT;` block.

## 2. Migration order

The order is hardcoded in `scripts/apply-all-migrations.mjs`. The base schema goes first because later files depend on tables it creates. Files in `db/migrations/` then run in ascending timestamp order.

| Order | File Path | Creates or updates | Internal TX | Idempotent |
|---:|---|---|---|---|
| 1 | `db/schema.sql` | Base scanner tables, settings, positions, orders, trades, fills, signals, caches, engine/lease tables, Tradetron event and developer-history tables, indexes, SQL functions, and RLS/permissions. | No | Mostly yes: tables/indexes use `IF NOT EXISTS`, functions use `CREATE OR REPLACE`, and seed rows use conflict-safe inserts. |
| 2 | `src/ledger/migrations/001_position_ledger.sql` | `position_ledger`, `webhook_events`, `system_meta`, and their indexes. | Yes — preserves its own `BEGIN;` / `COMMIT;` | Yes after the minimal change: table and index creation use `IF NOT EXISTS`; definitions and constraints are unchanged. |
| 3 | `db/migrations/20261010151000_tradetron_event_processing.sql` | Adds/sets event-processing status fields and an index on `dd_tradetron_events`. | No | Yes for its column/index additions; the status update and default/nullability changes are repeatable. |
| 4 | `db/migrations/20261011055500_secure_open_positions_summary_view.sql` | Hardens `dd_open_positions_summary` if that view already exists; revokes public/authenticated access. It does not create the view. | No | Yes — guarded by a view-existence check. |
| 5 | `db/migrations/20261012080000_tradetron_developer_api_sync.sql` | `dd_tradetron_developer_snapshots` and `dd_tradetron_developer_sync_state`, plus RLS and service-role permissions. | No | Yes for table creation and initial state. |
| 6 | `db/migrations/20261013090000_tradetron_developer_notifications_history.sql` | `dd_tradetron_developer_notifications`, `dd_tradetron_developer_notification_sync_state`, `dd_tradetron_developer_pnl_history`, and indexes; applies RLS and service-role permissions. | No | Yes for table/index creation and initial state. |

### Duplicate-object SQLSTATEs

The runner treats these four explicitly approved PostgreSQL SQLSTATE codes as “already exists” and continues to the next migration:

| SQLSTATE | PostgreSQL condition |
|---|---|
| `42P07` | `duplicate_table` |
| `42710` | `duplicate_object` |
| `42P06` | `duplicate_schema` |
| `42701` | `duplicate_column` |

The task brief mentions six codes, but explicitly supplies four. Only these four are ignored by the runner; other errors are not silently suppressed.

When one of these four codes is caught, that migration's current transaction is rolled back and the migration is reported as skipped. All other errors fail the workflow so the actual problem is visible.

## 3. Run via GitHub Actions

1. Open the repository on GitHub and select **Actions**.
2. Choose **Apply migrations**.
3. Click **Run workflow**.
4. In the confirmation input, type exactly `APPLY`.
5. Click **Run workflow** to start the job.

The workflow runs on Node.js 22, has a 10-minute timeout, and can only be started manually. It checks the confirmation input and checks that the `DATABASE_URL` secret is present before running the migration script. Neither check prints the secret value.

The migration progress and public-table inventory appear in the workflow log and in the **Summary** for that run.

## 4. Verify the tables

After the migration loop finishes, the script runs this query and prints the ordered table/view names and count:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

At minimum, the expected names include:

- Core tables: `dd_settings`, `dd_signals`, `dd_positions`, `dd_orders`, `dd_trades`, `dd_fills`, `dd_signal_cache`, `dd_market_cache`, `dd_option_cache`, `dd_engine_logs`, `dd_engine_lease`, and `dd_tradetron_events`.
- Position-ledger tables: `position_ledger`, `webhook_events`, and `system_meta`.
- Tradetron Developer API tables: `dd_tradetron_developer_snapshots`, `dd_tradetron_developer_sync_state`, `dd_tradetron_developer_notifications`, `dd_tradetron_developer_notification_sync_state`, and `dd_tradetron_developer_pnl_history`.

If any expected name is missing, the script prints a warning but exits successfully after an otherwise successful migration run. Review the list against the tables in Supabase before relying on a missing table. The secure-view migration only changes `dd_open_positions_summary` when it already exists.

## 5. Troubleshooting

### A migration reports “Skipped (already exists)”

This means PostgreSQL returned one of the four SQLSTATEs listed above. The runner rolls back that migration's current transaction, logs the skip, and continues. Check the final table inventory if the migration was expected to introduce important schema objects.

### The workflow fails partway through

A genuine error is reported with a sanitized message and the workflow stops. Files without their own transaction are wrapped in a transaction; the position-ledger file manages its own transaction. A failing transaction is rolled back, and later migrations are not attempted.

Fix the underlying database/schema issue, then re-run **Apply migrations** with confirmation `APPLY`. The files are designed to be re-runnable: previously applied tables, columns, indexes, and seed rows are guarded where appropriate. If the same genuine error remains, inspect the failing migration and workflow log before retrying again.

### The database secret is missing or authentication fails

Confirm that the repository secret is named exactly `DATABASE_URL` and points to the intended Supabase project's PostgreSQL connection. Update the secret in GitHub Settings; do not paste its value into an issue, workflow input, source file, or log.

### Expected tables are missing

Review the ordered table list in the workflow summary and confirm that all six files are present in the repository. A non-fatal missing-table warning does not prove that every application feature is ready; resolve any missing table that the running application requires before relying on it.
