-- Stable deployment boundary for automatic Engine Futures exit enrollment.
-- The timestamp is set once when this migration is applied and never moves on worker restart.
ALTER TABLE public.dd_settings
  ADD COLUMN IF NOT EXISTS exit_lifecycle_deploy_boundary_utc timestamptz;

UPDATE public.dd_settings
SET exit_lifecycle_deploy_boundary_utc = COALESCE(exit_lifecycle_deploy_boundary_utc, now())
WHERE id = 1;

COMMENT ON COLUMN public.dd_settings.exit_lifecycle_deploy_boundary_utc IS
  'Stable UTC cutoff: Engine Futures positions opened at/after this instant are auto-enrolled for timeout/SL/TP exits; older positions require explicit EXIT_LIFECYCLE_ENROLLED_POSITION_IDS enrollment.';
