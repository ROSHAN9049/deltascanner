-- Persist read-only Tradetron Developer API notifications and sampled P&L snapshots.
-- These records are strictly separate from dd_tradetron_events/dd_trades: notifications
-- and aggregate P&L observations are not proof of a fill or a closed trade.
CREATE TABLE IF NOT EXISTS public.dd_tradetron_developer_notifications (
  notification_id text PRIMARY KEY,
  deployment_id text,
  notification_type text,
  title text,
  description text,
  event_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dd_tradetron_developer_notifications_event_idx
  ON public.dd_tradetron_developer_notifications(event_at DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS dd_tradetron_developer_notifications_deployment_idx
  ON public.dd_tradetron_developer_notifications(deployment_id, event_at DESC);

CREATE TABLE IF NOT EXISTS public.dd_tradetron_developer_notification_sync_state (
  id integer PRIMARY KEY CHECK (id = 1),
  status text NOT NULL DEFAULT 'NOT_CONFIGURED',
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  notification_count integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.dd_tradetron_developer_notification_sync_state (id, status)
VALUES (1, 'NOT_CONFIGURED')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.dd_tradetron_developer_pnl_history (
  snapshot_id text PRIMARY KEY,
  deployment_id bigint NOT NULL,
  deployment_name text NOT NULL,
  captured_at timestamptz NOT NULL,
  reported_pnl numeric,
  open_positions integer,
  total_positions integer,
  currency_code text,
  status text,
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dd_tradetron_developer_pnl_history_capture_idx
  ON public.dd_tradetron_developer_pnl_history(captured_at DESC);
CREATE INDEX IF NOT EXISTS dd_tradetron_developer_pnl_history_deployment_idx
  ON public.dd_tradetron_developer_pnl_history(deployment_id, captured_at DESC);

ALTER TABLE public.dd_tradetron_developer_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dd_tradetron_developer_notification_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dd_tradetron_developer_pnl_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.dd_tradetron_developer_notifications FROM anon, authenticated;
REVOKE ALL ON TABLE public.dd_tradetron_developer_notification_sync_state FROM anon, authenticated;
REVOKE ALL ON TABLE public.dd_tradetron_developer_pnl_history FROM anon, authenticated;
GRANT ALL ON TABLE public.dd_tradetron_developer_notifications TO service_role;
GRANT ALL ON TABLE public.dd_tradetron_developer_notification_sync_state TO service_role;
GRANT ALL ON TABLE public.dd_tradetron_developer_pnl_history TO service_role;
