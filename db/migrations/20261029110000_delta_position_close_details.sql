BEGIN;

-- Nullable close-detail fields are populated only from confirmed exchange
-- close/fill evidence. Missing history remains unknown instead of fabricated.
ALTER TABLE public.dd_delta_positions
  ADD COLUMN IF NOT EXISTS exit_price NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS fees NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS fee_currency TEXT NULL,
  ADD COLUMN IF NOT EXISTS exit_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS close_order_id TEXT NULL;

ALTER TABLE public.dd_delta_positions
  ALTER COLUMN realized_pnl DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
COMMIT;
