BEGIN;

-- Bind E-STOP release challenges to one activation and allow atomic one-time use.
ALTER TABLE public.dd_settings
  ADD COLUMN IF NOT EXISTS emergency_stop_activated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS emergency_stop_release_token_hash TEXT NULL;

-- An already-active E-STOP gets a migration-time activation marker. This does
-- not release or otherwise change the emergency-stop state.
UPDATE public.dd_settings
SET emergency_stop_activated_at = COALESCE(updated_at, now())
WHERE emergency_stop IS TRUE
  AND emergency_stop_activated_at IS NULL;

NOTIFY pgrst, 'reload schema';
COMMIT;
