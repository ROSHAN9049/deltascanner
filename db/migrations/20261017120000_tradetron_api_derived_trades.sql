-- API-derived Tradetron observations are display-only and remain unverified.
CREATE TABLE IF NOT EXISTS public.dd_api_derived_position_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id text NOT NULL,
  position_key text NOT NULL,
  symbol text NOT NULL,
  quantity numeric,
  side text CHECK (side IN ('LONG','SHORT')),
  ltp numeric,
  raw_pnl numeric,
  is_open boolean NOT NULL DEFAULT false,
  raw_api_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  is_current boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS dd_api_derived_position_current_idx
  ON public.dd_api_derived_position_snapshots (deployment_id, position_key, is_current);

CREATE TABLE IF NOT EXISTS public.dd_api_derived_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id text NOT NULL,
  symbol text NOT NULL,
  side text CHECK (side IN ('LONG','SHORT') OR side IS NULL),
  qty_closed numeric,
  last_known_ltp numeric,
  raw_pnl numeric,
  raw_api_data jsonb NOT NULL,
  derived_from text NOT NULL CHECK (derived_from IN ('poll_transition','snapshot_closed','csv_import')),
  data_quality text NOT NULL CHECK (data_quality IN ('MINIMAL','PARTIAL','FULL')),
  transition_from_snapshot_id uuid NULL REFERENCES public.dd_api_derived_position_snapshots(id),
  detected_at timestamptz NOT NULL DEFAULT now(),
  closed_at_estimated timestamptz NULL,
  entry_price numeric NULL,
  exit_price numeric NULL,
  opened_at timestamptz NULL,
  closed_at timestamptz NULL,
  is_verified boolean NOT NULL DEFAULT false CHECK (is_verified = false),
  source_fingerprint text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS dd_api_derived_trades_detected_idx
  ON public.dd_api_derived_trades (detected_at DESC);
CREATE INDEX IF NOT EXISTS dd_api_derived_trades_deployment_symbol_idx
  ON public.dd_api_derived_trades (deployment_id, symbol, detected_at DESC);

ALTER TABLE public.dd_api_derived_position_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dd_api_derived_trades ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dd_api_derived_position_snapshots FROM anon, authenticated;
REVOKE ALL ON TABLE public.dd_api_derived_trades FROM anon, authenticated;
GRANT ALL ON TABLE public.dd_api_derived_position_snapshots TO service_role;
GRANT ALL ON TABLE public.dd_api_derived_trades TO service_role;
