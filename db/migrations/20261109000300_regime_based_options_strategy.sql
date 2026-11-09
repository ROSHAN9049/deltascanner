BEGIN;

ALTER TABLE public.dd_option_cache
  ADD COLUMN IF NOT EXISTS market_regime TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS iv_rank NUMERIC NULL;

ALTER TABLE public.dd_option_cache
  DROP CONSTRAINT IF EXISTS dd_option_cache_market_regime_check;
ALTER TABLE public.dd_option_cache
  ADD CONSTRAINT dd_option_cache_market_regime_check
  CHECK (market_regime IN ('TRENDING', 'SIDEWAYS', 'UNKNOWN')) NOT VALID;
ALTER TABLE public.dd_option_cache
  VALIDATE CONSTRAINT dd_option_cache_market_regime_check;

ALTER TABLE public.dd_option_cache
  DROP CONSTRAINT IF EXISTS dd_option_cache_iv_rank_check;
ALTER TABLE public.dd_option_cache
  ADD CONSTRAINT dd_option_cache_iv_rank_check
  CHECK (iv_rank IS NULL OR iv_rank BETWEEN 0 AND 100) NOT VALID;
ALTER TABLE public.dd_option_cache
  VALIDATE CONSTRAINT dd_option_cache_iv_rank_check;

CREATE TABLE IF NOT EXISTS public.dd_option_positions (
  position_key TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('OPTIONS_BUY', 'OPTIONS_SELL')),
  market_regime TEXT NOT NULL CHECK (market_regime IN ('TRENDING', 'SIDEWAYS')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty NUMERIC NOT NULL CHECK (qty > 0),
  contract_size NUMERIC NOT NULL CHECK (contract_size > 0),
  entry_premium NUMERIC NOT NULL CHECK (entry_premium > 0),
  hedge_symbol TEXT NULL,
  hedge_contract_size NUMERIC NULL,
  hedge_entry_premium NUMERIC NULL,
  entry_order_id TEXT NULL,
  hedge_entry_order_id TEXT NULL,
  expiry_ms BIGINT NOT NULL,
  dte NUMERIC NULL,
  peak_premium NUMERIC NULL,
  current_premium NUMERIC NULL,
  short_exit_premium NUMERIC NULL,
  hedge_exit_premium NUMERIC NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'HEDGE_CLOSE_PENDING', 'RECONCILIATION_REQUIRED', 'CLOSED')),
  exit_reason TEXT NULL,
  realized_pnl NUMERIC NULL,
  realized_pnl_verified BOOLEAN NOT NULL DEFAULT FALSE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS dd_option_positions_status_idx
  ON public.dd_option_positions (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS dd_option_positions_closed_idx
  ON public.dd_option_positions (closed_at DESC)
  WHERE status = 'CLOSED';

ALTER TABLE public.dd_option_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dd_option_positions FROM anon, authenticated;
GRANT ALL ON TABLE public.dd_option_positions TO service_role;

COMMENT ON COLUMN public.dd_option_cache.market_regime IS
  'Confirmed dual-timeframe 15m/1h regime. UNKNOWN is a no-entry state when regime routing is enabled.';
COMMENT ON COLUMN public.dd_option_cache.iv_rank IS
  'IV Rank 0-100 read directly from Delta option ticker/Greeks payload when supplied. NULL means unavailable and blocks entry.';
COMMENT ON TABLE public.dd_option_positions IS
  'Private service-role ledger for Delta Testnet Options positions, leg fills, automated exits and realized premium P&L.';

NOTIFY pgrst, 'reload schema';
COMMIT;
