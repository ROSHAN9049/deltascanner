-- Run this in Supabase SQL Editor if PostgREST returns 404 for
-- tables that exist in information_schema.
-- Safe to run multiple times.
--
-- Security note: a blanket SELECT grant to anon/authenticated is intentionally
-- omitted. The existing secure-open-positions migration revokes those roles
-- from dd_open_positions_summary, and ledger tables include data without RLS.
-- The Railway worker uses service_role, which receives the required privileges.

-- 1. Grant schema usage.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- 2. Ensure the server-side worker role can access database objects.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- 3. Ensure future objects created by the SQL Editor's active role inherit
-- service_role privileges. No default table reads are granted to public roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO service_role;

-- 4. Reload PostgREST schema cache and configuration.
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
