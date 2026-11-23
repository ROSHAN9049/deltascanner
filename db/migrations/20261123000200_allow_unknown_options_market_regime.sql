-- Preserve UNKNOWN as an explicit regime state for Demo options positions.
-- Demo-only quality filters may log an unknown regime without treating it as a hard blocker;
-- the ledger must accept the observed state rather than inventing TRENDING/SIDEWAYS.
ALTER TABLE public.dd_option_positions
  DROP CONSTRAINT IF EXISTS dd_option_positions_market_regime_check;

ALTER TABLE public.dd_option_positions
  ADD CONSTRAINT dd_option_positions_market_regime_check
  CHECK (market_regime = ANY (ARRAY['TRENDING'::text, 'SIDEWAYS'::text, 'UNKNOWN'::text]));
