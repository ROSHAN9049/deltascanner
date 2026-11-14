BEGIN;

ALTER TABLE public.dd_option_cache
  ADD COLUMN IF NOT EXISTS iv_percentile NUMERIC NULL;

COMMENT ON COLUMN public.dd_option_cache.iv_percentile IS
  'Daily IV Percentile: percentage of completed India-local days whose final-scan group-average IV is below current IV.';

CREATE OR REPLACE FUNCTION public.get_options_iv_group_metrics(
  p_underlying TEXT,
  p_option_type TEXT,
  p_delta_bucket TEXT,
  p_dte_bucket TEXT,
  p_since TIMESTAMPTZ,
  p_now TIMESTAMPTZ
)
RETURNS TABLE (
  observation_count BIGINT,
  oldest_observed_at TIMESTAMPTZ,
  newest_observed_at TIMESTAMPTZ,
  iv_low NUMERIC,
  iv_high NUMERIC,
  history_days NUMERIC,
  daily_sample_count INTEGER,
  daily_samples JSONB
)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH filtered AS MATERIALIZED (
    SELECT
      id,
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
    -- Several option contracts share a delta/DTE bucket. Average the
    -- contracts captured in the final complete scan of each day so a
    -- timestamp tie cannot pick an arbitrary contract by insertion order.
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

REVOKE ALL ON FUNCTION public.get_options_iv_group_metrics(
  TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_options_iv_group_metrics(
  TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
