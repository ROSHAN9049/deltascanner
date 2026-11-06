BEGIN;

ALTER TABLE public.dd_delta_positions
  ADD COLUMN IF NOT EXISTS realized_funding NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS funding_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fees_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pnl_currency TEXT NULL;

ALTER TABLE public.dd_trades
  ADD COLUMN IF NOT EXISTS exchange_realized_pnl NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS realized_funding NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS funding_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pnl_currency TEXT NULL;

COMMENT ON COLUMN public.dd_trades.exchange_realized_pnl IS
  'Delta Exchange fill/position realized_pnl, retained as the authoritative exchange value before separately reported funding and wallet fee movements.';
COMMENT ON COLUMN public.dd_trades.realized_funding IS
  'Signed Delta wallet funding movements associated with this net position lifecycle.';
COMMENT ON COLUMN public.dd_trades.net_pnl IS
  'All-in verified P&L: exchange_realized_pnl + signed realized_funding - fees. NULL until each component is verified.';

CREATE TABLE IF NOT EXISTS public.dd_wallet_transactions (
  id TEXT PRIMARY KEY,
  transaction_type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  balance NUMERIC NULL,
  product_id BIGINT NULL,
  asset_id BIGINT NULL,
  asset_symbol TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  timestamp_us BIGINT NULL,
  meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'rest',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS dd_wallet_transactions_product_created_idx
  ON public.dd_wallet_transactions (product_id, created_at ASC);
CREATE INDEX IF NOT EXISTS dd_wallet_transactions_created_idx
  ON public.dd_wallet_transactions (created_at ASC);
CREATE INDEX IF NOT EXISTS dd_wallet_transactions_type_created_idx
  ON public.dd_wallet_transactions (transaction_type, created_at ASC);
CREATE INDEX IF NOT EXISTS dd_wallet_transactions_asset_created_idx
  ON public.dd_wallet_transactions (asset_symbol, created_at ASC);

CREATE TABLE IF NOT EXISTS public.dd_wallet_transaction_sync_state (
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

INSERT INTO public.dd_wallet_transaction_sync_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.dd_wallet_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dd_wallet_transactions FROM anon, authenticated;
GRANT ALL ON TABLE public.dd_wallet_transactions TO service_role;

ALTER TABLE public.dd_wallet_transaction_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dd_wallet_transaction_sync_state FROM anon, authenticated;
GRANT ALL ON TABLE public.dd_wallet_transaction_sync_state TO service_role;

-- Four legacy client-order-ID rows duplicate an already-materialized canonical
-- Delta position lifecycle row. Keep them for audit, but exclude their P&L/trade
-- count and rotation effects from the active ledger.
UPDATE public.dd_trades AS legacy
SET result = 'SUPERSEDED',
    net_pnl = NULL,
    net_pnl_verified = FALSE
FROM public.dd_delta_positions AS position
JOIN public.dd_trades AS canonical
  ON canonical.execution_id = 'delta-testnet-position:' || position.id::text
WHERE legacy.execution_id = position.client_order_id
  AND legacy.execution_id IS NOT NULL
  AND legacy.execution_id NOT LIKE 'delta-testnet-position:%'
  AND canonical.net_pnl_verified IS TRUE;

DELETE FROM public.dd_rotation_ledger AS legacy_rotation
USING public.dd_delta_positions AS position
JOIN public.dd_trades AS canonical
  ON canonical.execution_id = 'delta-testnet-position:' || position.id::text
WHERE legacy_rotation.execution_id = position.client_order_id
  AND position.client_order_id IS NOT NULL
  AND canonical.net_pnl_verified IS TRUE;

-- The prior canonical materializer stored Delta's exchange realized_pnl in
-- net_pnl before wallet funding and the complete exchange fee ledger were
-- joined. Preserve that exchange value, but do not present it as all-in net.
UPDATE public.dd_trades
SET exchange_realized_pnl = COALESCE(exchange_realized_pnl, net_pnl),
    net_pnl = NULL,
    net_pnl_verified = FALSE,
    result = 'EXCHANGE P&L · COSTS UNVERIFIED'
WHERE execution_id LIKE 'delta-testnet-position:%'
  AND net_pnl_verified IS TRUE
  AND net_pnl IS NOT NULL;

-- Rotation rows are derived reporting only, not exchange transfers. Rebuild
-- them only after fee and funding verification establishes a positive net.
DELETE FROM public.dd_rotation_ledger
WHERE execution_id LIKE 'delta-testnet-position:%';

CREATE OR REPLACE FUNCTION public.refresh_dd_daily_pnl_for_date(p_trade_date DATE)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_trades INTEGER;
  v_realized NUMERIC;
  v_fees NUMERIC;
  v_wins INTEGER;
  v_losses INTEGER;
BEGIN
  SELECT
    COUNT(*)::INTEGER,
    COALESCE(SUM(net_pnl), 0),
    COALESCE(SUM(fees), 0),
    COUNT(*) FILTER (WHERE net_pnl > 0)::INTEGER,
    COUNT(*) FILTER (WHERE net_pnl < 0)::INTEGER
  INTO v_trades, v_realized, v_fees, v_wins, v_losses
  FROM public.dd_trades
  WHERE closed_at IS NOT NULL
    AND (closed_at AT TIME ZONE 'Asia/Kolkata')::DATE = p_trade_date
    AND net_pnl_verified IS TRUE
    AND result IS DISTINCT FROM 'SUPERSEDED';

  IF v_trades = 0 THEN
    DELETE FROM public.dd_daily_pnl WHERE trade_date = p_trade_date;
  ELSE
    INSERT INTO public.dd_daily_pnl (
      trade_date, realized, fees, wins, losses, trades, updated_at
    )
    VALUES (
      p_trade_date, v_realized, v_fees, v_wins, v_losses, v_trades, NOW()
    )
    ON CONFLICT (trade_date) DO UPDATE
    SET realized = EXCLUDED.realized,
        fees = EXCLUDED.fees,
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        trades = EXCLUDED.trades,
        updated_at = NOW();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_dd_daily_pnl_from_trade()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_date DATE;
  v_new_date DATE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.closed_at IS NOT NULL THEN
    v_old_date := (OLD.closed_at AT TIME ZONE 'Asia/Kolkata')::DATE;
    PERFORM public.refresh_dd_daily_pnl_for_date(v_old_date);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.closed_at IS NOT NULL THEN
    v_new_date := (NEW.closed_at AT TIME ZONE 'Asia/Kolkata')::DATE;
    IF v_new_date IS DISTINCT FROM v_old_date THEN
      PERFORM public.refresh_dd_daily_pnl_for_date(v_new_date);
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_dd_daily_pnl_for_date(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_dd_daily_pnl_from_trade() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_dd_daily_pnl_for_date(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_dd_daily_pnl_from_trade() TO service_role;

DROP TRIGGER IF EXISTS dd_trades_daily_pnl_sync ON public.dd_trades;
CREATE TRIGGER dd_trades_daily_pnl_sync
AFTER INSERT OR UPDATE OR DELETE ON public.dd_trades
FOR EACH ROW EXECUTE FUNCTION public.sync_dd_daily_pnl_from_trade();

-- Rebuild the daily ledger from verified, non-superseded exchange trade rows.
DELETE FROM public.dd_daily_pnl;
INSERT INTO public.dd_daily_pnl (
  trade_date, realized, fees, wins, losses, trades, updated_at
)
SELECT
  (closed_at AT TIME ZONE 'Asia/Kolkata')::DATE,
  COALESCE(SUM(net_pnl), 0),
  COALESCE(SUM(fees), 0),
  COUNT(*) FILTER (WHERE net_pnl > 0)::INTEGER,
  COUNT(*) FILTER (WHERE net_pnl < 0)::INTEGER,
  COUNT(*)::INTEGER,
  NOW()
FROM public.dd_trades
WHERE closed_at IS NOT NULL
  AND net_pnl_verified IS TRUE
  AND result IS DISTINCT FROM 'SUPERSEDED'
GROUP BY (closed_at AT TIME ZONE 'Asia/Kolkata')::DATE;

NOTIFY pgrst, 'reload schema';
COMMIT;
