-- Increase statement_timeout from default to 30s to prevent
-- "canceling statement due to statement timeout" on admin loadData queries,
-- which fetch up to 9 tables in parallel with nested joins via RLS.
ALTER ROLE authenticated SET statement_timeout = '30s';
ALTER ROLE anon SET statement_timeout = '30s';
