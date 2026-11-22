-- Reduce repeated materialization and heap I/O in grouped IV metrics.
-- The existing lookup index is retained as a covering index for the aggregate query.
BEGIN;

CREATE INDEX IF NOT EXISTS dd_iv_history_group_observed_cover_idx
  ON public.dd_iv_history
    (underlying, option_type, delta_bucket, dte_bucket, observed_at DESC)
  INCLUDE (iv_current);

DROP INDEX IF EXISTS public.dd_iv_history_group_observed_idx;

CREATE OR REPLACE FUNCTION public.get_options_iv_group_metrics(
  p_underlying text,
  p_option_type text,
  p_delta_bucket text,
  p_dte_bucket text,
  p_since timestamp with time zone,
  p_now timestamp with time zone
)
RETURNS TABLE(
  observation_count bigint,
  oldest_observed_at timestamp with time zone,
  newest_observed_at timestamp with time zone,
  iv_low numeric,
  iv_high numeric,
  history_days numeric,
  daily_sample_count integer,
  daily_samples jsonb
)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  WITH filtered AS NOT MATERIALIZED (
    SELECT
      observed_at,
      iv_current,
      (observed_at AT TIME ZONE 'Asia/Kolkata')::DATE AS market_day
    FROM public.dd_iv_history
    WHERE underlying = upper(trim(p_underlying))
      AND option_type = upper(trim(p_option_type))
      AND delta_bucket = p_delta_bucket
      AND dte_bucket = p_dte_bucket
      AND observed_at >= p_since
      AND observed_at <= p_now
      AND iv_current > 0
      AND iv_current <= 500
  ),
  aggregate_metrics AS (
    SELECT
      count(*)::BIGINT AS observation_count,
      min(observed_at) AS oldest_observed_at,
      max(observed_at) AS newest_observed_at,
      min(iv_current) AS iv_low,
      max(iv_current) AS iv_high,
      CASE
        WHEN min(observed_at) IS NULL THEN 0::NUMERIC
        ELSE greatest(0::NUMERIC,
          extract(epoch FROM (p_now - min(observed_at))) / 86400
        )::NUMERIC
      END AS history_days
    FROM filtered
  ),
  latest_daily_scan AS (
    SELECT market_day, max(observed_at) AS observed_at
    FROM filtered
    WHERE market_day < (p_now AT TIME ZONE 'Asia/Kolkata')::DATE
    GROUP BY market_day
  ),
  completed_daily_samples AS (
    SELECT latest.market_day, avg(sample.iv_current) AS daily_iv
    FROM latest_daily_scan AS latest
    JOIN filtered AS sample
      ON sample.market_day = latest.market_day
     AND sample.observed_at = latest.observed_at
    GROUP BY latest.market_day
  )
  SELECT
    aggregate_metrics.observation_count,
    aggregate_metrics.oldest_observed_at,
    aggregate_metrics.newest_observed_at,
    aggregate_metrics.iv_low,
    aggregate_metrics.iv_high,
    aggregate_metrics.history_days,
    (SELECT count(*)::INTEGER FROM completed_daily_samples) AS daily_sample_count,
    coalesce(
      (SELECT jsonb_agg(
        jsonb_build_object('day', market_day, 'iv', daily_iv)
        ORDER BY market_day
      ) FROM completed_daily_samples),
      '[]'::JSONB
    ) AS daily_samples
  FROM aggregate_metrics;
$function$;

NOTIFY pgrst, 'reload schema';
COMMIT;
