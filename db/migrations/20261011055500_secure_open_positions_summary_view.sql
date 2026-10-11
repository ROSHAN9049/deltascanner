-- Harden the open-position summary view against RLS bypass.
-- The live view currently exposes aggregate counts to anon/authenticated while
-- its owner (postgres) bypasses the underlying dd_positions RLS policies.
-- The app reads positions through the server-side service-role API, so this
-- summary view does not need public/authenticated grants.
DO $$
BEGIN
  IF to_regclass('public.dd_open_positions_summary') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.dd_open_positions_summary SET (security_invoker = true)';
    EXECUTE 'REVOKE ALL ON TABLE public.dd_open_positions_summary FROM anon, authenticated';
  END IF;
END
$$;
