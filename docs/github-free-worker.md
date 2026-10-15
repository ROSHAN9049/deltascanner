# Free GitHub Actions scanner worker

This is a **best-effort, free scan-only fallback**, not a guaranteed 24/7 server. The repository is public, so standard GitHub-hosted runner usage is free under GitHub's Actions billing rules. GitHub-hosted jobs have a six-hour maximum; scheduled workflows can also start late or be skipped.

## Safety guarantees

The workflow explicitly sets:

- `DELTA_ENVIRONMENT=SIGNAL_ONLY`
- `TRADETRON_BRIDGE_ENABLED=false`
- `ALLOW_SCAN_ONLY_NO_BRIDGE=true` (accepted only when GitHub Actions is running in SIGNAL_ONLY mode)

That means this workflow updates scanner data but **does not send entry/exit signals to Tradetron**. Direct Delta order execution remains hard-locked. The optional Tradetron Developer API key is used only by the worker's read-only snapshot/notification sync.

Do not change these settings to enable order routing as part of this free-worker setup.

## Add the repository Actions secrets

Open the repository on GitHub, then go to **Settings → Secrets and variables → Actions → New repository secret**. Add these three secrets. Copy the values privately from the existing Railway worker configuration or the original provider dashboard; never paste them into the workflow file, a GitHub issue, or a chat.

| Secret name | Value |
| --- | --- |
| `SUPABASE_URL` | The existing Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | The server-only Supabase service/secret key used by the worker |
| `ENGINE_SECRET` | The existing worker engine secret |

Optional: add `TRADETRON_DEVELOPER_API_KEY` only if the read-only Developer API is already configured. If you do not have its value, leave it unset; it is not required for market scanning.

The workflow never prints secret values. If required secrets are absent, it will skip starting the worker and show a warning in the run log.

## Test it manually

1. Open **Actions → DEALDOST free scanner worker**.
2. Tap **Run workflow**.
3. Select **30** minutes for the first test, then tap **Run workflow**.
4. Open the new run and check its logs for Supabase connectivity, Delta public market API health, and the explicit message that Tradetron routing is disabled.

After the workflow is merged to `main`, scheduled runs are attempted four times daily at 00:17, 06:17, 12:17, and 18:17 UTC. Scheduled sessions are capped at 330 minutes to leave room for setup and shutdown. They are best effort and may leave gaps; keep this limitation in mind when looking at freshness/heartbeat on the dashboard.

Use only one worker at a time. If the Railway worker later becomes active again, stop this fallback or otherwise ensure a single worker owns the engine lease.
