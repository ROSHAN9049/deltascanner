BEGIN;

ALTER TABLE public.dd_settings
  ADD COLUMN IF NOT EXISTS adaptive_volatility_shadow_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.dd_delta_positions
  ADD COLUMN IF NOT EXISTS requested_exit_reason TEXT NULL;

COMMENT ON COLUMN public.dd_settings.adaptive_volatility_shadow_enabled IS
  'Opt-in switch for Adaptive Volatility shadow observations and simulated trailing stops. Never enables order routing.';
COMMENT ON COLUMN public.dd_delta_positions.requested_exit_reason IS
  'Explicit local reason for a requested reduce-only exit, used only as fallback when exchange close evidence does not classify the exit.';

CREATE TABLE IF NOT EXISTS public.dd_shadow_signals (
  id BIGSERIAL PRIMARY KEY,
  signal_key TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('MOMENTUM', 'SCALPING')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  impulse_side TEXT NOT NULL CHECK (impulse_side IN ('BUY', 'SELL')),
  source_signal_side TEXT NULL,
  signal_at TIMESTAMPTZ NOT NULL,
  signal_price NUMERIC NULL,
  move_5m_pct NUMERIC NOT NULL,
  relative_volume NUMERIC NOT NULL,
  rsi NUMERIC NULL,
  ema_distance_atr NUMERIC NULL,
  ema_distance_limit_atr NUMERIC NULL,
  normalized_score NUMERIC NULL,
  taker_fee_rate NUMERIC NOT NULL DEFAULT 0,
  spread_pct NUMERIC NOT NULL DEFAULT 0,
  max_hold_minutes INTEGER NOT NULL DEFAULT 240 CHECK (max_hold_minutes > 0),
  base_blocked_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  shadow_blocked_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  shadow_status TEXT NOT NULL DEFAULT 'BLOCKED'
    CHECK (shadow_status IN ('BLOCKED', 'PENDING_ENTRY', 'OPEN', 'CLOSED', 'EXPIRED')),
  entry_at TIMESTAMPTZ NULL,
  entry_price NUMERIC NULL,
  initial_stop_price NUMERIC NULL,
  trailing_stop_price NUMERIC NULL,
  best_price NUMERIC NULL,
  worst_price NUMERIC NULL,
  trailing_activated BOOLEAN NOT NULL DEFAULT FALSE,
  last_processed_candle_time BIGINT NULL,
  exit_at TIMESTAMPTZ NULL,
  exit_price NUMERIC NULL,
  exit_reason TEXT NULL,
  gross_pnl_pct NUMERIC NULL,
  transaction_cost_pct NUMERIC NULL,
  net_pnl_pct NUMERIC NULL,
  max_favorable_excursion_pct NUMERIC NULL,
  max_adverse_excursion_pct NUMERIC NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dd_shadow_signals_status_signal_at_idx
  ON public.dd_shadow_signals (shadow_status, signal_at DESC);
CREATE INDEX IF NOT EXISTS dd_shadow_signals_strategy_created_idx
  ON public.dd_shadow_signals (strategy, created_at DESC);
CREATE INDEX IF NOT EXISTS dd_shadow_signals_symbol_created_idx
  ON public.dd_shadow_signals (symbol, created_at DESC);

ALTER TABLE public.dd_shadow_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dd_shadow_signals FROM anon, authenticated;
GRANT ALL ON TABLE public.dd_shadow_signals TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
