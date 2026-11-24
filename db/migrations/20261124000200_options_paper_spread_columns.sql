BEGIN;
ALTER TABLE public.dd_paper_trades
  DROP CONSTRAINT IF EXISTS dd_paper_trades_strategy_check,
  DROP CONSTRAINT IF EXISTS dd_paper_trades_side_check;
ALTER TABLE public.dd_paper_trades
  ADD CONSTRAINT dd_paper_trades_strategy_check CHECK (strategy IN ('OPTIONS_BUY', 'OPTIONS_SELL')),
  ADD CONSTRAINT dd_paper_trades_side_check CHECK (side IN ('BUY', 'SELL'));
ALTER TABLE public.dd_paper_trades
  ADD COLUMN IF NOT EXISTS hedge_symbol TEXT NULL,
  ADD COLUMN IF NOT EXISTS hedge_entry_price NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS spread_width NUMERIC NULL;
NOTIFY pgrst, 'reload schema';
COMMIT;