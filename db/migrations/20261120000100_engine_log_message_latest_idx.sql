-- Support the dashboard and health endpoint's latest-row lookups by exact log message.
-- The prior created_at-only index forced Postgres to scan recent log rows and filter
-- message values for every health request, increasing work during database pressure.
CREATE INDEX IF NOT EXISTS dd_engine_logs_message_created_idx
  ON public.dd_engine_logs (message, created_at DESC);
