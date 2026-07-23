-- Minimal stand in for the pieces of a real Supabase project
-- 0007_group_challenges.sql depends on: the auth.users table it
-- foreign-keys to, auth.uid() (reads a session setting here instead of a
-- request JWT, so a plain psql session can simulate "being" different
-- signed in users), the authenticated/service_role roles every migration's
-- grants target, and the supabase_realtime publication 0003 and 0007 both
-- add tables to. Run once, before the real migrations, by
-- test-group-challenges-db.mjs — never part of what ships to the real
-- Supabase project, only this test harness.

create extension if not exists pgcrypto;
create schema if not exists auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  phone text,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;

do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
grant usage on schema public to authenticated;
grant usage on schema auth to authenticated;

-- A real Supabase project grants baseline table privileges to authenticated
-- for the whole public schema as part of the platform itself, outside of
-- any user migration (every migration in this repo only ever adds RLS
-- policies on top of that, never a bare GRANT on a table).
grant select, insert, update, delete on all tables in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;

drop publication if exists supabase_realtime;
create publication supabase_realtime;
