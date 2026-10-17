-- Add a best-effort strategy label to display-only API-derived close observations.
-- Raw Tradetron position snapshots do not identify whether a net position belongs
-- to Momentum or Scalping; this backfill only labels from the latest signal cache.
-- All API-derived rows remain unverified and are never promoted into dd_trades.
ALTER TABLE public.dd_api_derived_trades
  ADD COLUMN IF NOT EXISTS strategy text;

UPDATE public.dd_api_derived_trades AS d
SET strategy = (
  SELECT c.strategy
  FROM public.dd_signal_cache AS c
  WHERE upper(c.symbol) = upper(d.symbol)
    AND c.strategy IN ('MOMENTUM', 'SCALPING')
  ORDER BY
    CASE WHEN c.ready IS TRUE THEN 0 ELSE 1 END,
    CASE c.stage WHEN 'CONFIRMED' THEN 0 WHEN 'SETUP' THEN 1 ELSE 2 END,
    c.score DESC NULLS LAST,
    c.cached_at DESC NULLS LAST,
    CASE c.strategy WHEN 'MOMENTUM' THEN 0 ELSE 1 END
  LIMIT 1
)
WHERE d.strategy IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.dd_signal_cache AS c
    WHERE upper(c.symbol) = upper(d.symbol)
      AND c.strategy IN ('MOMENTUM', 'SCALPING')
  );

CREATE INDEX IF NOT EXISTS dd_api_derived_trades_strategy_detected_idx
  ON public.dd_api_derived_trades (strategy, detected_at DESC);
