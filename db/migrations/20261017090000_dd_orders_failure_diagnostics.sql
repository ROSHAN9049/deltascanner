-- Add structured failure diagnostics to Tradetron signal reservations.
-- These nullable fields are observational; they do not affect execution safety or state transitions.
ALTER TABLE public.dd_orders
  ADD COLUMN IF NOT EXISTS failure_reason text;

ALTER TABLE public.dd_orders
  ADD COLUMN IF NOT EXISTS failure_detail text;
