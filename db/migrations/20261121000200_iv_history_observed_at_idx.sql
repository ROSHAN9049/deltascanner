-- Support bounded 30-day IV-history retention without scanning the full history table.
CREATE INDEX IF NOT EXISTS dd_iv_history_observed_at_idx
  ON public.dd_iv_history (observed_at);
