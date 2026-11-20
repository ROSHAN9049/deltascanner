-- Add covering indexes for the two foreign keys identified by Supabase performance advisors.
CREATE INDEX IF NOT EXISTS dd_api_derived_trades_transition_snapshot_idx
  ON public.dd_api_derived_trades (transition_from_snapshot_id);

CREATE INDEX IF NOT EXISTS dd_option_positions_delta_position_idx
  ON public.dd_option_positions (delta_position_id);
