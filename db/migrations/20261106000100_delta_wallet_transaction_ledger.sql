BEGIN;

-- Delta wallet transactions are the authoritative account-level source for
-- realized cashflow, trading commissions, funding and liquidation fees.
-- Keep amounts signed and retain the raw exchange record; never derive them
-- from entry/exit prices or mix them into the per-position realized_pnl field.
CREATE TABLE IF NOT EXISTS public.dd_delta_wallet_transactions (
  id TEXT PRIMARY KEY,
  transaction_type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  balance NUMERIC NULL,
  asset_id BIGINT NULL,
  asset_symbol TEXT NOT NULL,
  product_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'rest',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dd_delta_wallet_transactions_created_idx
  ON public.dd_delta_wallet_transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS dd_delta_wallet_transactions_type_asset_created_idx
  ON public.dd_delta_wallet_transactions (transaction_type, asset_symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS dd_delta_wallet_transactions_product_created_idx
  ON public.dd_delta_wallet_transactions (product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.dd_delta_wallet_sync_state (
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
INSERT INTO public.dd_delta_wallet_sync_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.dd_delta_wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dd_delta_wallet_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dd_delta_wallet_transactions FROM anon, authenticated;
REVOKE ALL ON TABLE public.dd_delta_wallet_sync_state FROM anon, authenticated;
GRANT ALL ON TABLE public.dd_delta_wallet_transactions TO service_role;
GRANT ALL ON TABLE public.dd_delta_wallet_sync_state TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
