-- Restore PostgREST visibility after schema changes and ensure service_role
-- has the database privileges required by the Railway worker.
--
-- Security note: do not blanket-GRANT SELECT to anon/authenticated here.
-- The prior secure-open-positions migration explicitly revokes those roles
-- from dd_open_positions_summary, and the ledger tables do not all have RLS.
-- A blanket grant would re-expose private position/webhook data.
--
-- 1. Schema usage for API roles.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- 2. Full privileges for the server-side worker role.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- 3. Ensure future objects created by the migration connection's role
-- inherit service_role privileges. Do not default-grant table reads to public roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO service_role;

-- 4. Reload PostgREST schema cache and configuration after privileges/DDL.
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
