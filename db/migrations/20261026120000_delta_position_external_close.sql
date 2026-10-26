BEGIN;

-- Ensure the position ledger columns exist even on databases created before the
-- Delta Testnet positions migration was applied.
ALTER TABLE public.dd_delta_positions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE public.dd_delta_positions
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ NULL;

ALTER TABLE public.dd_delta_positions
  DROP CONSTRAINT IF EXISTS dd_delta_positions_status_check;
ALTER TABLE public.dd_delta_positions
  ADD CONSTRAINT dd_delta_positions_status_check
  CHECK (status IN ('OPEN', 'CLOSED', 'CLOSED_EXTERNALLY')) NOT VALID;
ALTER TABLE public.dd_delta_positions
  VALIDATE CONSTRAINT dd_delta_positions_status_check;

DROP INDEX IF EXISTS public.dd_delta_positions_closed_idx;
CREATE INDEX dd_delta_positions_closed_idx
  ON public.dd_delta_positions (closed_at DESC)
  WHERE status IN ('CLOSED', 'CLOSED_EXTERNALLY');

NOTIFY pgrst, 'reload schema';
COMMIT;
