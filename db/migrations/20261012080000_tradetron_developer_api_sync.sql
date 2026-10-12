-- Read-only snapshots from Tradetron's documented Developer API.
-- The worker writes these using the Supabase server/service key. No browser role
-- receives direct table access. Existing webhook-managed dd_positions are untouched.
CREATE TABLE IF NOT EXISTS public.dd_tradetron_developer_snapshots (
  deployment_id bigint PRIMARY KEY,
  deployment_name text NOT NULL,
  deployment_type text,
  status text,
  broker text,
  multiplier numeric,
  capital numeric,
  pnl numeric,
  open_positions integer,
  total_positions integer,
  currency_code text,
  deployed_on text,
  positions_hidden boolean NOT NULL DEFAULT false,
  as_of timestamptz,
  positions jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_success_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dd_tradetron_developer_sync_state (
  id integer PRIMARY KEY CHECK (id = 1),
  status text NOT NULL DEFAULT 'NOT_CONFIGURED',
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  deployment_count integer NOT NULL DEFAULT 0,
  position_count integer NOT NULL DEFAULT 0,
  last_error text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.dd_tradetron_developer_sync_state (id, status)
VALUES (1, 'NOT_CONFIGURED')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.dd_tradetron_developer_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dd_tradetron_developer_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dd_tradetron_developer_snapshots FROM anon, authenticated;
REVOKE ALL ON TABLE public.dd_tradetron_developer_sync_state FROM anon, authenticated;
GRANT ALL ON TABLE public.dd_tradetron_developer_snapshots TO service_role;
GRANT ALL ON TABLE public.dd_tradetron_developer_sync_state TO service_role;
