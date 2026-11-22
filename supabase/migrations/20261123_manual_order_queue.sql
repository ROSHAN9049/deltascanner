CREATE TABLE IF NOT EXISTS public.dd_manual_option_order_queue (
  id BIGSERIAL PRIMARY KEY,
  contract TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  size INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','filled','failed')),
  claimed_at TIMESTAMPTZ,
  order_id TEXT,
  fill_price NUMERIC,
  filled_size NUMERIC,
  sl_order_id TEXT,
  tp_order_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.dd_manual_option_order_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON public.dd_manual_option_order_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_manual_queue_pending
  ON public.dd_manual_option_order_queue(status, created_at)
  WHERE status = 'pending';
