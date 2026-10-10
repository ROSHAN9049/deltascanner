-- Add processing state for exactly-once claim/finish semantics on Tradetron webhook events.
-- Safe for an existing populated table: only nullable processing metadata is added,
-- existing rows are initialized, and the unique event_id primary key remains intact.
ALTER TABLE public.dd_tradetron_events
  ADD COLUMN IF NOT EXISTS sync_status text,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_result jsonb,
  ADD COLUMN IF NOT EXISTS sync_error text;

ALTER TABLE public.dd_tradetron_events
  ALTER COLUMN sync_status SET DEFAULT 'RECEIVED';

UPDATE public.dd_tradetron_events
  SET sync_status = 'RECEIVED'
  WHERE sync_status IS NULL;

ALTER TABLE public.dd_tradetron_events
  ALTER COLUMN sync_status SET NOT NULL;

CREATE INDEX IF NOT EXISTS dd_tradetron_events_sync_status_created_idx
  ON public.dd_tradetron_events(sync_status, created_at DESC);
