-- SaveLock cloud schema.
--
-- Run this once in your Supabase project's SQL editor (or via `supabase db
-- push` if you use the CLI) after creating the project. See
-- SUPABASE_SETUP.md at the repo root for the full setup runbook.
--
-- Design notes:
--   * Every table is keyed to auth.users(id) and has row-level security
--     enabled with a single "own rows only" policy — a user can never read
--     or write another user's data, enforced by Postgres itself, not by
--     application code.
--   * Phone number is the only identity Supabase Auth needs; no email, no
--     name, no device fingerprint, no location. Everything else here is
--     exactly the financial-behavior data the app already tracks locally
--     (spends, goals, streaks, settings) — nothing new is collected by
--     adding accounts.
--   * profiles/settings get one row per user, auto-created by a trigger the
--     moment someone signs up, so the app never has to handle "row doesn't
--     exist yet" as a special case after first login.

create extension if not exists pgcrypto;

-- ---- profiles ------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  phone text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- ---- settings (one row per user) -----------------------------------------

create table public.settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  daily_limit numeric not null default 0,
  currency text not null default 'KSh',
  -- Current under-budget streak. Lives here (not on daily_logs) because
  -- it's a single piece of live account state, not a per-day historical
  -- fact — daily_logs rows are immutable once a day closes.
  streak_count int not null default 0,
  sms_notify_spend boolean not null default true,
  sms_notify_received boolean not null default true,
  sms_notify_mode text not null default 'always',
  categories jsonb not null default '["Food","Transport","Airtime","Bills","Shopping","Other"]'::jsonb,
  reminder_morning_enabled boolean not null default false,
  reminder_morning_time text not null default '08:00',
  reminder_evening_enabled boolean not null default false,
  reminder_evening_time text not null default '20:00',
  weekly_summary_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.settings enable row level security;

create policy "own settings" on public.settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- daily_logs: one row per user per already-closed calendar date -------
-- "allowance" is the limit that date was judged against (limits can change
-- over time, so this is never recomputed from current settings).

create table public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  allowance numeric not null,
  spent numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

alter table public.daily_logs enable row level security;

create policy "own daily_logs" on public.daily_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- spends: line items, both today's (still editable) and past ---------

create table public.spends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  amount numeric not null,
  note text,
  category text,
  source text not null default 'manual', -- 'manual' | 'sms'
  classification text not null default 'spend', -- 'spend' | 'savings-transfer'
  mpesa_code text,
  via_fuliza boolean not null default false,
  fuliza_amount numeric,
  at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index spends_user_date_idx on public.spends (user_id, date);

alter table public.spends enable row level security;

create policy "own spends" on public.spends
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- goals ----------------------------------------------------------------

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  target numeric not null,
  saved numeric not null default 0,
  target_date date not null,
  status text not null default 'active', -- 'active' | 'done' | 'broken'
  milestones_hit jsonb not null default '[]'::jsonb,
  saved_history jsonb not null default '[]'::jsonb,
  created_at_date date not null default current_date,
  completed_at date,
  broken_at date,
  days_early int,
  streak_lost int,
  updated_at timestamptz not null default now()
);

alter table public.goals enable row level security;

create policy "own goals" on public.goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- badges: earned once, kept forever -----------------------------------

create table public.badges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  badge_id text not null,
  earned_at date not null,
  unique (user_id, badge_id)
);

alter table public.badges enable row level security;

create policy "own badges" on public.badges
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- weekly challenges: opt-in, never auto-started -----------------------

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  target_extra numeric not null,
  start_date date not null,
  end_date date,
  status text not null default 'active', -- 'active' | 'passed' | 'missed' | 'cancelled'
  saved_amount numeric,
  created_at timestamptz not null default now()
);

alter table public.challenges enable row level security;

create policy "own challenges" on public.challenges
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- Fuliza events: repayment/activation/interest, never a spend --------

create table public.fuliza_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null, -- 'fuliza_repayment' | 'fuliza_activation' | 'fuliza_interest'
  amount numeric not null,
  mpesa_code text,
  at timestamptz not null default now()
);

alter table public.fuliza_events enable row level security;

create policy "own fuliza_events" on public.fuliza_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- auto-provision profile + default settings on signup -----------------

create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, phone) values (new.id, new.phone);
  insert into public.settings (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
