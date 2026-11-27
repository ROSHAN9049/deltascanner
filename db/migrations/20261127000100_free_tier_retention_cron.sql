-- Free-tier retention backstop: runs independently of the worker process.
-- Keeps 2 days of engine logs/signals, 20 days of IV history, and 3 days of option cache.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.cleanup_free_tier_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, private
AS $$
DECLARE
  affected integer;
  engine_logs_deleted bigint := 0;
  signals_deleted bigint := 0;
  iv_history_deleted bigint := 0;
  option_cache_deleted bigint := 0;
BEGIN
  LOOP
    DELETE FROM public.dd_engine_logs
    WHERE ctid IN (
      SELECT ctid FROM public.dd_engine_logs
      WHERE created_at < clock_timestamp() - interval '2 days'
      ORDER BY created_at ASC
      LIMIT 5000
    );
    GET DIAGNOSTICS affected = ROW_COUNT;
    engine_logs_deleted := engine_logs_deleted + affected;
    EXIT WHEN affected = 0;
  END LOOP;

  LOOP
    DELETE FROM public.dd_signals
    WHERE ctid IN (
      SELECT ctid FROM public.dd_signals
      WHERE captured_at < clock_timestamp() - interval '2 days'
      ORDER BY captured_at ASC
      LIMIT 5000
    );
    GET DIAGNOSTICS affected = ROW_COUNT;
    signals_deleted := signals_deleted + affected;
    EXIT WHEN affected = 0;
  END LOOP;

  LOOP
    DELETE FROM public.dd_iv_history
    WHERE ctid IN (
      SELECT ctid FROM public.dd_iv_history
      WHERE observed_at < clock_timestamp() - interval '20 days'
      ORDER BY observed_at ASC
      LIMIT 5000
    );
    GET DIAGNOSTICS affected = ROW_COUNT;
    iv_history_deleted := iv_history_deleted + affected;
    EXIT WHEN affected = 0;
  END LOOP;

  LOOP
    DELETE FROM public.dd_option_cache
    WHERE ctid IN (
      SELECT ctid FROM public.dd_option_cache
      WHERE cached_at < clock_timestamp() - interval '3 days'
      ORDER BY cached_at ASC
      LIMIT 5000
    );
    GET DIAGNOSTICS affected = ROW_COUNT;
    option_cache_deleted := option_cache_deleted + affected;
    EXIT WHEN affected = 0;
  END LOOP;

  RETURN jsonb_build_object(
    'engine_logs_deleted', engine_logs_deleted,
    'signals_deleted', signals_deleted,
    'iv_history_deleted', iv_history_deleted,
    'option_cache_deleted', option_cache_deleted,
    'completed_at', clock_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION private.cleanup_free_tier_history() FROM PUBLIC, anon, authenticated;

-- UTC: daily at 03:17. Re-scheduling the same job name updates it idempotently.
SELECT cron.schedule(
  'dealdost-free-tier-retention',
  '17 3 * * *',
  'SELECT private.cleanup_free_tier_history();'
);
