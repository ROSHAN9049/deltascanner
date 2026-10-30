BEGIN;

ALTER TABLE public.dd_delta_positions
  ADD COLUMN IF NOT EXISTS close_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS entry_order_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS realized_pnl_verified BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.dd_fills
  ADD COLUMN IF NOT EXISTS client_order_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS timestamp_us BIGINT NULL,
  ADD COLUMN IF NOT EXISTS sequence_no BIGINT NULL,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'rest';

CREATE INDEX IF NOT EXISTS dd_fills_symbol_created_idx
  ON public.dd_fills (symbol, created_at ASC);
CREATE INDEX IF NOT EXISTS dd_fills_order_created_idx
  ON public.dd_fills (order_id, created_at ASC);

-- Unknown gross P&L, fees, and net P&L must stay NULL rather than silently
-- appearing as zero while the verified fill/close reconciliation is incomplete.
ALTER TABLE public.dd_trades
  ADD COLUMN IF NOT EXISTS fees_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS net_pnl_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ALTER COLUMN fees DROP NOT NULL,
  ALTER COLUMN fees DROP DEFAULT,
  ALTER COLUMN gross_pnl DROP NOT NULL,
  ALTER COLUMN gross_pnl DROP DEFAULT,
  ALTER COLUMN net_pnl DROP NOT NULL,
  ALTER COLUMN net_pnl DROP DEFAULT;

CREATE TABLE IF NOT EXISTS public.dd_delta_fill_sync_state (
  id BIGINT PRIMARY KEY DEFAULT 1,
  last_synced_through_us BIGINT NULL,
  window_start_us BIGINT NULL,
  window_end_us BIGINT NULL,
  after_cursor TEXT NULL,
  last_success_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  rows_ingested BIGINT NOT NULL DEFAULT 0 CHECK (rows_ingested >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.dd_delta_fill_sync_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.dd_delta_fill_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dd_delta_fill_sync_state FROM anon, authenticated;
GRANT ALL ON TABLE public.dd_delta_fill_sync_state TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
